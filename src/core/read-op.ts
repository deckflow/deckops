import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runParse, type ParseOpOptions } from './parse-op.js';
import { irPath, probePath } from '../artifact/layout.js';
import { validateDeckIR } from '../ir/validate.js';
import { renderMarkdown } from '../views/markdown.js';
import type { DeckProbeReport } from '../shared/preflight.js';
import { assessCandidate, type Assessment } from '../quality/assessment.js';
import { finalQualityGate } from '../engine/router.js';
import type { RouteDecision } from '../engine/policy.js';
import type { DeckIR } from '../ir/schema.js';
import type { OutputFile } from '../types.js';
import { DeckOpsError } from '../errors/index.js';

export interface ReadReport {
  schemaVersion: 'deckops.run.v1'; execution: 'completed'; completeness: 'partial' | 'unknown';
  selected: { parseEngine: 'local' | 'cloud'; renderer: 'local'; cacheHit: boolean };
  assessment: Assessment; decision?: RouteDecision; artifactBase: string; warnings: string[];
}
export interface ReadResult<F extends 'markdown' | 'ir' = 'markdown' | 'ir'> {
  schemaVersion: 'deckops.read.v1'; ok: true; format: F;
  content: (F extends 'ir' ? DeckIR : string) | null;
  outputs: OutputFile[];
  assets: Array<{ path: string; lifecycle: 'cache' | 'output'; bytes: number }>;
  report: ReadReport;
}
export interface ReadOpOptions extends Omit<ParseOpOptions, 'out'> {
  out?: string; format?: 'markdown' | 'ir'; reportFile?: string; anchors?: boolean; splitPages?: boolean;
  cacheDir?: string;
}
export async function runRead(options: ReadOpOptions): Promise<ReadResult> {
  const format = options.format ?? 'markdown';
  if (!['markdown', 'ir'].includes(format)) throw DeckOpsError.usage('format must be markdown or ir.');
  if (options.splitPages) throw DeckOpsError.usage('Use deckops convert on an artifact for --split-pages.');
  const output = options.out && options.out !== '-' ? path.resolve(options.out) : undefined;
  if (format === 'ir' && output) throw DeckOpsError.usage('Use deckops parse -o DIR to export portable IR with assets.');
  if (options.reportFile === '-') throw DeckOpsError.usage('--report must be a file; stdout is reserved for content.');
  const reportFile = options.reportFile ? path.resolve(options.reportFile) : undefined;
  const sourceFile = options.input.kind === 'document' ? path.resolve(options.input.file) : undefined;
  const paths = [output, reportFile, sourceFile].filter((x): x is string => !!x);
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
    const canonical = async (p: string) => fs.realpath(p).catch(() => fs.realpath(path.dirname(p)).then(parent => path.join(parent, path.basename(p))).catch(() => p));
    if (await canonical(paths[i]!) === await canonical(paths[j]!)) throw DeckOpsError.usage('Source, output and report paths must be distinct.');
  }
  options.common.signal?.throwIfAborted();
  let artifactBase: string, ir: DeckIR, assessment: Assessment, decision: RouteDecision | undefined, warnings: string[] = [], cacheHit = false;
  if (options.input.kind === 'artifact') {
    if (options.input.manifest.manifestVersion !== 2) throw DeckOpsError.unsupported('Use explicit convert for legacy cloud-native artifacts.');
    artifactBase = path.resolve(options.input.dir);
    ir = validateDeckIR(JSON.parse(await fs.readFile(irPath(artifactBase), 'utf8')));
    const storedProbe = options.input.manifest.inspection ? await fs.readFile(probePath(artifactBase), 'utf8').then(body => JSON.parse(body) as DeckProbeReport).catch(() => undefined) : undefined;
    assessment = assessCandidate({ ir, quality: ir.quality, assets: [] }, storedProbe); cacheHit = true;
  } else {
    const root = options.cacheDir ?? process.env.DECKOPS_CACHE_DIR ?? path.join(os.homedir(), '.cache', 'deckops');
    // URL fetches and password-bearing parses are never persistently reused by identity alone.
    const key = createHash('sha256').update(JSON.stringify([options.input.kind === 'document' ? path.resolve(options.inputLabel) : options.inputLabel, { ...options.flags, password: undefined }, options.common.limits ?? {}])).digest('hex');
    const unique = options.input.kind !== 'document' || options.flags.password ? `-${randomUUID()}` : '';
    artifactBase = path.resolve(root, key + unique);
    const parsed = await runParse({ ...options, out: artifactBase, common: { ...options.common, failOnDegraded: false } });
    ir = validateDeckIR(JSON.parse(await fs.readFile(irPath(artifactBase), 'utf8')));
    assessment = parsed.assessment ?? assessCandidate({ ir, quality: ir.quality, assets: [] }); decision = parsed.decision; if (decision) decision.policy.acceptance = options.common.failOnDegraded ? 'no-degraded' : 'best-effort'; warnings = parsed.warnings; cacheHit = parsed.reusedParse;
  }
  const assets = await Promise.all(ir.document.assets.map(async asset => {
    const file = path.join(artifactBase, asset.path);
    const stat = await fs.stat(file).catch(() => undefined);
    if (!stat?.isFile() || stat.size !== asset.bytes) throw DeckOpsError.input('An exported image is unavailable; no content was published.');
    return { path: file, bytes: asset.bytes, lifecycle: 'cache' as const };
  }));
  const base = output?.endsWith('.md') ? output.slice(0, -3) : output;
  // Immutable asset directory: a failed overwrite must not damage the previous Markdown's links.
  const assetsName = base ? `${path.basename(base)}.assets-${randomUUID().slice(0, 8)}` : undefined;
  const prefix = output ? `${assetsName}/` : `${path.join(artifactBase, 'assets')}/`;
  const rendered = renderMarkdown(ir, { anchors: options.anchors, assetPrefix: prefix });
  const hasSourceText = ir.document.nodes.some(n => (n.text ?? '').trim());
  if (format === 'markdown' && hasSourceText && !rendered.markdown.trim()) assessment.issues.push({ code: 'markdown_content_missing', severity: 'error', message: 'Markdown is empty although the IR contains text.', impact: 'delivery', evidenceKind: 'source_comparison' });
  if (assessment.issues.some(i => i.severity !== 'info' && i.impact !== 'informational')) assessment.status = 'needs_attention';
  finalQualityGate({ quality: ir.quality, assessment }, options.common.failOnDegraded);
  options.common.signal?.throwIfAborted();
  const report: ReadReport = { schemaVersion: 'deckops.run.v1', execution: 'completed', completeness: assessment.issues.some(i => ['missing_slide', 'page_parse_failed', 'source_page_count_mismatch', 'source_object_loss'].includes(i.code)) ? 'partial' : 'unknown',
    selected: { parseEngine: ir.producer.engine, renderer: 'local', cacheHit }, assessment, ...(decision ? { decision } : {}), artifactBase,
    warnings: [...new Set([...warnings, ...(format === 'markdown' ? rendered.warnings : [])])] };
  const outputs: OutputFile[] = [];
  if (output) {
    await fs.mkdir(path.dirname(output), { recursive: true });
    const assetDir = path.join(path.dirname(output), assetsName!);
    const temp = `${output}.${randomUUID()}.tmp`;
    try {
      if (assets.length) await fs.mkdir(assetDir, { recursive: false });
      for (const asset of assets) { const file = path.join(assetDir, path.basename(asset.path)); await fs.copyFile(asset.path, file); outputs.push({ file, bytes: asset.bytes }); }
      await fs.writeFile(temp, rendered.markdown, 'utf8');
      options.common.signal?.throwIfAborted();
      await fs.rename(temp, output); outputs.unshift({ file: output, bytes: Buffer.byteLength(rendered.markdown) });
    } catch (cause) {
      await fs.rm(temp, { force: true }); await fs.rm(assetDir, { recursive: true, force: true });
      throw DeckOpsError.input('Could not deliver Markdown and its assets.', { cause });
    }
  }
  if (reportFile) { await fs.mkdir(path.dirname(reportFile), { recursive: true }); const temp = `${reportFile}.${randomUUID()}.tmp`; try { await fs.writeFile(temp, JSON.stringify(report, null, 2) + '\n'); await fs.rename(temp, reportFile); } finally { await fs.rm(temp, { force: true }); } }
  return { schemaVersion: 'deckops.read.v1', ok: true, format, content: output ? null : format === 'ir' ? ir : rendered.markdown, outputs, assets: output ? assets.map(asset => ({ ...asset, path: path.join(path.dirname(output), assetsName!, path.basename(asset.path)), lifecycle: 'output' as const })) : assets, report };
}

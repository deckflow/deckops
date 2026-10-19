import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DeckOpsError } from '../errors/index.js';
import type { OutputFile } from '../types.js';
import { irPath, readManifest, viewDir } from './artifact.js';
import { runConvert } from './convert-op.js';
import { markdownLink, rewriteLinks } from './localize.js';
import { runParse, type ParseOpOptions } from './parse-op.js';
import { validateConvertFlags } from './validation.js';

export interface ReadReport {
  schemaVersion: 'deckops.run.v2'; parseTaskId: string; convertTaskId?: string; cacheHit: boolean; artifactBase: string; warnings: string[];
}
export interface ReadResult<F extends 'markdown' | 'ir' = 'markdown' | 'ir'> {
  schemaVersion: 'deckops.read.v2'; ok: true; format: F;
  content: (F extends 'ir' ? unknown : string) | null;
  outputs: OutputFile[];
  assets: Array<{ path: string; lifecycle: 'cache' | 'output'; bytes: number }>;
  report: ReadReport;
}
export interface ReadOpOptions extends Omit<ParseOpOptions, 'out'> {
  out?: string; format?: 'markdown' | 'ir'; reportFile?: string; anchors?: boolean; cacheDir?: string;
}

/** Default entry: parse into the cache (or reuse), convert, hand back the content. */
export async function runRead(options: ReadOpOptions): Promise<ReadResult> {
  const format = options.format ?? 'markdown';
  if (!['markdown', 'ir'].includes(format)) throw DeckOpsError.usage('format must be markdown or ir.');
  const output = options.out && options.out !== '-' ? path.resolve(options.out) : undefined;
  if (format === 'ir' && output) throw DeckOpsError.usage('Use deckops parse -o DIR to export portable IR.');
  if (options.reportFile === '-') throw DeckOpsError.usage('--report must be a file; stdout is reserved for content.');
  const reportFile = options.reportFile ? path.resolve(options.reportFile) : undefined;
  const sourceFile = options.input.kind === 'document' ? path.resolve(options.input.file) : undefined;
  const paths = [output, reportFile, sourceFile].filter((x): x is string => !!x);
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
    const canonical = async (p: string) => fs.realpath(p).catch(() => fs.realpath(path.dirname(p)).then(parent => path.join(parent, path.basename(p))).catch(() => p));
    if (await canonical(paths[i]!) === await canonical(paths[j]!)) throw DeckOpsError.usage('Source, output and report paths must be distinct.');
  }
  const convertFlags = options.anchors !== undefined ? { anchors: options.anchors } : {};
  validateConvertFlags(options.input, convertFlags);
  options.common.signal?.throwIfAborted();

  let artifactBase: string; let cacheHit: boolean; let warnings: string[];
  if (options.input.kind === 'artifact') {
    artifactBase = path.resolve(options.input.dir); cacheHit = true; warnings = [];
  } else {
    const root = options.cacheDir ?? process.env.DECKOPS_CACHE_DIR ?? path.join(os.homedir(), '.cache', 'deckops');
    // URL fetches and password-bearing parses are never persistently reused by identity alone.
    const key = createHash('sha256').update(JSON.stringify([options.input.kind === 'document' ? path.resolve(options.inputLabel) : options.inputLabel, { ...options.flags, password: undefined }])).digest('hex');
    const unique = options.input.kind !== 'document' || options.flags.password ? `-${randomUUID()}` : '';
    artifactBase = path.resolve(root, key + unique);
    const parsed = await runParse({ ...options, out: artifactBase });
    cacheHit = parsed.reusedParse; warnings = parsed.warnings;
  }
  let manifest = await readManifest(artifactBase);
  const report: ReadReport = { schemaVersion: 'deckops.run.v2', parseTaskId: manifest.parse.taskId, cacheHit, artifactBase, warnings };
  const outputs: OutputFile[] = [];
  let content: unknown = null;
  let assets: ReadResult['assets'] = [];
  if (format === 'ir') {
    content = JSON.parse(await fs.readFile(irPath(artifactBase), 'utf8'));
  } else {
    const converted = await runConvert({ input: { kind: 'artifact', dir: artifactBase, manifest }, inputLabel: artifactBase, flags: convertFlags, common: options.common, client: options.client });
    manifest = await readManifest(artifactBase);
    report.convertTaskId = converted.taskId ?? manifest.views.markdown?.taskId ?? '';
    report.warnings = [...new Set([...warnings, ...converted.warnings])];
    assets = Object.entries(manifest.assets).map(([relative, asset]) => ({ path: path.join(artifactBase, relative), lifecycle: 'cache' as const, bytes: asset.bytes }));
    const base = output?.endsWith('.md') ? output.slice(0, -3) : output;
    // Immutable asset directory: a failed overwrite must not damage the previous Markdown's links.
    const assetsName = base ? `${path.basename(base)}.assets-${randomUUID().slice(0, 8)}` : undefined;
    const prefix = output ? `${assetsName}/` : `${path.join(artifactBase, 'assets')}/`;
    const view = await fs.readFile(path.join(viewDir(artifactBase, 'markdown'), 'index.md'), 'utf8');
    const markdown = rewriteLinks(view, new Map(Object.keys(manifest.assets).map((relative) =>
      [markdownLink(`../../${relative}`), markdownLink(`${prefix}${path.basename(relative)}`)])));
    if (output) {
      await fs.mkdir(path.dirname(output), { recursive: true });
      const assetDir = path.join(path.dirname(output), assetsName!);
      const temp = `${output}.${randomUUID()}.tmp`;
      try {
        if (assets.length) await fs.mkdir(assetDir, { recursive: false });
        for (const asset of assets) { const file = path.join(assetDir, path.basename(asset.path)); await fs.copyFile(asset.path, file); outputs.push({ file, bytes: asset.bytes }); }
        await fs.writeFile(temp, markdown, 'utf8');
        options.common.signal?.throwIfAborted();
        await fs.rename(temp, output); outputs.unshift({ file: output, bytes: Buffer.byteLength(markdown) });
      } catch (cause) {
        await fs.rm(temp, { force: true }); await fs.rm(assetDir, { recursive: true, force: true });
        throw DeckOpsError.input('Could not deliver Markdown and its assets.', { cause });
      }
      assets = assets.map((asset) => ({ ...asset, path: path.join(assetDir, path.basename(asset.path)), lifecycle: 'output' as const }));
    } else {
      content = markdown;
    }
  }
  if (reportFile) {
    await fs.mkdir(path.dirname(reportFile), { recursive: true });
    const temp = `${reportFile}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temp, `${JSON.stringify(report, null, 2)}\n`); await fs.rename(temp, reportFile); } finally { await fs.rm(temp, { force: true }); }
  }
  return { schemaVersion: 'deckops.read.v2', ok: true, format, content: content as string | null, outputs, assets, report };
}

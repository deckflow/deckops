import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultArtifactDir, irPath, PROBE_FILE, probePath } from '../artifact/layout.js';
import { normalizeParseParams, parseHit, readManifest, writeManifest } from '../artifact/manifest.js';
import type { CloudClient } from '../cloud/client.js';
import { routeParse } from '../engine/router.js';
import { DeckOpsError } from '../errors/index.js';
import { candidateAssetOutputPath } from '../ir/assets.js';
import type { SourceIdentity } from '../local/common.js';
import { DEFAULT_LOCAL_LIMITS } from '../local/limits.js';
import {
  assessPreflight, DEFAULT_PREFLIGHT_MODE, PREFLIGHT_REQUEST_VERSION, preflightProbeOptions,
  type DeckProbeReport, type PreflightMode, type PreflightOutcome,
} from '../shared/preflight.js';
import { parseParams } from '../shared/params.js';
import { formatForTaskType } from '../shared/validation.js';
import type { CommonFlags, Manifest, ManifestInspection, ManifestV2, OutputFile, ParseEnvelope, ParseFlags } from '../types.js';
import { PDF_PARSER_VERSION, VERSION } from '../version.js';
import { createNodeDocumentInspector, type NodeDocumentInspector } from './inspector.js';
import type { ResolvedInput } from './input.js';

export interface ParseOpOptions {
  input: ResolvedInput; inputLabel: string; out?: string; flags: ParseFlags; common: CommonFlags;
  /** Backward-compatible injection for tests and callers; only touched on a cloud route. */
  client?: CloudClient;
  cloud?: () => Promise<CloudClient>;
  preflight?: PreflightMode; inspector?: NodeDocumentInspector;
}

export async function runParse(options: ParseOpOptions): Promise<ParseEnvelope> {
  const { input, inputLabel, flags, common } = options;
  const startedAt = Date.now();
  if (input.kind === 'artifact') throw DeckOpsError.usage(`${inputLabel} is already an artifact.`, { hint: 'Run `deckops convert <artifact>` to derive a view from it.' });
  const requestedEngine = common.engine ?? 'local';
  const source = await sourceIdentity(input, requestedEngine === 'cloud' ? undefined : (common.limits?.sourceBytes ?? DEFAULT_LOCAL_LIMITS.sourceBytes));
  const params = normalizeParseParams({ ...parseParams(flags, input.kind === 'link'),
    ...(flags.pageFurniture ? { pageFurniture: flags.pageFurniture } : {}),
    ...(flags.overlaidText ? { overlaidText: flags.overlaidText } : {}),
    ...(flags.trackedChanges ? { trackedChanges: flags.trackedChanges } : {}),
    ...(common.limits ? { limits: common.limits } : {}) });
  const dir = options.out ?? defaultDirFor(input);
  const existing = !common.force ? await readManifest(dir).catch(() => undefined) : undefined;
  const cacheEngine = requestedEngine === 'auto' && !common.allowUpload ? 'local' : requestedEngine;
  const parserEngine = cacheEngine === 'auto' && existing?.manifestVersion === 2 ? existing.parse.engine : cacheEngine;
  const cacheHit = existing?.manifestVersion === 2 && parseHit(dir, existing, input.kind === 'link' ? undefined : source.sha256, params, cacheEngine, expectedParser(input, parserEngine));
  const storedInspection = cacheHit && existing ? await readStoredInspection(dir, existing) : undefined;
  const inspected = await runPreflight({ input, flags, mode: options.preflight ?? DEFAULT_PREFLIGHT_MODE,
    ...(options.inspector ? { inspector: options.inspector } : {}), ...(storedInspection ? { stored: storedInspection } : {}) });

  if (cacheHit && existing?.manifestVersion === 2) {
    if (common.failOnDegraded && existing.quality.status === 'degraded') {
      throw DeckOpsError.input('Cached artifact quality is degraded.', existing.quality.checks[0]?.message ? { hint: existing.quality.checks[0].message } : {});
    }
    const outputs: OutputFile[] = [];
    if (inspected.fresh && inspected.outcome.report && inspected.outcome.summary) {
      outputs.push(await writeProbeReport(dir, inspected.outcome.report));
      existing.inspection = manifestInspection(inspected.outcome.report, inspected.outcome.summary);
      await writeManifest(dir, existing); outputs.push({ file: path.join(dir, 'manifest.json'), bytes: 0 });
    }
    const summary = inspected.outcome.summary ?? existing.inspection?.summary;
    return envelope(inputLabel, dir, existing, { reused: true, startedAt, outputs,
      warnings: [...inspected.outcome.warnings, ...existing.quality.checks.filter((check) => check.severity !== 'info').map((check) => check.message)],
      ...(summary ? { inspection: summary } : {}) });
  }

  const cloud = options.cloud ?? (options.client ? async () => options.client! : undefined);
  const candidate = await routeParse({
    input: { input, inputLabel, source }, parse: { flags, common },
    ...(cloud ? { cloud } : {}),
    signal: AbortSignal.timeout(operationTimeoutMs(common)),
  });
  if (candidate.quality.status === 'unsupported') throw DeckOpsError.unsupported('The selected engine could not produce a trustworthy document structure.');

  await fs.mkdir(dir, { recursive: true });
  const outputs: OutputFile[] = [];
  const written = new Set<string>();
  for (const asset of candidate.assets) {
    const relative = candidateAssetOutputPath(asset);
    if (written.has(relative)) continue;
    written.add(relative);
    const target = path.join(dir, relative); await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, asset.data); outputs.push({ file: target, bytes: asset.data.byteLength });
  }
  const irJson = `${JSON.stringify(candidate.ir, null, 2)}\n`;
  await fs.writeFile(irPath(dir), irJson, 'utf-8'); outputs.unshift({ file: irPath(dir), bytes: Buffer.byteLength(irJson) });
  if (inspected.outcome.report) outputs.push(await writeProbeReport(dir, inspected.outcome.report));
  const manifest = buildManifest(candidate.ir, params, candidate.remote, inspected.outcome);
  await writeManifest(dir, manifest); outputs.push({ file: path.join(dir, 'manifest.json'), bytes: 0 });
  return envelope(inputLabel, dir, manifest, { reused: false, startedAt, outputs, warnings: [...inspected.outcome.warnings, ...(candidate.warnings ?? [])],
    ...(inspected.outcome.summary ? { inspection: inspected.outcome.summary } : {}) });
}

export async function runSourcePreflight(options: { input: Exclude<ResolvedInput, { kind: 'artifact' }>; flags: ParseFlags; mode?: PreflightMode; inspector?: NodeDocumentInspector }): Promise<PreflightOutcome> {
  return (await runPreflight({ input: options.input, flags: options.flags, mode: options.mode ?? DEFAULT_PREFLIGHT_MODE,
    ...(options.inspector ? { inspector: options.inspector } : {}) })).outcome;
}

interface PreflightRun { outcome: PreflightOutcome; fresh: boolean }
async function runPreflight(options: { input: Exclude<ResolvedInput, { kind: 'artifact' }>; flags: ParseFlags; mode: PreflightMode; inspector?: NodeDocumentInspector; stored?: DeckProbeReport }): Promise<PreflightRun> {
  if (options.mode === 'off') return { outcome: { warnings: [] }, fresh: false };
  if (options.input.kind === 'link') return { outcome: { warnings: ['DeckProbe preflight is local-only and was skipped for the URL input.'] }, fresh: false };
  const format = formatForTaskType(options.input.taskType);
  if (!format || format === 'link') return { outcome: { warnings: [] }, fresh: false };
  const assess = (report: import('../shared/preflight.js').DeckProbeResult): PreflightOutcome => assessPreflight(report, {
    mode: options.mode as Exclude<PreflightMode, 'off'>, format, passwordProvided: Boolean(options.flags.password),
  });
  if (options.stored) return { outcome: assess(options.stored), fresh: false };
  const inspector = options.inspector ?? createNodeDocumentInspector();
  try {
    const result = await inspector.inspect(options.input, preflightProbeOptions(format));
    return { outcome: assess(result), fresh: result.status !== 'error' };
  } catch (error) {
    if (error instanceof DeckOpsError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (options.mode === 'strict') throw DeckOpsError.input(`DeckProbe preflight failed to run: ${message}`, { hint: 'Retry with preflight validate/off.', cause: error });
    return { outcome: { warnings: [`DeckProbe preflight failed to run: ${message}. Parsing will continue.`] }, fresh: false };
  }
}

async function sourceIdentity(input: Exclude<ResolvedInput, { kind: 'artifact' }>, maxBytes?: number): Promise<SourceIdentity> {
  if (input.kind === 'link') return { sha256: createHash('sha256').update(input.url).digest('hex'), name: input.url, bytes: 0 };
  if (input.kind === 'document') {
    const stat = await fs.stat(input.file);
    if (maxBytes !== undefined && stat.size > maxBytes) throw DeckOpsError.input('Source exceeds the local input size limit.');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(input.file)) hash.update(chunk as Buffer);
    return { sha256: hash.digest('hex'), name: input.name, bytes: stat.size };
  }
  if (maxBytes !== undefined && input.data.byteLength > maxBytes) throw DeckOpsError.input('Source exceeds the local input size limit.');
  return { sha256: createHash('sha256').update(input.data).digest('hex'), name: input.name, bytes: input.data.byteLength };
}

function buildManifest(ir: import('../ir/schema.js').DeckIR, params: Record<string, unknown>, remote: import('../ir/schema.js').ParseCandidate['remote'], inspected: PreflightOutcome): ManifestV2 {
  return {
    manifestVersion: 2, source: ir.source,
    parse: { engine: ir.producer.engine, format: ir.format, schemaVersion: 'deckir.v1', parser: { name: ir.producer.name, version: ir.producer.version },
      params, createdAt: new Date().toISOString(), remote: remote ?? null },
    ...(inspected.report && inspected.summary ? { inspection: manifestInspection(inspected.report, inspected.summary) } : {}),
    quality: ir.quality, views: {}, assets: Object.fromEntries(ir.document.assets.map((asset) => [asset.path, { key: asset.hash, hash: asset.hash, bytes: asset.bytes, ...(asset.mediaType ? { mediaType: asset.mediaType } : {}) }])),
    producer: { deckparse: VERSION },
  };
}

function defaultDirFor(input: Exclude<ResolvedInput, { kind: 'artifact' }>): string {
  if (input.kind === 'document') return defaultArtifactDir(input.file);
  if (input.kind === 'stdin') return 'stdin';
  const url = new URL(input.url); return `${url.hostname}${url.pathname}`.replace(/[^\w.-]+/g, '-').replace(/-+$/, '') || 'page';
}

function expectedParser(input: Exclude<ResolvedInput, { kind: 'artifact' }>, engine: NonNullable<CommonFlags['engine']>): { name: string; major: number; minor?: number } | undefined {
  if (engine === 'cloud') return { name: 'deckflow-cloud', major: 1 };
  if (engine === 'auto' || input.kind === 'link') return undefined;
  if (input.taskType === 'pdf.pdfParse') {
    const [major, minor] = PDF_PARSER_VERSION.split('.').map(Number);
    // Pre-1.0 minor releases can change parsing semantics (e.g. embedded image defaults).
    return { name: 'pdf-lite-parse', major: major!, ...(major === 0 ? { minor: minor! } : {}) };
  }
  if (input.taskType === 'pptx.parse') return { name: 'deckparse-pptx', major: 1 };
  if (input.taskType === 'docx.parseTextAndImage') return { name: 'deckparse-docx', major: 1 };
  return undefined;
}

function operationTimeoutMs(common: CommonFlags): number {
  const value = common.timeout !== undefined ? common.timeout * 1000 : common.engine === 'cloud' ? 120_000 : (common.limits?.timeoutMs ?? 120_000);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw DeckOpsError.usage('Timeout must be a positive duration within the Node.js timer range.');
  return value;
}

async function readStoredInspection(dir: string, manifest: Manifest): Promise<DeckProbeReport | undefined> {
  const inspection = manifest.inspection;
  if (!inspection || inspection.file !== PROBE_FILE || inspection.requestVersion !== PREFLIGHT_REQUEST_VERSION) return undefined;
  try { const parsed = JSON.parse(await fs.readFile(probePath(dir), 'utf-8')) as DeckProbeReport; return parsed.schema_version === 2 && (parsed.status === 'ok' || parsed.status === 'partial') ? parsed : undefined; } catch { return undefined; }
}

async function writeProbeReport(dir: string, report: DeckProbeReport): Promise<OutputFile> {
  const body = `${JSON.stringify(report, null, 2)}\n`; await fs.writeFile(probePath(dir), body, 'utf-8'); return { file: probePath(dir), bytes: Buffer.byteLength(body) };
}

function manifestInspection(report: DeckProbeReport, summary: import('../shared/preflight.js').PreflightSummary): ManifestInspection {
  return { file: PROBE_FILE, schemaVersion: 2, toolVersion: report.tool_version, requestVersion: PREFLIGHT_REQUEST_VERSION,
    status: report.status, summary, createdAt: new Date().toISOString() };
}

function envelope(input: string, dir: string, manifest: ManifestV2, extra: { reused: boolean; startedAt: number; outputs: OutputFile[]; warnings: string[]; inspection?: import('../shared/preflight.js').PreflightSummary }): ParseEnvelope {
  const type = manifest.parse.format === 'pdf' ? 'pdf.pdfParse' : manifest.parse.format === 'pptx' ? 'pptx.parse' : manifest.parse.format === 'docx' ? 'docx.parseTextAndImage' : manifest.parse.format === 'keynote' ? 'keynote.parseTextAndImage' : 'html.getByURL';
  return { ok: true, op: 'parse', input, engine: extra.reused ? 'artifact-cache' : manifest.parse.engine, type, format: manifest.parse.format,
    quality: manifest.quality, taskId: extra.reused ? null : (manifest.parse.remote?.taskId ?? null), reusedParse: extra.reused,
    ...(manifest.parse.remote ? { irKey: manifest.parse.remote.irKey } : {}), irSchemaVersion: 'deckir.v1', artifact: dir,
    ...(extra.inspection ? { inspection: extra.inspection } : {}), outputs: extra.outputs, warnings: extra.warnings, durationMs: Date.now() - extra.startedAt };
}

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { ParseResult, ParseSource } from '@deckops/sdk';
import { localizeImages } from '../assets/localize.js';
import { assetsDir, defaultArtifactDir, irPath, PROBE_FILE, probePath } from '../artifact/layout.js';
import { normalizeParseParams, parseHit, readManifest, writeManifest } from '../artifact/manifest.js';
import type { CloudClient } from '../cloud/client.js';
import { DeckParseError } from '../errors/index.js';
import {
  assessPreflight,
  DEFAULT_PREFLIGHT_MODE,
  PREFLIGHT_REQUEST_VERSION,
  preflightProbeOptions,
  type DeckProbeReport,
  type PreflightMode,
  type PreflightOutcome,
} from '../shared/preflight.js';
import { formatForTaskType } from '../shared/validation.js';
import type { CommonFlags, Manifest, ManifestInspection, OutputFile, ParseEnvelope, ParseFlags } from '../types.js';
import { parseParams } from '../shared/params.js';
import { VERSION } from '../version.js';
import { createNodeDocumentInspector, type NodeDocumentInspector } from './inspector.js';
import type { ResolvedInput } from './input.js';

/**
 * parse: document → IR artifact (docs/rfc.md §4.1).
 *
 * Crash-safe write order: ir.json, optional probe.json, assets, then manifest.json. Registered
 * in the manifest ⇒ present on disk. A manifest hit means zero cloud calls.
 */

export interface ParseOpOptions {
  input: ResolvedInput;
  /** Raw input string, echoed into the envelope. */
  inputLabel: string;
  out?: string;
  flags: ParseFlags;
  common: CommonFlags;
  client: CloudClient;
  preflight?: PreflightMode;
  inspector?: NodeDocumentInspector;
}

/** Parse-result images (pdf): assetPath + persistent identity + a signed URL. */
interface ParseResultImage {
  assetPath: string;
  key: string;
  bytes: number;
  hash: string;
  accessURL: string;
}

export async function runParse(options: ParseOpOptions): Promise<ParseEnvelope> {
  const { input, inputLabel, flags, common, client } = options;
  const startedAt = Date.now();

  if (input.kind === 'artifact') {
    throw DeckParseError.usage(`${inputLabel} is already an artifact.`, {
      hint: 'Run `deckparse convert <artifact>` to derive a view from it.',
    });
  }

  const params = parseParams(flags, input.kind === 'link');
  const sha256 = await sha256Of(input);
  const dir = options.out ?? defaultDirFor(input);
  const existing = !common.force ? await readManifest(dir).catch(() => undefined) : undefined;
  const cacheHit = existing !== undefined && parseHit(dir, existing, sha256, params);
  const storedInspection = cacheHit ? await readStoredInspection(dir, existing) : undefined;
  const inspected = await runPreflight({
    input,
    flags,
    mode: options.preflight ?? DEFAULT_PREFLIGHT_MODE,
    ...(options.inspector !== undefined ? { inspector: options.inspector } : {}),
    ...(storedInspection !== undefined ? { stored: storedInspection } : {}),
  });

  // Idempotence: same bytes, same request, IR on disk → reuse, zero cloud calls.
  if (cacheHit && existing) {
    const outputs: OutputFile[] = [];
    if (inspected.fresh && inspected.outcome.report && inspected.outcome.summary) {
      await fs.mkdir(dir, { recursive: true });
      outputs.push(await writeProbeReport(dir, inspected.outcome.report));
      existing.inspection = manifestInspection(inspected.outcome.report, inspected.outcome.summary);
      await writeManifest(dir, existing);
      outputs.push({ file: path.join(dir, 'manifest.json'), bytes: 0 });
    }
    const inspection = inspected.outcome.summary ?? existing.inspection?.summary;
    return envelope(inputLabel, dir, existing, {
      reused: true,
      startedAt,
      outputs,
      warnings: inspected.outcome.warnings,
      ...(inspection !== undefined ? { inspection } : {}),
    });
  }

  const parsed = await client.parse(sourceFor(input), {
    ...params,
    ...(common.spaceId ? { spaceId: common.spaceId } : {}),
    ...(common.timeout ? { wait: { timeout: common.timeout } } : {}),
  });

  await fs.mkdir(dir, { recursive: true });
  const outputs: OutputFile[] = [];

  const irJson = `${JSON.stringify(parsed.ir, null, 2)}\n`;
  await fs.writeFile(irPath(dir), irJson, 'utf-8');
  outputs.push({ file: path.join(dir, 'ir.json'), bytes: Buffer.byteLength(irJson) });

  // Only pdf parse results carry a unified image index; other formats get
  // their assets/ filled in at convert time (docs/rfc.md §4.1).
  const manifest = buildManifest(input, sha256, params, parsed, inspected.outcome);
  if (inspected.outcome.report) {
    outputs.push(await writeProbeReport(dir, inspected.outcome.report));
  }
  const images = pdfImagesOf(parsed.ir);
  if (images.length > 0) {
    const localized = await localizeImages({
      images: images.map((image) => ({
        ref: image.accessURL,
        key: image.key,
        suggestedPath: image.assetPath,
        bytes: image.bytes,
        hash: image.hash,
      })),
      destDir: assetsDir(dir),
      linkPrefix: 'assets/',
      // Parse-time asset capture is best-effort: the durable path is convert's
      // unified manifest. Failing the whole parse over one thumbnail would
      // punish the wrong operation.
      keepRemote: true,
    });
    for (const [file, asset] of Object.entries(localized.saved)) {
      manifest.assets[`assets/${file}`] = { key: asset.key, hash: asset.hash, bytes: asset.bytes };
      outputs.push({ file: path.join(dir, 'assets', file), bytes: asset.bytes });
    }
  }

  await writeManifest(dir, manifest);
  outputs.push({ file: path.join(dir, 'manifest.json'), bytes: 0 });

  return envelope(inputLabel, dir, manifest, {
    reused: false,
    startedAt,
    outputs,
    taskId: parsed.taskId,
    warnings: inspected.outcome.warnings,
    ...(inspected.outcome.summary !== undefined ? { inspection: inspected.outcome.summary } : {}),
  });
}

interface PreflightRun {
  outcome: PreflightOutcome;
  fresh: boolean;
}

export async function runSourcePreflight(options: {
  input: Exclude<ResolvedInput, { kind: 'artifact' }>;
  flags: ParseFlags;
  mode?: PreflightMode;
  inspector?: NodeDocumentInspector;
}): Promise<PreflightOutcome> {
  return (await runPreflight({
    input: options.input,
    flags: options.flags,
    mode: options.mode ?? DEFAULT_PREFLIGHT_MODE,
    ...(options.inspector !== undefined ? { inspector: options.inspector } : {}),
  })).outcome;
}

async function runPreflight(options: {
  input: Exclude<ResolvedInput, { kind: 'artifact' }>;
  flags: ParseFlags;
  mode: PreflightMode;
  inspector?: NodeDocumentInspector;
  stored?: DeckProbeReport;
}): Promise<PreflightRun> {
  if (options.mode === 'off') {
    return { outcome: { warnings: [] }, fresh: false };
  }
  if (options.input.kind === 'link') {
    return {
      outcome: { warnings: ['DeckProbe preflight is local-only and was skipped for the URL input.'] },
      fresh: false,
    };
  }
  const format = formatForTaskType(options.input.taskType);
  if (!format || format === 'link') {
    return { outcome: { warnings: [] }, fresh: false };
  }
  const assess = (report: import('../shared/preflight.js').DeckProbeResult): PreflightOutcome => assessPreflight(report, {
    mode: options.mode as Exclude<PreflightMode, 'off'>,
    format,
    passwordProvided: Boolean(options.flags.password),
  });
  if (options.stored) {
    return { outcome: assess(options.stored), fresh: false };
  }
  const inspector = options.inspector ?? createNodeDocumentInspector();
  try {
    const result = await inspector.inspect(options.input, preflightProbeOptions(format));
    return { outcome: assess(result), fresh: result.status !== 'error' };
  } catch (error) {
    if (error instanceof DeckParseError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (options.mode === 'strict') {
      throw DeckParseError.input(`DeckProbe preflight failed to run: ${message}`, {
        hint: 'Retry with preflight validate/off.',
        cause: error,
      });
    }
    return {
      outcome: { warnings: [`DeckProbe preflight failed to run: ${message}. Cloud parsing will continue.`] },
      fresh: false,
    };
  }
}

async function readStoredInspection(dir: string, manifest: Manifest): Promise<DeckProbeReport | undefined> {
  const inspection = manifest.inspection;
  if (!inspection || inspection.file !== PROBE_FILE || inspection.requestVersion !== PREFLIGHT_REQUEST_VERSION) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(await fs.readFile(probePath(dir), 'utf-8')) as DeckProbeReport;
    return parsed.schema_version === 2 && (parsed.status === 'ok' || parsed.status === 'partial') ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function writeProbeReport(dir: string, report: DeckProbeReport): Promise<OutputFile> {
  const body = `${JSON.stringify(report, null, 2)}\n`;
  await fs.writeFile(probePath(dir), body, 'utf-8');
  return { file: probePath(dir), bytes: Buffer.byteLength(body) };
}

async function sha256Of(input: ResolvedInput): Promise<string | undefined> {
  if (input.kind === 'document') {
    return createHash('sha256')
      .update(await fs.readFile(input.file))
      .digest('hex');
  }
  if (input.kind === 'stdin') {
    return createHash('sha256').update(input.data).digest('hex');
  }
  // Links have no stable content: never a cache hit.
  return undefined;
}

function defaultDirFor(input: ResolvedInput): string {
  if (input.kind === 'document') {
    return defaultArtifactDir(input.file);
  }
  if (input.kind === 'stdin') {
    return 'stdin';
  }
  if (input.kind === 'link') {
    const url = new URL(input.url);
    const slug = `${url.hostname}${url.pathname}`.replace(/[^\w.-]+/g, '-').replace(/-+$/, '');
    return slug || 'page';
  }
  throw DeckParseError.usage('Artifacts cannot be parsed again.');
}

function sourceFor(input: ResolvedInput): ParseSource {
  switch (input.kind) {
    case 'document':
      return input.file;
    case 'stdin':
      return { file: { input: input.data, name: input.name }, name: input.name };
    case 'link':
      return { url: input.url };
    default:
      throw DeckParseError.usage('Artifacts cannot be parsed again.');
  }
}

function buildManifest(
  input: Exclude<ResolvedInput, { kind: 'artifact' }>,
  sha256: string | undefined,
  params: Record<string, unknown>,
  parsed: ParseResult,
  inspected: PreflightOutcome
): Manifest {
  const name =
    input.kind === 'link' ? input.url : input.kind === 'document' ? path.basename(input.file) : input.name;
  const bytes = input.kind === 'stdin' ? input.data.length : undefined;
  return {
    manifestVersion: 1,
    source: { name, ...(sha256 ? { sha256 } : {}), ...(bytes !== undefined ? { bytes } : {}) },
    parse: {
      taskId: parsed.taskId,
      type: parsed.type,
      irKey: parsed.irKey,
      irSchemaVersion: parsed.irSchemaVersion,
      params: normalizeParseParams(params),
      createdAt: new Date().toISOString(),
    },
    ...(inspected.report && inspected.summary
      ? { inspection: manifestInspection(inspected.report, inspected.summary) }
      : {}),
    views: {},
    assets: {},
    producer: { deckparse: VERSION, sdk: sdkVersion() },
  };
}

function manifestInspection(report: DeckProbeReport, summary: import('../shared/preflight.js').PreflightSummary): ManifestInspection {
  return {
    file: PROBE_FILE,
    schemaVersion: 2,
    toolVersion: report.tool_version,
    requestVersion: PREFLIGHT_REQUEST_VERSION,
    status: report.status,
    summary,
    createdAt: new Date().toISOString(),
  };
}

function pdfImagesOf(ir: unknown): ParseResultImage[] {
  if (typeof ir !== 'object' || ir === null) {
    return [];
  }
  const images = (ir as { images?: unknown }).images;
  if (!Array.isArray(images)) {
    return [];
  }
  return images.filter(
    (image): image is ParseResultImage =>
      typeof image === 'object' &&
      image !== null &&
      typeof (image as ParseResultImage).assetPath === 'string' &&
      typeof (image as ParseResultImage).key === 'string' &&
      typeof (image as ParseResultImage).accessURL === 'string'
  );
}

function envelope(
  inputLabel: string,
  dir: string,
  manifest: Manifest,
  extra: {
    reused: boolean;
    startedAt: number;
    outputs: OutputFile[];
    taskId?: string;
    warnings?: string[];
    inspection?: import('../shared/preflight.js').PreflightSummary;
  }
): ParseEnvelope {
  return {
    ok: true,
    op: 'parse',
    input: inputLabel,
    engine: extra.reused ? 'local-cache' : 'cloud',
    type: manifest.parse.type,
    taskId: extra.reused ? null : (extra.taskId ?? manifest.parse.taskId),
    reusedParse: extra.reused,
    irKey: manifest.parse.irKey,
    irSchemaVersion: manifest.parse.irSchemaVersion,
    artifact: dir,
    ...(extra.inspection ? { inspection: extra.inspection } : {}),
    outputs: extra.outputs,
    warnings: extra.warnings ?? [],
    durationMs: Date.now() - extra.startedAt,
  };
}

function sdkVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    // entry: …/node_modules/@deckops/sdk/dist/index.js → package.json one level up.
    const entry = req.resolve('@deckops/sdk');
    const pkg = readFileSync(path.join(path.dirname(entry), '..', 'package.json'), 'utf-8');
    return (JSON.parse(pkg) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

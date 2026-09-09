import fs from 'node:fs/promises';
import { readManifest } from './artifact/manifest.js';
import { irPath, probePath } from './artifact/layout.js';
import type { CloudClient } from './cloud/client.js';
import type { CredentialOverrides } from './config/index.js';
import { runConvert } from './core/convert-op.js';
import { resolveInput } from './core/input.js';
import type { NodeDocumentInspector } from './core/inspector.js';
import { runRead, type ReadResult } from './core/read-op.js';
import { runParse } from './core/parse-op.js';
import { validateConvertFlags, validateParseFlags } from './core/validation.js';
import { DeckOpsError } from './errors/index.js';
import { validateDeckIR } from './ir/validate.js';
import type { DeckProbeReport, PreflightMode, PreflightSummary } from './shared/preflight.js';
import type { CommonFlags, ConvertEnvelope, ConvertFlags, Manifest, ParseEnvelope, ParseFlags } from './types.js';

export { DeckOpsError, ERROR_CODES, EXIT_CODES, type ErrorCode } from './errors/index.js';
export { resolveCredentials, writeSharedCredentials, type ResolvedCredentials } from './config/index.js';
export { DECK_IR_SCHEMA_VERSION, type DeckIR, type DeckIrNode, type QualityReport } from './ir/schema.js';
export { validateDeckIR } from './ir/validate.js';
export { renderMarkdown, MARKDOWN_RENDERER_VERSION } from './views/markdown.js';
export type {
  CommonFlags, ConvertEnvelope, ConvertFlags, EngineMode, Envelope, LocalLimits, Manifest, ManifestAsset,
  ManifestInspection, ManifestV1, ManifestV2, ManifestView, OutputFile, ParseEnvelope, ParseFlags, ParseTaskType,
  PreflightMode, PreflightSummary,
} from './types.js';
export type { DeckProbeReport } from './shared/preflight.js';
export { createNodeDocumentInspector, type NodeDocumentInspector } from './core/inspector.js';

export type { ReadResult, ReadReport } from './core/read-op.js';
export { CAPABILITIES, compilePolicy, evaluatePolicy } from './engine/policy.js';
export type { ExecutionPolicy, RouteDecision } from './engine/policy.js';
export type { Assessment, QualityIssue } from './quality/assessment.js';
export interface ReadInputOptions extends ParseInputOptions { format?: 'markdown' | 'ir'; reportFile?: string; cacheDir?: string; anchors?: boolean; splitPages?: boolean }

export interface ClientOptions extends CredentialOverrides { inspector?: NodeDocumentInspector }
export interface ParseInputOptions extends ParseFlags, CommonFlags { out?: string; from?: string; preflight?: PreflightMode }
export interface ConvertInputOptions extends ConvertFlags, CommonFlags, ParseFlags { out?: string; from?: string; preflight?: PreflightMode }

export class ParsedDocument {
  constructor(readonly dir: string, readonly manifest: Manifest, private readonly cloud: () => Promise<CloudClient>) {}

  async ir(): Promise<unknown> {
    const value = JSON.parse(await fs.readFile(irPath(this.dir), 'utf-8'));
    return this.manifest.manifestVersion === 2 ? validateDeckIR(value) : value;
  }

  get irKey(): string | undefined {
    return this.manifest.manifestVersion === 1 ? this.manifest.parse.irKey : this.manifest.parse.remote?.irKey;
  }

  get inspection(): PreflightSummary | undefined { return this.manifest.inspection?.summary; }

  async inspectionReport(): Promise<DeckProbeReport | undefined> {
    if (!this.manifest.inspection) return undefined;
    try { return JSON.parse(await fs.readFile(probePath(this.dir), 'utf-8')) as DeckProbeReport; }
    catch (cause) { throw DeckOpsError.input(`${this.dir} is missing its registered probe report.`, { hint: 'Re-run parse with preflight validate/strict.', cause }); }
  }

  async convert(options: ConvertInputOptions = {}): Promise<ConvertEnvelope> {
    const { out, from: _from, preflight, spaceId, timeout, force, engine, allowUpload, failOnDegraded, limits, cloudLimits, signal, policySource,
      profile, password, includeImages, pageFurniture, overlaidText, trackedChanges, stayImageAreaRate, mode, ...flags } = options;
    const input = { kind: 'artifact' as const, dir: this.dir, manifest: this.manifest };
    const parseFlags = compact<ParseFlags>({ profile, password, includeImages, pageFurniture, overlaidText, trackedChanges, stayImageAreaRate, mode });
    validateParseFlags(input, parseFlags); validateConvertFlags(input, flags); validateCommon({ timeout, engine, allowUpload });
    return runConvert({ input, inputLabel: this.dir,
      ...(out !== undefined ? { out } : {}), flags,
      common: compact<CommonFlags>({ spaceId, timeout, force, engine, allowUpload, failOnDegraded, limits, cloudLimits, signal, policySource }),
      ...(preflight !== undefined ? { preflight } : {}), cloud: this.cloud });
  }
}

export interface DeckOpsClient {
  read(input: string, options: ReadInputOptions & { format: 'ir' }): Promise<ReadResult<'ir'>>;
  read(input: string, options?: ReadInputOptions & { format?: 'markdown' }): Promise<ReadResult<'markdown'>>;
  parse(input: string, options?: ParseInputOptions): Promise<ParsedDocument>;
  openArtifact(dir: string): Promise<ParsedDocument>;
  convert(input: string, options?: ConvertInputOptions): Promise<ConvertEnvelope>;
  parseEnvelope(input: string, options?: ParseInputOptions): Promise<ParseEnvelope>;
}

export function createClient(options: ClientOptions = {}): DeckOpsClient {
  let cached: CloudClient | undefined;
  const cloud = async (): Promise<CloudClient> => {
    if (!cached) {
      const [{ createCloudClient }, { resolveCredentials }] = await Promise.all([import('./cloud/client.js'), import('./config/index.js')]);
      cached = createCloudClient(await resolveCredentials(options));
    }
    return cached;
  };
  const parseEnvelope = async (input: string, parseOptions: ParseInputOptions = {}): Promise<ParseEnvelope> => {
    const { out, from, preflight, spaceId, timeout, force, engine, allowUpload, failOnDegraded, limits, cloudLimits, signal, policySource, ...flags } = parseOptions;
    const resolved = await resolveInput(input, from !== undefined ? { from } : {});
    validateParseFlags(resolved, flags); validateCommon({ timeout, engine, allowUpload });
    return runParse({ input: resolved, inputLabel: input, ...(out !== undefined ? { out } : {}), flags,
      common: compact<CommonFlags>({ spaceId, timeout, force, engine, allowUpload, failOnDegraded, limits, cloudLimits, signal, policySource }),
      ...(preflight !== undefined ? { preflight } : {}), ...(options.inspector ? { inspector: options.inspector } : {}), cloud });
  };
  const read = async (input: string, readOptions: ReadInputOptions = {}): Promise<ReadResult> => {
    const { out, from, preflight, format, reportFile, cacheDir, anchors, splitPages, spaceId, timeout, force, engine, allowUpload, failOnDegraded, limits, cloudLimits, signal, policySource, ...flags } = readOptions;
    const resolved = await resolveInput(input, from !== undefined ? { from } : {});
    validateParseFlags(resolved, flags); validateCommon({ timeout, engine, allowUpload });
    return runRead({ input: resolved, inputLabel: input, flags,
      common: compact<CommonFlags>({ spaceId, timeout, force, engine, allowUpload, failOnDegraded, limits, cloudLimits, signal, policySource }),
      ...compact<Pick<import('./core/read-op.js').ReadOpOptions, 'out' | 'preflight' | 'format' | 'reportFile' | 'cacheDir' | 'anchors' | 'splitPages'>>({ out, preflight, format, reportFile, cacheDir, anchors, splitPages }), ...(options.inspector ? { inspector: options.inspector } : {}), cloud });
  };
  return {
    read: read as DeckOpsClient['read'],
    parseEnvelope,
    parse: async (input, parseOptions = {}) => { const envelope = await parseEnvelope(input, parseOptions); return new ParsedDocument(envelope.artifact, await readManifest(envelope.artifact), cloud); },
    openArtifact: async (dir) => new ParsedDocument(dir, await readManifest(dir), cloud),
    convert: async (input, convertOptions = {}) => {
      const { out, from, preflight, spaceId, timeout, force, engine, allowUpload, failOnDegraded, limits, cloudLimits, signal, policySource,
        profile, password, includeImages, pageFurniture, overlaidText, trackedChanges, stayImageAreaRate, mode, ...flags } = convertOptions;
      const resolved = await resolveInput(input, from !== undefined ? { from } : {});
      const parseFlags = compact<ParseFlags>({ profile, password, includeImages, pageFurniture, overlaidText, trackedChanges, stayImageAreaRate, mode });
      validateParseFlags(resolved, parseFlags); validateConvertFlags(resolved, flags); validateCommon({ timeout, engine, allowUpload });
      return runConvert({ input: resolved, inputLabel: input, ...(out !== undefined ? { out } : {}), flags, parseFlags,
        common: compact<CommonFlags>({ spaceId, timeout, force, engine, allowUpload, failOnDegraded, limits, cloudLimits, signal, policySource }),
        ...(preflight !== undefined ? { preflight } : {}), ...(options.inspector ? { inspector: options.inspector } : {}), cloud });
    },
  };
}

function compact<T extends object>(value: Record<string, unknown>): T { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T; }
function validateCommon(value: { timeout: CommonFlags['timeout']; engine: CommonFlags['engine']; allowUpload: CommonFlags['allowUpload'] }): void {
  if (value.engine !== undefined && !['local', 'cloud', 'auto'].includes(value.engine)) throw DeckOpsError.usage('engine must be local, cloud, or auto.');
  if (value.allowUpload && (value.engine === 'local' || value.engine === undefined)) throw DeckOpsError.usage('Explicit local mode conflicts with allowUpload.');
  if (value.allowUpload === false && value.engine === 'cloud') throw DeckOpsError.usage('Cloud mode conflicts with upload denial.');
  if (value.timeout !== undefined && (!Number.isFinite(value.timeout) || value.timeout <= 0)) throw DeckOpsError.usage('timeout must be a positive number of seconds.');
}

const defaultClient = createClient();
export async function parse(input: string, options?: ParseInputOptions): Promise<ParsedDocument> { return defaultClient.parse(input, options); }
export async function openArtifact(dir: string): Promise<ParsedDocument> { return defaultClient.openArtifact(dir); }
export async function convert(input: string, options?: ConvertInputOptions): Promise<ConvertEnvelope> { return defaultClient.convert(input, options); }

export function read(input: string, options: ReadInputOptions & { format: 'ir' }): Promise<ReadResult<'ir'>>;
export function read(input: string, options?: ReadInputOptions & { format?: 'markdown' }): Promise<ReadResult<'markdown'>>;
export function read(input: string, options?: ReadInputOptions): Promise<ReadResult> { return defaultClient.read(input, options as ReadInputOptions & { format: 'ir' }); }

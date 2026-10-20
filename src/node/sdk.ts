import fs from 'node:fs/promises';
import type { DeckClient } from '../client/legacy.js';
import type { CredentialOverrides } from '../config/index.js';
import { DeckOpsError } from '../errors/index.js';
import type { CommonFlags, ConvertEnvelope, ConvertFlags, Manifest, ParseEnvelope, ParseFlags } from '../types.js';
import { irPath, readManifest } from './artifact.js';
import { cloudClient } from './cloud.js';
import { runConvert } from './convert-op.js';
import { resolveInput } from './input.js';
import { runParse } from './parse-op.js';
import { runRead, type ReadResult } from './read-op.js';
import { validateConvertFlags, validateParseFlags } from './validation.js';

/** Node SDK: the cloud client plus filesystem artifacts and the shared credential chain. */

export type ClientOptions = CredentialOverrides;
export type ParseInputOptions = ParseFlags & CommonFlags & { out?: string; from?: string };
export type ConvertInputOptions = ConvertFlags & ParseFlags & CommonFlags & { out?: string; from?: string };
export type ReadInputOptions = ParseInputOptions & { format?: 'markdown' | 'ir'; reportFile?: string; cacheDir?: string; anchors?: boolean };
export type ArtifactConvertOptions = ConvertFlags & CommonFlags & { out?: string };

const PARSE_KEYS = ['profile', 'password', 'includeImages', 'stayImageAreaRate', 'mode'] as const;
const CONVERT_KEYS = ['to', 'anchors', 'splitPages', 'strict', 'keepRemoteImages'] as const;
const COMMON_KEYS = ['signal', 'spaceId', 'timeout', 'force'] as const;
const READ_KEYS = ['out', 'format', 'reportFile', 'cacheDir', 'anchors'] as const;

/** An artifact on disk: the server IR it stores and a convert() bound to it. */
export class ParsedDocument {
  constructor(readonly dir: string, readonly manifest: Manifest, private readonly client: () => Promise<DeckClient>) {}

  get taskId(): string { return this.manifest.parse.taskId; }
  get irKey(): string { return this.manifest.parse.irKey; }
  get irSchemaVersion(): string { return this.manifest.parse.irSchemaVersion; }
  get expiresAt(): string { return this.manifest.parse.expiresAt; }

  /** ir.json as the server returned it. */
  async ir(): Promise<unknown> {
    return JSON.parse(await fs.readFile(irPath(this.dir), 'utf-8'));
  }

  async convert(options: ArtifactConvertOptions = {}): Promise<ConvertEnvelope> {
    assertKnown(options, [...CONVERT_KEYS, ...COMMON_KEYS, 'out'], 'convert');
    const input = { kind: 'artifact' as const, dir: this.dir, manifest: this.manifest };
    const flags = pick<ConvertFlags>(options, CONVERT_KEYS);
    validateConvertFlags(input, flags);
    return runConvert({ input, inputLabel: this.dir, ...(options.out !== undefined ? { out: options.out } : {}), flags,
      common: pick<CommonFlags>(options, COMMON_KEYS), client: this.client });
  }
}

export interface DeckOpsClient {
  read(input: string, options: ReadInputOptions & { format: 'ir' }): Promise<ReadResult<'ir'>>;
  read(input: string, options?: ReadInputOptions & { format?: 'markdown' }): Promise<ReadResult<'markdown'>>;
  parse(input: string, options?: ParseInputOptions): Promise<ParsedDocument>;
  parseEnvelope(input: string, options?: ParseInputOptions): Promise<ParseEnvelope>;
  convert(input: string, options?: ConvertInputOptions): Promise<ConvertEnvelope>;
  openArtifact(dir: string): Promise<ParsedDocument>;
}

export function createClient(options: ClientOptions = {}): DeckOpsClient {
  assertKnown(options, ['apiKey', 'token', 'spaceId', 'apiBase'], 'client');
  let cached: DeckClient | undefined;
  const client = async (): Promise<DeckClient> => (cached ??= await cloudClient(options));

  const parseEnvelope = async (input: string, settings: ParseInputOptions = {}): Promise<ParseEnvelope> => {
    assertKnown(settings, [...PARSE_KEYS, ...COMMON_KEYS, 'out', 'from'], 'parse');
    const resolved = await resolveInput(input, settings.from !== undefined ? { from: settings.from } : {});
    const flags = pick<ParseFlags>(settings, PARSE_KEYS);
    validateParseFlags(resolved, flags);
    return runParse({ input: resolved, inputLabel: input, ...(settings.out !== undefined ? { out: settings.out } : {}), flags,
      common: pick<CommonFlags>(settings, COMMON_KEYS), client });
  };

  const read = async (input: string, settings: ReadInputOptions = {}): Promise<ReadResult> => {
    assertKnown(settings, [...PARSE_KEYS, ...COMMON_KEYS, ...READ_KEYS, 'from'], 'read');
    const resolved = await resolveInput(input, settings.from !== undefined ? { from: settings.from } : {});
    const flags = pick<ParseFlags>(settings, PARSE_KEYS);
    validateParseFlags(resolved, flags);
    return runRead({ input: resolved, inputLabel: input, flags, common: pick<CommonFlags>(settings, COMMON_KEYS), client,
      ...pick<Pick<ReadInputOptions, (typeof READ_KEYS)[number]>>(settings, READ_KEYS) });
  };

  return {
    read: read as DeckOpsClient['read'],
    parseEnvelope,
    parse: async (input, settings = {}) => {
      const envelope = await parseEnvelope(input, settings);
      return new ParsedDocument(envelope.artifact, await readManifest(envelope.artifact), client);
    },
    openArtifact: async (dir) => new ParsedDocument(dir, await readManifest(dir), client),
    convert: async (input, settings = {}) => {
      assertKnown(settings, [...CONVERT_KEYS, ...PARSE_KEYS, ...COMMON_KEYS, 'out', 'from'], 'convert');
      const resolved = await resolveInput(input, settings.from !== undefined ? { from: settings.from } : {});
      const parseFlags = pick<ParseFlags>(settings, PARSE_KEYS);
      const flags = pick<ConvertFlags>(settings, CONVERT_KEYS);
      validateParseFlags(resolved, parseFlags);
      validateConvertFlags(resolved, flags);
      return runConvert({ input: resolved, inputLabel: input, ...(settings.out !== undefined ? { out: settings.out } : {}), flags, parseFlags,
        common: pick<CommonFlags>(settings, COMMON_KEYS), client });
    },
  };
}

/** A removed or misspelled option must not be ignored: dropping `engine: 'local'` silently would upload. */
function assertKnown(options: object, allowed: readonly string[], label: string): void {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) throw DeckOpsError.usage(`${label} options must be an object.`);
  const unknown = Object.keys(options).filter((key) => !allowed.includes(key));
  if (unknown.length) throw DeckOpsError.usage(`Unknown ${label} option${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`);
}

function pick<T>(options: object, keys: readonly string[]): T {
  return Object.fromEntries(Object.entries(options).filter(([key, value]) => keys.includes(key) && value !== undefined)) as T;
}

const defaultClient = createClient();
export async function parse(input: string, options?: ParseInputOptions): Promise<ParsedDocument> { return defaultClient.parse(input, options); }
export async function openArtifact(dir: string): Promise<ParsedDocument> { return defaultClient.openArtifact(dir); }
export async function convert(input: string, options?: ConvertInputOptions): Promise<ConvertEnvelope> { return defaultClient.convert(input, options); }

export function read(input: string, options: ReadInputOptions & { format: 'ir' }): Promise<ReadResult<'ir'>>;
export function read(input: string, options?: ReadInputOptions & { format?: 'markdown' }): Promise<ReadResult<'markdown'>>;
export function read(input: string, options?: ReadInputOptions): Promise<ReadResult> { return defaultClient.read(input, options as ReadInputOptions & { format: 'ir' }); }

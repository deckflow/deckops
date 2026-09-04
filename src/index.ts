/**
 * Library surface (docs/pdf.md §6, docs/rfc.md §3.3). The core object is the
 * document handle: `parse()` returns it, every later operation hangs off it —
 * "parse once, operate repeatedly" made visible in the types. `extract` /
 * `modify` land on the same handle in future releases.
 */

import { runConvert } from './core/convert-op.js';
import { resolveInput } from './core/input.js';
import { runParse } from './core/parse-op.js';
import { createCloudClient, type CloudClient } from './cloud/client.js';
import { DeckParseError } from './errors/index.js';
import { resolveCredentials, type CredentialOverrides } from './config/index.js';
import { readManifest } from './artifact/manifest.js';
import { irPath, probePath } from './artifact/layout.js';
import type { CommonFlags, ConvertEnvelope, ConvertFlags, Manifest, ParseEnvelope, ParseFlags } from './types.js';
import type { DeckProbeReport, PreflightMode, PreflightSummary } from './shared/preflight.js';
import type { NodeDocumentInspector } from './core/inspector.js';
import fs from 'node:fs/promises';

export { DeckParseError, ERROR_CODES, EXIT_CODES, type ErrorCode } from './errors/index.js';
export { resolveCredentials, writeSharedCredentials, type ResolvedCredentials } from './config/index.js';
export type {
  CommonFlags,
  ConvertEnvelope,
  ConvertFlags,
  Envelope,
  Manifest,
  ManifestAsset,
  ManifestInspection,
  ManifestView,
  OutputFile,
  ParseEnvelope,
  ParseFlags,
  ParseTaskType,
  PreflightMode,
  PreflightSummary,
} from './types.js';
export type { DeckProbeReport } from './shared/preflight.js';
export { createNodeDocumentInspector, type NodeDocumentInspector } from './core/inspector.js';

export interface ClientOptions extends CredentialOverrides {
  inspector?: NodeDocumentInspector;
}

export interface ParseInputOptions extends ParseFlags, CommonFlags {
  /** Artifact directory. Defaults to a sibling directory named after the input. */
  out?: string;
  /** stdin/binary inputs: pick the parser by extension, e.g. "pdf". */
  from?: string;
  /** Local DeckProbe policy. Defaults to validate; use off to skip it. */
  preflight?: PreflightMode;
}

export interface ConvertInputOptions extends ConvertFlags, CommonFlags {
  out?: string;
  /** One-shot source conversion defaults to validate; use off to skip it. */
  preflight?: PreflightMode;
}

export class ParsedDocument {
  constructor(
    readonly dir: string,
    readonly manifest: Manifest,
    private readonly client: CloudClient
  ) {}

  /** Server response snapshot, verbatim. Read lazily — it can be large. */
  async ir(): Promise<unknown> {
    return JSON.parse(await fs.readFile(irPath(this.dir), 'utf-8'));
  }

  get irKey(): string {
    return this.manifest.parse.irKey;
  }

  get inspection(): PreflightSummary | undefined {
    return this.manifest.inspection?.summary;
  }

  /** Full local DeckProbe report, when parse ran with preflight enabled. */
  async inspectionReport(): Promise<DeckProbeReport | undefined> {
    if (!this.manifest.inspection) return undefined;
    try {
      return JSON.parse(await fs.readFile(probePath(this.dir), 'utf-8')) as DeckProbeReport;
    } catch (cause) {
      throw DeckParseError.input(`${this.dir} is missing its registered probe report.`, {
        hint: 'Re-run parse with preflight validate/strict.',
        cause,
      });
    }
  }

  async convert(options: ConvertInputOptions = {}): Promise<ConvertEnvelope> {
    const { out, spaceId, timeout, force, preflight, ...flags } = options;
    return runConvert({
      input: { kind: 'artifact', dir: this.dir, manifest: this.manifest },
      inputLabel: this.dir,
      ...(out !== undefined ? { out } : {}),
      flags,
      common: {
        ...(spaceId !== undefined ? { spaceId } : {}),
        ...(timeout !== undefined ? { timeout } : {}),
        ...(force !== undefined ? { force } : {}),
      },
      ...(preflight !== undefined ? { preflight } : {}),
      client: this.client,
    });
  }
}

export interface DeckParseClient {
  parse(input: string, options?: ParseInputOptions): Promise<ParsedDocument>;
  openArtifact(dir: string): Promise<ParsedDocument>;
  convert(input: string, options?: ConvertInputOptions): Promise<ConvertEnvelope>;
  /** The raw parse envelope, for callers that want the `--json` shape. */
  parseEnvelope(input: string, options?: ParseInputOptions): Promise<ParseEnvelope>;
}

export function createClient(options: ClientOptions = {}): DeckParseClient {
  let cached: CloudClient | undefined;
  const clientPromise = async (): Promise<CloudClient> => {
    if (!cached) {
      cached = createCloudClient(await resolveCredentials(options));
    }
    return cached;
  };

  const parseEnvelope = async (input: string, parseOptions: ParseInputOptions = {}): Promise<ParseEnvelope> => {
    const { out, from, spaceId, timeout, force, preflight, ...flags } = parseOptions;
    const resolved = await resolveInput(input, from !== undefined ? { from } : {});
    return runParse({
      input: resolved,
      inputLabel: input,
      ...(out !== undefined ? { out } : {}),
      flags,
      common: {
        ...(spaceId !== undefined ? { spaceId } : {}),
        ...(timeout !== undefined ? { timeout } : {}),
        ...(force !== undefined ? { force } : {}),
      },
      ...(preflight !== undefined ? { preflight } : {}),
      ...(options.inspector !== undefined ? { inspector: options.inspector } : {}),
      client: await clientPromise(),
    });
  };

  return {
    parseEnvelope,

    parse: async (input, parseOptions = {}) => {
      const envelope = await parseEnvelope(input, parseOptions);
      const manifest = await readManifest(envelope.artifact);
      return new ParsedDocument(envelope.artifact, manifest, await clientPromise());
    },

    openArtifact: async (dir) => {
      const manifest = await readManifest(dir);
      return new ParsedDocument(dir, manifest, await clientPromise());
    },

    convert: async (input, convertOptions = {}) => {
      const { out, spaceId, timeout, force, preflight, ...flags } = convertOptions;
      const resolved = await resolveInput(input);
      return runConvert({
        input: resolved,
        inputLabel: input,
        ...(out !== undefined ? { out } : {}),
        flags,
        common: {
          ...(spaceId !== undefined ? { spaceId } : {}),
          ...(timeout !== undefined ? { timeout } : {}),
          ...(force !== undefined ? { force } : {}),
        },
        ...(preflight !== undefined ? { preflight } : {}),
        ...(options.inspector !== undefined ? { inspector: options.inspector } : {}),
        client: await clientPromise(),
      });
    },
  };
}

/** Module-level conveniences over a default client. */
const defaultClient = createClient();

export async function parse(input: string, options?: ParseInputOptions): Promise<ParsedDocument> {
  return defaultClient.parse(input, options);
}

export async function openArtifact(dir: string): Promise<ParsedDocument> {
  return defaultClient.openArtifact(dir);
}

export async function convert(input: string, options?: ConvertInputOptions): Promise<ConvertEnvelope> {
  return defaultClient.convert(input, options);
}

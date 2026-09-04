/**
 * Public shapes: the artifact manifest, operation options and result envelopes.
 * The `--json` envelope and the manifest layout are public contracts
 * (docs/rfc.md §3.2, §5.3) — changing them is a breaking change.
 */

import type { ConvertImage, IrFormat } from '@deckops/sdk';
import type { PreflightMode, PreflightSummary } from './shared/preflight.js';

// ------------------------------------------------------------------ manifest

/** Task types the cloud routes documents to, mirrored from the SDK. */
export type ParseTaskType =
  | 'pdf.pdfParse'
  | 'pptx.parse'
  | 'docx.parseTextAndImage'
  | 'keynote.parseTextAndImage';

export interface ManifestView {
  taskId: string;
  params: Record<string, unknown>;
  /** Paths relative to the artifact root. Registered ⇒ the file exists. */
  files: string[];
  createdAt: string;
}

export interface ManifestAsset {
  key: string;
  hash: string;
  bytes: number;
}

export interface ManifestInspection {
  /** DeckProbe schema-v2 report, relative to the artifact root. */
  file: string;
  schemaVersion: 2;
  toolVersion: string;
  requestVersion: number;
  status: 'ok' | 'partial';
  summary: PreflightSummary;
  createdAt: string;
}

export interface Manifest {
  manifestVersion: 1;
  source: { sha256?: string; name: string; bytes?: number };
  parse: {
    taskId: string;
    type: ParseTaskType | 'html.getByURL';
    irKey: string;
    irSchemaVersion: string;
    /** Normalized parse params — defaults filled in, keys sorted. */
    params: Record<string, unknown>;
    createdAt: string;
  };
  inspection?: ManifestInspection;
  views: Partial<Record<string, ManifestView>>;
  /** Artifact-relative asset path → persistent identity. */
  assets: Record<string, ManifestAsset>;
  producer: { deckparse: string; sdk: string };
}

// ------------------------------------------------------------------- options

export interface ParseFlags {
  /** pdf */
  profile?: 'fast' | 'balanced' | 'quality';
  password?: string;
  includeImages?: boolean;
  /** keynote */
  stayImageAreaRate?: number;
  /** url */
  mode?: 'source' | 'runtime';
}

export interface ConvertFlags {
  to?: 'markdown';
  /** pdf: per-element provenance comments (`markdownMeta`). */
  anchors?: boolean;
  /** pptx / keynote: per-page markdown files. */
  splitPages?: boolean;
  strict?: boolean;
  /** Accept expiring remote image links instead of failing (docs/rfc.md §4.4). */
  keepRemoteImages?: boolean;
}

export interface CommonFlags {
  spaceId?: string;
  /** Task wait timeout in seconds. */
  timeout?: number;
  force?: boolean;
}

// ------------------------------------------------------------------ envelope

export interface OutputFile {
  file: string;
  bytes: number;
}

export interface ParseEnvelope {
  ok: true;
  op: 'parse';
  input: string;
  engine: 'cloud' | 'local-cache';
  type: ParseTaskType | 'html.getByURL';
  taskId: string | null;
  reusedParse: boolean;
  irKey: string;
  irSchemaVersion: string;
  artifact: string;
  inspection?: PreflightSummary;
  outputs: OutputFile[];
  warnings: string[];
  durationMs: number;
}

export interface ConvertEnvelope {
  ok: true;
  op: 'convert';
  input: string;
  to: 'markdown';
  engine: 'cloud' | 'local-cache';
  format: IrFormat;
  taskId: string | null;
  /** One-shot convenience path only: the implicit parse task. */
  parseTaskId?: string;
  /** One-shot source conversion only: local facts collected before upload. */
  inspection?: PreflightSummary;
  reusedParse: boolean;
  outputs: OutputFile[];
  warnings: string[];
  durationMs: number;
}

export interface ErrorEnvelope {
  ok: false;
  op: 'parse' | 'convert';
  error: { code: string; message: string; hint?: string; taskId?: string };
}

export type Envelope = ParseEnvelope | ConvertEnvelope | ErrorEnvelope;

export type { ConvertImage, IrFormat };
export type { PreflightMode, PreflightSummary };

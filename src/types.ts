/** Public artifact, option and machine-readable envelope contracts (3.0). */

import type { IrFormat } from './cloud/parse/types.js';
export type { ConvertImage, IrFormat } from './cloud/parse/types.js';

export type ParseTaskType = 'pdf.pdfParse' | 'pptx.parse' | 'docx.parseTextAndImage' | 'keynote.parseTextAndImage';
export type ParseType = ParseTaskType | 'html.getByURL';

export interface ManifestView {
  taskId: string;
  schemaVersion: string;
  params: Record<string, unknown>;
  files: string[];
  createdAt: string;
}

export interface ManifestAsset { key: string; hash: string; bytes: number; mediaType?: string }

export interface ManifestV3 {
  manifestVersion: 3;
  /** URL sources record sha256(url) and bytes 0. */
  source: { sha256: string; name: string; bytes: number };
  parse: {
    taskId: string; type: ParseType; irKey: string; irSchemaVersion: string;
    params: Record<string, unknown>; createdAt: string; expiresAt: string;
  };
  views: Partial<Record<'markdown', ManifestView>>;
  assets: Record<string, ManifestAsset>;
  producer: { deckops: string };
}

export type Manifest = ManifestV3;

export interface ParseFlags {
  profile?: 'fast' | 'balanced' | 'quality';
  password?: string;
  includeImages?: boolean;
  stayImageAreaRate?: number;
  mode?: 'source' | 'runtime';
}

export interface ConvertFlags {
  to?: 'markdown'; anchors?: boolean; splitPages?: boolean; strict?: boolean; keepRemoteImages?: boolean;
}

export interface CommonFlags {
  signal?: AbortSignal; spaceId?: string; timeout?: number; force?: boolean;
}

export interface OutputFile { file: string; bytes: number }

export interface ParseEnvelope {
  ok: true; op: 'parse'; input: string; type: ParseType; format: IrFormat;
  taskId: string; irKey: string; irSchemaVersion: string; expiresAt: string;
  reusedParse: boolean; artifact: string; outputs: OutputFile[]; warnings: string[]; durationMs: number;
}

export interface ConvertEnvelope {
  ok: true; op: 'convert'; input: string; to: 'markdown'; format: IrFormat;
  /** The convert task; null when a cached view was returned. */
  taskId: string | null; parseTaskId: string; reusedParse: boolean;
  /** Markdown, only for `-o -`. */
  content?: string;
  outputs: OutputFile[]; warnings: string[]; durationMs: number;
}

export interface ErrorEnvelope {
  ok: false; op: 'parse' | 'convert' | 'install' | 'read'; error: { code: string; message: string; hint?: string; taskId?: string };
}

export type Envelope = ParseEnvelope | ConvertEnvelope | ErrorEnvelope;

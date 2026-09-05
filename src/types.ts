/** Public artifact, option and machine-readable envelope contracts. */

import type { IrFormat } from './cloud/parse/types.js';
export type { ConvertImage } from './cloud/parse/types.js';
import type { DeckIR, DocumentFormat, QualityReport } from './ir/schema.js';
import type { LocalLimits } from './local/limits.js';
import type { PreflightMode, PreflightSummary } from './shared/preflight.js';

export type ParseTaskType = 'pdf.pdfParse' | 'pptx.parse' | 'docx.parseTextAndImage' | 'keynote.parseTextAndImage';
export type EngineMode = 'local' | 'cloud' | 'auto';
export type OutputEngine = 'local' | 'cloud' | 'artifact-cache';

export interface ManifestView {
  engine: 'local' | 'cloud';
  rendererVersion: string;
  taskId?: string;
  params: Record<string, unknown>;
  files: string[];
  createdAt: string;
}

export interface ManifestAsset { key: string; hash: string; bytes: number; mediaType?: string }

export interface ManifestInspection {
  file: string; schemaVersion: 2; toolVersion: string; requestVersion: number;
  status: 'ok' | 'partial'; summary: PreflightSummary; createdAt: string;
}

export interface ManifestV1View {
  taskId: string; params: Record<string, unknown>; files: string[]; createdAt: string;
}

export interface ManifestV1 {
  manifestVersion: 1;
  source: { sha256?: string; name: string; bytes?: number };
  parse: {
    taskId: string; type: ParseTaskType | 'html.getByURL'; irKey: string; irSchemaVersion: string;
    params: Record<string, unknown>; createdAt: string;
  };
  inspection?: ManifestInspection;
  views: Partial<Record<string, ManifestV1View>>;
  assets: Record<string, ManifestAsset>;
  producer: { deckparse: string; sdk: string };
}

export interface ManifestV2 {
  manifestVersion: 2;
  source: { sha256: string; name: string; bytes: number };
  parse: {
    engine: 'local' | 'cloud'; format: DocumentFormat; schemaVersion: 'deckir.v1';
    parser: { name: string; version: string }; params: Record<string, unknown>; createdAt: string;
    remote: { taskId: string; irKey: string; expiresAt?: string | undefined } | null;
  };
  inspection?: ManifestInspection;
  quality: QualityReport;
  views: Partial<Record<string, ManifestView>>;
  assets: Record<string, ManifestAsset>;
  producer: { deckparse: string; sdk?: string };
}

export type Manifest = ManifestV1 | ManifestV2;

export interface ParseFlags {
  profile?: 'fast' | 'balanced' | 'quality';
  password?: string;
  includeImages?: boolean;
  pageFurniture?: 'off' | 'drop' | 'extract';
  overlaidText?: 'auto' | 'keep' | 'drop';
  trackedChanges?: 'final' | 'original' | 'all';
  stayImageAreaRate?: number;
  mode?: 'source' | 'runtime';
}

export interface ConvertFlags {
  to?: 'markdown'; anchors?: boolean; splitPages?: boolean; strict?: boolean; keepRemoteImages?: boolean;
}

export interface CommonFlags {
  spaceId?: string; timeout?: number; force?: boolean;
  engine?: EngineMode; allowUpload?: boolean; failOnDegraded?: boolean;
  limits?: Partial<LocalLimits>;
}

export interface OutputFile { file: string; bytes: number }

export interface ParseEnvelope {
  ok: true; op: 'parse'; input: string; engine: OutputEngine; type: ParseTaskType | 'html.getByURL';
  format: DocumentFormat; quality: QualityReport; taskId: string | null; reusedParse: boolean;
  irKey?: string; irSchemaVersion: 'deckir.v1'; artifact: string; inspection?: PreflightSummary;
  outputs: OutputFile[]; warnings: string[]; durationMs: number;
}

export interface ConvertEnvelope {
  ok: true; op: 'convert'; input: string; to: 'markdown'; engine: OutputEngine; format: IrFormat;
  taskId: string | null; parseTaskId?: string; inspection?: PreflightSummary; reusedParse: boolean;
  quality?: QualityReport; outputs: OutputFile[]; warnings: string[]; durationMs: number;
}

export interface ErrorEnvelope {
  ok: false; op: 'parse' | 'convert'; error: { code: string; message: string; hint?: string; taskId?: string };
}

export type Envelope = ParseEnvelope | ConvertEnvelope | ErrorEnvelope;

export type { DeckIR, DocumentFormat, IrFormat, LocalLimits, PreflightMode, PreflightSummary, QualityReport };

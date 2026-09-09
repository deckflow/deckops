export const DECK_IR_SCHEMA_VERSION = 'deckir.v1' as const;

export type DocumentFormat = 'pdf' | 'pptx' | 'docx' | 'html' | 'keynote';
export type QualityStatus = 'pass' | 'degraded' | 'unsupported';

export interface SourceRef {
  part?: string | undefined;
  relationship?: string | undefined;
  path?: string | undefined;
  page?: number | undefined;
  objectIds?: string[] | undefined;
  [key: string]: unknown;
}

export interface DeckIrRun {
  text: string;
  bold?: boolean | undefined;
  italic?: boolean | undefined;
  underline?: boolean | undefined;
  strike?: boolean | undefined;
  code?: boolean | undefined;
  href?: string | undefined;
  style?: Record<string, unknown> | undefined;
}

export interface DeckIrNode {
  id: string;
  type: string;
  parentId: string | null;
  children: string[];
  order: number;
  text?: string | undefined;
  runs?: DeckIrRun[] | undefined;
  style?: Record<string, unknown> | undefined;
  links?: Array<{ href: string; text?: string | undefined }> | undefined;
  page?: number | undefined;
  bbox?: [number, number, number, number] | undefined;
  zIndex?: number | undefined;
  sourceRef: SourceRef;
  confidence?: number | undefined;
  issues?: string[] | undefined;
  extensions?: Record<string, unknown> | undefined;
  opaque?: { type: string; reason?: string | undefined; data?: Record<string, unknown> | undefined } | undefined;
}

export interface DeckIrPage {
  id: string;
  index: number;
  width?: number | undefined;
  height?: number | undefined;
  nodeIds: string[];
  sourceRef: SourceRef;
}

export interface DeckIrAsset {
  id: string;
  path: string;
  hash: string;
  bytes: number;
  mediaType?: string | undefined;
  sourceRef?: SourceRef | undefined;
}

export interface QualityCheck {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  pages?: number[] | undefined;
  nodeIds?: string[] | undefined;
  detail?: Record<string, unknown> | undefined;
}

export interface QualityReport {
  status: QualityStatus;
  checks: QualityCheck[];
  coverage: {
    pages?: { parsed: number; total: number } | undefined;
    objects?: { parsed: number; opaque: number; total?: number | undefined } | undefined;
    textCharacters?: number | undefined;
    [key: string]: unknown;
  };
  recommendation?: 'cloud' | undefined;
}

export interface DeckIR {
  schemaVersion: typeof DECK_IR_SCHEMA_VERSION;
  format: DocumentFormat;
  source: { sha256: string; name: string; bytes: number };
  producer: { engine: 'local' | 'cloud'; name: string; version: string };
  document: {
    metadata: Record<string, unknown>;
    pages: DeckIrPage[];
    nodes: DeckIrNode[];
    assets: DeckIrAsset[];
  };
  quality: QualityReport;
}

export interface CandidateAsset {
  /** Logical path used by nodes before artifact materialization. */
  path: string;
  data: Uint8Array;
  mediaType?: string | undefined;
  sourceRef?: SourceRef | undefined;
}

export interface ParseCandidate {
  assessment?: import('../shared/assessment-types.js').Assessment;
  decision?: import('../shared/policy-types.js').RouteDecision;
  ir: DeckIR;
  quality: QualityReport;
  assets: CandidateAsset[];
  remote?: { taskId: string; irKey: string; expiresAt?: string | undefined } | undefined;
  warnings?: string[] | undefined;
}

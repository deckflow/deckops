import { finalizeAssets } from '../ir/assets.js';
import { DECK_IR_SCHEMA_VERSION, type CandidateAsset, type DeckIR, type DeckIrNode, type DocumentFormat, type QualityCheck, type QualityReport } from '../ir/schema.js';

export interface SourceIdentity {
  sha256: string;
  name: string;
  bytes: number;
}

export function qualityOf(checks: QualityCheck[], coverage: QualityReport['coverage']): QualityReport {
  const status = checks.some((check) => check.severity === 'error' || check.severity === 'warning') ? 'degraded' : 'pass';
  return { status, checks, coverage, ...(status === 'degraded' ? { recommendation: 'cloud' as const } : {}) };
}

export function makeIr(options: {
  format: DocumentFormat;
  source: SourceIdentity;
  producer: { name: string; version: string; engine?: 'local' | 'cloud' };
  metadata?: Record<string, unknown>;
  pages?: DeckIR['document']['pages'];
  nodes: DeckIrNode[];
  assets?: CandidateAsset[];
  quality: QualityReport;
}): DeckIR {
  return {
    schemaVersion: DECK_IR_SCHEMA_VERSION,
    format: options.format,
    source: options.source,
    producer: { engine: options.producer.engine ?? 'local', name: options.producer.name, version: options.producer.version },
    document: {
      metadata: options.metadata ?? {},
      pages: options.pages ?? [],
      nodes: options.nodes,
      assets: finalizeAssets(options.assets ?? [], options.nodes),
    },
    quality: options.quality,
  };
}

export function mediaTypeForPath(file: string): string | undefined {
  const ext = file.toLowerCase().split('.').pop();
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml',
    webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff', bmp: 'image/bmp', emf: 'image/emf', wmf: 'image/wmf' } as Record<string, string>)[ext ?? ''];
}

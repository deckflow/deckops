import { finalizeAssets } from '../ir/assets.js';
import { DECK_IR_SCHEMA_VERSION, type CandidateAsset, type DeckIR, type DeckIrNode, type DocumentFormat, type QualityCheck, type QualityReport } from '../ir/schema.js';

export interface SourceIdentity {
  sha256: string;
  name: string;
  bytes: number;
}

export function qualityOf(checks: QualityCheck[], coverage: QualityReport['coverage']): QualityReport {
  const status = checks.some((check) => check.severity === 'error' || check.severity === 'warning') ? 'degraded' : 'pass';
  return { status, checks, coverage };
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

/**
 * OOXML 包里一张图片的资产路径与媒体类型。
 *
 * 扩展名认得就照扩展名；认不得就看文件头。实测一份讲义有两张 PNG 存成 `ppt/media/image92.tmp`，
 * 原先照原名落成 `.tmp` 资产，Markdown 里的链接没有查看器打得开。认出来后在逻辑路径上补一个
 * 真实扩展名（`image92.tmp.png`），落盘时的文件名随之而来；不改原名，免得与包里别的部件撞名。
 */
export function packageImageAsset(target: string, data: Uint8Array): { path: string; mediaType?: string } {
  const declared = mediaTypeForPath(target);
  if (declared) return { path: target, mediaType: declared };
  const sniffed = sniffImage(data);
  return sniffed ? { path: `${target}${sniffed.extension}`, mediaType: sniffed.mediaType } : { path: target };
}

/** 按文件头认图片类型；认不出返回 undefined。 */
export function sniffImage(data: Uint8Array): { mediaType: string; extension: string } | undefined {
  const starts = (...bytes: number[]): boolean => bytes.every((byte, index) => data[index] === byte);
  const ascii = (offset: number, text: string): boolean => [...text].every((character, index) => data[offset + index] === character.charCodeAt(0));
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { mediaType: 'image/png', extension: '.png' };
  if (starts(0xff, 0xd8, 0xff)) return { mediaType: 'image/jpeg', extension: '.jpg' };
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return { mediaType: 'image/gif', extension: '.gif' };
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return { mediaType: 'image/webp', extension: '.webp' };
  if (starts(0x49, 0x49, 0x2a, 0x00) || starts(0x4d, 0x4d, 0x00, 0x2a)) return { mediaType: 'image/tiff', extension: '.tiff' };
  if (ascii(0, 'BM') && data.byteLength >= 26) return { mediaType: 'image/bmp', extension: '.bmp' };
  if (starts(0x01, 0x00, 0x00, 0x00) && ascii(40, ' EMF')) return { mediaType: 'image/emf', extension: '.emf' };
  if (starts(0xd7, 0xcd, 0xc6, 0x9a) || starts(0x01, 0x00, 0x09, 0x00) || starts(0x02, 0x00, 0x09, 0x00)) return { mediaType: 'image/wmf', extension: '.wmf' };
  return undefined;
}

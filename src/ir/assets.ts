import path from 'node:path';
import { sha256 } from './ids.js';
import type { CandidateAsset, DeckIrAsset, DeckIrNode } from './schema.js';

export function finalizeAssets(assets: CandidateAsset[], nodes: DeckIrNode[]): DeckIrAsset[] {
  const rewrites = new Map<string, string>();
  const unique = new Map<string, DeckIrAsset>();
  for (const asset of assets) {
    const hash = sha256(asset.data);
    const ext = safeExtension(asset.path, asset.mediaType);
    const outputPath = `assets/${hash}${ext}`;
    rewrites.set(normalize(asset.path), outputPath);
    unique.set(outputPath, {
      id: `asset_${sha256(outputPath).slice(0, 20)}`,
      path: outputPath,
      hash,
      bytes: asset.data.byteLength,
      ...(asset.mediaType ? { mediaType: asset.mediaType } : {}),
      ...(asset.sourceRef ? { sourceRef: asset.sourceRef } : {}),
    });
  }
  for (const node of nodes) rewriteNodeAsset(node, rewrites);
  return [...unique.values()].sort((a, b) => a.path.localeCompare(b.path));
}
export function candidateAssetOutputPath(asset: CandidateAsset): string {
  const hash = sha256(asset.data);
  return `assets/${hash}${safeExtension(asset.path, asset.mediaType)}`;
}

function rewriteNodeAsset(node: DeckIrNode, rewrites: Map<string, string>): void {
  const extensions = node.extensions;
  if (!extensions) return;
  for (const key of ['assetPath', 'previewPath'] as const) {
    const value = extensions[key];
    if (typeof value === 'string') extensions[key] = rewrites.get(normalize(value)) ?? value;
  }
}

function normalize(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function safeExtension(name: string, mediaType?: string): string {
  const fromName = path.posix.extname(normalize(name)).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(fromName)) return fromName;
  const known: Record<string, string> = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/svg+xml': '.svg',
    'image/webp': '.webp', 'image/tiff': '.tiff', 'image/bmp': '.bmp',
  };
  return mediaType ? (known[mediaType] ?? '.bin') : '.bin';
}

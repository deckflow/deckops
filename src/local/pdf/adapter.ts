import type { ParseArtifacts, ParseOptions } from 'pdf-lite-parse';
import { result3ToDeckIr } from '../../ir/result3-adapter.js';
import type { ParseCandidate } from '../../ir/schema.js';
import { mediaTypeForPath, type SourceIdentity } from '../common.js';

export interface LocalPdfOptions {
  password?: string;
  pageFurniture?: 'off' | 'drop' | 'extract';
  overlaidText?: 'auto' | 'keep' | 'drop';
  includeImages?: boolean;
}

export async function parsePdf(input: string | Uint8Array, source: SourceIdentity, options: LocalPdfOptions = {}): Promise<ParseCandidate> {
  // Deliberately lazy: formats/help and OOXML paths do not load PDF.js.
  const { parseArtifacts } = await import('pdf-lite-parse');
  const upstreamOptions: ParseOptions = {
    ...(options.password !== undefined ? { password: options.password } : {}),
    ...(options.pageFurniture !== undefined ? { pageFurniture: options.pageFurniture } : {}),
    ...(options.overlaidText !== undefined ? { overlaidText: options.overlaidText } : {}),
  };
  const artifacts: ParseArtifacts = await parseArtifacts(input, upstreamOptions);
  const assets = [...artifacts.assets].map(([assetPath, data]) => ({ assetPath, data }));
  const candidate = result3ToDeckIr({
    document: artifacts.document,
    source,
    assets: assets.map(({ assetPath, data }) => ({ path: assetPath, data, ...(mediaTypeForPath(assetPath) ? { mediaType: mediaTypeForPath(assetPath) } : {}) })),
  });
  if (options.includeImages === false) {
    candidate.assets = [];
    candidate.ir.document.assets = [];
    for (const node of candidate.ir.document.nodes) {
      if (node.extensions && 'assetPath' in node.extensions) delete node.extensions.assetPath;
    }
  }
  return candidate;
}

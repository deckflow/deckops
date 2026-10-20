import { fetchSignedBlob } from '../cloud/download.js';
import { DeckOpsError } from '../errors/index.js';
import { translateError } from '../shared/errors.js';
import { extensionOf } from './plan.js';
import type { DocumentFormat, RemoteFile } from './types.js';

/**
 * Result normalization. Render tasks return file tuples `[url, bytes, md5, bounds?]` — a list for
 * multi-frame tasks, one tuple for single-file tasks. `document.*` tasks return the delivery
 * shape of RFC §5.6: signed URLs plus suggested paths, never a storage key.
 */

const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.json': 'application/json', '.md': 'text/markdown',
};

type Fields = Omit<RemoteFile, 'blob'>;

export function remoteFile(fields: Fields): RemoteFile {
  return {
    ...fields,
    async blob(options = {}) {
      try {
        return await fetchSignedBlob(fields.url, options.signal);
      } catch (error) {
        options.signal?.throwIfAborted();
        throw translateError(error);
      }
    },
  };
}

/** File tuples → files numbered by frame: `001.png`, `002.png`, … */
export function filesFromTuples(raw: unknown, type: string): RemoteFile[] {
  const tuples = isTuple(raw) ? [raw] : Array.isArray(raw) ? raw.filter(isTuple) : [];
  if (!tuples.length) throw DeckOpsError.backend(`${type} completed but returned no files.`);
  return tuples.map(([url, bytes, hash, bounds], index) => {
    const extension = extensionOf(pathname(url)) || '.bin';
    const page = index + 1;
    const size = typeof bounds === 'object' && bounds !== null ? bounds as { w?: unknown; h?: unknown } : {};
    return remoteFile({
      url,
      path: `${String(page).padStart(3, '0')}${extension}`,
      bytes: typeof bytes === 'number' ? bytes : 0,
      hash: typeof hash === 'string' ? hash : '',
      ...(MEDIA_TYPES[extension] ? { mediaType: MEDIA_TYPES[extension] } : {}),
      page,
      ...(typeof size.w === 'number' ? { width: size.w } : {}),
      ...(typeof size.h === 'number' ? { height: size.h } : {}),
    });
  });
}

/** The fields every `document.*` delivery shares. */
export interface DocumentDelivery {
  format: DocumentFormat;
  pages: number | null;
  reusedParse: boolean;
  assetsExpireAt?: string;
  warnings: string[];
}

export function documentDelivery(raw: unknown, type: string): DocumentDelivery & { body: Record<string, unknown> } {
  if (typeof raw !== 'object' || raw === null) throw DeckOpsError.backend(`${type} returned no result.`);
  const body = raw as Record<string, unknown>;
  return {
    body,
    format: body.format as DocumentFormat,
    pages: typeof body.pages === 'number' ? body.pages : null,
    reusedParse: body.reusedParse === true,
    ...(typeof body.assetsExpireAt === 'string' ? { assetsExpireAt: body.assetsExpireAt } : {}),
    warnings: Array.isArray(body.warnings) ? body.warnings.filter((item): item is string => typeof item === 'string') : [],
  };
}

/** `images[]` / `assets[]` of a document delivery. */
export function assetFiles(list: unknown): RemoteFile[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    const asset = item as Record<string, unknown> | null;
    if (typeof asset?.url !== 'string' || typeof asset.path !== 'string') return [];
    return [remoteFile({
      url: asset.url,
      path: asset.path,
      bytes: typeof asset.bytes === 'number' ? asset.bytes : 0,
      hash: typeof asset.hash === 'string' ? asset.hash : '',
      ...(typeof asset.mediaType === 'string' ? { mediaType: asset.mediaType } : {}),
    })];
  });
}

/** The delivered document file itself (`markdownURL` / `documentURL`) as an output. */
export function deliveredFile(body: Record<string, unknown>, urlField: string, path: string, type: string): RemoteFile {
  const url = body[urlField];
  if (typeof url !== 'string') throw DeckOpsError.backend(`${type} returned no ${urlField}.`);
  const extension = extensionOf(path);
  return remoteFile({
    url,
    path,
    bytes: typeof body.bytes === 'number' ? body.bytes : 0,
    hash: typeof body.hash === 'string' ? body.hash : '',
    ...(MEDIA_TYPES[extension] ? { mediaType: MEDIA_TYPES[extension] } : {}),
  });
}

/**
 * Point Markdown image links at the files they name. The server writes `images[].path` into the
 * Markdown; this swaps each such link target (and HTML `src`) for its URL, leaving the rest alone.
 */
export function rewriteImageRefs(markdown: string, images: readonly RemoteFile[]): string {
  if (!images.length) return markdown;
  const target = new Map(images.map((image) => [image.path, image.url]));
  const lookup = (ref: string): string | undefined => target.get(ref) ?? target.get(safeDecode(ref));
  return markdown
    .replace(/(\]\(\s*)(<)?([^)\s>]+)(>)?/g, (match, open: string, lt: string | undefined, ref: string, gt: string | undefined) => {
      const url = lookup(ref);
      return url === undefined ? match : `${open}${lt ?? ''}${url}${gt ?? ''}`;
    })
    .replace(/(\bsrc=)(["'])([^"']+)\2/g, (match, attr: string, quote: string, ref: string) => {
      const url = lookup(ref);
      return url === undefined ? match : `${attr}${quote}${url}${quote}`;
    });
}

function isTuple(value: unknown): value is [string, ...unknown[]] {
  return Array.isArray(value) && typeof value[0] === 'string';
}

function pathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

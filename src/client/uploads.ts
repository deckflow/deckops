import type { SourceBytes } from './input.js';

/**
 * fileIds this client already uploaded, by space: first by the caller's object (a `File` is never
 * uploaded twice), then by SHA-256 (the same bytes in another object are not either). The ids
 * stay in memory; the server's own reuse of a parse is keyed by the file hash.
 */
export class UploadCache {
  private readonly byObject = new WeakMap<object, Map<string, Promise<string>>>();
  private readonly byHash = new Map<string, Promise<string>>();

  /** The fileId for `source` in `spaceId`; `upload` runs only when nothing matches. */
  async fileId(spaceId: string, source: SourceBytes, upload: () => Promise<string>): Promise<{ id: string; reused: boolean }> {
    const objects = source.identity ? this.objectsFor(source.identity) : undefined;
    const known = objects?.get(spaceId);
    if (known) return { id: await known, reused: true };

    let reused = false;
    // The object is claimed before hashing, so concurrent calls with it share one upload.
    const pending = (async () => {
      const hashKey = await this.hashKey(spaceId, source);
      const shared = hashKey === undefined ? undefined : this.byHash.get(hashKey);
      if (shared) {
        reused = true;
        return await shared;
      }
      const uploading = upload();
      if (hashKey !== undefined) {
        this.byHash.set(hashKey, uploading);
        uploading.catch(() => { if (this.byHash.get(hashKey) === uploading) this.byHash.delete(hashKey); });
      }
      return await uploading;
    })();
    objects?.set(spaceId, pending);
    try {
      return { id: await pending, reused };
    } catch (error) {
      if (objects?.get(spaceId) === pending) objects.delete(spaceId);
      throw error;
    }
  }

  /** The server no longer knows the id (files expire): forget it so the next call uploads again. */
  async forget(spaceId: string, source: SourceBytes): Promise<void> {
    if (source.identity) this.byObject.get(source.identity)?.delete(spaceId);
    const hashKey = await this.hashKey(spaceId, source);
    if (hashKey !== undefined) this.byHash.delete(hashKey);
  }

  private async hashKey(spaceId: string, source: SourceBytes): Promise<string | undefined> {
    const hash = await sha256(source.data);
    return hash === undefined ? undefined : `${spaceId}\n${hash}`;
  }

  private objectsFor(identity: object): Map<string, Promise<string>> {
    let map = this.byObject.get(identity);
    if (!map) {
      map = new Map();
      this.byObject.set(identity, map);
    }
    return map;
  }
}

/** Hex SHA-256 via Web Crypto; undefined where it is unavailable (insecure browser contexts). */
async function sha256(data: Blob | Uint8Array | ArrayBuffer): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return undefined;
  const bytes = typeof Blob !== 'undefined' && data instanceof Blob ? await data.arrayBuffer() : data as Uint8Array | ArrayBuffer;
  const digest = await subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

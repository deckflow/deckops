import { throwIfAborted, withSignal } from '../cloud/abort.js';
import type { FileIdStore } from '../cloud/runtime.js';
import type { SourceBytes } from './input.js';

/**
 * fileIds this client already uploaded, by space: first by the caller's object (a `File` is never
 * uploaded twice), then by SHA-256 (the same bytes in another object are not either), then in the
 * runtime's persistent store when it has one. The server's own reuse of a parse is keyed by the
 * file hash; this only saves the upload.
 */
export class UploadCache {
  private readonly byObject = new WeakMap<object, Map<string, Promise<string>>>();
  private readonly byHash = new Map<string, Promise<string>>();

  /** `scope` (the API root) keeps ids of different environments apart in the persistent store. */
  constructor(private readonly store?: FileIdStore, private readonly scope = '') {}

  /**
   * The fileId for `source` in `spaceId`; `upload` runs only when nothing matches. `persist: false`
   * keeps a sensitive upload (a password-protected source) out of the persistent store. A call that
   * joins another call's upload ends only by its own `signal`: when that upload fails for any reason
   * (the other call was cancelled or timed out, say), this call uploads for itself.
   */
  async fileId(
    spaceId: string, source: SourceBytes, upload: () => Promise<string>, options: { persist?: boolean; signal?: AbortSignal } = {},
  ): Promise<{ id: string; reused: boolean }> {
    const { persist = true, signal } = options;
    const objects = source.identity ? this.objectsFor(source.identity) : undefined;
    for (let known = objects?.get(spaceId); known; known = objects!.get(spaceId)) {
      const id = await join(objects!, spaceId, known, signal);
      if (id !== undefined) return { id, reused: true };
    }

    let reused = false;
    // The object is claimed before hashing, so concurrent calls with it share one upload.
    const pending = (async () => {
      const hashKey = await this.hashKey(spaceId, source);
      for (let shared = hashKey === undefined ? undefined : this.byHash.get(hashKey); shared; shared = this.byHash.get(hashKey!)) {
        const id = await join(this.byHash, hashKey!, shared, signal);
        if (id !== undefined) {
          reused = true;
          return id;
        }
      }
      const stored = persist && hashKey !== undefined ? await this.stored(hashKey) : undefined;
      if (stored !== undefined) {
        reused = true;
        this.byHash.set(hashKey!, Promise.resolve(stored));
        return stored;
      }
      const uploading = upload().then(async (id) => {
        if (persist && hashKey !== undefined) await this.remember(hashKey, id);
        return id;
      });
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
    if (hashKey === undefined) return;
    this.byHash.delete(hashKey);
    await this.store?.delete(this.storeKey(hashKey)).catch(() => {});
  }

  // The persistent store is a convenience: when it cannot be read or written, upload as usual.
  private async stored(hashKey: string): Promise<string | undefined> {
    return await this.store?.get(this.storeKey(hashKey)).catch(() => undefined);
  }

  private async remember(hashKey: string, id: string): Promise<void> {
    await this.store?.set(this.storeKey(hashKey), id).catch(() => {});
  }

  private storeKey(hashKey: string): string {
    return `${this.scope}\n${hashKey}`;
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

/**
 * Wait for another call's upload, or until this call is cancelled. Undefined when that upload failed:
 * it is dropped so the caller uploads for itself instead of inheriting someone else's failure.
 */
async function join(
  map: Map<string, Promise<string>>, key: string, shared: Promise<string>, signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    return await withSignal(shared, signal);
  } catch {
    throwIfAborted(signal);
    if (map.get(key) === shared) map.delete(key);
    return undefined;
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

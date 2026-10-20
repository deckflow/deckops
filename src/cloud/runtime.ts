import type { CreateDeckOptions } from './contracts.js';

/** A persistent `key → fileId` map. Node keeps one under ~/.cache/deckops; browsers keep none. */
export interface FileIdStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, fileId: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Runtime hooks stay outside the shared HTTP, upload and task implementation. */
export interface DeckRuntime {
  resolveAuthUuid(options: CreateDeckOptions): Promise<string>;
  readFile?(path: string, signal?: AbortSignal): Promise<{ data: Uint8Array; name: string }>;
  useFetchStreams?: (boolean) | undefined;
  /** Remembers uploaded files across processes, so the same bytes are not uploaded twice. */
  fileIds?: (FileIdStore) | undefined;
}

import type { CreateDeckOptions } from './contracts.js';

/** Runtime hooks stay outside the shared HTTP, upload and task implementation. */
export interface DeckRuntime {
  resolveAuthUuid(options: CreateDeckOptions): Promise<string>;
  readFile?(path: string, signal?: AbortSignal): Promise<{ data: Uint8Array; name: string }>;
  useFetchStreams?: (boolean) | undefined;
}

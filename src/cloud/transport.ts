import { getCapabilities } from './capabilities.js';
import { FilesApi } from './files.js';
import { HttpClient } from './http-client.js';
import { TasksApi } from './tasks.js';
import type { CreateDeckOptions } from './contracts.js';
import type { DeckRuntime } from './runtime.js';

/** Private product transport: HTTP, uploads, the task protocol and the capabilities gate. */
export function createTransport(options: CreateDeckOptions, runtime: DeckRuntime) {
  const http = new HttpClient(options, runtime);
  const files = new FilesApi(http, runtime);
  const tasks = new TasksApi(http, files);
  return {
    files,
    tasks,
    root: http.root,
    capabilities: (signal?: AbortSignal) => getCapabilities(http, signal),
    resolveSpaceId: (spaceId?: string, signal?: AbortSignal) => http.resolveSpaceId(spaceId, signal),
    setToken: (token: string | undefined) => http.setToken(token),
    setApiKey: (key: string | undefined) => http.setApiKey(key),
    setSpaceId: (id: string | undefined) => http.setSpaceId(id),
    getAuthUuid: () => http.getAuthUuid(),
  };
}
export type TransportClient = ReturnType<typeof createTransport>;

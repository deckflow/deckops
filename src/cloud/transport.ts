import { FilesApi } from './files.js';
import { HttpClient } from './http-client.js';
import { TasksApi } from './tasks.js';
import { createParse } from './parse-facade.js';
import type { CreateDeckOptions, CreateTaskParams } from './contracts.js';
import type { DeckRuntime } from './runtime.js';

/** Private product transport. No general-purpose tool shortcuts or SDK exports. */
export function createTransport(options: CreateDeckOptions, runtime: DeckRuntime) {
  const http = new HttpClient(options, runtime);
  const files = new FilesApi(http, runtime);
  const tasks = new TasksApi(http, files);
  const parse = createParse({
    createTask: (params) => tasks.create(params as CreateTaskParams),
    waitTask: (id, options) => tasks.wait(id, options),
    downTask: (id, options) => tasks.down(id, options),
  });
  return {
    ...parse,
    files,
    tasks,
    root: http.root,
    setToken: (token: string | undefined) => http.setToken(token),
    setApiKey: (key: string | undefined) => http.setApiKey(key),
    setSpaceId: (id: string | undefined) => http.setSpaceId(id),
    getAuthUuid: () => http.getAuthUuid(),
  };
}
export type TransportClient = ReturnType<typeof createTransport>;

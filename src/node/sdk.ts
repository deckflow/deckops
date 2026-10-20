import type { ClientInput, OpsClient } from '../client/types.js';
import type { CredentialOverrides } from '../config/index.js';
import { DeckOpsError } from '../errors/index.js';
import { probeFile, type ProbeOptions, type ProbeReport } from '../ops/probe.js';
import { MAX_SOURCE_BYTES } from '../shared/constants.js';
import { cloudClient, type CloudClient } from './cloud.js';
import { statFile } from './source.js';

/**
 * The Node SDK: the isomorphic ops client with Node inputs (paths), the shared credential chain
 * and the persistent upload index, plus the local, free `probe`. It returns results with signed
 * URLs; writing files is the CLI's job.
 */

export type ClientOptions = CredentialOverrides;
export type NodeInput = ClientInput;

export interface ProbeCallOptions extends ProbeOptions {
  signal?: AbortSignal;
  /** Seconds for the engine. Defaults to 300. */
  timeout?: number;
}

export interface DeckOpsClient extends OpsClient<NodeInput> {
  /** Runs locally with DeckProbe: no credentials, no network, no quota. */
  probe(path: string, options?: ProbeCallOptions): Promise<ProbeReport>;
}

/** Credentials resolve on the first cloud call (flags → environment → ~/.deckflow/credentials). */
export function createClient(options: ClientOptions = {}): DeckOpsClient {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) throw DeckOpsError.usage('client options must be an object.');
  const unknown = Object.keys(options).filter((key) => !['apiKey', 'token', 'spaceId', 'apiBase'].includes(key));
  if (unknown.length) throw DeckOpsError.usage(`Unknown client option${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`);
  let pending: Promise<CloudClient> | undefined;
  const ops = (): Promise<CloudClient> => (pending ??= cloudClient(options).then(({ client }) => client));
  return {
    probe,
    render: async (input, settings) => (await ops()).render(input, settings),
    convert: async (input, settings) => (await ops()).convert(input, settings),
    extract: (async (input: NodeInput, settings: Parameters<OpsClient<NodeInput>['extract']>[1]) =>
      (await ops()).extract(input, settings)) as OpsClient<NodeInput>['extract'],
    tasks: {
      get: async (taskId, settings) => (await ops()).tasks.get(taskId, settings),
      wait: async (taskId, settings) => (await ops()).tasks.wait(taskId, settings),
      download: async (taskId, settings) => (await ops()).tasks.download(taskId, settings),
    },
    files: {
      upload: async (input, settings) => (await ops()).files.upload(input, settings),
    },
  };
}

/** Probe a local file. Free and offline: it never creates a cloud client. */
export async function probe(path: string, options: ProbeCallOptions = {}): Promise<ProbeReport> {
  const { signal, timeout, ...probeOptions } = options;
  if (timeout !== undefined && !(Number.isFinite(timeout) && timeout > 0)) throw DeckOpsError.usage('timeout must be a positive number of seconds.');
  await statFile(path);
  return await probeFile(path, probeOptions, {
    ...(signal ? { signal } : {}),
    deadlineMs: Math.ceil((timeout ?? 300) * 1000),
    maxInputBytes: MAX_SOURCE_BYTES,
  });
}

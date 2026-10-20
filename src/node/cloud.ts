import { createClientWith } from '../client/index.js';
import { nodeRuntime } from './runtime.js';
import { resolveCredentials, type CredentialOverrides, type ResolvedCredentials } from '../config/index.js';

export type CloudClient = ReturnType<typeof createClientWith>;

/** The isomorphic client bound to the Node runtime and the shared credential chain. */
export async function cloudClient(overrides: CredentialOverrides = {}): Promise<{ client: CloudClient; credentials: ResolvedCredentials }> {
  const credentials = await resolveCredentials(overrides);
  const client = createClientWith({
    apiBase: credentials.apiBase,
    ...(credentials.token ? { token: credentials.token } : {}),
    ...(credentials.apiKey ? { apiKey: credentials.apiKey } : {}),
    ...(credentials.spaceId ? { spaceId: credentials.spaceId } : {}),
  }, nodeRuntime, 'node');
  return { client, credentials };
}

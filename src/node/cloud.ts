import { createClientWith, type DeckClient } from '../client/legacy.js';
import { nodeRuntime } from './runtime.js';
import { resolveCredentials, type CredentialOverrides } from '../config/index.js';

/** The isomorphic client bound to the Node runtime and the shared credential chain. */
export async function cloudClient(overrides: CredentialOverrides = {}): Promise<DeckClient> {
  const credentials = await resolveCredentials(overrides);
  return createClientWith({
    apiBase: credentials.apiBase,
    ...(credentials.token ? { token: credentials.token } : {}),
    ...(credentials.apiKey ? { apiKey: credentials.apiKey } : {}),
    ...(credentials.spaceId ? { spaceId: credentials.spaceId } : {}),
  }, nodeRuntime, 'node');
}

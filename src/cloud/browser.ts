import { createTransport } from './transport.js';
import { resolveAuthUuid } from './browser-auth-uuid.js';
import type { CreateDeckOptions } from './contracts.js';
import type { DeckRuntime } from './runtime.js';

export const browserRuntime: DeckRuntime = { resolveAuthUuid, useFetchStreams: true };

/** Browser transport defaults: no guest downgrade, no replayed mutations. */
export function createBrowserTransport(options: CreateDeckOptions = {}) {
  return createTransport(
    { allowGuestFallback: false, retryMutations: false, ...options },
    browserRuntime,
  );
}

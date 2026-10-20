import { createTransport } from './transport.js';
import { withLegacyParse } from './legacy-transport.js';
import { resolveAuthUuid } from './browser-auth-uuid.js';
import type { CreateDeckOptions } from './contracts.js';
import type { DeckRuntime } from './runtime.js';

export const browserRuntime: DeckRuntime = { resolveAuthUuid, useFetchStreams: true };

/** Browser transport defaults; still carries the 3.0 parse facade its tests exercise. */
export function createBrowserTransport(options: CreateDeckOptions = {}) {
  return withLegacyParse(createTransport(
    { allowGuestFallback: false, retryMutations: false, ...options },
    browserRuntime,
  ));
}

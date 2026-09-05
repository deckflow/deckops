import { createTransport } from './transport.js';
import { resolveAuthUuid } from './browser-auth-uuid.js';
import type { CreateDeckOptions } from './contracts.js';

export function createBrowserTransport(options: CreateDeckOptions = {}) {
  return createTransport(
    { allowGuestFallback: false, retryMutations: false, ...options },
    { resolveAuthUuid, useFetchStreams: true },
  );
}

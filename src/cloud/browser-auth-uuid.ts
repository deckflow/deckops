import type { CreateDeckOptions } from './contracts.js';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let defaultResolving: Promise<string> | undefined;

export function isValidAuthUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4_RE.test(value);
}

export function generateAuthUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Browser/SSR-safe: no filesystem, environment variables, or import-time storage access. */
export async function resolveAuthUuid(options: CreateDeckOptions = {}): Promise<string> {
  if (isValidAuthUuid(options.authUuid)) return options.authUuid;
  if (options.authUuidStorage) {
    const stored = await options.authUuidStorage.get();
    if (isValidAuthUuid(stored)) return stored;
    const generated = generateAuthUuid();
    await options.authUuidStorage.set(generated);
    return generated;
  }
  defaultResolving ??= Promise.resolve().then(() => {
    try {
      const stored = globalThis.localStorage?.getItem('df_uuid');
      if (isValidAuthUuid(stored)) return stored;
    } catch { /* Storage can be denied or absent during SSR. */ }
    const generated = generateAuthUuid();
    try { globalThis.localStorage?.setItem('df_uuid', generated); } catch { /* Use memory. */ }
    return generated;
  });
  return defaultResolving;
}

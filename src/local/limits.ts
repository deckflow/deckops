export interface LocalLimits {
  sourceBytes: number;
  zipEntries: number;
  zipEntryBytes: number;
  zipExpandedBytes: number;
  zipCompressionRatio: number;
  xmlDepth: number;
  xmlAttributes: number;
  xmlTextBytes: number;
  xmlEvents: number;
  urlBytes: number;
  redirects: number;
  timeoutMs: number;
  workerHeapMb: number;
}
export const DEFAULT_LOCAL_LIMITS: LocalLimits = Object.freeze({
  sourceBytes: 256 * 1024 * 1024,
  zipEntries: 10_000,
  zipEntryBytes: 128 * 1024 * 1024,
  zipExpandedBytes: 512 * 1024 * 1024,
  zipCompressionRatio: 1_000,
  xmlDepth: 256,
  xmlAttributes: 256,
  xmlTextBytes: 32 * 1024 * 1024,
  xmlEvents: 5_000_000,
  urlBytes: 32 * 1024 * 1024,
  redirects: 5,
  timeoutMs: 120_000,
  workerHeapMb: 256,
});

export function resolveLimits(overrides: Partial<LocalLimits> = {}): LocalLimits {
  const limits = { ...DEFAULT_LOCAL_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0) throw new TypeError(`Local limit ${key} must be positive.`);
  }
  return limits;
}

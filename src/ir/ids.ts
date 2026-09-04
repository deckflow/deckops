import { createHash } from 'node:crypto';

/** Stable across repeated parses by the same parser major and normalized params. */
export function stableId(sourceSha256: string, locator: string, prefix = 'n'): string {
  const digest = createHash('sha256').update(sourceSha256).update('\0').update(locator).digest('hex').slice(0, 20);
  return `${prefix}_${digest}`;
}
export function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

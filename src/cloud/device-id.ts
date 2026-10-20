/**
 * X-Auth-UUID is a device id. The server hashes it into a guest id and stores it in a 100-character
 * column; it never parses it. So any 1–100 visible ASCII characters will do — a UUID, or the nanoid an
 * app keeps in localStorage `df_uuid` where crypto.randomUUID is missing — and an app's own id is reused,
 * never replaced. DeckOps itself generates UUID v4s.
 */
const DEVICE_ID = /^[\x21-\x7e]{1,100}$/;

export function isValidAuthUuid(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_ID.test(value);
}

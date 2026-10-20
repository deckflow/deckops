import { withSignal } from './abort.js';
import { APIError } from './errors.js';
import type { HttpClient } from './http-client.js';

/** `GET /tools/capabilities`: what this server can run. The SDK's version gate reads it. */
export interface Capabilities {
  server?: { name?: string; capabilitiesVersion?: number };
  /** Task type → the targets it accepts. */
  tasks: Record<string, { to: string[] }>;
  /** Days a parsed source stays reusable without a new charge. */
  parseRetentionDays?: number;
}

/** Servers older than DeckOps 4.0 have no capabilities route and no `document.*` tasks. */
export const LEGACY_CAPABILITIES: Capabilities = Object.freeze({ tasks: Object.freeze({}) }) as Capabilities;

/** Matches the server's Cache-Control max-age: a deploy is visible within five minutes. */
const CACHE_MS = 300_000;

/** Module-level: every client for the same API root shares one lookup. */
const cache = new Map<string, { at: number; value: Promise<Capabilities> }>();

export function getCapabilities(http: HttpClient, signal?: AbortSignal): Promise<Capabilities> {
  const hit = cache.get(http.root);
  if (hit && Date.now() - hit.at < CACHE_MS) return withSignal(hit.value, signal);
  const entry = { at: Date.now(), value: fetchCapabilities(http) };
  // A failed lookup is not an answer; the next call asks again.
  entry.value.catch(() => { if (cache.get(http.root) === entry) cache.delete(http.root); });
  cache.set(http.root, entry);
  return withSignal(entry.value, signal);
}

/** Whether the server lists `task`, and `to` among its targets when given. */
export function supportsTask(capabilities: Capabilities, task: string, to?: string): boolean {
  const entry = capabilities.tasks[task];
  return entry !== undefined && (to === undefined || entry.to.includes(to));
}

export function clearCapabilitiesCache(): void {
  cache.clear();
}

// The shared lookup is not tied to one caller's signal: cancelling one call must not fail the others.
async function fetchCapabilities(http: HttpClient): Promise<Capabilities> {
  try {
    const res = await http.get<unknown>('/tools/capabilities');
    return normalize(res.data);
  } catch (error) {
    if (error instanceof APIError && error.statusCode === 404) return LEGACY_CAPABILITIES;
    throw error;
  }
}

function normalize(body: unknown): Capabilities {
  const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
  const tasks: Capabilities['tasks'] = {};
  if (typeof record.tasks === 'object' && record.tasks !== null) {
    for (const [type, value] of Object.entries(record.tasks as Record<string, unknown>)) {
      const to = (value as { to?: unknown } | null)?.to;
      tasks[type] = { to: Array.isArray(to) ? to.filter((item): item is string => typeof item === 'string') : [] };
    }
  }
  return {
    ...(typeof record.server === 'object' && record.server !== null ? { server: record.server as Capabilities['server'] & object } : {}),
    tasks,
    ...(typeof record.parseRetentionDays === 'number' ? { parseRetentionDays: record.parseRetentionDays } : {}),
  };
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { DIR_MODE, SECRET_FILE_MODE, credentialsPath, deckflowDir } from './paths.js';

/**
 * Shared credential resolution. Behavior copied from deckrender's
 * config/credentials.ts (docs/rfc.md §6) with the env prefix swapped to
 * DECKOPS_* — a machine set up for any DeckFlow tool works here untouched.
 */
export interface SharedCredentials { apiKey?: string; token?: string; spaceId?: string; apiBase?: string; [key: string]: unknown }

export type CredentialSource =
  | 'flag'
  | `env:${string}`
  | 'file:~/.deckflow/credentials'
  | 'default';

export interface ResolvedCredentials {
  apiKey?: string;
  token?: string;
  spaceId?: string;
  apiBase: string;
  sources: {
    apiKey?: CredentialSource;
    token?: CredentialSource;
    spaceId?: CredentialSource;
    apiBase: CredentialSource;
  };
}

export interface CredentialOverrides {
  apiKey?: string;
  token?: string;
  spaceId?: string;
  apiBase?: string;
}

export const DEFAULT_API_BASE = 'https://app.deckflow.com/v1';

export const API_KEY_ENV_VARS = ['DECKOPS_API_KEY', 'DECKFLOW_API_KEY'] as const;
export const TOKEN_ENV_VARS = ['DECKOPS_TOKEN', 'DECKFLOW_TOKEN'] as const;
export const SPACE_ID_ENV_VARS = ['DECKOPS_SPACE_ID', 'DECKFLOW_SPACE_ID'] as const;
export const API_BASE_ENV_VARS = ['DECKOPS_API_BASE', 'DECKFLOW_API_BASE'] as const;

function firstEnv(names: readonly string[]): { value: string; source: CredentialSource } | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim()) {
      return { value: value.trim(), source: `env:${name}` };
    }
  }
  return undefined;
}

async function readJsonFile(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8'));
  } catch {
    return undefined;
  }
}

export async function readSharedCredentials(): Promise<SharedCredentials> {
  const raw = await readJsonFile(credentialsPath());
  if (raw === undefined) {
    return {};
  }
  return sanitizeCredentials(raw);
}

function sanitizeCredentials(raw: unknown): SharedCredentials {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const result: Record<string, unknown> = { ...record };
  for (const key of ['apiKey', 'token', 'spaceId'] as const) {
    if (typeof record[key] === 'string' && record[key].trim()) result[key] = record[key].trim();
    else delete result[key];
  }
  const apiBase = typeof record.apiBase === 'string' ? record.apiBase.trim() : '';
  if (apiBase && isHttpUrl(apiBase)) result.apiBase = apiBase; else delete result.apiBase;
  return result;
}

function isHttpUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:'; } catch { return false; }
}

/**
 * Resolve credentials through the credential chain:
 *
 *   flags → env → ~/.deckflow/credentials → defaults
 *
 * Each field resolves independently.
 */
export async function resolveCredentials(overrides: CredentialOverrides = {}): Promise<ResolvedCredentials> {
  const shared = await readSharedCredentials();

  const pick = (
    override: string | undefined,
    envNames: readonly string[],
    sharedValue: string | undefined
  ): { value: string | undefined; source: CredentialSource | undefined } => {
    if (override && override.trim()) {
      return { value: override.trim(), source: 'flag' };
    }
    const env = firstEnv(envNames);
    if (env) {
      return { value: env.value, source: env.source };
    }
    if (sharedValue) {
      return { value: sharedValue, source: 'file:~/.deckflow/credentials' };
    }
    return { value: undefined, source: undefined };
  };

  const apiKey = pick(overrides.apiKey, API_KEY_ENV_VARS, shared.apiKey);
  const token = pick(overrides.token, TOKEN_ENV_VARS, shared.token);
  const spaceId = pick(overrides.spaceId, SPACE_ID_ENV_VARS, shared.spaceId);
  const apiBase = pick(overrides.apiBase, API_BASE_ENV_VARS, shared.apiBase);

  return {
    ...(apiKey.value ? { apiKey: apiKey.value } : {}),
    ...(token.value ? { token: token.value } : {}),
    ...(spaceId.value ? { spaceId: spaceId.value } : {}),
    apiBase: apiBase.value ?? DEFAULT_API_BASE,
    sources: {
      ...(apiKey.source ? { apiKey: apiKey.source } : {}),
      ...(token.source ? { token: token.source } : {}),
      ...(spaceId.source ? { spaceId: spaceId.source } : {}),
      apiBase: apiBase.source ?? 'default',
    },
  };
}

export function hasCredentials(resolved: ResolvedCredentials): boolean {
  return Boolean(resolved.apiKey || resolved.token);
}

/**
 * Merge values into `~/.deckflow/credentials`. Read-merge-write so that keys
 * owned by other DeckFlow tools survive. `null` deletes a field.
 */
export async function writeSharedCredentials(
  patch: Partial<Record<keyof SharedCredentials, string | null>>
): Promise<string> {
  const current = await readSharedCredentials();
  const next: Record<string, unknown> = { ...current };

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[key];
    } else if (value !== undefined) {
      next[key] = value;
    }
  }

  const file = credentialsPath();
  await fs.mkdir(deckflowDir(), { recursive: true, mode: DIR_MODE });
  await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: SECRET_FILE_MODE,
  });
  // writeFile's mode only applies at creation; enforce it on pre-existing files.
  await fs.chmod(file, SECRET_FILE_MODE).catch(() => undefined);

  return file;
}

/** Mask a secret for display: keep enough to identify it, never enough to use it. */
export function maskSecret(value: string): string {
  if (value.length <= 8) {
    return '*'.repeat(value.length);
  }
  return `${value.slice(0, 4)}${'*'.repeat(Math.min(12, value.length - 8))}${value.slice(-4)}`;
}

export function displayPath(file: string): string {
  const home = process.env.HOME;
  return home && file.startsWith(home) ? `~${file.slice(home.length)}` : path.normalize(file);
}

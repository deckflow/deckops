import type { CreateDeckOptions } from './types.js';

export const AUTH_UUID_STORAGE_KEY = 'df_uuid';
export const AUTH_UUID_FILENAME = 'auth-uuid';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidAuthUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_V4_RE.test(value);
}

export function generateAuthUuid(): string {
  return globalThis.crypto.randomUUID();
}

function isNode(): boolean {
  return typeof process !== 'undefined' && process.versions != null && process.versions.node != null;
}

function isBrowserWithLocalStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

let memoryFallback: string | undefined;
let defaultResolving: Promise<string> | undefined;

function readBrowserStorage(): string | null {
  if (!isBrowserWithLocalStorage()) {
    return null;
  }
  try {
    const value = localStorage.getItem(AUTH_UUID_STORAGE_KEY);
    return isValidAuthUuid(value) ? value : null;
  } catch {
    return null;
  }
}

function writeBrowserStorage(value: string): void {
  if (!isBrowserWithLocalStorage()) {
    return;
  }
  try {
    localStorage.setItem(AUTH_UUID_STORAGE_KEY, value);
  } catch {
    // Storage may be unavailable in private browsing mode.
  }
}

async function getNodeConfigDir(): Promise<string> {
  const os = await import('node:os');
  const path = await import('node:path');
  return process.env.DECKOPS_CONFIG_DIR ?? path.join(os.homedir(), '.deckops');
}

async function readNodeFile(): Promise<string | null> {
  if (!isNode()) {
    return null;
  }
  try {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const configDir = await getNodeConfigDir();
    const filePath = path.join(configDir, AUTH_UUID_FILENAME);
    const content = (await fs.readFile(filePath, 'utf-8')).trim();
    return isValidAuthUuid(content) ? content : null;
  } catch {
    return null;
  }
}

async function writeNodeFile(value: string): Promise<void> {
  if (!isNode()) {
    return;
  }
  try {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const configDir = await getNodeConfigDir();
    const filePath = path.join(configDir, AUTH_UUID_FILENAME);
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(filePath, value, 'utf-8');
  } catch {
    // File system may be read-only.
  }
}

async function readFromDefaultStorage(): Promise<string | null> {
  if (isBrowserWithLocalStorage()) {
    return readBrowserStorage();
  }
  if (isNode()) {
    return await readNodeFile();
  }
  return null;
}

async function persistToDefaultStorage(value: string): Promise<void> {
  if (isBrowserWithLocalStorage()) {
    writeBrowserStorage(value);
    return;
  }
  if (isNode()) {
    await writeNodeFile(value);
  }
}

async function resolveWithCustomStorage(options: CreateDeckOptions): Promise<string> {
  const storage = options.authUuidStorage;
  if (!storage) {
    throw new Error('authUuidStorage is required');
  }

  const stored = await storage.get();
  if (isValidAuthUuid(stored)) {
    return stored;
  }

  const generated = generateAuthUuid();
  await storage.set(generated);
  return generated;
}

async function resolveWithDefaultStorage(): Promise<string> {
  const stored = await readFromDefaultStorage();
  if (stored) {
    return stored;
  }

  const generated = generateAuthUuid();
  await persistToDefaultStorage(generated);
  memoryFallback = memoryFallback ?? generated;
  return generated;
}

export async function resolveAuthUuid(options: CreateDeckOptions = {}): Promise<string> {
  if (isValidAuthUuid(options.authUuid)) {
    return options.authUuid;
  }

  if (isNode() && isValidAuthUuid(process.env.DECKOPS_AUTH_UUID)) {
    return process.env.DECKOPS_AUTH_UUID;
  }

  if (options.authUuidStorage) {
    return resolveWithCustomStorage(options);
  }

  if (!defaultResolving) {
    defaultResolving = resolveWithDefaultStorage();
  }
  return defaultResolving;
}

/** Resets module-level caches. For unit tests only. */
export function resetAuthUuidCacheForTests(): void {
  defaultResolving = undefined;
  memoryFallback = undefined;
}

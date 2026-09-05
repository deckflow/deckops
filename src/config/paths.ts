import os from 'node:os';
import path from 'node:path';

export const DECKFLOW_DIR_ENV = 'DECKFLOW_CONFIG_DIR';
export const DECKOPS_DIR_ENV = 'DECKOPS_CONFIG_DIR';

/** Shared credentials and identity; product overrides do not affect it. */
export function deckflowDir(): string {
  return process.env[DECKFLOW_DIR_ENV] || path.join(os.homedir(), '.deckflow');
}
export function deckopsDir(): string {
  return process.env[DECKOPS_DIR_ENV] || path.join(deckflowDir(), 'deckops');
}
export function credentialsPath(): string {
  return path.join(deckflowDir(), 'credentials');
}
export function configPath(): string {
  return path.join(deckopsDir(), 'config.json');
}
export const DIR_MODE = 0o700;
export const SECRET_FILE_MODE = 0o600;

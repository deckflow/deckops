import fs from 'node:fs';
import path from 'node:path';
import { DeckOpsError } from '../errors/index.js';
import { configPath, DIR_MODE, SECRET_FILE_MODE } from './paths.js';

export interface ProductConfig {
  timeout?: number;
}

/** Only understood, valid settings are read; anything else in the file is ignored. */
function sanitizeProductConfig(raw: Record<string, unknown>): ProductConfig {
  const out: ProductConfig = {};
  if (typeof raw.timeout === 'number' && Number.isSafeInteger(raw.timeout) && raw.timeout > 0) out.timeout = raw.timeout;
  return out;
}

/** Local preferences only. Reading defaults never resolves cloud credentials. */
export function readProductConfig(): ProductConfig {
  const file = configPath();
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected a JSON object');
    return sanitizeProductConfig(raw as Record<string, unknown>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw DeckOpsError.usage(`Cannot read product configuration: ${file}`, { cause: error });
  }
}

export function writeProductOption(key: string, value: string): string {
  if (key !== 'timeout') throw DeckOpsError.usage(`Unknown product option: ${key}`);
  const valid = sanitizeProductConfig({ timeout: Number(value) });
  if (!('timeout' in valid)) throw DeckOpsError.usage(`Invalid value for ${key}.`);
  const file = configPath();
  // Validate an existing file first instead of replacing malformed user configuration.
  readProductConfig();
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> : {};
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE });
  fs.writeFileSync(file, `${JSON.stringify({ ...existing, ...valid }, null, 2)}\n`, { mode: SECRET_FILE_MODE });
  fs.chmodSync(file, SECRET_FILE_MODE);
  return file;
}

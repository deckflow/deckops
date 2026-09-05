import fs from 'node:fs';
import path from 'node:path';
import { DeckOpsError } from '../errors/index.js';
import { configPath, DIR_MODE, SECRET_FILE_MODE } from './paths.js';

export interface ProductConfig {
  engine?: 'local' | 'auto' | 'cloud';
  allowUpload?: boolean;
  failOnDegraded?: boolean;
  timeout?: number;
  preflight?: 'off' | 'validate' | 'strict';
}

/** Only understood, valid settings cross the one-time migration boundary. */
export function sanitizeProductConfig(raw: Record<string, unknown>): ProductConfig {
  const out: ProductConfig = {};
  if (raw.engine === 'local' || raw.engine === 'auto' || raw.engine === 'cloud') out.engine = raw.engine;
  if (typeof raw.allowUpload === 'boolean') out.allowUpload = raw.allowUpload;
  if (typeof raw.failOnDegraded === 'boolean') out.failOnDegraded = raw.failOnDegraded;
  if (typeof raw.timeout === 'number' && Number.isSafeInteger(raw.timeout) && raw.timeout > 0) out.timeout = raw.timeout;
  if (raw.preflight === 'off' || raw.preflight === 'validate' || raw.preflight === 'strict') out.preflight = raw.preflight;
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
  const fields = { engine: 'engine', 'allow-upload': 'allowUpload', 'fail-on-degraded': 'failOnDegraded', timeout: 'timeout', preflight: 'preflight' } as const;
  const field = fields[key as keyof typeof fields];
  if (!field) throw DeckOpsError.usage(`Unknown product option: ${key}`);
  const parsed: unknown = field === 'timeout' ? Number(value)
    : field === 'allowUpload' || field === 'failOnDegraded' ? (value === 'true' ? true : value === 'false' ? false : undefined) : value;
  const valid = sanitizeProductConfig({ [field]: parsed });
  if (!(field in valid)) throw DeckOpsError.usage(`Invalid value for ${key}.`);
  const file = configPath();
  // Validate an existing file first instead of replacing malformed user configuration.
  readProductConfig();
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> : {};
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE });
  fs.writeFileSync(file, `${JSON.stringify({ ...existing, ...valid }, null, 2)}\n`, { mode: SECRET_FILE_MODE });
  fs.chmodSync(file, SECRET_FILE_MODE);
  return file;
}

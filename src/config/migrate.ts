import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { deckflowDir, deckopsDir, DIR_MODE, SECRET_FILE_MODE } from './paths.js';
import { sanitizeProductConfig } from './product.js';

export interface MigrationOptions {
  fromParse?: string;
  fromTools?: string;
  sharedDir?: string;
  opsDir?: string;
  toolsDir?: string;
  dryRun?: boolean;
}

async function readObject(file: string): Promise<Record<string, unknown>> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Expected a JSON object: ${file}`);
    return raw as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

/** Explicit administrative operation, never invoked by parse/convert or config loading. */
export async function migrateConfig(options: MigrationOptions = {}) {
  const shared = options.sharedDir ?? deckflowDir();
  const ops = options.opsDir ?? (options.sharedDir ? path.join(shared, 'deckops') : deckopsDir());
  const tools = options.toolsDir ?? process.env.DECKTOOLS_CONFIG_DIR ?? path.join(shared, 'decktools');
  const fromParse = options.fromParse ?? path.join(os.homedir(), '.deckparse');
  const fromTools = options.fromTools ?? path.join(os.homedir(), '.deckops');
  const parse = await readObject(path.join(fromParse, 'config.json'));
  const legacyTools = await readObject(path.join(fromTools, 'config.json'));
  const credentials: Record<string, unknown> = {};
  // Preserve shared target values first; legacy tools take precedence over legacy parse.
  for (const source of [legacyTools, parse]) {
    for (const key of ['apiKey', 'token', 'spaceId', 'apiBase']) {
      const value = source[key];
      if (credentials[key] !== undefined || typeof value !== 'string' || !value.trim()) continue;
      if (key === 'apiBase') {
        try { if (!['http:', 'https:'].includes(new URL(value).protocol)) continue; } catch { continue; }
      }
      credentials[key] = value.trim();
    }
  }
  const preferences: Record<string, unknown> = {};
  if (typeof legacyTools.webhook === 'string') preferences.webhook = legacyTools.webhook;
  if (typeof legacyTools.retentionHours === 'number' && Number.isFinite(legacyTools.retentionHours) && legacyTools.retentionHours > 0) preferences.retentionHours = legacyTools.retentionHours;

  const candidates: [string, Record<string, unknown>][] = [
    [path.join(shared, 'credentials'), credentials],
    [path.join(ops, 'config.json'), { ...sanitizeProductConfig(parse) }],
    [path.join(tools, 'config.json'), preferences],
  ];
  // Validate every target before writing any of them. Unknown target fields survive.
  const changes = await Promise.all(candidates.map(async ([file, incoming]) => {
    const current = await readObject(file);
    const missing = Object.fromEntries(Object.entries(incoming).filter(([key]) => !(key in current)));
    return { file, next: { ...current, ...missing }, fields: Object.keys(missing) };
  }));
  for (const change of changes) {
    if (!change.fields.length || options.dryRun) continue;
    await fs.mkdir(path.dirname(change.file), { recursive: true, mode: DIR_MODE });
    const temporary = `${change.file}.migration-${randomUUID()}`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(change.next, null, 2)}\n`, { flag: 'wx', mode: SECRET_FILE_MODE });
      await fs.rename(temporary, change.file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  // Return field names and paths, never secret values. UUID files are never touched.
  return { dryRun: options.dryRun ?? false, changes: changes.filter((item) => item.fields.length).map(({ file, fields }) => ({ file, fields })) };
}

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DeckOpsError } from '../errors/index.js';
import type { EngineMode, Manifest, ManifestV1, ManifestV1View, ManifestV2, ManifestView } from '../types.js';
import { irPath, manifestPath } from './layout.js';
import { validateDeckIR } from '../ir/validate.js';

export const IR_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export async function readManifest(dir: string): Promise<Manifest> {
  const file = manifestPath(dir);
  let parsed: unknown;
  try { parsed = JSON.parse(await fs.readFile(file, 'utf-8')); }
  catch (cause) {
    if (!existsSync(file)) throw DeckOpsError.input(`${dir} is not an artifact: no ${path.basename(file)}.`, { hint: 'Run `deckops parse <source>` to create one.', cause });
    throw DeckOpsError.input(`${file} is not valid JSON.`, { hint: 'The artifact is damaged. Re-run parse with --force.', cause });
  }
  if (!isRecord(parsed)) throw DeckOpsError.input(`${file} is not a deckops manifest.`);
  if (parsed.manifestVersion === 1) {
    const manifest = parsed as unknown as ManifestV1;
    if (!manifest.parse?.irKey || !manifest.parse.type) throw DeckOpsError.input(`${file} is not a valid manifest v1.`);
    return manifest;
  }
  if (parsed.manifestVersion === 2) {
    const manifest = parsed as unknown as ManifestV2;
    if (manifest.parse?.schemaVersion !== 'deckir.v1' || !manifest.source?.sha256 || !manifest.quality) throw DeckOpsError.input(`${file} is not a valid manifest v2.`);
    try {
      const ir = validateDeckIR(JSON.parse(await fs.readFile(irPath(dir), 'utf-8')));
      if (ir.source.sha256 !== manifest.source.sha256 || ir.source.bytes !== manifest.source.bytes || ir.source.name !== manifest.source.name) throw DeckOpsError.input(`${dir} has inconsistent source identities in manifest.json and ir.json.`);
      if (ir.format !== manifest.parse.format || ir.producer.engine !== manifest.parse.engine ||
          ir.producer.name !== manifest.parse.parser.name || ir.producer.version !== manifest.parse.parser.version) {
        throw DeckOpsError.input(`${dir} has inconsistent parser metadata in manifest.json and ir.json.`);
      }
      if (JSON.stringify(ir.quality) !== JSON.stringify(manifest.quality)) throw DeckOpsError.input(`${dir} has inconsistent quality reports in manifest.json and ir.json.`);
      const irAssets = new Map(ir.document.assets.map((asset) => [asset.path, asset]));
      for (const [relative, asset] of Object.entries(manifest.assets)) {
        const target = containedPath(dir, relative);
        if (!target) throw DeckOpsError.input(`${dir} registers an unsafe asset path.`);
        const stat = await fs.lstat(target);
        if (!stat.isFile() || stat.size !== asset.bytes) throw DeckOpsError.input(`${dir} has a missing or truncated registered asset: ${relative}.`);
        const hash = createHash('sha256').update(await fs.readFile(target)).digest('hex');
        if (hash !== asset.hash || irAssets.has(relative) && irAssets.get(relative)?.hash !== hash) throw DeckOpsError.input(`${dir} has a corrupted registered asset: ${relative}.`);
      }
      if ([...irAssets.keys()].some((relative) => !(relative in manifest.assets))) throw DeckOpsError.input(`${dir} has inconsistent asset indexes in manifest.json and ir.json.`);
      for (const view of Object.values(manifest.views)) {
        if (view?.files.some((relative) => !containedPath(dir, relative))) throw DeckOpsError.input(`${dir} registers an unsafe view path.`);
      }
    }
    catch (cause) { if (cause instanceof DeckOpsError) throw cause; throw DeckOpsError.input(`${dir} has a missing or invalid ir.json.`, { cause }); }
    return manifest;
  }
  throw DeckOpsError.input(`${file} is from an incompatible deckops version.`);
}

export async function writeManifest(dir: string, manifest: Manifest): Promise<void> {
  const file = manifestPath(dir); const tmp = `${file}.tmp`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  await fs.rename(tmp, file);
}

export function normalizeParseParams(params: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = { parseProfile: 'balanced', includeImages: true, ...params };
  if ('password' in clean) { clean.passwordProvided = typeof clean.password === 'string'; delete clean.password; }
  return sortKeys(clean);
}

export function sameParams(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(normalizeParseParams(a)) === JSON.stringify(normalizeParseParams(b));
}

export function parseHit(dir: string, manifest: Manifest, sha256: string | undefined, params: Record<string, unknown>, engine?: EngineMode, parser?: { name: string; major: number; minor?: number }): boolean {
  if (!sha256 || manifest.source.sha256 !== sha256 || !existsSync(irPath(dir))) return false;
  if (!sameParams(manifest.parse.params, params)) return false;
  if (manifest.manifestVersion === 1) return engine === undefined || engine === 'cloud';
  if (parser && (manifest.parse.parser.name !== parser.name || majorOf(manifest.parse.parser.version) !== parser.major)) return false;
  if (parser?.minor !== undefined && Number(manifest.parse.parser.version.split('.')[1]) !== parser.minor) return false;
  if (engine === 'local' && manifest.parse.engine !== 'local') return false;
  if (engine === 'cloud' && manifest.parse.engine !== 'cloud') return false;
  return true;
}

export function viewHit(dir: string, view: ManifestView | ManifestV1View | undefined, params: Record<string, unknown>): boolean {
  if (!view || JSON.stringify(sortKeys(view.params)) !== JSON.stringify(sortKeys(params))) return false;
  return view.files.length > 0 && view.files.every((file) => { const target = containedPath(dir, file); return Boolean(target && existsSync(target)); });
}

export function locallyExpired(manifest: Manifest, now: number = Date.now()): boolean {
  if (manifest.manifestVersion === 2 && !manifest.parse.remote) return false;
  const expiresAt = manifest.manifestVersion === 2 ? manifest.parse.remote?.expiresAt : undefined;
  if (expiresAt) { const expires = Date.parse(expiresAt); return Number.isFinite(expires) && now > expires; }
  const createdAt = Date.parse(manifest.parse.createdAt);
  return Number.isFinite(createdAt) && now - createdAt > IR_RETENTION_MS;
}

function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)]));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) return sortKeys(value);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function majorOf(version: string): number { const value = Number.parseInt(version.match(/\d+/)?.[0] ?? '', 10); return Number.isFinite(value) ? value : -1; }
function containedPath(dir: string, relative: string): string | undefined {
  if (!relative || path.isAbsolute(relative)) return undefined;
  const root = path.resolve(dir); const target = path.resolve(root, relative);
  return target.startsWith(`${root}${path.sep}`) ? target : undefined;
}

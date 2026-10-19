import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DeckOpsError } from '../errors/index.js';
import type { Manifest, ManifestView } from '../types.js';

/**
 * Artifact layout (public contract):
 *
 *   <artifact>/
 *   ├── ir.json          server parse response, verbatim
 *   ├── manifest.json    written last — registered ⇒ exists
 *   ├── submission.json  only while a cloud task has no result yet
 *   ├── assets/          images downloaded by convert, named by persistent key
 *   └── views/markdown/  index.md (+ 001.md… with --split-pages); written only by convert
 */
export const IR_FILE = 'ir.json';
export const MANIFEST_FILE = 'manifest.json';
export const SUBMISSION_FILE = 'submission.json';
export const ASSETS_DIR = 'assets';
export const VIEWS_DIR = 'views';
export const IR_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const irPath = (dir: string): string => path.join(dir, IR_FILE);
export const manifestPath = (dir: string): string => path.join(dir, MANIFEST_FILE);
export const submissionPath = (dir: string): string => path.join(dir, SUBMISSION_FILE);
export const assetsDir = (dir: string): string => path.join(dir, ASSETS_DIR);
export const viewDir = (dir: string, to: string): string => path.join(dir, VIEWS_DIR, to);

/** Default artifact directory for a source document: sibling dir named after it. */
export function defaultArtifactDir(sourcePath: string): string {
  const base = path.basename(sourcePath, path.extname(sourcePath));
  return path.join(path.dirname(sourcePath), base);
}

export async function readManifest(dir: string): Promise<Manifest> {
  const file = manifestPath(dir);
  let parsed: unknown;
  try { parsed = JSON.parse(await fs.readFile(file, 'utf-8')); }
  catch (cause) {
    if (!existsSync(file)) throw DeckOpsError.input(`${dir} is not an artifact: no ${MANIFEST_FILE}.`, { hint: 'Run `deckops parse <source>` to create one.', cause });
    throw DeckOpsError.input(`${file} is not valid JSON.`, { hint: 'The artifact is damaged. Re-run parse with --force.', cause });
  }
  if (!isRecord(parsed)) throw DeckOpsError.input(`${file} is not a deckops manifest.`);
  if (parsed.manifestVersion === 1 || parsed.manifestVersion === 2) {
    throw DeckOpsError.input(`${dir} was created by DeckOps 2.x with a local engine and cannot be read by 3.x.`, {
      hint: 'Run `deckops parse <source> --force` to create a cloud artifact.',
    });
  }
  if (parsed.manifestVersion !== 3) throw DeckOpsError.input(`${file} is from an incompatible deckops version.`);
  const manifest = parsed as unknown as Manifest;
  if (!isRecord(manifest.parse) || !manifest.parse.irKey || !manifest.parse.type || !isRecord(manifest.source) || !manifest.source.sha256 ||
      !isRecord(manifest.views) || !isRecord(manifest.assets)) {
    throw DeckOpsError.input(`${file} is not a valid manifest v3.`);
  }
  for (const relative of [...Object.keys(manifest.assets), ...Object.values(manifest.views).flatMap((view) => view?.files ?? [])]) {
    if (!containedPath(dir, relative)) throw DeckOpsError.input(`${dir} registers an unsafe path: ${relative}.`);
  }
  return manifest;
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

/** Same bytes, same request, ir.json on disk. Expiry is the caller's decision (warn and re-parse). */
export function parseHit(dir: string, manifest: Manifest, sha256: string | undefined, params: Record<string, unknown>): boolean {
  return Boolean(sha256) && manifest.source.sha256 === sha256 && existsSync(irPath(dir)) && sameParams(manifest.parse.params, params);
}

export function viewHit(dir: string, view: ManifestView | undefined, params: Record<string, unknown>): boolean {
  if (!view || JSON.stringify(sortKeys(view.params)) !== JSON.stringify(sortKeys(params))) return false;
  return view.files.length > 0 && view.files.every((file) => { const target = containedPath(dir, file); return Boolean(target && existsSync(target)); });
}

export function expired(manifest: Manifest, now: number = Date.now()): boolean {
  const expires = Date.parse(manifest.parse.expiresAt);
  return !Number.isFinite(expires) || now > expires;
}

export function containedPath(dir: string, relative: string): string | undefined {
  if (!relative || path.isAbsolute(relative)) return undefined;
  const root = path.resolve(dir); const target = path.resolve(root, relative);
  return target.startsWith(`${root}${path.sep}`) ? target : undefined;
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

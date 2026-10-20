import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import pLimit from 'p-limit';
import { fetchSigned } from '../cloud/download.js';
import { DeckOpsError } from '../errors/index.js';
import type { RemoteFile } from '../ops/types.js';
import type { OutputFile } from '../types.js';

/** Result files fetched at once. */
const DOWNLOADS_AT_ONCE = 4;

export interface DownloadItem {
  file: RemoteFile;
  target: string;
}

/** Write text through a temporary file, so a reader never sees half of it. */
export async function writeText(file: string, text: string): Promise<OutputFile> {
  await writeAtomic(file, Buffer.from(text, 'utf8'));
  return { file, bytes: Buffer.byteLength(text) };
}

/** Fetch result files to their targets, verifying the md5 the server reported. */
export async function download(items: readonly DownloadItem[], signal: AbortSignal): Promise<OutputFile[]> {
  const limit = pLimit(DOWNLOADS_AT_ONCE);
  return await Promise.all(items.map((item) => limit(async () => {
    signal.throwIfAborted();
    const expected = /^[0-9a-f]{32}$/i.test(item.file.hash) ? item.file.hash.toLowerCase() : undefined;
    let data: Buffer;
    try {
      data = Buffer.from(await (await fetchSigned(item.file.url, signal)).arrayBuffer());
    } catch (cause) {
      signal.throwIfAborted();
      throw DeckOpsError.asset(`Could not download ${item.file.path}.`, { cause });
    }
    if (expected !== undefined && md5(data) !== expected) {
      throw DeckOpsError.asset(`The download of ${item.file.path} does not match its checksum.`, { hint: 'Run the command again.' });
    }
    await writeAtomic(item.target, data);
    return describe(item, data.byteLength);
  })));
}

/**
 * A document's own assets directory (`<stem>.assets/`): files are fetched into a temporary sibling
 * that then takes the directory's place, so a failed run leaves the previous one intact and two
 * documents never share a directory. With no files, a stale directory from an earlier run goes.
 */
export async function replaceDirectory(
  target: string, files: readonly { file: RemoteFile; relative: string }[], signal: AbortSignal,
): Promise<OutputFile[]> {
  const parent = path.dirname(path.resolve(target));
  if (!files.length) {
    await fs.rm(target, { recursive: true, force: true });
    return [];
  }
  await fs.mkdir(parent, { recursive: true });
  const staging = await fs.mkdtemp(path.join(parent, `.${path.basename(target)}.`));
  const previous = `${staging}.previous`;
  try {
    const written = await download(files.map((item) => ({ file: item.file, target: inside(staging, item.relative) })), signal);
    const hadPrevious = await fs.rename(target, previous).then(() => true, () => false);
    await fs.rename(staging, target);
    if (hadPrevious) await fs.rm(previous, { recursive: true, force: true });
    return written.map((output) => ({ ...output, file: path.join(target, path.relative(staging, output.file)) }));
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

/** A server-suggested relative path, kept inside `dir`. */
export function inside(dir: string, relative: string): string {
  const target = path.resolve(dir, relative);
  const root = path.resolve(dir);
  if (path.isAbsolute(relative) || (target !== root && !target.startsWith(`${root}${path.sep}`))) {
    throw DeckOpsError.asset(`The cloud suggested a path outside the output directory: ${relative}`);
  }
  return target;
}

async function writeAtomic(file: string, data: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  const temp = path.join(path.dirname(path.resolve(file)), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, data);
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

function describe(item: DownloadItem, bytes: number): OutputFile {
  return {
    file: item.target, bytes,
    ...(item.file.page !== undefined ? { page: item.file.page } : {}),
    ...(item.file.width !== undefined ? { width: item.file.width } : {}),
    ...(item.file.height !== undefined ? { height: item.file.height } : {}),
  };
}

function md5(data: Uint8Array): string {
  return createHash('md5').update(data).digest('hex');
}

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FileIdStore } from '../cloud/runtime.js';

/**
 * The only state DeckOps keeps on disk, in `~/.cache/deckops/index.json` (or `$DECKOPS_CACHE_DIR`):
 * uploaded file ids by content hash, and the submission journal that lets a rerun continue a
 * task an interrupted run created instead of paying for it twice. Ids and hashes only — no
 * signed URLs, no document content, no passwords.
 */

export interface Submission {
  /** `submission_unknown`: the request left but no answer came back, so the task may or may not exist. */
  status: 'submission_unknown' | 'submitted';
  taskId?: string;
  type?: string;
  spaceId?: string;
  at: string;
}

interface CacheIndex {
  version: 1;
  files: Record<string, { fileId: string; at: string }>;
  submissions: Record<string, Submission>;
}

/** Uploaded files expire on the server; an older id is not worth trying. */
const FILE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
/** A journal entry this old belongs to a task the server has archived. */
const SUBMISSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOCK_WAIT_MS = 2000;
const STALE_LOCK_MS = 30_000;

export function cacheDir(): string {
  return path.resolve(process.env.DECKOPS_CACHE_DIR ?? path.join(os.homedir(), '.cache', 'deckops'));
}

function indexPath(): string {
  return path.join(cacheDir(), 'index.json');
}

/** Entry keys are hashes, so the index names no API root, account or source. */
export function cacheKey(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

async function readIndex(): Promise<CacheIndex> {
  try {
    const parsed = JSON.parse(await fs.readFile(indexPath(), 'utf8')) as Partial<CacheIndex>;
    if (parsed.version === 1 && typeof parsed.files === 'object' && typeof parsed.submissions === 'object') {
      return { version: 1, files: parsed.files ?? {}, submissions: parsed.submissions ?? {} };
    }
  } catch { /* Missing or damaged: start over; it is a cache. */ }
  return { version: 1, files: {}, submissions: {} };
}

/** Read-modify-write under a lock file, written atomically, so concurrent runs do not lose entries. */
async function updateIndex(mutate: (index: CacheIndex) => void): Promise<void> {
  const dir = cacheDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = `${indexPath()}.lock`;
  const release = await acquire(lock);
  try {
    const index = await readIndex();
    mutate(index);
    const now = Date.now();
    for (const [key, entry] of Object.entries(index.files)) if (now - Date.parse(entry.at) > FILE_TTL_MS) delete index.files[key];
    for (const [key, entry] of Object.entries(index.submissions)) if (now - Date.parse(entry.at) > SUBMISSION_TTL_MS) delete index.submissions[key];
    const temp = `${indexPath()}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(index)}\n`, { mode: 0o600 });
    await fs.rename(temp, indexPath());
  } finally {
    await release();
  }
}

async function acquire(lock: string): Promise<() => Promise<void>> {
  const started = Date.now();
  for (;;) {
    try {
      const handle = await fs.open(lock, 'wx', 0o600);
      await handle.close();
      return async () => { await fs.rm(lock, { force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stat = await fs.stat(lock).catch(() => undefined);
      if (stat && Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
        await fs.rm(lock, { force: true });
        continue;
      }
      // A cache must never block an operation for long: go on without the lock.
      if (Date.now() - started > LOCK_WAIT_MS) return async () => {};
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

/** `sha256 → fileId`, scoped by the client to API root and space. */
export const fileIdStore: FileIdStore = {
  async get(key) {
    const entry = (await readIndex()).files[cacheKey([key])];
    return entry && Date.now() - Date.parse(entry.at) <= FILE_TTL_MS ? entry.fileId : undefined;
  },
  async set(key, fileId) {
    await updateIndex((index) => { index.files[cacheKey([key])] = { fileId, at: new Date().toISOString() }; });
  },
  async delete(key) {
    await updateIndex((index) => { delete index.files[cacheKey([key])]; });
  },
};

export const submissions = {
  async get(key: string): Promise<Submission | undefined> {
    return (await readIndex()).submissions[key];
  },
  async set(key: string, submission: Omit<Submission, 'at'>): Promise<void> {
    await updateIndex((index) => { index.submissions[key] = { ...submission, at: new Date().toISOString() }; });
  },
  async delete(key: string): Promise<void> {
    await updateIndex((index) => { delete index.submissions[key]; });
  },
};

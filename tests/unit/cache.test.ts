import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheKey, fileIdStore, submissions } from '../../src/node/cache.js';

let dir: string;
const previous = process.env.DECKOPS_CACHE_DIR;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deckops-cache-'));
  process.env.DECKOPS_CACHE_DIR = dir;
});
afterEach(() => {
  vi.useRealTimers();
  if (previous === undefined) delete process.env.DECKOPS_CACHE_DIR; else process.env.DECKOPS_CACHE_DIR = previous;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the cache index', () => {
  it('keeps file ids and journal entries under hashed keys only', async () => {
    await fileIdStore.set('https://api.test/v1\nspace\nsha', 'file-1');
    await submissions.set('journal-key', { status: 'submitted', taskId: 'task-1', type: 'document.convert', spaceId: 'space' });
    expect(await fileIdStore.get('https://api.test/v1\nspace\nsha')).toBe('file-1');
    expect(await submissions.get('journal-key')).toMatchObject({ status: 'submitted', taskId: 'task-1' });
    const raw = fs.readFileSync(path.join(dir, 'index.json'), 'utf8');
    expect(raw).not.toContain('api.test');
    expect(raw).toContain(cacheKey(['https://api.test/v1\nspace\nsha']));
    await fileIdStore.delete('https://api.test/v1\nspace\nsha');
    await submissions.delete('journal-key');
    expect(await fileIdStore.get('https://api.test/v1\nspace\nsha')).toBeUndefined();
    expect(await submissions.get('journal-key')).toBeUndefined();
  });

  it('starts over from a damaged index and loses no entry to concurrent writers', async () => {
    fs.writeFileSync(path.join(dir, 'index.json'), '{ not json');
    expect(await fileIdStore.get('anything')).toBeUndefined();
    await Promise.all(Array.from({ length: 12 }, (_, index) => fileIdStore.set(`key-${index}`, `file-${index}`)));
    for (let index = 0; index < 12; index += 1) expect(await fileIdStore.get(`key-${index}`)).toBe(`file-${index}`);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp') || name.endsWith('.lock'))).toEqual([]);
  });

  it('forgets file ids the server will have expired', async () => {
    await fileIdStore.set('old', 'file-old');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 4 * 24 * 60 * 60 * 1000);
    expect(await fileIdStore.get('old')).toBeUndefined();
  });
});

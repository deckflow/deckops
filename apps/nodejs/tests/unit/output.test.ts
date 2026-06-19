import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { DeckTask } from '@deckops/sdk';
import { writeTaskOutput } from '../../src/utils/output.js';

describe('writeTaskOutput', () => {
  let tempDir: string;
  const baseUrl = 'https://download.test';

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deckops-output-'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const textByUrl: Record<string, string> = {
          [`${baseUrl}/one.pdf`]: 'pdf-bytes',
          [`${baseUrl}/first.jpg`]: 'first-image',
          [`${baseUrl}/second.jpg`]: 'second-image',
        };
        const text = textByUrl[String(url)];
        return {
          ok: text !== undefined,
          status: text === undefined ? 404 : 200,
          statusText: text === undefined ? 'Not Found' : 'OK',
          arrayBuffer: async () => {
            const bytes = Buffer.from(text ?? '');
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          },
        };
      })
    );
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('writes a single file directly when the extension matches', async () => {
    const outPath = path.join(tempDir, 'result.pdf');
    const result = await writeTaskOutput(task(), outPath, [`${baseUrl}/one.pdf`, 9, 'hash']);

    expect(result).toEqual({ kind: 'file', path: outPath });
    await expect(fs.readFile(outPath, 'utf-8')).resolves.toBe('pdf-bytes');
  });

  it('treats a mismatched single-file path as a directory', async () => {
    const outPath = path.join(tempDir, 'mismatch.txt');
    const result = await writeTaskOutput(task(), outPath, [`${baseUrl}/one.pdf`, 9, 'hash']);
    const expected = path.join(outPath, 'task-1.pdf');

    expect(result).toEqual({ kind: 'file', path: expected });
    await expect(fs.readFile(expected, 'utf-8')).resolves.toBe('pdf-bytes');
  });

  it('writes multiple files in order to a directory', async () => {
    const outPath = path.join(tempDir, 'images');
    const result = await writeTaskOutput(task(), outPath, [
      [`${baseUrl}/first.jpg`, 11, 'hash-1'],
      [`${baseUrl}/second.jpg`, 12, 'hash-2'],
    ]);

    expect(result.kind).toBe('directory');
    await expect(fs.readFile(path.join(outPath, '01.jpg'), 'utf-8')).resolves.toBe('first-image');
    await expect(fs.readFile(path.join(outPath, '02.jpg'), 'utf-8')).resolves.toBe('second-image');
  });

  it('writes multiple files to a zip when requested', async () => {
    const outPath = path.join(tempDir, 'images.zip');
    const result = await writeTaskOutput(task(), outPath, [
      [`${baseUrl}/first.jpg`, 11, 'hash-1'],
      [`${baseUrl}/second.jpg`, 12, 'hash-2'],
    ]);
    const bytes = await fs.readFile(outPath);

    expect(result).toEqual({ kind: 'zip', path: outPath });
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    expect(bytes.includes(Buffer.from('01.jpg'))).toBe(true);
    expect(bytes.includes(Buffer.from('02.jpg'))).toBe(true);
  });
});

function task(): DeckTask {
  return {
    id: 'task-1',
    spaceId: 'space-1',
    type: 'convertor.ppt2pdf',
    status: 'completed',
  };
}

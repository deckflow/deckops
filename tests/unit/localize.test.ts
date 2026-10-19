import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assignFileNames, localizeImages, rewriteLinks } from '../../src/node/localize.js';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'deckops-assets-'));

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const md5 = (data: Buffer): string => createHash('md5').update(data).digest('hex');

const image = (over: Partial<{ ref: string; key: string; suggestedPath: string; hash: string }> = {}) => ({
  ref: 'https://signed.example/img?sig=1',
  key: '2026-08/aa/one.png',
  suggestedPath: 'assets/one.png',
  bytes: png.length,
  hash: md5(png),
  ...over,
});

const okFetch = (body: Buffer = png): typeof fetch =>
  (async () => new Response(new Uint8Array(body))) as unknown as typeof fetch;

describe('file naming', () => {
  it('same key twice downloads once; same basename for different keys gets a suffix', () => {
    const names = assignFileNames([
      image(),
      image({ ref: 'https://signed.example/img?sig=2' }),
      image({ key: 'other/one.png', suggestedPath: 'assets/one.png', ref: 'r3' }),
    ]);
    expect(names.size).toBe(2);
    expect(names.get('2026-08/aa/one.png')).toBe('one.png');
    expect(names.get('other/one.png')).toMatch(/^one-[0-9a-f]{8}\.png$/);
  });
});

describe('localizeImages', () => {
  it('downloads, verifies, and yields exact-string rewrites', async () => {
    const dir = tmp();
    const result = await localizeImages({
      images: [image()],
      destDir: dir,
      linkPrefix: '../../assets/',
      fetchImpl: okFetch(),
    });
    expect(fs.readFileSync(path.join(dir, 'one.png'))).toEqual(png);
    expect(result.rewrites.get('https://signed.example/img?sig=1')).toBe('../../assets/one.png');
    expect(result.saved['one.png']).toMatchObject({ key: '2026-08/aa/one.png', bytes: png.length, mediaType: 'image/png' });
    expect(result.warnings).toEqual([]);
  });

  it('records the media type from the response header, falling back to the extension', async () => {
    const typed = (async () => new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/webp; q=1' } })) as unknown as typeof fetch;
    const result = await localizeImages({ images: [image()], destDir: tmp(), linkPrefix: 'a/', fetchImpl: typed });
    expect(result.saved['one.png']?.mediaType).toBe('image/webp');
    const untyped = (async () => new Response(new Uint8Array(png), { headers: { 'Content-Type': 'application/octet-stream' } })) as unknown as typeof fetch;
    const other = await localizeImages({ images: [image({ suggestedPath: 'assets/one.bin' })], destDir: tmp(), linkPrefix: 'a/', fetchImpl: untyped });
    expect(other.saved['one.bin']).not.toHaveProperty('mediaType');
  });

  it('a corrupted download fails the run — a wrong image is worse than a missing one', async () => {
    await expect(
      localizeImages({
        images: [image({ hash: 'not-the-md5' })],
        destDir: tmp(),
        linkPrefix: 'a/',
        fetchImpl: okFetch(),
      })
    ).rejects.toMatchObject({ code: 'asset_error' });
  });

  it('download failure fails by default, degrades to a warning only with keepRemote', async () => {
    const failing = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    await expect(
      localizeImages({ images: [image()], destDir: tmp(), linkPrefix: 'a/', fetchImpl: failing })
    ).rejects.toMatchObject({ code: 'asset_error' });

    const tolerant = await localizeImages({
      images: [image()],
      destDir: tmp(),
      linkPrefix: 'a/',
      keepRemote: true,
      fetchImpl: failing,
    });
    expect(tolerant.warnings).toHaveLength(1);
    expect(tolerant.rewrites.size).toBe(0); // the remote link stays in the text
  });
});

describe('cancellation', () => {
  it('aborts a hanging download and its retries with the signal reason, even with keepRemote', async () => {
    // Like fetch: rejects at once for an aborted signal, otherwise when it aborts.
    const hanging = ((_url: string, init?: RequestInit) => new Promise((_, reject) => {
      if (init?.signal?.aborted) reject(init.signal.reason);
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    })) as unknown as typeof fetch;
    const controller = new AbortController();
    const running = localizeImages({ images: [image()], destDir: tmp(), linkPrefix: 'a/', keepRemote: true, fetchImpl: hanging, signal: controller.signal });
    controller.abort(new Error('stopped by caller'));
    await expect(running).rejects.toThrow('stopped by caller');

    const failing = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const started = Date.now();
    await expect(localizeImages({ images: [image()], destDir: tmp(), linkPrefix: 'a/', fetchImpl: failing, signal: AbortSignal.timeout(50) }))
      .rejects.toMatchObject({ name: 'TimeoutError' });
    expect(Date.now() - started).toBeLessThan(500); // the retry backoff stopped waiting
  });
});

describe('rewriteLinks', () => {
  it('rewrites by exact string, no URL normalization', () => {
    const rewrites = new Map([['https://s.example/a?Expires=1&sig=x', 'assets/a.png']]);
    const text = '![](https://s.example/a?Expires=1&sig=x) and ![](https://s.example/a?Expires=2)';
    expect(rewriteLinks(text, rewrites)).toBe('![](assets/a.png) and ![](https://s.example/a?Expires=2)');
  });
});

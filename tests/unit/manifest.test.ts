import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  IR_RETENTION_MS,
  expired,
  normalizeParseParams,
  parseHit,
  readManifest,
  sameParams,
  viewHit,
  writeManifest,
} from '../../src/node/artifact.js';
import type { Manifest } from '../../src/types.js';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'deckops-manifest-'));

const manifest = (overrides: Partial<Manifest['parse']> = {}): Manifest => {
  const createdAt = new Date();
  return {
    manifestVersion: 3,
    source: { name: 'a.pdf', sha256: 'abc', bytes: 3 },
    parse: {
      taskId: 't1',
      type: 'pdf.pdfParse',
      irKey: '2026-10/aa/ir.json',
      irSchemaVersion: 'result.v3',
      params: normalizeParseParams({}),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + IR_RETENTION_MS).toISOString(),
      ...overrides,
    },
    views: {},
    assets: {},
    producer: { deckops: '3.0.0' },
  };
};

describe('param normalization', () => {
  it('defaults and explicit defaults are the same request', () => {
    expect(sameParams({}, { parseProfile: 'balanced', includeImages: true })).toBe(true);
    expect(sameParams({}, { parseProfile: 'quality' })).toBe(false);
    expect(sameParams({ password: 'x' }, { password: 'x' })).toBe(true);
    expect(normalizeParseParams({ password: 'secret' })).toEqual({ includeImages: true, parseProfile: 'balanced', passwordProvided: true });
  });
});

describe('hit detection', () => {
  it('parse hit needs same bytes, same request, ir.json on disk', () => {
    const dir = tmp();
    const m = manifest();
    expect(parseHit(dir, m, 'abc', {})).toBe(false); // no ir.json yet
    fs.writeFileSync(path.join(dir, 'ir.json'), '{}');
    expect(parseHit(dir, m, 'abc', {})).toBe(true);
    expect(parseHit(dir, m, 'other', {})).toBe(false);
    expect(parseHit(dir, m, 'abc', { parseProfile: 'quality' })).toBe(false);
    expect(parseHit(dir, m, undefined, {})).toBe(false);
  });

  it('view hit needs same params and every registered file present', () => {
    const dir = tmp();
    const view = { taskId: 't2', schemaVersion: 'result.v3', params: { splitPages: true }, files: ['views/markdown/index.md'], createdAt: 'x' };
    expect(viewHit(dir, view, { splitPages: true })).toBe(false); // file missing
    fs.mkdirSync(path.join(dir, 'views/markdown'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'views/markdown/index.md'), '# hi');
    expect(viewHit(dir, view, { splitPages: true })).toBe(true);
    expect(viewHit(dir, view, {})).toBe(false); // different params
    expect(viewHit(dir, undefined, {})).toBe(false);
  });
});

describe('retention', () => {
  it('reads expiry from expiresAt, recorded as createdAt + 7 days', () => {
    expect(expired(manifest())).toBe(false);
    expect(expired(manifest({ expiresAt: new Date(Date.now() - 60_000).toISOString() }))).toBe(true);
    expect(expired(manifest({ expiresAt: 'not a date' }))).toBe(true);
  });
});

describe('read / write', () => {
  it('round-trips atomically and rejects damage precisely', async () => {
    const dir = tmp();
    const m = manifest();
    await writeManifest(dir, m);
    expect(await readManifest(dir)).toEqual(m);
    expect(fs.existsSync(path.join(dir, 'manifest.json.tmp'))).toBe(false);

    fs.writeFileSync(path.join(dir, 'manifest.json'), '{ not json');
    await expect(readManifest(dir)).rejects.toMatchObject({ code: 'input_error' });

    const empty = tmp();
    await expect(readManifest(empty)).rejects.toMatchObject({ code: 'input_error' });
  });

  it.each([1, 2])('refuses a DeckOps 2.x manifest v%i and says how to recreate it', async (version) => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...manifest(), manifestVersion: version }));
    await expect(readManifest(dir)).rejects.toMatchObject({
      code: 'input_error',
      message: expect.stringContaining('DeckOps 2.x'),
      hint: expect.stringContaining('deckops parse <source> --force'),
    });
  });

  it('rejects registered paths that escape the artifact', async () => {
    const dir = tmp();
    await writeManifest(dir, { ...manifest(), assets: { '../outside.png': { key: 'k', hash: 'h', bytes: 1 } } });
    await expect(readManifest(dir)).rejects.toMatchObject({ code: 'input_error', message: expect.stringContaining('unsafe path') });
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClientWith } from '../../src/client/legacy.js';
import { nodeRuntime } from '../../src/node/runtime.js';
import { runConvert } from '../../src/node/convert-op.js';
import { resolveInput } from '../../src/node/input.js';
import { runParse } from '../../src/node/parse-op.js';
import { runRead } from '../../src/node/read-op.js';
import { MAX_SOURCE_BYTES } from '../../src/shared/constants.js';
import type { CommonFlags } from '../../src/types.js';
import { createFakeCloud, FIXTURE_PNG, type FakeCloud } from '../browser/fake-cloud.mjs';

/**
 * The Node operation layer over real HTTP against the wire-protocol fixture: artifact layout,
 * reuse, image localization, resume after a lost result, and retention.
 */

let cloud: FakeCloud;
beforeAll(async () => { cloud = await createFakeCloud(); });
afterAll(async () => { await cloud.close(); });

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'deckops-ops-'));
const clientFor = (name: string) => async () => createClientWith({ apiBase: cloud.apiBase(name), token: 'test-token' }, nodeRuntime, 'node');
const created = (name: string) => cloud.state(name).tasks;
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

const writeSource = (dir: string, name = 'doc.pdf'): string => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'fake document bytes');
  return file;
};

const parse = async (name: string, source: string, out: string, extra: { flags?: object; common?: CommonFlags } = {}) =>
  runParse({ input: await resolveInput(source), inputLabel: source, out, flags: extra.flags ?? {}, common: extra.common ?? {}, client: clientFor(name) });

const convert = async (name: string, input: string, extra: { flags?: object; common?: CommonFlags; out?: string } = {}) =>
  runConvert({ input: await resolveInput(input), inputLabel: input, ...(extra.out ? { out: extra.out } : {}), flags: extra.flags ?? {}, common: extra.common ?? {}, client: clientFor(name) });

describe('parse → artifact', () => {
  it('stores the server IR verbatim with manifest v3, then reuses it without a task', async () => {
    const dir = tmp();
    const source = writeSource(dir);
    const out = path.join(dir, 'artifact');

    const first = await parse('parse', source, out);
    expect(first).toMatchObject({
      ok: true, op: 'parse', type: 'pdf.pdfParse', format: 'pdf', taskId: 'task-1', irKey: 'fixture/task-1/ir.json',
      irSchemaVersion: 'result.v3', reusedParse: false, artifact: out, warnings: [],
    });
    expect(Date.parse(first.expiresAt) - Date.now()).toBeGreaterThan(6.9 * 24 * 3600 * 1000);
    expect(first.outputs.map((output) => path.basename(output.file))).toEqual(['ir.json', 'manifest.json']);
    expect(readJson(path.join(out, 'ir.json'))).toEqual({
      irKey: 'fixture/task-1/ir.json', irSchemaVersion: 'result.v3',
      document: { schemaVersion: 'result.v3', elements: [{ text: 'Hello browser' }] }, images: [],
    });
    expect(readJson(path.join(out, 'manifest.json'))).toMatchObject({
      manifestVersion: 3,
      source: { name: 'doc.pdf', bytes: 19, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      parse: { taskId: 'task-1', type: 'pdf.pdfParse', irKey: 'fixture/task-1/ir.json', params: { parseProfile: 'balanced', includeImages: true } },
      views: {}, assets: {}, producer: { deckops: expect.any(String) },
    });
    // Views and images belong to convert; a finished parse leaves no submission log.
    for (const name of ['views', 'assets', 'submission.json']) expect(fs.existsSync(path.join(out, name))).toBe(false);

    const second = await parse('parse', source, out);
    expect(second).toMatchObject({ reusedParse: true, taskId: 'task-1', irKey: 'fixture/task-1/ir.json' });
    expect(created('parse')).toHaveLength(1);

    await parse('parse', source, out, { common: { force: true } });
    await parse('parse', source, out, { flags: { profile: 'quality' } });
    expect(created('parse')).toHaveLength(3);
    expect(cloud.state('parse').uploads).toHaveLength(0); // small sources travel inline with the task
  });

  it('never reuses a URL parse by identity alone', async () => {
    const out = path.join(tmp(), 'page');
    await parse('url', 'https://example.com/article', out);
    const again = await parse('url', 'https://example.com/article', out);
    expect(again).toMatchObject({ reusedParse: false, type: 'html.getByURL', format: 'html' });
    expect(created('url')).toHaveLength(2);
  });

  it('refuses to parse an artifact and to read a DeckOps 2.x artifact', async () => {
    const dir = tmp();
    const out = path.join(dir, 'artifact');
    await parse('refuse', writeSource(dir), out);
    await expect(parse('refuse', out, out)).rejects.toMatchObject({ code: 'usage_error' });

    const legacy = path.join(dir, 'legacy');
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, 'manifest.json'), JSON.stringify({ manifestVersion: 2 }));
    await expect(convert('refuse', legacy)).rejects.toMatchObject({ code: 'input_error', hint: expect.stringContaining('--force') });
  });
});

describe('parse guards', () => {
  it('leaves a DeckOps 2.x artifact untouched, and --force replaces the whole directory', async () => {
    const dir = tmp();
    const source = writeSource(dir);
    const out = path.join(dir, 'artifact');
    fs.mkdirSync(path.join(out, 'candidates', 'local'), { recursive: true });
    for (const [name, body] of [['manifest.json', '{"manifestVersion":2}'], ['probe.json', '{}'], ['upgrade.json', '{}'], ['assessment.json', '{}'], ['run.json', '{}']]) {
      fs.writeFileSync(path.join(out, name!), body!);
    }
    await expect(parse('legacy', source, out)).rejects.toMatchObject({ code: 'input_error', hint: expect.stringContaining('--force') });
    expect(cloud.state('legacy').requests).toHaveLength(0);
    expect(fs.readdirSync(out).sort()).toEqual(['assessment.json', 'candidates', 'manifest.json', 'probe.json', 'run.json', 'upgrade.json']);

    const forced = await parse('legacy', source, out, { common: { force: true } });
    expect(forced).toMatchObject({ reusedParse: false, taskId: 'task-1' });
    expect(fs.readdirSync(out).sort()).toEqual(['ir.json', 'manifest.json']);
    expect(readJson(path.join(out, 'manifest.json')).manifestVersion).toBe(3);
  });

  it('refuses a source over the cloud size limit before reading it', async () => {
    const dir = tmp();
    const source = path.join(dir, 'huge.pdf');
    fs.writeFileSync(source, '');
    fs.truncateSync(source, MAX_SOURCE_BYTES + 1); // sparse: no real disk use
    try {
      await expect(parse('huge', source, path.join(dir, 'artifact'))).rejects.toMatchObject({
        code: 'input_error', message: expect.stringContaining('accepts sources up to 256 MiB'),
      });
      expect(cloud.state('huge').requests).toHaveLength(0);
    } finally {
      fs.rmSync(source, { force: true });
    }
  });
});

describe('resume', () => {
  it('waits for the task an interrupted run submitted instead of submitting again', async () => {
    const dir = tmp();
    const source = writeSource(dir);
    const out = path.join(dir, 'artifact');
    cloud.state('resume').failDownloads = 1;

    await expect(parse('resume', source, out)).rejects.toMatchObject({ code: 'backend_error' });
    expect(readJson(path.join(out, 'submission.json'))).toMatchObject({
      status: 'submitted', taskId: 'task-1', spaceId: 'fixture-space', sourceHash: expect.any(String), params: expect.any(Object),
    });
    expect(fs.existsSync(path.join(out, 'manifest.json'))).toBe(false);

    const second = await parse('resume', source, out);
    expect(second).toMatchObject({ reusedParse: false, taskId: 'task-1' });
    expect(second.warnings.join('\n')).toContain('Resumed cloud task task-1');
    expect(created('resume')).toHaveLength(1); // nothing uploaded or billed again
    expect(fs.existsSync(path.join(out, 'submission.json'))).toBe(false);
  });

  it('forgets a task that cannot be resumed, so the next run submits anew', async () => {
    const dir = tmp();
    const source = writeSource(dir);
    const out = path.join(dir, 'artifact');
    cloud.state('gone').failDownloads = 1;
    await expect(parse('gone', source, out)).rejects.toMatchObject({ code: 'backend_error' });
    const journal = path.join(out, 'submission.json');
    fs.writeFileSync(journal, JSON.stringify({ ...readJson(journal), taskId: 'task-missing' }));

    await expect(parse('gone', source, out)).rejects.toMatchObject({
      code: 'backend_error', taskId: 'task-missing', hint: expect.stringContaining('submit a new task'),
    });
    expect(fs.existsSync(journal)).toBe(false);

    const third = await parse('gone', source, out);
    expect(third).toMatchObject({ reusedParse: false, taskId: 'task-2' });
    expect(created('gone')).toHaveLength(2);
  });
});

describe('convert <artifact>', () => {
  const setup = async (name: string, file = 'doc.pdf') => {
    const dir = tmp();
    const out = path.join(dir, 'artifact');
    await parse(name, writeSource(dir, file), out);
    return { dir, out };
  };

  it('localizes images into assets/, writes views/markdown/, then reuses the view', async () => {
    const { dir, out } = await setup('convert');
    const first = await convert('convert', out);
    expect(first).toMatchObject({ ok: true, op: 'convert', to: 'markdown', format: 'pdf', taskId: 'task-2', parseTaskId: 'task-1', reusedParse: true });
    expect(created('convert').map((task) => task.type)).toEqual(['pdf.pdfParse', 'parse.convert']);
    expect(created('convert')[1]?.params).toEqual({ irKey: 'fixture/task-1/ir.json', to: 'markdown' });

    const body = fs.readFileSync(path.join(out, 'views/markdown/index.md'), 'utf8');
    expect(body).toContain('![](../../assets/image.png)');
    expect(body).not.toContain('expires='); // no signed URLs on disk
    expect(fs.readFileSync(path.join(out, 'assets/image.png'))).toEqual(FIXTURE_PNG);
    expect(readJson(path.join(out, 'manifest.json'))).toMatchObject({
      views: { markdown: { taskId: 'task-2', schemaVersion: 'result.v3', params: {}, files: ['views/markdown/index.md'] } },
      assets: { 'assets/image.png': { key: 'fixture/image.png', bytes: FIXTURE_PNG.length, mediaType: 'image/png', hash: expect.any(String) } },
    });

    const cached = await convert('convert', out);
    expect(cached).toMatchObject({ taskId: null, parseTaskId: 'task-1', reusedParse: true });
    expect(created('convert')).toHaveLength(2);

    // Different view options or an explicit output render again from the same irKey.
    await convert('convert', out, { flags: { anchors: true } });
    const portable = await convert('convert', out, { out: path.join(dir, 'export.md'), flags: { anchors: true } });
    expect(created('convert').map((task) => task.type)).toEqual(['pdf.pdfParse', 'parse.convert', 'parse.convert', 'parse.convert']);
    expect(fs.readFileSync(path.join(dir, 'export.md'), 'utf8')).toContain('![](export.assets/image.png)');
    expect(portable.outputs.map((output) => path.relative(dir, output.file))).toEqual(expect.arrayContaining(['export.md', 'export.assets/image.png']));
  });

  it('writes one file per page with --split-pages', async () => {
    const { out } = await setup('split', 'slides.pptx');
    await convert('split', out, { flags: { splitPages: true } });
    expect(fs.readdirSync(path.join(out, 'views/markdown')).sort()).toEqual(['001.md', '002.md', 'index.md']);
    expect(readJson(path.join(out, 'manifest.json')).views.markdown.files).toEqual([
      'views/markdown/index.md', 'views/markdown/001.md', 'views/markdown/002.md',
    ]);
  });

  it('treats markdownError as failure and a dead image as asset_error unless --keep-remote-images', async () => {
    const bad = await setup('bad-markdown');
    await expect(convert('bad-markdown', bad.out)).rejects.toMatchObject({ code: 'backend_error' });

    const dead = await setup('dead-image');
    await expect(convert('dead-image', dead.out)).rejects.toMatchObject({ code: 'asset_error' });
    const tolerated = await convert('dead-image', dead.out, { flags: { keepRemoteImages: true } });
    expect(tolerated.warnings).toHaveLength(1);
    expect(fs.readFileSync(path.join(dead.out, 'views/markdown/index.md'), 'utf8')).toContain('image.png?expires=fixture');
  });
});

describe('convert time budget and asset replacement', () => {
  it('bounds image downloads by --timeout and by the caller signal', async () => {
    const dir = tmp();
    const out = path.join(dir, 'artifact');
    await parse('hanging-image', writeSource(dir), out);
    const started = Date.now();
    await expect(convert('hanging-image', out, { common: { timeout: 0.5 } })).rejects.toMatchObject({
      code: 'backend_error', message: expect.stringMatching(/^Stopped after/),
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('cancelled by caller')), 300);
    await expect(convert('hanging-image', out, { common: { signal: controller.signal } })).rejects.toThrow('cancelled by caller');
    await expect(convert('hanging-image', writeSource(dir), { out: path.join(dir, 'oneshot.md'), common: { timeout: 0.5 } }))
      .rejects.toMatchObject({ code: 'backend_error' });
    expect(Date.now() - started).toBeLessThan(5_000);
    // The interrupted renders left the artifact as parse wrote it.
    expect(fs.readdirSync(out).sort()).toEqual(['ir.json', 'manifest.json']);
  });

  it('replaces assets/ on a new render, and keeps the previous view when a download fails', async () => {
    const dir = tmp();
    const out = path.join(dir, 'artifact');
    await parse('replace', writeSource(dir), out);
    await convert('replace', out);
    const manifestFile = path.join(out, 'manifest.json');
    fs.writeFileSync(path.join(out, 'assets', 'stale.png'), 'old');
    fs.writeFileSync(manifestFile, JSON.stringify({ ...readJson(manifestFile), assets: { ...readJson(manifestFile).assets, 'assets/stale.png': { key: 'old', hash: '', bytes: 3 } } }));
    await convert('replace', out, { common: { force: true } });
    expect(fs.readdirSync(path.join(out, 'assets'))).toEqual(['image.png']);
    expect(Object.keys(readJson(manifestFile).assets)).toEqual(['assets/image.png']);

    const dead = path.join(dir, 'dead');
    await parse('dead-image_replace', writeSource(dir), dead);
    fs.mkdirSync(path.join(dead, 'assets'));
    fs.writeFileSync(path.join(dead, 'assets', 'previous.png'), 'kept');
    const before = readJson(path.join(dead, 'manifest.json'));
    await expect(convert('dead-image_replace', dead)).rejects.toMatchObject({ code: 'asset_error' });
    expect(fs.readdirSync(dead).sort()).toEqual(['assets', 'ir.json', 'manifest.json']); // no staging directory left
    expect(fs.readdirSync(path.join(dead, 'assets'))).toEqual(['previous.png']);
    expect(readJson(path.join(dead, 'manifest.json'))).toEqual(before);
  });
});

describe('retention', () => {
  const expire = (out: string): void => {
    const file = path.join(out, 'manifest.json');
    const manifest = readJson(file);
    manifest.parse.expiresAt = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(file, JSON.stringify(manifest));
  };

  it('fails convert locally with ir_expired, and re-parses an expired hit with a warning', async () => {
    const dir = tmp();
    const source = writeSource(dir);
    const out = path.join(dir, 'artifact');
    await parse('expired-ir', source, out);
    expire(out);

    await expect(convert('expired-ir', out)).rejects.toMatchObject({ code: 'ir_expired', hint: expect.stringContaining('--force') });
    expect(created('expired-ir')).toHaveLength(1); // saved the round trip

    const again = await parse('expired-ir', source, out);
    expect(again).toMatchObject({ reusedParse: false, taskId: 'task-2' });
    expect(again.warnings.join('\n')).toContain('expired');
    expect(Date.parse(again.expiresAt)).toBeGreaterThan(Date.now());
  });
});

describe('convert <document> (one-shot)', () => {
  it('chains parse + convert, writes a portable copy, and leaves no artifact', async () => {
    const dir = tmp();
    const source = writeSource(dir);
    const envelope = await convert('oneshot', source, { out: path.join(dir, 'doc.md') });
    expect(envelope).toMatchObject({ reusedParse: false, parseTaskId: 'task-1', taskId: 'task-2', format: 'pdf' });
    expect(fs.readFileSync(path.join(dir, 'doc.md'), 'utf8')).toContain('![](doc.assets/image.png)');
    expect(fs.readFileSync(path.join(dir, 'doc.assets/image.png'))).toEqual(FIXTURE_PNG);
    expect(fs.existsSync(path.join(dir, 'doc', 'manifest.json'))).toBe(false);
  });

  it('rejects --to anything but markdown before any request', async () => {
    const source = writeSource(tmp());
    await expect(convert('to-html', source, { flags: { to: 'html' } })).rejects.toMatchObject({ code: 'unsupported' });
    expect(cloud.state('to-html').requests).toHaveLength(0);
  });
});

describe('read', () => {
  const read = async (name: string, source: string, extra: Record<string, unknown> = {}) =>
    runRead({ input: await resolveInput(source), inputLabel: source, flags: {}, common: {}, client: clientFor(name), ...extra });

  it('parses into the cache, converts, and hands back Markdown with escaped local image links', async () => {
    const dir = tmp();
    const source = writeSource(dir);
    const cacheDir = path.join(dir, 'cache with spaces');
    const first = await read('read', source, { cacheDir });
    expect(first).toMatchObject({ schemaVersion: 'deckops.read.v2', ok: true, format: 'markdown', outputs: [] });
    expect(first.report).toMatchObject({ schemaVersion: 'deckops.run.v2', parseTaskId: 'task-1', convertTaskId: 'task-2', cacheHit: false, warnings: [] });
    const escaped = path.join(first.report.artifactBase, 'assets').replaceAll(' ', '%20');
    expect(first.content).toContain(`![](${escaped}/image.png)`);
    expect(first.assets).toEqual([{ path: path.join(first.report.artifactBase, 'assets/image.png'), lifecycle: 'cache', bytes: FIXTURE_PNG.length }]);

    const second = await read('read', source, { cacheDir });
    expect(second.report.cacheHit).toBe(true);
    expect(created('read')).toHaveLength(2); // cached parse and cached view

    const ir = await read('read', source, { cacheDir, format: 'ir' });
    expect(ir.content).toMatchObject({ irKey: 'fixture/task-1/ir.json' });

    const out = path.join(dir, 'out.md');
    const reportFile = path.join(dir, 'run.json');
    const written = await read('read', source, { cacheDir, out, reportFile });
    expect(written.content).toBeNull();
    expect(written.assets[0]).toMatchObject({ lifecycle: 'output' });
    expect(fs.readFileSync(out, 'utf8')).toMatch(/!\[\]\(out\.assets-[0-9a-f]{8}\/image\.png\)/);
    expect(readJson(reportFile)).toMatchObject({ schemaVersion: 'deckops.run.v2', parseTaskId: 'task-1', cacheHit: true });
    await expect(read('read', source, { out: source })).rejects.toMatchObject({ code: 'usage_error' });
    await expect(read('read', source, { format: 'ir', out })).rejects.toMatchObject({ code: 'usage_error' });
  });
});

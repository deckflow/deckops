import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCapabilitiesCache } from '../../src/cloud/capabilities.js';
import { cloudClient } from '../../src/node/cloud.js';
import { runConvert, runExtract, runProbe, runRender } from '../../src/node/ops.js';
import { createFakeCloud, FIXTURE_DOCUMENT, FIXTURE_MARKDOWN, FIXTURE_PNG, type FakeCloud } from '../browser/fake-cloud.mjs';

let cloud: FakeCloud;
let work: string;
const env = { ...process.env };

beforeAll(async () => {
  cloud = await createFakeCloud();
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'deckops-node-ops-'));
  // Nothing in these tests may touch the real home directory.
  process.env.DECKOPS_CACHE_DIR = path.join(work, 'cache');
  process.env.DECKFLOW_CONFIG_DIR = path.join(work, 'config');
  process.env.DECKOPS_CONFIG_DIR = path.join(work, 'config');
});
afterAll(async () => {
  await cloud.close();
  process.env = env;
  fs.rmSync(work, { recursive: true, force: true });
});
beforeEach(() => { clearCapabilitiesCache(); });

const dir = (name: string): string => fs.mkdtempSync(path.join(work, `${name}-`));
const source = (folder: string, name: string, text = `${name} bytes`): string => {
  const file = path.join(folder, name);
  fs.writeFileSync(file, text);
  return file;
};
const request = (caseName: string, input: string, extra: { out?: string; force?: boolean; timeout?: number } = {}) => ({
  input,
  ...(extra.out !== undefined ? { out: extra.out } : {}),
  common: { ...(extra.force ? { force: true } : {}), ...(extra.timeout ? { timeout: extra.timeout } : {}) },
  cloud: () => cloudClient({ apiBase: cloud.apiBase(caseName), token: 'test-token', spaceId: 'test-space' }),
});
const created = (name: string) => cloud.state(name).requests.filter((req) => req.path === '/tools/tasks' && req.method === 'POST');

describe('convert writes Markdown with its images beside it', () => {
  it('links images by relative path and downloads them into assets/', async () => {
    const folder = dir('convert');
    const out = path.join(folder, 'out', 'report.md');
    const envelope = await runConvert({ ...request('n-convert', source(folder, 'report.pdf'), { out }), options: {} });
    expect(fs.readFileSync(out, 'utf8')).toBe(FIXTURE_MARKDOWN);
    expect(fs.readFileSync(path.join(folder, 'out', 'assets', 'image.png'))).toEqual(FIXTURE_PNG);
    expect(envelope).toMatchObject({
      ok: true, op: 'convert', to: 'markdown', format: 'pdf', pages: 2, reusedParse: false,
      tasks: [{ type: 'document.convert', id: 'task-1' }],
      outputs: [{ file: out, bytes: FIXTURE_MARKDOWN.length }, { file: path.join(folder, 'out', 'assets', 'image.png'), bytes: 8 }],
      warnings: [],
    });
    expect(envelope).not.toHaveProperty('content');
  });

  it('prints signed links on stdout, keeps remote links on request, and defaults to <stem>.md beside the source', async () => {
    const folder = dir('convert-modes');
    const input = source(folder, 'deck.pptx');
    const stdout = await runConvert({ ...request('n-stdout', input, { out: '-' }), options: {} });
    expect(stdout.content).toContain(`${cloud.apiBase('n-stdout')}/results/image.png?sig=fixture`);
    expect(stdout.outputs).toEqual([]);

    const remote = await runConvert({ ...request('n-remote', input, { out: path.join(folder, 'remote.md') }), options: { keepRemoteImages: true } });
    expect(fs.readFileSync(path.join(folder, 'remote.md'), 'utf8')).toContain('?sig=fixture');
    expect(fs.existsSync(path.join(folder, 'assets'))).toBe(false);
    expect(remote.outputs).toHaveLength(1);

    const fallback = await runConvert({ ...request('n-default', input), options: { splitPages: true } });
    expect(fallback.outputs.map((output) => path.basename(output.file))).toEqual(['deck.md', 'image.png', 'deck-001.md', 'deck-002.md']);
    expect(fs.readFileSync(path.join(folder, 'deck-001.md'), 'utf8')).toBe('# Page one\n\n![](assets/image.png)');
  });

  it('refuses to overwrite another document’s asset, reuses an identical one, and rejects a corrupted download', async () => {
    const folder = dir('assets');
    const input = source(folder, 'a.pdf');
    fs.mkdirSync(path.join(folder, 'assets'));
    fs.writeFileSync(path.join(folder, 'assets', 'image.png'), 'another document');
    await expect(runConvert({ ...request('n-conflict', input, { out: path.join(folder, 'a.md') }), options: {} })).rejects.toMatchObject({
      code: 'asset_error', hint: expect.stringContaining('its own directory'),
    });
    expect(fs.existsSync(path.join(folder, 'a.md'))).toBe(false);

    fs.writeFileSync(path.join(folder, 'assets', 'image.png'), FIXTURE_PNG);
    await runConvert({ ...request('n-identical', input, { out: path.join(folder, 'a.md') }), options: {} });
    expect(cloud.state('n-identical').requests.some((req) => req.path === '/results/image.png')).toBe(false);

    const fresh = dir('corrupt');
    await expect(runConvert({ ...request('corrupt-result', source(fresh, 'b.pdf'), { out: path.join(fresh, 'b.md') }), options: {} }))
      .rejects.toMatchObject({ code: 'asset_error', message: expect.stringContaining('checksum') });
  });

  it('refuses an output that would overwrite the source', async () => {
    const folder = dir('same');
    const input = source(folder, 'notes.docx');
    await expect(runConvert({ ...request('n-same', input, { out: input }), options: {} })).rejects.toMatchObject({ code: 'usage_error' });
    expect(cloud.state('n-same').requests).toHaveLength(0);
  });
});

describe('extract and render write their files', () => {
  it('writes the JSON document with assets beside it, or prints it', async () => {
    const folder = dir('extract');
    const input = source(folder, 'report.pdf');
    const out = path.join(folder, 'report.json');
    const written = await runExtract({ ...request('n-extract', input, { out }), options: { to: 'json' } });
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual(FIXTURE_DOCUMENT);
    expect(fs.existsSync(path.join(folder, 'assets', 'image.png'))).toBe(true);
    expect(written).toMatchObject({ op: 'extract', to: 'json', schemaVersion: 'result.v3', format: 'pdf' });

    const printed = await runExtract({ ...request('n-extract-stdout', input, { out: '-' }), options: { to: 'json' } });
    expect(printed.content).toEqual(FIXTURE_DOCUMENT);

    const assets = await runExtract({ ...request('n-assets', input, { out: path.join(folder, 'images') }), options: { to: 'assets' } });
    expect(assets.outputs.map((output) => path.relative(folder, output.file))).toEqual([path.join('images', 'assets', 'image.png')]);
    await expect(runExtract({ ...request('n-assets-stdout', input, { out: '-' }), options: { to: 'assets' } })).rejects.toMatchObject({ code: 'usage_error' });
  });

  it('names frames by page in a directory, and single outputs as files', async () => {
    const folder = dir('render');
    const deck = source(folder, 'deck.pptx');
    const frames = await runRender({ ...request('n-render', deck), options: { to: 'image', pages: [1, 3] } });
    expect(frames.outputs.map((output) => [path.relative(folder, output.file), output.page, output.width])).toEqual([
      [path.join('deck', '001.png'), 1, 1920], [path.join('deck', '003.png'), 3, 1920],
    ]);
    expect(frames).toMatchObject({ op: 'render', to: 'image', pages: 3, tasks: [{ type: 'convertor.ppt2image' }] });

    const named = await runRender({ ...request('n-render-named', deck, { out: path.join(folder, 'slide.png') }), options: { to: 'image' } });
    expect(named.outputs.map((output) => path.basename(output.file))).toEqual(['slide-001.png', 'slide-002.png', 'slide-003.png']);

    const video = await runRender({ ...request('n-video', deck), options: { to: 'video' } });
    expect(video.outputs.map((output) => path.relative(folder, output.file))).toEqual(['deck.mp4']);
    await expect(runRender({ ...request('n-render-stdout', deck, { out: '-' }), options: { to: 'image' } })).rejects.toMatchObject({ code: 'usage_error' });
  });
});

describe('the upload index and the submission journal', () => {
  it('uploads the same bytes once across runs and clients', async () => {
    const folder = dir('index');
    const input = source(folder, 'report.pdf', 'indexed bytes');
    await runConvert({ ...request('n-index', input, { out: '-' }), options: {} });
    await runExtract({ ...request('n-index', input, { out: '-' }), options: { to: 'json' } });
    expect(cloud.state('n-index').uploads).toHaveLength(1);
    const index = JSON.parse(fs.readFileSync(path.join(work, 'cache', 'index.json'), 'utf8'));
    expect(JSON.stringify(index)).not.toMatch(/report\.pdf|test-token|indexed bytes|sig=/);
  });

  it('continues the task an interrupted run created, without uploading or submitting again', async () => {
    const folder = dir('resume');
    const input = source(folder, 'report.pdf', 'resume bytes');
    cloud.state('n-resume').forceStatus = 'running';
    await expect(runConvert({ ...request('n-resume', input, { out: '-', timeout: 0.5 }), options: {} })).rejects.toMatchObject({
      code: 'backend_error', taskId: 'task-1',
    });
    delete cloud.state('n-resume').forceStatus;
    const resumed = await runConvert({ ...request('n-resume', input, { out: '-' }), options: {} });
    expect(resumed.tasks).toEqual([{ type: 'document.convert', id: 'task-1' }]);
    expect(resumed.warnings).toEqual([expect.stringContaining('Continued cloud task task-1')]);
    expect(created('n-resume')).toHaveLength(1);
    expect(cloud.state('n-resume').uploads).toHaveLength(1);
    // Done: the next run is a new task.
    await runConvert({ ...request('n-resume', input, { out: '-' }), options: {} });
    expect(created('n-resume')).toHaveLength(2);
  });

  it('submits anew with --force, and forgets a task that failed', async () => {
    const folder = dir('force');
    const input = source(folder, 'deck.pptx', 'force bytes');
    cloud.state('n-force').forceStatus = 'running';
    await expect(runRender({ ...request('n-force', input, { timeout: 0.5 }), options: { to: 'video' } })).rejects.toBeDefined();
    delete cloud.state('n-force').forceStatus;
    const forced = await runRender({ ...request('n-force', input, { force: true }), options: { to: 'video' } });
    expect(forced.tasks).toEqual([{ type: 'convertor.ppt2video', id: 'task-2' }]);
    expect(forced.warnings).toEqual([expect.stringContaining('--force')]);

    cloud.state('n-force').forceStatus = 'running';
    await expect(runRender({ ...request('n-force', input, { timeout: 0.5 }), options: { to: 'video' } })).rejects.toBeDefined();
    cloud.state('n-force').forceStatus = 'failed';
    await expect(runRender({ ...request('n-force', input), options: { to: 'video' } })).rejects.toMatchObject({
      code: 'backend_error', taskId: 'task-3', message: expect.stringContaining('cannot be continued'),
    });
    delete cloud.state('n-force').forceStatus;
    await runRender({ ...request('n-force', input), options: { to: 'video' } });
    expect(created('n-force')).toHaveLength(4);
  });

  it('refuses to guess when an earlier request may have created a task, and forgets one the server refused', async () => {
    const folder = dir('unknown');
    const input = source(folder, 'report.pdf', 'unknown bytes');
    await expect(runConvert({ ...request('hanging-create', input, { out: '-', timeout: 0.5 }), options: {} })).rejects.toBeDefined();
    await expect(runConvert({ ...request('hanging-create', input, { out: '-' }), options: {} })).rejects.toMatchObject({
      code: 'backend_error', hint: expect.stringContaining('--force'),
    });

    await expect(runConvert({ ...request('quota', input, { out: '-' }), options: {} })).rejects.toMatchObject({ code: 'quota_error' });
    await expect(runConvert({ ...request('quota', input, { out: '-' }), options: {} })).rejects.toMatchObject({ code: 'quota_error' });
    expect(created('quota')).toHaveLength(2);
  });
});

describe('probe', () => {
  it('runs locally without credentials, network or a single request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    process.env.DECKOPS_API_BASE = cloud.apiBase('probe');
    for (const name of ['DECKOPS_API_KEY', 'DECKOPS_TOKEN', 'DECKFLOW_API_KEY', 'DECKFLOW_TOKEN']) delete process.env[name];
    const report = await runProbe({ input: path.resolve('tests/test-data/test.pdf'), options: { targets: ['page_count'] }, common: {} });
    expect(report).toMatchObject({ schema_version: 2, status: 'ok', results: { 'pdf.page_count': { value: 3 } } });
    expect(cloud.state('probe').requests).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    delete process.env.DECKOPS_API_BASE;
  });

  it('refuses URLs and maps engine errors to DeckOps codes', async () => {
    await expect(runProbe({ input: 'https://example.com/a.pdf', options: {}, common: {} })).rejects.toMatchObject({ code: 'unsupported' });
    const folder = dir('probe');
    await expect(runProbe({ input: source(folder, 'broken.pdf', 'not a pdf'), options: {}, common: {} })).rejects.toMatchObject({
      code: expect.stringMatching(/input_error|unsupported/),
    });
    await expect(runProbe({ input: path.join(folder, 'missing.pdf'), options: {}, common: {} })).rejects.toMatchObject({ code: 'input_error' });
  });
});

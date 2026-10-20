import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearCapabilitiesCache } from '../../src/cloud/capabilities.js';
import type { DeckRuntime } from '../../src/cloud/runtime.js';
import { createClientWith } from '../../src/client/index.js';
import type { ProgressEvent } from '../../src/client/types.js';
import { DeckOpsError, isDeckOpsError } from '../../src/errors/index.js';
import { nodeRuntime } from '../../src/node/runtime.js';
import { createFakeCloud, FIXTURE_DOCUMENT, FIXTURE_MARKDOWN, type FakeCloud } from '../browser/fake-cloud.mjs';

/** No credential files and no persisted device id: the runtime only reads input paths. */
const runtime: DeckRuntime = { resolveAuthUuid: async () => '9f6b3c2e-6c1a-4f2b-9d1e-5a7c8b9d0e1f', readFile: nodeRuntime.readFile! };

let cloud: FakeCloud;
beforeAll(async () => { cloud = await createFakeCloud(); });
afterAll(async () => { await cloud.close(); });
beforeEach(() => { clearCapabilitiesCache(); });

const clientFor = (name: string) => createClientWith({ apiBase: cloud.apiBase(name), token: 'test-token', spaceId: 'test-space' }, runtime, 'node');
const file = (name: string, text = `${name} bytes`) => ({ file: new TextEncoder().encode(text), name });
const created = (name: string) => cloud.state(name).requests.filter((req) => req.path === '/tools/tasks' && req.method === 'POST');
const capabilityRequests = (name: string) => cloud.state(name).requests.filter((req) => req.path === '/tools/capabilities');

describe('render over the route table', () => {
  it.each([
    ['pptx', 'deck.pptx', 'convertor.ppt2image', { format: 'png' }],
    ['ppt', 'deck.ppt', 'convertor.ppt2image', { format: 'png' }],
    ['pdf', 'report.pdf', 'convertor.pdf2image', { format: 'png' }],
    ['key', 'slides.key', 'convertor.keynote2image', {}],
  ] as const)('renders %s frames with one task', async (caseName, name, type, params) => {
    const result = await clientFor(`render-${caseName}`).render(file(name), { to: 'image' });
    expect(created(`render-${caseName}`).map((req) => req.body)).toEqual([
      expect.objectContaining({ type, params, fileIds: ['file-1'], spaceId: 'test-space' }),
    ]);
    expect(result).toMatchObject({ to: 'image', pages: 3, warnings: [], tasks: [{ type, id: 'task-1' }] });
    expect(result.outputs.map((output) => [output.path, output.page])).toEqual([['001.png', 1], ['002.png', 2], ['003.png', 3]]);
    expect(result.outputs[0]).toMatchObject({ bytes: 8, hash: expect.stringMatching(/^[0-9a-f]{32}$/), mediaType: 'image/png' });
    if (type !== 'convertor.keynote2image') expect(result.outputs[0]).toMatchObject({ width: 1920, height: 1080 });
    expect(new Uint8Array(await (await result.outputs[0]!.blob()).arrayBuffer())).toHaveLength(8);
  });

  it('chains docx through PDF, re-uploading the intermediate result', async () => {
    const result = await clientFor('render-docx').render(file('notes.docx'), { to: 'image', quality: 'low', pages: [2] });
    const bodies = created('render-docx').map((req) => req.body as Record<string, unknown>);
    expect(bodies).toEqual([
      expect.objectContaining({ type: 'convertor.doc2pdf', params: {}, fileIds: ['file-1'] }),
      expect.objectContaining({ type: 'convertor.pdf2image', params: { resolution: 1080, format: 'jpg' }, fileIds: ['file-2'] }),
    ]);
    expect(cloud.state('render-docx').uploads.map((upload) => upload.name)).toEqual(['notes.docx', 'step-001.pdf']);
    expect(result).toMatchObject({ pages: 3, tasks: [{ type: 'convertor.doc2pdf' }, { type: 'convertor.pdf2image' }] });
    expect(result.outputs.map((output) => output.path)).toEqual(['002.jpg']);
    expect(result.warnings).toEqual([expect.stringContaining('PDF pagination')]);
  });

  it.each([
    ['html', 'page.html', 'convertor.html2png', { fullPage: true, width: 800 }],
    ['md', 'notes.md', 'convertor.markdown2png', { pageWidth: 800 }],
  ] as const)('renders %s as one image', async (caseName, name, type, params) => {
    const result = await clientFor(`render-${caseName}`).render(file(name), { to: 'image', width: 800 });
    expect(created(`render-${caseName}`)[0]?.body).toMatchObject({ type, params });
    expect(result.outputs.map((output) => output.path)).toEqual(['001.png']);
  });

  it('renders pptx to video', async () => {
    const result = await clientFor('render-video').render(file('deck.pptx'), { to: 'video' });
    expect(created('render-video')[0]?.body).toMatchObject({ type: 'convertor.ppt2video', params: {} });
    expect(result.outputs).toEqual([expect.objectContaining({ path: '001.mp4', mediaType: 'video/mp4' })]);
  });

  it('converts each selected frame to webp and nothing else', async () => {
    const result = await clientFor('render-webp').render(file('deck.pptx'), { to: 'image', imageFormat: 'webp', pages: [1, 3] });
    expect(created('render-webp').map((req) => (req.body as { type: string }).type)).toEqual([
      'convertor.ppt2image', 'image.convertWebp', 'image.convertWebp',
    ]);
    expect(created('render-webp')[0]?.body).toMatchObject({ params: { format: 'png' } });
    expect(result.outputs.map((output) => [output.path, output.page, output.width])).toEqual([['001.webp', 1, 1920], ['003.webp', 3, 1920]]);
    expect(result.tasks).toHaveLength(3);
  });

  it('refuses a page beyond the rendered count', async () => {
    await expect(clientFor('render-pages').render(file('deck.pptx'), { to: 'image', pages: [5] })).rejects.toMatchObject({
      code: 'usage_error', message: 'Requested page 5 but the document rendered 3 pages.', taskId: 'task-1',
    });
  });

  it('renders a URL only where the server lists it, and never uploads it', async () => {
    await expect(clientFor('render-url-gate').render({ url: 'https://example.com/' }, { to: 'image' })).rejects.toMatchObject({
      code: 'unsupported', hint: 'Save the page as .html and render the file.',
    });
    expect(created('render-url-gate')).toHaveLength(0);
    const result = await clientFor('render-url').render({ url: 'https://example.com/' }, { to: 'image' });
    const body = created('render-url')[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ type: 'convertor.html2png', params: { key: 'https://example.com/', fullPage: true } });
    expect(body).not.toHaveProperty('fileIds');
    expect(cloud.state('render-url').uploads).toHaveLength(0);
    expect(result.outputs).toHaveLength(1);
  });

  it('renders on a server without capabilities, which it never asks', async () => {
    await clientFor('legacy-server_render').render(file('deck.pptx'), { to: 'video' });
    expect(capabilityRequests('legacy-server_render')).toHaveLength(0);
  });
});

describe('convert and extract through document tasks', () => {
  it.each([
    ['pdf', 'report.pdf', 'pdf'],
    ['pptx', 'deck.pptx', 'pptx'],
    ['docx', 'notes.docx', 'docx'],
    ['key', 'slides.key', 'keynote'],
  ] as const)('converts %s to Markdown with signed image links', async (caseName, name, format) => {
    const result = await clientFor(`convert-${caseName}`).convert(file(name));
    const image = `${cloud.apiBase(`convert-${caseName}`)}/files/image.png?sig=fixture`;
    expect(created(`convert-${caseName}`).map((req) => req.body)).toEqual([
      expect.objectContaining({ type: 'document.convert', params: { to: 'markdown' }, fileIds: ['file-1'] }),
    ]);
    expect(result).toMatchObject({ to: 'markdown', format, pages: 2, reusedParse: false, tasks: [{ type: 'document.convert', id: 'task-1' }] });
    expect(result.content).toBe(FIXTURE_MARKDOWN.replace('assets/image.png', image));
    expect(result.images).toEqual([expect.objectContaining({ url: image, path: 'assets/image.png', mediaType: 'image/png' })]);
    expect(result.outputs.map((output) => output.path)).toEqual(['document.md', 'assets/image.png']);
    expect(result.assetsExpireAt).toBe('2026-10-27T08:00:00.000Z');
    // Signed result URLs carry no credentials.
    const fetched = cloud.state(`convert-${caseName}`).requests.filter((req) => req.path.startsWith('/files/'));
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.every((req) => req.headers['x-auth-token'] === undefined && req.headers['x-auth-uuid'] === undefined)).toBe(true);
  });

  it('converts a URL without uploading and without a file list', async () => {
    const result = await clientFor('convert-url').convert({ url: 'https://example.com/article' });
    const body = created('convert-url')[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ type: 'document.convert', params: { to: 'markdown', url: 'https://example.com/article' } });
    expect(body).not.toHaveProperty('fileIds');
    expect(cloud.state('convert-url').uploads).toHaveLength(0);
    expect(result.format).toBe('html');
  });

  it('keeps relative links on request, returns slides, and passes options and server warnings through', async () => {
    const result = await clientFor('convert-options').convert(file('deck.pptx'), { splitPages: true, strict: true, imageRefs: 'path' });
    expect(created('convert-options')[0]?.body).toMatchObject({ params: { to: 'markdown', splitPages: true, strict: true } });
    expect(result.content).toBe(FIXTURE_MARKDOWN);
    expect(result.contentPages).toEqual(['# Page one\n\n![](assets/image.png)', '# Page two']);
    const pdf = await clientFor('soft-render-error').convert(file('a.pdf'), { anchors: true, profile: 'quality' });
    expect(created('soft-render-error')[0]?.body).toMatchObject({ params: { to: 'markdown', anchors: true, parse: { profile: 'quality' } } });
    expect(pdf.warnings).toEqual(['markdownError: renderer failed']);
  });

  it.each([
    ['pdf', 'report.pdf'], ['pptx', 'deck.pptx'], ['docx', 'notes.docx'], ['key', 'slides.key'],
  ] as const)('extracts the %s document as JSON with its assets', async (caseName, name) => {
    const result = await clientFor(`extract-json-${caseName}`).extract(file(name), { to: 'json' });
    expect(created(`extract-json-${caseName}`)[0]?.body).toMatchObject({ type: 'document.extract', params: { to: 'json' } });
    expect(result).toMatchObject({ to: 'json', schemaVersion: 'result.v3', content: FIXTURE_DOCUMENT, pages: 2 });
    expect(result.assets.map((asset) => asset.path)).toEqual(['assets/image.png']);
    expect(result.outputs.map((output) => output.path)).toEqual(['document.json', 'assets/image.png']);
  });

  it.each([
    ['pdf', file('report.pdf')], ['url', { url: 'https://example.com/' }],
  ] as const)('extracts %s assets without a document download', async (caseName, input) => {
    const result = await clientFor(`extract-assets-${caseName}`).extract(input, { to: 'assets' });
    expect(created(`extract-assets-${caseName}`)[0]?.body).toMatchObject({ type: 'document.extract', params: { to: 'assets' } });
    expect(result).toMatchObject({ to: 'assets', assets: [{ path: 'assets/image.png' }] });
    expect(cloud.state(`extract-assets-${caseName}`).requests.some((req) => req.path.endsWith('document.json'))).toBe(false);
  });

  it('extracts JSON from a URL', async () => {
    const result = await clientFor('extract-json-url').extract({ url: 'https://example.com/' }, { to: 'json' });
    expect(created('extract-json-url')[0]?.body).toMatchObject({ params: { to: 'json', url: 'https://example.com/' } });
    expect(result.content).toEqual(FIXTURE_DOCUMENT);
  });

  it('uploads one File once for convert then extract, and the server reuses the parse', async () => {
    const client = clientFor('dedupe');
    const source = new File(['%PDF dedupe'], 'report.pdf');
    const first = await client.convert(source);
    const second = await client.extract(source, { to: 'json' });
    const copy = await client.extract({ file: new TextEncoder().encode('%PDF dedupe'), name: 'copy.pdf' }, { to: 'assets' });
    expect(cloud.state('dedupe').uploads).toHaveLength(1);
    expect(created('dedupe').map((req) => (req.body as { fileIds: string[] }).fileIds)).toEqual([['file-1'], ['file-1'], ['file-1']]);
    expect([first.reusedParse, second.reusedParse, copy.reusedParse]).toEqual([false, true, true]);
  });

  it('uploads again when the server forgot a reused file id', async () => {
    const client = clientFor('stale-file');
    const source = new File(['%PDF stale'], 'report.pdf');
    await client.convert(source);
    cloud.state('stale-file').expiredFiles = ['file-1'];
    const result = await client.convert(source);
    expect(cloud.state('stale-file').uploads.map((upload) => upload.id)).toEqual(['file-1', 'file-2']);
    expect(created('stale-file').map((req) => (req.body as { fileIds: string[] }).fileIds)).toEqual([['file-1'], ['file-1'], ['file-2']]);
    expect(result.tasks).toEqual([{ type: 'document.convert', id: 'task-2' }]);
  });
});

describe('the version gate', () => {
  it('fails convert and extract on a server without document tasks, before any upload', async () => {
    const client = clientFor('legacy-server');
    await expect(client.convert(file('report.pdf'))).rejects.toMatchObject({
      code: 'unsupported',
      message: `The DeckOps Cloud at ${cloud.apiBase('legacy-server')} does not offer document.convert to markdown.`,
      hint: expect.stringContaining('Upgrade the server'),
    });
    await expect(client.extract(file('report.pdf'), { to: 'json' })).rejects.toMatchObject({ code: 'unsupported' });
    expect(cloud.state('legacy-server').uploads).toHaveLength(0);
    expect(created('legacy-server')).toHaveLength(0);
  });

  it('asks each API root once and shares the answer across clients', async () => {
    await clientFor('caps').convert(file('a.pdf'));
    await clientFor('caps').extract(file('b.pdf'), { to: 'assets' });
    expect(capabilityRequests('caps')).toHaveLength(1);
    await clientFor('caps-other').convert(file('a.pdf'));
    expect(capabilityRequests('caps-other')).toHaveLength(1);
  });
});

describe('errors, progress and cancellation', () => {
  it('maps insufficientPackage to quota_error and keeps the server body for a top-up dialog', async () => {
    const error = await clientFor('insufficient').convert(file('report.pdf')).catch((caught: unknown) => caught);
    expect(isDeckOpsError(error, 'quota_error')).toBe(true);
    expect(error).toMatchObject({
      details: { code: 'insufficientPackage', message: 'Insufficient package balance', data: ['Insufficient package balance', { need: 3, remain: 1 }] },
    });
    expect((error as DeckOpsError).exitCode).toBe(8);
  });

  it('reports a failed task with its id', async () => {
    await expect(clientFor('failed-task').render(file('deck.pptx'), { to: 'video' })).rejects.toMatchObject({
      code: 'backend_error', taskId: 'task-1', details: { reason: 'failed' }, message: 'Task failed: Fixture parser failure',
    });
  });

  it('ends a call at its timeout with the task id and reason', async () => {
    const error = await clientFor('pending').convert(file('report.pdf'), { timeout: 0.5, useEventStream: false, pollInterval: 20 })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'backend_error', taskId: 'task-1', details: { reason: 'timeout' } });
  });

  it('rejects with the caller’s own abort reason', async () => {
    const controller = new AbortController();
    const reason = new Error('user navigated away');
    const call = clientFor('pending_abort').convert(file('report.pdf'), {
      signal: controller.signal, useEventStream: false, pollInterval: 20,
      onProgress: (event) => { if (event.phase === 'task') controller.abort(reason); },
    });
    await expect(call).rejects.toBe(reason);
  });

  it('reports upload, then the task with its id, then the download, for this call only', async () => {
    const events: ProgressEvent[] = [];
    const client = clientFor('progress');
    const source = new File(['%PDF progress'], 'report.pdf');
    await client.convert(source, { onProgress: (event) => events.push(event) });
    const phases = events.map((event) => event.phase === 'task' ? `task:${event.status}` : `${event.phase}:${event.progress}`);
    expect(phases[0]).toBe('upload:1');
    expect(events).toContainEqual({ phase: 'task', type: 'document.convert', id: 'task-1', spaceId: 'test-space', status: 'pending' });
    expect(phases.slice(phases.indexOf('task:completed'))).toEqual(['task:completed', 'download:0', 'download:1']);

    const reused: ProgressEvent[] = [];
    await client.extract(source, { to: 'assets', onProgress: (event) => reused.push(event) });
    expect(reused[0]).toEqual({ phase: 'upload', progress: 1 });
    expect(reused.filter((event) => event.phase === 'task').every((event) => event.phase === 'task' && event.id === 'task-2')).toBe(true);
  });

  it('rejects unknown options by name and targets a verb does not have', async () => {
    const client = clientFor('options');
    await expect(client.convert(file('a.pdf'), { preflight: 'off' } as never)).rejects.toMatchObject({
      code: 'usage_error', message: 'Unknown operation option: preflight.',
    });
    await expect(client.convert(file('a.pdf'), { to: 'pdf' } as never)).rejects.toMatchObject({ code: 'unsupported', hint: 'convert supports markdown.' });
    await expect(client.render(file('a.pdf'), {} as never)).rejects.toMatchObject({ code: 'usage_error' });
    await expect(client.render(file('a.md'), { to: 'video' })).rejects.toMatchObject({ code: 'unsupported' });
    expect(cloud.state('options').requests).toHaveLength(0);
  });
});

describe('low level and resume', () => {
  it('continues a submitted document task without uploading or creating it again', async () => {
    const client = clientFor('resume');
    const first = await client.convert(file('report.pdf'));
    const resumed = await client.run('convert', file('report.pdf'), {}, { resume: first.tasks[0]! });
    expect(created('resume')).toHaveLength(1);
    expect(cloud.state('resume').uploads).toHaveLength(1);
    expect(resumed).toMatchObject({ tasks: [{ type: 'document.convert', id: 'task-1' }], reusedParse: false });
  });

  it('inspects, waits for and downloads a task by id, and uploads a file once', async () => {
    const client = clientFor('low-level');
    const uploaded = await client.files.upload(file('report.pdf'));
    expect(uploaded).toEqual({ id: 'file-1', name: 'report.pdf', bytes: 16 });
    const result = await client.extract({ file: new TextEncoder().encode('report.pdf bytes'), name: 'report.pdf' }, { to: 'assets' });
    expect(cloud.state('low-level').uploads).toHaveLength(1);
    const id = result.tasks[0]!.id;
    expect(await client.tasks.get(id)).toMatchObject({ id, type: 'document.extract', status: 'completed' });
    expect(await client.tasks.wait(id)).toMatchObject({ status: 'completed' });
    expect(await client.tasks.download(id)).toMatchObject({ to: 'assets', assets: [{ path: 'assets/image.png' }] });
    await expect(client.tasks.get('missing')).rejects.toMatchObject({ code: 'backend_error', taskId: 'missing' });
  });
});

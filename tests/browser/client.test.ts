import { File as NodeFile } from 'node:buffer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, DeckOpsError, isDeckOpsError } from '../../src/browser/index.js';
import type { ProgressEvent } from '../../src/browser/index.js';
import { clearCapabilitiesCache } from '../../src/cloud/capabilities.js';
import { createFakeCloud, FIXTURE_DOCUMENT, FIXTURE_MARKDOWN, type FakeCloud } from './fake-cloud.mjs';

let cloud: FakeCloud;
beforeAll(async () => { cloud = await createFakeCloud(); });
afterAll(async () => { await cloud.close(); });
beforeEach(() => { clearCapabilitiesCache(); });

const submissions = (name: string) => cloud.state(name).requests.filter((req) => req.path === '/tools/tasks' && req.method === 'POST');
const apiRequests = (name: string) => cloud.state(name).requests.filter((req) => !req.path.startsWith('/results/') && !req.path.startsWith('/storage/'));
const clientFor = (name: string) => createClient({ apiBase: cloud.apiBase(name), token: 'test-token', spaceId: 'test-space' });
const url = { url: 'https://example.com/' };

describe('browser SDK over real HTTP', () => {
  it('uploads a File once, verifies it, maps PDF options and returns Markdown with signed links', async () => {
    const events: ProgressEvent[] = [];
    // Node's standards-based File lacks only the browser directory-picker field.
    const file = new NodeFile(['%PDF fixture'], 'report.pdf') as unknown as File;
    const result = await clientFor('file').convert(file, {
      profile: 'quality', includeImages: false, password: 'document-password', onProgress: (event) => events.push(event),
    });
    expect(submissions('file')[0]?.body).toMatchObject({
      type: 'document.convert', spaceId: 'test-space', fileIds: ['file-1'],
      params: { to: 'markdown', parse: { profile: 'quality', includeImages: false, password: 'document-password' } },
    });
    expect(cloud.state('file').uploads).toMatchObject([{ name: 'report.pdf', bytes: 12, status: 'uploaded' }]);
    expect(cloud.state('file').requests.filter((req) => req.path === '/files/file-1/status/uploaded')).toHaveLength(1);
    expect(result.content).toBe(FIXTURE_MARKDOWN.replace('assets/image.png', result.images[0]!.url));
    expect(events).toContainEqual({ phase: 'task', type: 'document.convert', id: 'task-1', spaceId: 'test-space', status: 'completed' });
    expect(apiRequests('file').every((req) => req.headers['x-auth-token'] === 'test-token')).toBe(true);
    expect(cloud.state('file').requests.filter((req) => req.path.startsWith('/results/'))
      .every((req) => req.headers['x-auth-token'] === undefined)).toBe(true);
  });

  it('keeps the filename of a Blob and passes keynote options to extract', async () => {
    const result = await clientFor('blob').extract({ file: new Blob(['keynote bytes']), name: 'slides.key' }, { to: 'json', stayImageAreaRate: 0.2 });
    expect(submissions('blob')[0]?.body).toMatchObject({ type: 'document.extract', params: { to: 'json', parse: { stayImageAreaRate: 0.2 } } });
    expect(cloud.state('blob').uploads).toMatchObject([{ name: 'slides.key', bytes: 13 }]);
    expect(result).toMatchObject({ to: 'json', format: 'keynote', content: FIXTURE_DOCUMENT, schemaVersion: 'result.v3' });
  });

  it.each([
    ['uint8', new Uint8Array([1, 2, 3])],
    ['arraybuffer', new Uint8Array([1, 2, 3]).buffer],
  ] as const)('accepts named %s input', async (name, file) => {
    await clientFor(name).convert({ file, name: 'notes.docx' });
    expect(cloud.state(name).uploads).toMatchObject([{ name: 'notes.docx', bytes: 3 }]);
  });

  it('converts a URL without uploading', async () => {
    const result = await clientFor('url').convert(url);
    expect(submissions('url')[0]?.body).toMatchObject({ type: 'document.convert', params: { to: 'markdown', url: 'https://example.com/' } });
    expect(submissions('url')[0]?.body).not.toHaveProperty('fileIds');
    expect(cloud.state('url').uploads).toHaveLength(0);
    expect(result.format).toBe('html');
  });

  it('uploads one File once for convert and extract', async () => {
    const client = clientFor('reuse');
    const file = new NodeFile(['%PDF reuse'], 'report.pdf') as unknown as File;
    const events: ProgressEvent[] = [];
    await client.convert(file);
    const assets = await client.extract(file, { to: 'assets', onProgress: (event) => events.push(event) });
    expect(cloud.state('reuse').uploads).toHaveLength(1);
    expect(events[0]).toEqual({ phase: 'upload', progress: 1 });
    expect(assets.reusedParse).toBe(true);
  });

  it('keeps per-call spaces isolated during concurrent calls', async () => {
    const client = createClient({ apiBase: cloud.apiBase('sse_spaces'), token: 'test-token', spaceId: 'space-A' });
    const [a, b] = await Promise.all([
      client.convert({ file: new Blob(['pdf']), name: 'a.pdf' }),
      client.convert({ url: 'https://example.com/b' }, { spaceId: 'space-B' }),
    ]);
    const tasks = cloud.state('sse_spaces').tasks;
    expect(tasks.find((task) => task.id === a.tasks[0]!.id)?.spaceId).toBe('space-A');
    expect(tasks.find((task) => task.id === b.tasks[0]!.id)?.spaceId).toBe('space-B');
    expect(await client.tasks.get(b.tasks[0]!.id, { spaceId: 'space-B' })).toMatchObject({ spaceId: 'space-B' });
    for (const task of tasks) {
      for (const request of cloud.state('sse_spaces').requests.filter((req) => req.path.startsWith(`/tools/tasks/${task.id}`))) {
        if (request.query.spaceId !== undefined) expect(request.query.spaceId).toBe(task.spaceId);
      }
    }
  });

  it('uploads to storage without credentials and reports upload progress', async () => {
    const size = 4 * 1024 * 1024 + 1;
    const progress: ProgressEvent[] = [];
    await clientFor('large').convert({ file: new Blob([new Uint8Array(size)]), name: 'large.pdf' }, { onProgress: (event) => progress.push(event) });
    const upload = cloud.state('large').requests.find((req) => req.path === '/storage/file-1');
    expect(upload?.bytes).toBe(size);
    expect(upload?.headers['x-auth-token']).toBeUndefined();
    expect(submissions('large')[0]?.headers['content-type']).toContain('application/json');
    expect(progress).toContainEqual({ phase: 'upload', progress: 1 });
  });

  it('completes multipart uploads with returned ETags before verifying', async () => {
    const size = 4 * 1024 * 1024 + 1;
    await clientFor('multipart').convert({ file: new Uint8Array(size), name: 'large.pptx' });
    const parts = cloud.state('multipart').requests.filter((req) => req.path.includes('/part-'));
    expect(parts.map((req) => req.bytes).sort((a, b) => a - b)).toEqual([1, 2 * 1024 * 1024, 2 * 1024 * 1024]);
    const paths = cloud.state('multipart').requests.map((req) => req.path);
    expect(paths.indexOf('/storage/file-1/complete')).toBeLessThan(paths.indexOf('/files/file-1/status/uploaded'));
    expect(cloud.state('multipart').requests.find((req) => req.path.endsWith('/complete'))?.body).toContain('<ETag>fixture-etag</ETag>');
  });

  it('reports an upload the server cannot verify as input_error with its body, and submits nothing', async () => {
    const error = await clientFor('bad-upload').convert({ file: new Blob(['pdf']), name: 'a.pdf' }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'input_error', details: { fileId: 'file-1', code: 'fileUploadInvalid' } });
    expect(submissions('bad-upload')).toHaveLength(0);
  });

  it('reports SSE progress and closes the stream on completion', async () => {
    const events: ProgressEvent[] = [];
    await clientFor('sse').convert(url, { onProgress: (event) => events.push(event) });
    expect(events).toContainEqual({ phase: 'task', type: 'document.convert', id: 'task-1', spaceId: 'test-space', status: 'running' });
    expect(events).toContainEqual({ phase: 'task', type: 'document.convert', id: 'task-1', spaceId: 'test-space', status: 'completed' });
    await vi.waitFor(() => expect(cloud.state('sse').activeStreams).toBe(0));
    expect(cloud.state('sse').closedStreams).toBe(1);
  });

  it('falls back to polling when a proxy returns nonterminal JSON instead of SSE', async () => {
    const result = await clientFor('json-stream').convert(url, { pollInterval: 10, timeout: 2 });
    expect(result.content).toContain('# Page one');
    const details = cloud.state('json-stream').requests.filter((req) => req.path === '/tools/tasks/task-1');
    expect(details.filter((req) => req.headers['response-event-stream'] === 'yes')).toHaveLength(1);
    expect(details.filter((req) => req.headers['response-event-stream'] !== 'yes').length).toBeGreaterThanOrEqual(2);
    expect(submissions('json-stream')).toHaveLength(1);
  });

  it('fails closed on 401, with no guest identity request or duplicated task', async () => {
    await expect(clientFor('unauthorized').convert(url)).rejects.toMatchObject({ name: 'DeckOpsError', code: 'auth_error' });
    expect(submissions('unauthorized')).toHaveLength(1);
    expect(apiRequests('unauthorized').some((req) => req.path === '/user')).toBe(false);
    expect(submissions('unauthorized')[0]?.headers['x-auth-token']).toBe('test-token');
  });

  it('also fails closed on the separate SSE transport 401 path', async () => {
    await expect(clientFor('sse-unauthorized').convert(url)).rejects.toMatchObject({ code: 'auth_error' });
    expect(submissions('sse-unauthorized')).toHaveLength(1);
    expect(apiRequests('sse-unauthorized').filter((req) => req.path !== '/tools/capabilities')
      .every((req) => req.headers['x-auth-token'] === 'test-token')).toBe(true);
    expect(apiRequests('sse-unauthorized').some((req) => req.path === '/user')).toBe(false);
  });

  it('refreshes an expired token once and never sends an anonymous retry', async () => {
    const refresh = vi.fn(async () => 'fresh-token');
    const client = createClient({ apiBase: cloud.apiBase('refresh'), token: 'stale-token', spaceId: 'test-space', onUnauthorized: refresh });
    await client.convert(url);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(submissions('refresh').map((req) => req.headers['x-auth-token'])).toEqual(['stale-token', 'fresh-token']);
    expect(cloud.state('refresh').tasks).toHaveLength(1);
  });

  const refreshes: [string, () => Promise<unknown>][] = [
    ['unauthorized_refresh', async () => { throw new Error('Session ended'); }],
    ['unauthorized_empty', async () => ''],
    ['unauthorized_identity', async () => ({ token: 'other-token', spaceId: 'other-space' })],
  ];
  it.each(refreshes)('fails closed when token refresh does not give a token for the same user (%s)', async (name, onUnauthorized) => {
    const client = createClient({ apiBase: cloud.apiBase(name), token: 'stale-token', spaceId: 'test-space', onUnauthorized: onUnauthorized as never });
    await expect(client.convert(url)).rejects.toMatchObject({ code: 'auth_error' });
    expect(submissions(name)).toHaveLength(1);
  });

  it('does not blindly retry a task-creation 502', async () => {
    await expect(clientFor('create-error').convert(url)).rejects.toBeInstanceOf(DeckOpsError);
    expect(submissions('create-error')).toHaveLength(1);
  }, 2_500);

  it('maps quota failures to quota_error and keeps the package details', async () => {
    await expect(clientFor('quota').convert(url)).rejects.toMatchObject({ name: 'DeckOpsError', code: 'quota_error' });
    const error = await clientFor('insufficient').convert(url).catch((caught: unknown) => caught);
    expect(isDeckOpsError(error, 'quota_error')).toBe(true);
    expect((error as DeckOpsError).details?.data).toEqual(['Insufficient package balance', { need: 3, remain: 1 }]);
  });

  it('reports a failed task with its id and a soft rendering failure as a warning', async () => {
    await expect(clientFor('failed-task').convert(url)).rejects.toMatchObject({ code: 'backend_error', taskId: 'task-1', details: { reason: 'failed' } });
    await expect(clientFor('soft-render-error').convert(url)).resolves.toMatchObject({ warnings: ['markdownError: renderer failed'] });
  });

  it('aborts an active SSE wait with the caller’s reason, closes the request, and submits nothing else', async () => {
    const controller = new AbortController();
    const pending = clientFor('pending').convert(url, { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(cloud.state('pending').activeStreams).toBe(1));
    controller.abort();
    await rejected;
    await vi.waitFor(() => expect(cloud.state('pending').activeStreams).toBe(0));
    expect(cloud.state('pending').closedStreams).toBe(1);
    expect(submissions('pending')).toHaveLength(1);
    expect(cloud.state('pending').requests.some((req) => req.path.endsWith('/download'))).toBe(false);
  });

  it('aborts the in-flight create request rather than only abandoning its promise', async () => {
    const controller = new AbortController();
    const pending = clientFor('hanging-create').convert(url, { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(submissions('hanging-create')).toHaveLength(1));
    controller.abort();
    await rejected;
    await vi.waitFor(() => expect(cloud.state('hanging-create').abortedCreates).toBe(1));
  });

  it('does not send requests for a pre-aborted call', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(clientFor('pre-aborted').convert(url, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(cloud.state('pre-aborted').requests).toHaveLength(0);
  });

  it('aborts a signed-upload request before any task is created', async () => {
    const controller = new AbortController();
    const pending = clientFor('hanging-upload').convert({ file: new Blob([new Uint8Array(1024)]), name: 'large.pdf' }, { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const upload = () => cloud.state('hanging-upload').requests.find((req) => req.path === '/storage/file-1');
    await vi.waitFor(() => expect(upload()).toBeDefined());
    controller.abort(); await rejected;
    await vi.waitFor(() => expect(upload()?.closed).toBe(true));
    expect(submissions('hanging-upload')).toHaveLength(0);
  });

  it('aborts the result download after task completion', async () => {
    const controller = new AbortController();
    const pending = clientFor('hanging-download').convert(url, { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const download = () => cloud.state('hanging-download').requests.find((req) => req.path.endsWith('/download'));
    await vi.waitFor(() => expect(download()).toBeDefined());
    controller.abort(); await rejected;
    await vi.waitFor(() => expect(download()?.closed).toBe(true));
    expect(submissions('hanging-download')).toHaveLength(1);
  });

  it('enforces the call timeout in seconds and closes the open SSE request', async () => {
    const started = Date.now();
    await expect(clientFor('pending_timeout').convert(url, { timeout: 0.1 })).rejects.toMatchObject({
      name: 'DeckOpsError', taskId: 'task-1', details: { reason: 'timeout' },
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    await vi.waitFor(() => expect(cloud.state('pending_timeout').activeStreams).toBe(0));
    expect(submissions('pending_timeout')).toHaveLength(1);
  });

  it('exposes the created task id and can inspect it after local cancellation', async () => {
    const controller = new AbortController();
    const client = clientFor('pending_recover');
    let submitted: string | undefined;
    const pending = client.convert(url, {
      signal: controller.signal,
      onProgress: (event) => { if (event.phase === 'task') submitted = event.id; },
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(submitted).toBe('task-1'));
    controller.abort(); await rejected;
    expect(await client.tasks.get(submitted!)).toMatchObject({ id: 'task-1', type: 'document.convert', status: 'running' });
    expect(submissions('pending_recover')).toHaveLength(1);
  });

  it('cancels polling promptly without waiting for the next polling interval', async () => {
    const controller = new AbortController();
    const pending = clientFor('pending_poll').convert(url, { signal: controller.signal, useEventStream: false, pollInterval: 5_000 });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(cloud.state('pending_poll').requests.some((req) => req.path === '/tools/tasks/task-1')).toBe(true));
    const started = Date.now(); controller.abort(); await rejected;
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(cloud.state('pending_poll').closedStreams).toBe(0);
  });

  it('rejects invalid browser inputs and options before any request', async () => {
    const client = clientFor('invalid');
    for (const input of ['/tmp/report.pdf', new Blob(['pdf']), { file: new Blob(['pdf']), name: '' },
      { file: new Blob(['pdf']), name: 'report.exe' }, { file: new Blob([]), name: 'empty.pdf' },
      { url: 'file:///tmp/report.pdf' }, { url: 'https://user:secret@example.com/' }]) {
      await expect(client.convert(input as never)).rejects.toBeInstanceOf(DeckOpsError);
    }
    await expect(client.convert({ file: new Blob(['slides']), name: 'slides.pptx' }, { anchors: true })).rejects.toMatchObject({ code: 'usage_error' });
    await expect(client.convert({ file: new Blob(['pdf']), name: 'a.pdf' }, { to: 'html' } as never)).rejects.toMatchObject({ code: 'unsupported' });
    await expect(client.convert({ file: new Blob(['pdf']), name: 'a.pdf' }, { preflight: 'off' } as never)).rejects.toMatchObject({
      code: 'usage_error', message: 'Unknown operation option: preflight.',
    });
    expect(() => createClient({ apiKey: 'server-secret' } as never)).toThrow(expect.objectContaining({
      code: 'usage_error', hint: expect.stringContaining('Keep server API keys on your backend'),
    }));
    expect(cloud.state('invalid').requests).toHaveLength(0);
  });
});

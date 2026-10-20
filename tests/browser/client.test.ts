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

  it('reports to each concurrent call only its own progress', async () => {
    const client = clientFor('sse_events');
    const seen: ProgressEvent[][] = [[], []];
    const results = await Promise.all(['https://example.com/a', 'https://example.com/b'].map((url, index) =>
      client.convert({ url }, { onProgress: (event) => seen[index]!.push(event) })));
    results.forEach((result, index) => {
      const ids = seen[index]!.flatMap((event) => event.phase === 'task' ? [event.id] : []);
      expect(new Set(ids)).toEqual(new Set([result.tasks[0]!.id]));
      expect(seen[index]!.filter((event) => event.phase === 'download').length).toBeGreaterThan(0);
    });
    expect(results[0]!.tasks[0]!.id).not.toBe(results[1]!.tasks[0]!.id);
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

  it('falls back to polling at once when the event stream fails at the network layer', async () => {
    const realFetch = globalThis.fetch;
    // The browser sends the task event stream through fetch; the network drops only that request.
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      new Headers(init?.headers).get('response-event-stream') === 'yes'
        ? Promise.reject(new TypeError('Failed to fetch'))
        : realFetch(input, init));
    try {
      cloud.state('sse-network').forceStatus = 'running';
      setTimeout(() => { delete cloud.state('sse-network').forceStatus; }, 300);
      const started = Date.now();
      await expect(clientFor('sse-network').convert(url, { pollInterval: 50 })).resolves.toMatchObject({ content: expect.any(String) });
      expect(Date.now() - started).toBeLessThan(1000);
      expect(cloud.state('sse-network').tasks).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
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
    // The server's own words, not a generic checkout message.
    expect((error as DeckOpsError).message).toBe('API Error (402): Insufficient package balance');
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

  for (const [ending, settings, end] of [
    ['a custom abort reason', {}, (controller: AbortController) => controller.abort(new Error('left the page'))],
    ['its own timeout', { timeout: 0.3 }, () => {}],
  ] as const) {
    it(`lets a call that joined a shared upload finish when the owner ends with ${ending}`, async () => {
      const name = `first-upload-hangs_${ending.split(' ').pop()}`;
      const client = clientFor(name);
      const file = new NodeFile(['%PDF shared'], 'shared.pdf') as unknown as File;
      const controller = new AbortController();
      const owner = client.convert(file, { ...settings, signal: controller.signal }).catch((error: unknown) => error);
      await vi.waitFor(() => expect(cloud.state(name).requests.some((req) => req.path === '/storage/file-1')).toBe(true));
      const joined = client.extract(file, { to: 'json' });
      await new Promise((resolve) => setTimeout(resolve, 50));
      end(controller);
      await expect(joined).resolves.toMatchObject({ content: FIXTURE_DOCUMENT });
      expect(await owner).toSatisfy((error: unknown) => controller.signal.aborted
        ? error === controller.signal.reason
        : isDeckOpsError(error) && (error.details as { reason?: string }).reason === 'timeout');
      expect(submissions(name).map((task) => (task.body as { fileIds?: string[] }).fileIds)).toEqual([['file-2']]);
    });
  }

  it('ends a call waiting on a shared upload by its own signal, leaving the owner uploading', async () => {
    const ownerControl = new AbortController();
    const client = clientFor('hanging-upload_joined');
    const file = new NodeFile(['%PDF shared'], 'shared.pdf') as unknown as File;
    const owner = client.convert(file, { signal: ownerControl.signal }).catch((error: unknown) => error);
    const upload = () => cloud.state('hanging-upload_joined').requests.find((req) => req.path === '/storage/file-1');
    await vi.waitFor(() => expect(upload()).toBeDefined());
    const controller = new AbortController();
    const reason = new Error('closed the dialog');
    const joined = client.extract(file, { to: 'json', signal: controller.signal }).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort(reason);
    expect(await joined).toBe(reason);
    expect(upload()?.closed).toBeFalsy();
    ownerControl.abort(); await owner;
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

  it('reports what a finished task billed and how long it ran', async () => {
    const client = clientFor('billing');
    const result = await client.convert(url);
    expect(await client.tasks.get(result.tasks[0]!.id)).toEqual({
      id: 'task-1', spaceId: 'test-space', type: 'document.convert', status: 'completed',
      credits: 15, consumedMS: 27000, createdAt: '2026-10-20T08:00:00.000Z', completedAt: '2026-10-20T08:00:27.000Z',
    });
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
    expect(await client.tasks.get(submitted!)).toEqual({
      id: 'task-1', spaceId: 'test-space', type: 'document.convert', status: 'running',
      credits: 15, createdAt: '2026-10-20T08:00:00.000Z', completedAt: null, consumedMS: null,
    });
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

  it('shares one token refresh between concurrent 401s', async () => {
    let refreshes = 0;
    const refresh = async () => { refreshes += 1; await new Promise((resolve) => setTimeout(resolve, 50)); return 'fresh-token'; };
    const client = createClient({ apiBase: cloud.apiBase('refresh_concurrent'), token: 'stale-token', spaceId: 'test-space', onUnauthorized: refresh });
    await Promise.all([client.convert(url), client.extract(url, { to: 'assets' })]);
    expect(refreshes).toBe(1);
    expect(submissions('refresh_concurrent').map((req) => req.headers['x-auth-token']).sort()).toEqual(['fresh-token', 'fresh-token', 'stale-token', 'stale-token']);
    expect(cloud.state('refresh_concurrent').tasks).toHaveLength(2);
  });

  it('retries a 401 that arrives after the shared refresh with the new token, without refreshing again', async () => {
    const refresh = vi.fn(async () => 'fresh-token');
    const client = createClient({ apiBase: cloud.apiBase('refresh-late'), token: 'stale-token', spaceId: 'test-space', onUnauthorized: refresh });
    await Promise.all([client.convert(url), client.convert({ url: 'https://example.com/b' })]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(submissions('refresh-late').map((req) => req.headers['x-auth-token']).sort()).toEqual(['fresh-token', 'fresh-token', 'stale-token', 'stale-token']);
    expect(cloud.state('refresh-late').tasks).toHaveLength(2);
  });

  it('keeps a call-level space when a refresh retries its request', async () => {
    const client = createClient({ apiBase: cloud.apiBase('refresh_space'), token: 'stale-token', spaceId: 'space-A', onUnauthorized: async () => 'fresh-token' });
    const result = await client.convert(url, { spaceId: 'space-B' });
    expect(submissions('refresh_space').map((req) => (req.body as { spaceId?: string }).spaceId)).toEqual(['space-B', 'space-B']);
    expect(cloud.state('refresh_space').tasks.find((task) => task.id === result.tasks[0]!.id)?.spaceId).toBe('space-B');
  });

  it('sends an explicit authUuid as X-Auth-UUID, a UUID or a nanoid, and rejects one that cannot be a header', async () => {
    for (const [name, authUuid] of [['auth-uuid', '0f8d1f8e-3c2b-4a6f-9e1d-2b3c4d5e6f70'], ['auth-nanoid', 'V1StGXR8_Z5jdHi6B-myT']] as const) {
      await createClient({ apiBase: cloud.apiBase(name), token: 'test-token', spaceId: 'test-space', authUuid }).convert(url);
      expect(apiRequests(name).every((req) => req.headers['x-auth-uuid'] === authUuid)).toBe(true);
    }
    for (const authUuid of ['', 'device 1', 'x'.repeat(101), 'gerät']) {
      expect(() => createClient({ authUuid })).toThrow(expect.objectContaining({
        code: 'usage_error', message: 'authUuid must be a device id of 1–100 visible ASCII characters, such as a UUID.',
      }));
    }
  });

  it('rejects with the caller’s own abort reason, or an AbortError DOMException without one', async () => {
    const reason = new Error('user left the page');
    const controller = new AbortController();
    const pending = clientFor('pending_reason').convert(url, { signal: controller.signal });
    await vi.waitFor(() => expect(submissions('pending_reason')).toHaveLength(1));
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    const bare = new AbortController(); bare.abort();
    const error = await clientFor('pending_bare').convert(url, { signal: bare.signal }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DOMException);
    expect(error).toMatchObject({ name: 'AbortError' });
  });
});

describe('browser entry without a browser', () => {
  it('imports without side effects, works during SSR, and reuses the app\'s own device id from localStorage df_uuid', async () => {
    // An app without crypto.randomUUID keeps a nanoid there; it is reused, never replaced.
    const stored = 'V1StGXR8_Z5jdHi6B-myT';
    const reads: string[] = [];
    const writes: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.resetModules();
    vi.stubGlobal('localStorage', { getItem: (key: string) => { reads.push(key); return stored; }, setItem: (key: string) => { writes.push(key); } });
    try {
      const entry = await import('../../src/browser/index.js');
      expect(reads).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
      await entry.createClient({ apiBase: cloud.apiBase('df-uuid'), token: 'test-token', spaceId: 'test-space' }).convert(url);
      expect(reads).toEqual(['df_uuid']);
      expect(writes).toEqual([]);
      expect(apiRequests('df-uuid').every((req) => req.headers['x-auth-uuid'] === stored)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      fetchSpy.mockRestore();
      vi.resetModules();
    }
  });
});

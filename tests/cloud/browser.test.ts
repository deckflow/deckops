import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserTransport as createDeck } from '../../src/cloud/browser.js';
import type { CreateDeckOptions } from '../../src/cloud/contracts.js';
import { resetRetryDelaysForTests, setRetryDelaysForTests } from '../../src/cloud/errors.js';

const root = 'https://sdk.test/v1';
const authUuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const task = { id: 't1', spaceId: 's1', type: 'convertor.ppt2image', status: 'completed' };
const client = (options: CreateDeckOptions = {}) => createDeck({ root, authUuid, spaceId: 's1', token: 'user-token', ...options });

describe('browser entry and safety', () => {
  let mock: MockAdapter;
  beforeEach(() => { mock = new MockAdapter(axios as unknown as ConstructorParameters<typeof MockAdapter>[0]); setRetryDelaysForTests([0, 0]); });
  afterEach(() => { mock.restore(); vi.unstubAllGlobals(); vi.useRealTimers(); resetRetryDelaysForTests(); });

  it('rejects local paths even while running in Node/SSR', async () => {
    await expect(client().files.prepare('/never/read/this.pdf')).rejects.toThrow(/only supported in Node/);
    expect(mock.history.get).toHaveLength(0);
  });

  it('does not downgrade a failed token or API key to guest', async () => {
    mock.onGet(`${root}/tools/tasks/t1`).reply(401, { message: 'expired' });
    await expect(client().tasks.get('t1')).rejects.toMatchObject({ statusCode: 401 });
    await expect(client({ token: undefined, apiKey: 'bad-key' }).tasks.get('t1')).rejects.toMatchObject({ statusCode: 401 });
    expect(mock.history.get).toHaveLength(2);
    expect(mock.history.get!.every((request) => !request.url?.endsWith('/user'))).toBe(true);
  });

  it('fails closed when refresh throws, without removing credentials', async () => {
    const refresh = vi.fn(async () => { throw new Error('refresh denied'); });
    mock.onGet(`${root}/tools/tasks/t1`).reply(401, { message: 'expired' });
    const deck = client({ onUnauthorized: refresh });
    await expect(deck.tasks.get('t1')).rejects.toMatchObject({ statusCode: 401 });
    expect(refresh).toHaveBeenCalledOnce();
    expect(mock.history.get).toHaveLength(1);
    expect(mock.history.get![0]?.headers?.['X-Auth-Token']).toBe('user-token');
  });

  it('retries refreshed credentials once and never downgrades after a second 401', async () => {
    const refresh = vi.fn(async () => 'new-token');
    mock.onGet(`${root}/tools/tasks/t1`).reply(401, { message: 'still expired' });
    await expect(client({ onUnauthorized: refresh }).tasks.get('t1')).rejects.toMatchObject({ statusCode: 401 });
    expect(refresh).toHaveBeenCalledOnce();
    expect(mock.history.get).toHaveLength(2);
    expect(mock.history.get![1]?.headers?.['X-Auth-Token']).toBe('new-token');
  });

  it('accepts a successful token refresh', async () => {
    mock.onGet(`${root}/tools/tasks/t1`).replyOnce(401, {}).onGet(`${root}/tools/tasks/t1`).reply(200, task);
    await expect(client({ onUnauthorized: async () => 'fresh' }).tasks.get('t1')).resolves.toMatchObject({ id: 't1' });
    expect(mock.history.get).toHaveLength(2);
  });

  it.each(['', '   ', { token: '' }, { token: '  ' }, {}, null])('fails closed for invalid refresh result %j', async (auth) => {
    mock.onGet(`${root}/tools/tasks/t1`).reply(401, { message: 'expired' });
    const refresh = vi.fn(async () => auth as { token: string });
    await expect(client({ onUnauthorized: refresh }).tasks.get('t1')).rejects.toMatchObject({ statusCode: 401 });
    expect(refresh).toHaveBeenCalledOnce();
    expect(mock.history.get).toHaveLength(1);
    expect(mock.history.get![0]?.headers?.['X-Auth-Token']).toBe('user-token');
  });

  it('does not retry an uncertain task POST but still retries reads', async () => {
    mock.onPost(`${root}/tools/tasks`).reply(502, { message: 'upstream failed' });
    mock.onGet(`${root}/tools/tasks/t1`).replyOnce(502, {}).onGet(`${root}/tools/tasks/t1`).reply(200, task);
    await expect(client().tasks.create({ type: 'convertor.ppt2image', fileIds: ['f1'] })).rejects.toMatchObject({ statusCode: 502 });
    expect(mock.history.post).toHaveLength(1);
    await expect(client().tasks.get('t1')).resolves.toMatchObject({ id: 't1' });
    expect(mock.history.get).toHaveLength(2);
  });

  it('supports an explicit mutation retry opt-in', async () => {
    mock.onPost(`${root}/tools/tasks`).replyOnce(502, {}).onPost(`${root}/tools/tasks`).reply(200, task);
    await expect(client({ retryMutations: true }).tasks.create({ type: 'convertor.ppt2image' })).resolves.toMatchObject({ id: 't1' });
    expect(mock.history.post).toHaveLength(2);
  });

  it('rejects pre-aborted upload and create without requests', async () => {
    const controller = new AbortController(); controller.abort();
    const signal = controller.signal;
    const deck = client();
    for (const promise of [
      deck.files.upload(new Blob(['x']), { name: 'a.pdf', signal }),
      deck.tasks.create({ type: 'convertor.ppt2image', signal }),
    ]) await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(mock.history.get).toHaveLength(0);
    expect(mock.history.post).toHaveLength(0);
  });

  it('cancels the default-space request before task submission', async () => {
    const controller = new AbortController();
    mock.onGet(`${root}/user`).reply((config) => {
      expect(config.signal).toBe(controller.signal);
      controller.abort();
      return [200, { id: 's1' }];
    });
    await expect(client({ spaceId: undefined }).tasks.create({ type: 'convertor.ppt2image', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mock.history.post).toHaveLength(0);
  });

  it('cancels upload storage I/O without completing or submitting a task', async () => {
    const controller = new AbortController();
    mock.onPost(`${root}/spaces/s1/file/auth`).reply((config) => {
      expect(config.signal).toBe(controller.signal);
      return [200, { id: 'f1', platform: 'oss', multipart: false, auth: { url: 'https://storage.test/file', headers: {} } }];
    });
    mock.onPut('https://storage.test/file').reply((config) => {
      expect(config.signal).toBe(controller.signal);
      controller.abort();
      return [200];
    });
    const progress = vi.fn();
    await expect(client().files.upload(new Blob(['abc']), { name: 'a.pdf', signal: controller.signal, onProgress: progress })).rejects.toMatchObject({ name: 'AbortError' });
    expect(progress).not.toHaveBeenCalled();
    expect(mock.history.put).toHaveLength(1);
    expect(mock.history.post).toHaveLength(1);
  });

  it('reports inline completion after the POST and before any wait', async () => {
    const events: string[] = [];
    mock.onPost(`${root}/tools/tasks`).reply((config) => {
      expect((config.data as FormData).get('files')).toMatchObject({ name: 'a.pdf' });
      events.push('post');
      return [200, { ...task, status: 'pending' }];
    });
    await expect(client().tasks.create({
      type: 'convertor.pdf2image', files: [{ input: new Blob(['abc']), name: 'a.pdf' }],
      upload: { onProgress: () => events.push('uploaded') }, onDispatch: () => { events.push('dispatch'); },
    })).resolves.toMatchObject({ id: 't1' });
    expect(events).toEqual(['dispatch', 'post', 'uploaded']);
    expect(mock.history.get).toHaveLength(0);
  });

  it('propagates a signal through create, wait and download', async () => {
    const signal = new AbortController().signal;
    mock.onPost(`${root}/tools/tasks`).reply((config) => {
      expect(config.signal).toBe(signal);
      return [200, { ...task, type: 'document.convert' }];
    });
    mock.onGet(`${root}/tools/tasks/t1`).reply((config) => {
      expect(config.signal).toBeDefined();
      return [200, { ...task, type: 'document.convert' }];
    });
    mock.onGet(`${root}/tools/tasks/t1/download`).reply((config) => {
      expect(config.signal).toBe(signal);
      return [200, { to: 'markdown' }];
    });
    const deck = client();
    const created = await deck.tasks.create({ type: 'document.convert', fileIds: ['f1'], signal });
    await deck.tasks.wait(created.id, { signal });
    await expect(deck.tasks.down(created.id, { signal })).resolves.toEqual({ to: 'markdown' });
  });

  it('stops poll delay immediately on abort', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    mock.onGet(`${root}/tools/tasks/t1`).reply(200, { ...task, status: 'running' });
    let updates = 0;
    const waiting = client().tasks.wait('t1', { signal: controller.signal, useEventStream: false, pollInterval: 30_000,
      onProgress: () => { if (++updates === 2) setTimeout(() => controller.abort(), 1); },
    });
    const assertion = expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(2);
    await assertion;
    expect(mock.history.get).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts a live browser SSE without reconnecting or falling back to polls', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let streamSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
      streamSignal = options.signal as AbortSignal;
      started();
      return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    mock.onGet(`${root}/tools/tasks/t1`).reply(200, { ...task, status: 'running' });
    const waiting = client().tasks.wait('t1', { signal: controller.signal });
    const assertion = expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    await ready;
    controller.abort();
    await assertion;
    expect(streamSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mock.history.get).toHaveLength(1);
  });

  it('aborts HTTP retry backoff without another request', async () => {
    vi.useFakeTimers(); setRetryDelaysForTests([5000, 10_000]);
    const controller = new AbortController();
    mock.onGet(`${root}/tools/tasks/t1`).reply(502, {});
    const waiting = client().tasks.get('t1', { signal: controller.signal });
    const assertion = expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await assertion;
    expect(mock.history.get).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes the SSE network stream when the overall wait deadline expires', async () => {
    vi.useFakeTimers();
    const closed = vi.fn();
    let streamSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
      streamSignal = options.signal as AbortSignal;
      return new Response(new ReadableStream({ cancel: closed }), { headers: { 'content-type': 'text/event-stream' } });
    }));
    mock.onGet(`${root}/tools/tasks/t1`).reply(200, { ...task, status: 'running' });
    const assertion = expect(client().tasks.wait('t1', { timeout: 0.01 })).rejects.toThrow(/did not complete/);
    await vi.advanceTimersByTimeAsync(11);
    await assertion;
    expect(streamSignal?.aborted).toBe(true);
    expect(closed).toHaveBeenCalledOnce();
    expect(mock.history.get).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps SSE authentication failures closed without polling fallback', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ message: 'expired' }), {
      status: 401, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    mock.onGet(`${root}/tools/tasks/t1`).reply(200, { ...task, status: 'running' });
    const refresh = vi.fn(async () => ({ token: '' }));
    await expect(client({ onUnauthorized: refresh }).tasks.wait('t1')).rejects.toMatchObject({ statusCode: 401 });
    expect(refresh).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mock.history.get).toHaveLength(1);
  });

  it.each(['running', 'pending'])('falls back to polling for a non-terminal SSE JSON snapshot (%s)', async (status) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ...task, status }), {
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    mock.onGet(`${root}/tools/tasks/t1`).replyOnce(200, { ...task, status })
      .onGet(`${root}/tools/tasks/t1`).replyOnce(200, { ...task, status })
      .onGet(`${root}/tools/tasks/t1`).reply(200, task);
    await expect(client().tasks.wait('t1', { timeout: 0.05, pollInterval: 1 })).resolves.toMatchObject({ status: 'completed' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mock.history.get).toHaveLength(3);
    expect(mock.history.post).toHaveLength(0);
  });

  it('accepts a terminal SSE JSON snapshot without polling', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(task), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    mock.onGet(`${root}/tools/tasks/t1`).reply(200, { ...task, status: 'running' });
    await expect(client().tasks.wait('t1', { timeout: 0.05 })).resolves.toMatchObject({ status: 'completed' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mock.history.get).toHaveLength(1);
  });

  it('rewrites multipart spaceId after auth refresh while preserving file and params', async () => {
    const seen: { space: FormDataEntryValue | null; token: unknown }[] = [];
    mock.onPost(`${root}/tools/tasks`).reply((config) => {
      const form = config.data as FormData;
      expect(form.get('files')).toMatchObject({ name: 'a.pdf', size: 3 });
      expect(JSON.parse(String(form.get('params')))).toMatchObject({ format: 'png' });
      seen.push({ space: form.get('spaceId'), token: config.headers?.['X-Auth-Token'] });
      return seen.length === 1 ? [401, { message: 'expired' }] : [200, { ...task, spaceId: 's2', type: 'convertor.pdf2image' }];
    });
    await expect(client({ onUnauthorized: async () => ({ token: 'fresh', spaceId: 's2' }) }).tasks.create({
      type: 'convertor.pdf2image', files: [{ input: new Blob(['abc']), name: 'a.pdf' }], params: { format: 'png' },
    })).resolves.toMatchObject({ spaceId: 's2' });
    expect(seen).toEqual([{ space: 's1', token: 'user-token' }, { space: 's2', token: 'fresh' }]);
  });

  it.each([false, true])('keeps a per-call space across snapshot, SSE, polling and download (SSE=%s)', async (useEventStream) => {
    const otherTask = { ...task, spaceId: 'operation-space' };
    let gets = 0;
    mock.onGet(`${root}/tools/tasks/t1`).reply((config) => {
      expect(config.params.spaceId).toBe('operation-space');
      return [200, { ...otherTask, status: ++gets === 1 ? 'running' : 'completed' }];
    });
    mock.onGet(`${root}/tools/tasks/t1/download`).reply((config) => {
      expect(config.params.spaceId).toBe('operation-space');
      return [200, [['https://files.test/1.png', 1, 'h']]];
    });
    const fetchMock = vi.fn(async (url: string) => {
      expect(new URL(url).searchParams.get('spaceId')).toBe('operation-space');
      return new Response(JSON.stringify({ ...otherTask, status: 'running' }), { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const deck = client();
    await expect(deck.tasks.wait('t1', { spaceId: 'operation-space', useEventStream, timeout: 0.05, pollInterval: 1 }))
      .resolves.toMatchObject({ status: 'completed' });
    await expect(deck.tasks.down('t1', { spaceId: 'operation-space' })).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(useEventStream ? 1 : 0);
    expect(gets).toBe(2);
  });
});

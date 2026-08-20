import { Readable } from 'node:stream';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { resetAuthUuidCacheForTests } from '../../src/auth-uuid.js';
import { resetRetryDelaysForTests, setRetryDelaysForTests } from '../../src/errors.js';
import { createDeck, DEFAULT_ROOT, isValidAuthUuid, APIError } from '../../src/index.js';

const TEST_AUTH_UUID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('@deckops/sdk', () => {
  let mock: MockAdapter;

  beforeEach(() => {
    mock = new MockAdapter(axios);
    resetAuthUuidCacheForTests();
    resetRetryDelaysForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    mock.restore();
  });

  it('uses the default root', () => {
    const deck = createDeck();
    expect(deck.root).toBe(DEFAULT_ROOT);
  });

  it('sends token and apiKey headers when creating a task', async () => {
    const deck = createDeck({
      root: 'http://localhost:3000/api',
      token: 'token-1',
      apiKey: 'key-1',
      spaceId: 'space-1',
    });

    mock.onPost('http://localhost:3000/api/tools/tasks').reply((config) => {
      expect(config.headers?.['X-Auth-Token']).toBe('token-1');
      expect(config.headers?.Authorization).toBe('Bearer key-1');
      expect(JSON.parse(String(config.data))).toMatchObject({
        spaceId: 'space-1',
        fileIds: ['file-1'],
        type: 'convertor.ppt2pdf',
        name: 'slides',
        params: {},
      });
      return [
        200,
        {
          id: 'task-1',
          spaceId: 'space-1',
          type: 'convertor.ppt2pdf',
          status: 'pending',
        },
      ];
    });

    const task = await deck.convertPptToPdf({ fileIds: ['file-1'], name: 'slides' });
    expect(task.id).toBe('task-1');
  });

  it('resolves spaceId from user.self when not configured', async () => {
    const deck = createDeck({
      root: 'http://localhost:3000/api',
      token: 'token-1',
    });

    mock.onGet('http://localhost:3000/api/user').reply((config) => {
      expect(config.headers?.['X-Auth-Token']).toBe('token-1');
      return [200, { id: 'space-from-user' }];
    });
    mock.onPost('http://localhost:3000/api/tools/tasks').reply((config) => {
      expect(JSON.parse(String(config.data))).toMatchObject({
        spaceId: 'space-from-user',
        fileIds: ['file-1'],
        type: 'convertor.ppt2pdf',
      });
      return [
        200,
        {
          id: 'task-1',
          spaceId: 'space-from-user',
          type: 'convertor.ppt2pdf',
          status: 'pending',
        },
      ];
    });

    const task = await deck.convertPptToPdf({ fileIds: ['file-1'] });
    expect(task.id).toBe('task-1');
  });

  it('resolves spaceId from user.self using apiKey when not configured', async () => {
    const deck = createDeck({
      root: 'http://localhost:3000/api',
      apiKey: 'key-1',
    });

    mock.onGet('http://localhost:3000/api/user').reply((config) => {
      expect(config.headers?.Authorization).toBe('Bearer key-1');
      return [200, { id: 'space-from-api-key' }];
    });
    mock.onPost('http://localhost:3000/api/tools/tasks').reply((config) => {
      expect(JSON.parse(String(config.data))).toMatchObject({
        spaceId: 'space-from-api-key',
      });
      return [
        200,
        {
          id: 'task-1',
          spaceId: 'space-from-api-key',
          type: 'convertor.ppt2pdf',
          status: 'pending',
        },
      ];
    });

    const task = await deck.convertPptToPdf({ fileIds: ['file-1'] });
    expect(task.spaceId).toBe('space-from-api-key');
  });

  it('sends schema-aligned task params unchanged', async () => {
    const deck = createDeck({ root: 'http://localhost:3000/api', token: 'token-1', spaceId: 'space-1' });

    mock.onPost('http://localhost:3000/api/tools/tasks').reply((config) => {
      expect(JSON.parse(String(config.data))).toMatchObject({
        spaceId: 'space-1',
        fileIds: ['file-1'],
        type: 'convertor.ppt2image',
        params: { resolution: 1920, format: 'jpg' },
      });
      return [
        200,
        {
          id: 'task-1',
          spaceId: 'space-1',
          type: 'convertor.ppt2image',
          status: 'pending',
        },
      ];
    });

    const task = await deck.convertPptToImage({
      fileIds: ['file-1'],
      params: { resolution: 1920, format: 'jpg' },
    });
    expect(task.type).toBe('convertor.ppt2image');
  });

  it('lists, gets, deletes, and waits for tasks', async () => {
    const deck = createDeck({ root: 'http://localhost:3000/api', token: 'token-1', spaceId: 'space-1' });

    mock
      .onGet('http://localhost:3000/api/tools/tasks')
      .reply(200, [{ id: 'task-1', spaceId: 'space-1', type: 'image.ocr', status: 'pending' }], {
        'x-content-record-total': '1',
      });
    mock
      .onGet('http://localhost:3000/api/tools/tasks/task-1')
      .reply(200, { id: 'task-1', spaceId: 'space-1', type: 'image.ocr', status: 'completed' }, {
        'content-type': 'application/json',
      });
    mock.onDelete('http://localhost:3000/api/tools/tasks/task-1').reply(200);

    const list = await deck.tasks.list();
    expect(list.total).toBe(1);
    expect(list.tasks[0]?.id).toBe('task-1');

    const got = await deck.tasks.get('task-1');
    expect(got.status).toBe('completed');

    const waited = await deck.tasks.wait('task-1', { useEventStream: false, timeout: 5 });
    expect(waited.status).toBe('completed');

    await expect(deck.tasks.delete('task-1')).resolves.toBeUndefined();
  });

  it('falls back to polling when event stream wait is unavailable', async () => {
    const deck = createDeck({ root: 'http://localhost:3000/api', token: 'token-1', spaceId: 'space-1' });
    let polls = 0;

    mock.onGet('http://localhost:3000/api/tools/tasks/task-stream').reply((config) => {
      if (config.headers?.['response-event-stream'] === 'yes') {
        return [503, { message: 'stream unavailable' }];
      }

      polls += 1;
      return [
        200,
        {
          id: 'task-stream',
          spaceId: 'space-1',
          type: 'image.ocr',
          status: polls === 1 ? 'running' : 'completed',
        },
        { 'content-type': 'application/json' },
      ];
    });

    const task = await deck.tasks.wait('task-stream', { timeout: 5 });
    expect(task.status).toBe('completed');
    expect(polls).toBeGreaterThan(1);
  });

  it('resolves wait when task is already completed before SSE connects', async () => {
    const deck = createDeck({ root: 'http://localhost:3000/api', token: 'token-1', spaceId: 'space-1' });
    let detailCalls = 0;

    mock.onGet('http://localhost:3000/api/tools/tasks/task-done').reply((config) => {
      detailCalls += 1;
      // First call is the non-SSE status check in wait(); SSE must not be required.
      expect(config.headers?.['response-event-stream']).toBeUndefined();
      return [
        200,
        { id: 'task-done', spaceId: 'space-1', type: 'image.ocr', status: 'completed' },
        { 'content-type': 'application/json' },
      ];
    });

    const task = await deck.tasks.wait('task-done', { timeout: 5 });
    expect(task.status).toBe('completed');
    expect(detailCalls).toBe(1);
  });

  it('parses JSON task body from Node streams during SSE subscribe', async () => {
    const deck = createDeck({ root: 'http://localhost:3000/api', token: 'token-1', spaceId: 'space-1' });
    const completed = {
      id: 'task-json-stream',
      spaceId: 'space-1',
      type: 'image.ocr',
      status: 'completed' as const,
    };

    mock.onGet('http://localhost:3000/api/tools/tasks/task-json-stream').reply((config) => {
      if (config.headers?.['response-event-stream'] === 'yes') {
        // Mimic axios responseType:'stream' — JSON body arrives as a Readable.
        return [
          200,
          Readable.from([JSON.stringify(completed)]),
          { 'content-type': 'application/json' },
        ];
      }
      return [200, { ...completed, status: 'running' }, { 'content-type': 'application/json' }];
    });

    const updates: Array<{ status: string }> = [];
    const cancel = await deck.tasks.subscribe('task-json-stream', {
      onUpdate: (task) => {
        updates.push({ status: task.status });
      },
    });

    await vi.waitFor(() => {
      expect(updates).toEqual([{ status: 'completed' }]);
    });
    cancel();
  });

  it('retries event-stream task detail requests after network failures', async () => {
    vi.useFakeTimers();
    const deck = createDeck({
      root: 'http://localhost:3000/api',
      token: 'token-1',
      spaceId: 'space-1',
      authUuid: TEST_AUTH_UUID,
    });
    const url = 'http://localhost:3000/api/tools/tasks/task-retry';
    let sseAttempts = 0;

    mock.onGet(url).reply((config) => {
      if (config.headers?.['response-event-stream'] !== 'yes') {
        return [
          200,
          { id: 'task-retry', spaceId: 'space-1', type: 'image.ocr', status: 'running' },
          { 'content-type': 'application/json' },
        ];
      }

      sseAttempts += 1;
      if (sseAttempts === 1) {
        return Promise.reject(new Error('Network Error'));
      }

      return [
        200,
        Readable.from([
          `data: ${JSON.stringify({
            id: 'task-retry',
            spaceId: 'space-1',
            type: 'image.ocr',
            status: 'completed',
          })}\n\n`,
        ]),
        { 'content-type': 'text/event-stream' },
      ];
    });

    const waiting = deck.tasks.wait('task-retry', { timeout: 30 });
    await vi.advanceTimersByTimeAsync(0);
    expect(sseAttempts).toBe(1);

    await vi.advanceTimersByTimeAsync(4999);
    expect(sseAttempts).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    const task = await waiting;

    expect(task.status).toBe('completed');
    expect(sseAttempts).toBe(2);
  });

  it('stops event-stream network retries after 100 attempts', async () => {
    vi.useFakeTimers();
    const deck = createDeck({
      root: 'http://localhost:3000/api',
      token: 'token-1',
      spaceId: 'space-1',
      authUuid: TEST_AUTH_UUID,
    });
    const url = 'http://localhost:3000/api/tools/tasks/task-down';
    const onError = vi.fn();

    mock.onGet(url).networkError();

    await deck.tasks.subscribe('task-down', {
      onUpdate: () => {},
      onError,
    });

    await vi.advanceTimersByTimeAsync(5000 * 100);

    expect(mock.history.get.filter((request) => request.url === url)).toHaveLength(101);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('downloads task results through ttask.down', async () => {
    const deck = createDeck({ root: 'http://localhost:3000/api', token: 'token-1', spaceId: 'space-1' });

    mock.onGet('http://localhost:3000/api/tools/tasks/task-1/download').reply(200, [
      ['https://cdn.example.com/out.pdf', 1024, 'hash-1', { total: 12, w: 1920, h: 1080 }],
    ]);

    const result = await deck.ttask.down<'convertor.ppt2pdf'>('task-1');
    expect(result[0]?.[0]).toBe('https://cdn.example.com/out.pdf');
    expect(result[0]?.[3]?.total).toBe(12);
  });

  it('passes download type for generation-style task downloads', async () => {
    const deck = createDeck({ root: 'http://localhost:3000/api', token: 'token-1', spaceId: 'space-1' });

    mock.onGet('http://localhost:3000/api/tools/tasks/task-gen/download').reply((config) => {
      expect(config.params).toEqual({ _type: 'pptx' });
      return [200, { downloadUrl: 'https://cdn.example.com/deck.pptx' }];
    });

    const result = await deck.tasks.down<'generation'>('task-gen', { type: 'pptx' });
    expect(result.downloadUrl).toContain('deck.pptx');
  });

  it('requests upload auth and returns deduplicated file ids', async () => {
    const deck = createDeck({ root: 'http://localhost:3000/api', token: 'token-1', spaceId: 'space-1' });

    mock.onPost('http://localhost:3000/api/spaces/space-1/file/auth').reply((config) => {
      const body = JSON.parse(String(config.data));
      expect(body.name).toBe('a.txt');
      expect(body.bytes).toBe(3);
      expect(body.hash).toBe('900150983cd24fb0d6963f7d28e17f72');
      return [
        200,
        {
          id: 'file-1',
          key: 'files/a.txt',
          hash: body.hash,
          platform: 'oss',
          multipart: false,
        },
      ];
    });

    const result = await deck.files.upload(new Uint8Array([97, 98, 99]), {
      name: 'a.txt',
    });
    expect(result.id).toBe('file-1');
  });

  it('uploads files inside task helpers before creating tasks', async () => {
    const deck = createDeck({ root: 'http://localhost:3000/api', token: 'token-1', spaceId: 'space-1' });

    mock.onPost('http://localhost:3000/api/spaces/space-1/file/auth').reply((config) => {
      const body = JSON.parse(String(config.data));
      expect(body.name).toBe('slides.pptx');
      expect(body.bytes).toBe(3);
      expect(body.hash).toBe('900150983cd24fb0d6963f7d28e17f72');
      return [
        200,
        {
          id: 'uploaded-file-1',
          key: 'files/slides.pptx',
          hash: body.hash,
          platform: 'oss',
          multipart: false,
        },
      ];
    });

    mock.onPost('http://localhost:3000/api/tools/tasks').reply((config) => {
      expect(JSON.parse(String(config.data))).toMatchObject({
        spaceId: 'space-1',
        fileIds: ['existing-file', 'uploaded-file-1'],
        type: 'convertor.ppt2pdf',
      });
      return [
        200,
        {
          id: 'task-1',
          spaceId: 'space-1',
          type: 'convertor.ppt2pdf',
          status: 'pending',
          fileIds: ['existing-file', 'uploaded-file-1'],
        },
      ];
    });

    const task = await deck.convertPptToPdf({
      fileIds: ['existing-file'],
      files: [{ input: new Uint8Array([97, 98, 99]), name: 'slides.pptx' }],
    });

    expect(task.fileIds).toEqual(['existing-file', 'uploaded-file-1']);
  });

  it('calculates hashes for Blob uploads', async () => {
    const deck = createDeck({ root: 'http://localhost:3000/api', token: 'token-1', spaceId: 'space-1' });
    const file = new File([new Uint8Array([97, 98, 99])], 'browser.txt');

    mock.onPost('http://localhost:3000/api/spaces/space-1/file/auth').reply((config) => {
      const body = JSON.parse(String(config.data));
      expect(body.name).toBe('browser.txt');
      expect(body.bytes).toBe(3);
      expect(body.hash).toBe('900150983cd24fb0d6963f7d28e17f72');
      return [
        200,
        {
          id: 'browser-file-1',
          key: 'files/browser.txt',
          hash: body.hash,
          platform: 'oss',
          multipart: false,
        },
      ];
    });

    const result = await deck.files.upload(file);
    expect(result.id).toBe('browser-file-1');
  });

  it('retries once after onUnauthorized updates credentials', async () => {
    const deck = createDeck({
      root: 'http://localhost:3000/api',
      token: 'old-token',
      spaceId: 'space-old',
      authUuid: TEST_AUTH_UUID,
      onUnauthorized: async () => ({ token: 'new-token', spaceId: 'space-new' }),
    });

    mock.onGet('http://localhost:3000/api/tools/tasks/task-1').replyOnce(401, { message: 'expired' });
    mock.onGet('http://localhost:3000/api/tools/tasks/task-1').reply((config) => {
      expect(config.headers?.['X-Auth-Token']).toBe('new-token');
      expect(config.headers?.['X-Auth-UUID']).toBe(TEST_AUTH_UUID);
      expect(config.params).toEqual({ spaceId: 'space-new' });
      return [
        200,
        { id: 'task-1', spaceId: 'space-new', type: 'image.ocr', status: 'completed' },
        { 'content-type': 'application/json' },
      ];
    });

    const task = await deck.tasks.get('task-1');
    expect(task.spaceId).toBe('space-new');
  });

  it('dedupes concurrent onUnauthorized refresh across parallel 401 responses', async () => {
    let refreshCalls = 0;
    const deck = createDeck({
      root: 'http://localhost:3000/api',
      token: 'old-token',
      spaceId: 'space-old',
      authUuid: TEST_AUTH_UUID,
      onUnauthorized: async () => {
        refreshCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { token: 'new-token', spaceId: 'space-new' };
      },
    });

    mock.onGet(/http:\/\/localhost:3000\/api\/tools\/tasks\/task-[12]$/).reply((config) => {
      if (config.headers?.['X-Auth-Token'] === 'old-token') {
        return [401, { message: 'expired' }];
      }
      const taskId = String(config.url).endsWith('/task-1') ? 'task-1' : 'task-2';
      expect(config.headers?.['X-Auth-Token']).toBe('new-token');
      return [
        200,
        { id: taskId, spaceId: 'space-new', type: 'image.ocr', status: 'completed' },
        { 'content-type': 'application/json' },
      ];
    });

    const [task1, task2] = await Promise.all([
      deck.tasks.get('task-1'),
      deck.tasks.get('task-2'),
    ]);

    expect(refreshCalls).toBe(1);
    expect(task1.id).toBe('task-1');
    expect(task2.id).toBe('task-2');
  });

  it('sends updated token on later requests after setToken', async () => {
    const deck = createDeck({
      root: 'http://localhost:3000/api',
      token: 'old-token',
      spaceId: 'space-1',
      authUuid: TEST_AUTH_UUID,
    });

    let seenToken: string | undefined;
    mock.onGet('http://localhost:3000/api/tools/tasks/task-1').reply((config) => {
      seenToken = config.headers?.['X-Auth-Token'] as string | undefined;
      return [
        200,
        { id: 'task-1', spaceId: 'space-1', type: 'image.ocr', status: 'completed' },
        { 'content-type': 'application/json' },
      ];
    });

    deck.setToken('new-token');
    await deck.tasks.get('task-1');
    expect(seenToken).toBe('new-token');
  });

  it('reuses refreshed credentials across sequential requests without re-auth', async () => {
    let refreshCalls = 0;
    const deck = createDeck({
      root: 'http://localhost:3000/api',
      token: 'old-token',
      spaceId: 'space-1',
      authUuid: TEST_AUTH_UUID,
      onUnauthorized: async () => {
        refreshCalls += 1;
        return { token: 'new-token', spaceId: 'space-1' };
      },
    });

    mock.onPost('http://localhost:3000/api/tools/tasks').reply((config) => {
      if (config.headers?.['X-Auth-Token'] === 'old-token') {
        return [401, { message: 'expired' }];
      }
      return [
        200,
        { id: 'task-1', spaceId: 'space-1', type: 'convertor.html2pptx', status: 'pending' },
      ];
    });
    mock.onGet('http://localhost:3000/api/tools/tasks/task-1').reply((config) => {
      expect(config.headers?.['X-Auth-Token']).toBe('new-token');
      return [
        200,
        { id: 'task-1', spaceId: 'space-1', type: 'convertor.html2pptx', status: 'completed' },
        { 'content-type': 'application/json' },
      ];
    });

    await deck.tasks.create({ type: 'convertor.html2pptx', fileIds: ['file-1'] });
    expect(refreshCalls).toBe(1);

    await deck.tasks.get('task-1');
    expect(refreshCalls).toBe(1);
  });

  it('sends explicit authUuid as X-Auth-UUID header', async () => {
    const deck = createDeck({
      root: 'http://localhost:3000/api',
      token: 'token-1',
      spaceId: 'space-1',
      authUuid: TEST_AUTH_UUID,
    });

    mock.onPost('http://localhost:3000/api/tools/tasks').reply((config) => {
      expect(config.headers?.['X-Auth-UUID']).toBe(TEST_AUTH_UUID);
      return [
        200,
        {
          id: 'task-1',
          spaceId: 'space-1',
          type: 'convertor.ppt2pdf',
          status: 'pending',
        },
      ];
    });

    await deck.convertPptToPdf({ fileIds: ['file-1'] });
    await expect(deck.getAuthUuid()).resolves.toBe(TEST_AUTH_UUID);
  });

  it('reads authUuid from custom storage and persists newly generated values', async () => {
    let stored: string | undefined;
    const deck = createDeck({
      root: 'http://localhost:3000/api',
      token: 'token-1',
      spaceId: 'space-1',
      authUuidStorage: {
        get: () => stored,
        set: (value) => {
          stored = value;
        },
      },
    });

    mock.onPost('http://localhost:3000/api/tools/tasks').reply((config) => {
      expect(config.headers?.['X-Auth-UUID']).toMatch(UUID_V4_RE);
      return [
        200,
        {
          id: 'task-1',
          spaceId: 'space-1',
          type: 'convertor.ppt2pdf',
          status: 'pending',
        },
      ];
    });

    await deck.convertPptToPdf({ fileIds: ['file-1'] });
    expect(stored).toMatch(UUID_V4_RE);
    expect(isValidAuthUuid(stored)).toBe(true);

    const deckAgain = createDeck({
      root: 'http://localhost:3000/api',
      token: 'token-1',
      spaceId: 'space-1',
      authUuidStorage: {
        get: () => stored,
        set: (value) => {
          stored = value;
        },
      },
    });
    await expect(deckAgain.getAuthUuid()).resolves.toBe(stored);
  });

  it('reuses authUuid from custom storage when already persisted', async () => {
    const deck = createDeck({
      root: 'http://localhost:3000/api',
      token: 'token-1',
      spaceId: 'space-1',
      authUuidStorage: {
        get: () => TEST_AUTH_UUID,
        set: () => {},
      },
    });

    mock.onGet('http://localhost:3000/api/tools/tasks/task-1').reply((config) => {
      expect(config.headers?.['X-Auth-UUID']).toBe(TEST_AUTH_UUID);
      return [
        200,
        { id: 'task-1', spaceId: 'space-1', type: 'image.ocr', status: 'pending' },
        { 'content-type': 'application/json' },
      ];
    });

    await deck.tasks.get('task-1');
    await expect(deck.getAuthUuid()).resolves.toBe(TEST_AUTH_UUID);
  });

  it('falls back to guest mode on api-key 401', async () => {
    const deck = createDeck({
      root: 'http://localhost:3000/api',
      apiKey: 'key-1',
      spaceId: 'space-1',
      authUuid: TEST_AUTH_UUID,
    });

    mock
      .onGet('http://localhost:3000/api/tools/tasks/task-1')
      .replyOnce(401, { message: 'invalid key' }, { 'x-request-id': 'req-auth-1' });
    mock.onGet('http://localhost:3000/api/user').reply((config) => {
      expect(config.headers?.Authorization).toBeUndefined();
      expect(config.headers?.['X-Auth-UUID']).toBe(TEST_AUTH_UUID);
      return [200, { id: 'guest-space' }];
    });
    mock.onGet('http://localhost:3000/api/tools/tasks/task-1').reply((config) => {
      expect(config.headers?.Authorization).toBeUndefined();
      expect(config.headers?.['X-Auth-UUID']).toBe(TEST_AUTH_UUID);
      expect(config.params?.spaceId).toBe('guest-space');
      return [
        200,
        { id: 'task-1', spaceId: 'guest-space', type: 'image.ocr', status: 'completed' },
        { 'content-type': 'application/json' },
      ];
    });

    const task = await deck.tasks.get('task-1');
    expect(task.spaceId).toBe('guest-space');
  });

  it('falls back to guest mode on token 401 without onUnauthorized', async () => {
    const deck = createDeck({
      root: 'http://localhost:3000/api',
      token: 'expired-token',
      spaceId: 'space-1',
      authUuid: TEST_AUTH_UUID,
    });

    mock.onGet('http://localhost:3000/api/tools/tasks/task-1').replyOnce(401, { message: 'expired' });
    mock.onGet('http://localhost:3000/api/user').reply((config) => {
      expect(config.headers?.['X-Auth-Token']).toBeUndefined();
      expect(config.headers?.['X-Auth-UUID']).toBe(TEST_AUTH_UUID);
      return [200, { id: 'guest-space' }];
    });
    mock.onGet('http://localhost:3000/api/tools/tasks/task-1').reply((config) => {
      expect(config.headers?.['X-Auth-Token']).toBeUndefined();
      expect(config.headers?.['X-Auth-UUID']).toBe(TEST_AUTH_UUID);
      expect(config.params?.spaceId).toBe('guest-space');
      return [
        200,
        { id: 'task-1', spaceId: 'guest-space', type: 'image.ocr', status: 'completed' },
        { 'content-type': 'application/json' },
      ];
    });

    const task = await deck.tasks.get('task-1');
    expect(task.spaceId).toBe('guest-space');
  });

  it('falls back to guest mode when onUnauthorized refresh fails', async () => {
    const deck = createDeck({
      root: 'http://localhost:3000/api',
      token: 'expired-token',
      spaceId: 'space-1',
      authUuid: TEST_AUTH_UUID,
      onUnauthorized: async () => {
        throw new Error('refresh unavailable');
      },
    });

    mock.onPost('http://localhost:3000/api/tools/tasks').replyOnce(401, { message: 'expired' });
    mock.onGet('http://localhost:3000/api/user').reply(200, { id: 'guest-space' });
    mock.onPost('http://localhost:3000/api/tools/tasks').reply((config) => {
      expect(config.headers?.['X-Auth-Token']).toBeUndefined();
      expect(JSON.parse(String(config.data))).toMatchObject({
        spaceId: 'guest-space',
        type: 'convertor.ppt2pdf',
      });
      return [
        200,
        { id: 'task-guest', spaceId: 'guest-space', type: 'convertor.ppt2pdf', status: 'pending' },
      ];
    });

    const task = await deck.convertPptToPdf({ fileIds: ['file-1'] });
    expect(task.id).toBe('task-guest');
  });

  it('dedupes concurrent guest downgrade across parallel 401 responses', async () => {
    let userCalls = 0;
    const deck = createDeck({
      root: 'http://localhost:3000/api',
      token: 'expired-token',
      spaceId: 'space-old',
      authUuid: TEST_AUTH_UUID,
    });

    mock.onGet(/http:\/\/localhost:3000\/api\/tools\/tasks\/task-[12]$/).reply((config) => {
      if (config.headers?.['X-Auth-Token'] === 'expired-token') {
        return [401, { message: 'expired' }];
      }
      const taskId = String(config.url).endsWith('/task-1') ? 'task-1' : 'task-2';
      expect(config.headers?.['X-Auth-Token']).toBeUndefined();
      expect(config.params?.spaceId).toBe('guest-space');
      return [
        200,
        { id: taskId, spaceId: 'guest-space', type: 'image.ocr', status: 'completed' },
        { 'content-type': 'application/json' },
      ];
    });
    mock.onGet('http://localhost:3000/api/user').reply(() => {
      userCalls += 1;
      return [200, { id: 'guest-space' }];
    });

    const [task1, task2] = await Promise.all([
      deck.tasks.get('task-1'),
      deck.tasks.get('task-2'),
    ]);

    expect(userCalls).toBe(1);
    expect(task1.id).toBe('task-1');
    expect(task2.id).toBe('task-2');
  });

  it('prompts users to complete checkout on 402 without onPaymentRequired', async () => {
    const deck = createDeck({
      root: 'http://localhost:3000/api',
      token: 'token-1',
      spaceId: 'space-1',
      authUuid: TEST_AUTH_UUID,
    });

    mock
      .onGet('http://localhost:3000/api/tools/tasks/task-1')
      .reply(402, { message: 'payment required' }, { 'x-request-id': 'req-pay-1' });

    await expect(deck.tasks.get('task-1')).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(APIError);
      const apiError = error as APIError;
      expect(apiError.statusCode).toBe(402);
      expect(apiError.message).toContain('checkout');
      expect(apiError.message).toContain('X-RequestId: req-pay-1');
      return true;
    });
  });

  it('includes X-RequestId in other 4xx errors', async () => {
    const deck = createDeck({
      root: 'http://localhost:3000/api',
      token: 'token-1',
      spaceId: 'space-1',
      authUuid: TEST_AUTH_UUID,
    });

    mock
      .onGet('http://localhost:3000/api/tools/tasks/task-1')
      .reply(404, { message: 'task not found' }, { 'x-request-id': 'req-404-1' });

    await expect(deck.tasks.get('task-1')).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(APIError);
      const apiError = error as APIError;
      expect(apiError.statusCode).toBe(404);
      expect(apiError.message).toContain('task not found');
      expect(apiError.message).toContain('X-RequestId: req-404-1');
      return true;
    });
  });

  it('retries 502 responses up to 3 times before succeeding', async () => {
    setRetryDelaysForTests([0, 0, 0]);
    let calls = 0;
    const deck = createDeck({
      root: 'http://localhost:3000/api',
      token: 'token-1',
      spaceId: 'space-1',
      authUuid: TEST_AUTH_UUID,
    });

    mock.onGet('http://localhost:3000/api/tools/tasks/task-1').reply(() => {
      calls += 1;
      if (calls <= 3) {
        return [502, { message: 'bad gateway' }];
      }
      return [
        200,
        { id: 'task-1', spaceId: 'space-1', type: 'image.ocr', status: 'completed' },
        { 'content-type': 'application/json' },
      ];
    });

    const task = await deck.tasks.get('task-1');
    expect(task.id).toBe('task-1');
    expect(calls).toBe(4);
  });

  it('does not retry 403 business errors', async () => {
    setRetryDelaysForTests([0, 0, 0]);
    let calls = 0;
    const deck = createDeck({
      root: 'http://localhost:3000/api',
      token: 'token-1',
      spaceId: 'space-1',
      authUuid: TEST_AUTH_UUID,
    });

    mock.onGet('http://localhost:3000/api/tools/tasks/task-1/download').reply(() => {
      calls += 1;
      return [403, { message: 'forbidden' }, { 'x-request-id': 'req-403-1' }];
    });

    await expect(deck.tasks.down('task-1')).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(APIError);
      const apiError = error as APIError;
      expect(apiError.statusCode).toBe(403);
      expect(apiError.message).toContain('forbidden');
      return true;
    });
    expect(calls).toBe(1);
  });

  it('creates tasks in guest mode by resolving spaceId from /user via X-Auth-UUID', async () => {
    const deck = createDeck({
      root: 'http://localhost:3000/api',
      authUuid: TEST_AUTH_UUID,
    });

    mock.onGet('http://localhost:3000/api/user').reply((config) => {
      expect(config.headers?.['X-Auth-Token']).toBeUndefined();
      expect(config.headers?.Authorization).toBeUndefined();
      expect(config.headers?.['X-Auth-UUID']).toBe(TEST_AUTH_UUID);
      return [200, { id: 'guest-space' }];
    });
    mock.onPost('http://localhost:3000/api/tools/tasks').reply((config) => {
      expect(config.headers?.['X-Auth-UUID']).toBe(TEST_AUTH_UUID);
      expect(JSON.parse(String(config.data))).toMatchObject({
        spaceId: 'guest-space',
        fileIds: ['file-1'],
        type: 'convertor.ppt2pdf',
      });
      return [
        200,
        { id: 'task-guest', spaceId: 'guest-space', type: 'convertor.ppt2pdf', status: 'pending' },
      ];
    });

    const task = await deck.convertPptToPdf({ fileIds: ['file-1'] });
    expect(task.id).toBe('task-guest');
  });

  it('lists tasks in guest mode using spaceId resolved from /user', async () => {
    const deck = createDeck({
      root: 'http://localhost:3000/api',
      authUuid: TEST_AUTH_UUID,
    });

    mock.onGet('http://localhost:3000/api/user').reply(200, { id: 'guest-space' });
    mock.onGet('http://localhost:3000/api/tools/tasks').reply((config) => {
      expect(config.params?.spaceId).toBe('guest-space');
      return [
        200,
        [{ id: 'task-guest', spaceId: 'guest-space', type: 'image.ocr', status: 'pending' }],
        { 'x-content-record-total': '1' },
      ];
    });

    const list = await deck.tasks.list();
    expect(list.total).toBe(1);
  });

  it('uploads files in guest mode using spaceId resolved from /user', async () => {
    const deck = createDeck({
      root: 'http://localhost:3000/api',
      authUuid: TEST_AUTH_UUID,
    });

    mock.onGet('http://localhost:3000/api/user').reply(200, { id: 'guest-space' });
    mock.onPost('http://localhost:3000/api/spaces/guest-space/file/auth').reply((config) => {
      const body = JSON.parse(String(config.data));
      expect(body.name).toBe('a.txt');
      expect(body.bytes).toBe(3);
      expect(body.hash).toBe('900150983cd24fb0d6963f7d28e17f72');
      return [
        200,
        {
          id: 'file-guest-1',
          key: 'files/a.txt',
          hash: body.hash,
          platform: 'oss',
          multipart: false,
        },
      ];
    });

    const result = await deck.files.upload(new Uint8Array([97, 98, 99]), { name: 'a.txt' });
    expect(result.id).toBe('file-guest-1');
  });
});

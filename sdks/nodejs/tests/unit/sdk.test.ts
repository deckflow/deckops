import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { createDeck, DEFAULT_ROOT } from '../../src/index.js';

describe('@deckops/sdk', () => {
  let mock: MockAdapter;

  beforeEach(() => {
    mock = new MockAdapter(axios);
  });

  afterEach(() => {
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

  it('retries once after onUnauthorized updates credentials', async () => {
    const deck = createDeck({
      root: 'http://localhost:3000/api',
      token: 'old-token',
      spaceId: 'space-old',
      onUnauthorized: async () => ({ token: 'new-token', spaceId: 'space-new' }),
    });

    mock.onGet('http://localhost:3000/api/tools/tasks/task-1').replyOnce(401, { message: 'expired' });
    mock.onGet('http://localhost:3000/api/tools/tasks/task-1').reply((config) => {
      expect(config.headers?.['X-Auth-Token']).toBe('new-token');
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
});

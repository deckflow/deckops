/**
 * Unit tests for API Client module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { APIClient } from '../../src/core/api-client.js';

describe('APIClient', () => {
  let mock: MockAdapter;
  let client: APIClient;

  beforeEach(() => {
    // Create axios mock adapter
    mock = new MockAdapter(axios);
    client = new APIClient('http://localhost:3000/api', 'test-token');
  });

  afterEach(() => {
    mock.restore();
  });

  it('should initialize with correct properties', () => {
    expect(client.baseURL).toBe('http://localhost:3000/api');
    expect(client.token).toBe('test-token');
  });

  it('should build URLs correctly', () => {
    // Access private method via type assertion for testing
    const url1 = (client as any).url('/tools/tasks');
    const url2 = (client as any).url('tools/tasks');

    expect(url1).toBe('http://localhost:3000/api/tools/tasks');
    expect(url2).toBe('http://localhost:3000/api/tools/tasks');
  });

  it('should add a task', async () => {
    const mockTask = {
      id: 'task-123',
      type: 'convertor.ppt2pdf',
      status: 'pending' as const,
      spaceId: 'space-1',
    };

    mock.onPost('http://localhost:3000/api/tools/tasks').reply(200, mockTask);

    const result = await client.addTask(
      'space-1',
      ['file-1'],
      'convertor.ppt2pdf',
      'Test Task',
      { param: 'value' }
    );

    expect(result.id).toBe('task-123');
    expect(result.type).toBe('convertor.ppt2pdf');
  });

  it('should list tasks with pagination', async () => {
    const mockTasks = [
      { id: 'task-1', status: 'completed' as const, type: 'test', spaceId: 'space-1' },
      { id: 'task-2', status: 'pending' as const, type: 'test', spaceId: 'space-1' },
    ];

    mock
      .onGet('http://localhost:3000/api/tools/tasks')
      .reply(200, mockTasks, { 'x-content-record-total': '2' });

    const result = await client.listTasks('space-1');

    expect(result.total).toBe(2);
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0].id).toBe('task-1');
  });

  it('should get task details', async () => {
    const mockTask = {
      id: 'task-123',
      status: 'completed' as const,
      type: 'test',
      spaceId: 'space-1',
      result: { output: 'file-xyz' },
    };

    mock
      .onGet('http://localhost:3000/api/tools/tasks/task-123')
      .reply(200, mockTask, { 'content-type': 'application/json' });

    const result = await client.getTask('task-123');

    expect(result.id).toBe('task-123');
    expect(result.status).toBe('completed');
  });

  it('should delete a task', async () => {
    mock.onDelete('http://localhost:3000/api/tools/tasks/task-123').reply(200);

    await expect(client.deleteTask('task-123')).resolves.toBeUndefined();
  });

  it('should calculate MD5 hash correctly', async () => {
    // Create a temporary file
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-md5-'));
    const testFile = path.join(tempDir, 'test.txt');
    await fs.writeFile(testFile, 'Hello, World!');

    const hash = await APIClient.calculateMD5(testFile);

    // Verify against expected hash
    const expected = crypto.createHash('md5').update('Hello, World!').digest('hex');
    expect(hash).toBe(expected);

    // Cleanup
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should request file upload authorization', async () => {
    const mockResponse = {
      id: 'file-123',
      key: 'file-key-123',
      hash: 'abc123',
      platform: 'oss' as const,
      multipart: false,
      auth: {
        url: 'https://storage.example.com/upload',
        headers: {},
        Authorization: 'Bearer token',
      },
    };

    mock.onPost('http://localhost:3000/api/spaces/space-1/file/auth').reply(200, mockResponse);

    const result = await client.requestFileUpload('space-1', 'test.pptx', 1024, 'abc123', 10485760);

    expect(result.id).toBe('file-123');
    expect(result.key).toBe('file-key-123');
    expect(result.auth).toBeDefined();
  });

  it('should wait for task completion (polling mode)', async () => {
    // Mock sequence of responses
    let callCount = 0;
    mock.onGet('http://localhost:3000/api/tools/tasks/task-1').reply(() => {
      callCount++;
      if (callCount === 1) {
        return [
          200,
          { id: 'task-1', status: 'pending', type: 'test', spaceId: 'space-1' },
          { 'content-type': 'application/json' },
        ];
      } else if (callCount === 2) {
        return [
          200,
          { id: 'task-1', status: 'running', type: 'test', spaceId: 'space-1' },
          { 'content-type': 'application/json' },
        ];
      } else {
        return [
          200,
          {
            id: 'task-1',
            status: 'completed',
            type: 'test',
            spaceId: 'space-1',
            result: { output: 'done' },
          },
          { 'content-type': 'application/json' },
        ];
      }
    });

    const result = await client.waitForTask('task-1', 10, false);

    expect(result.status).toBe('completed');
    expect(result.result?.output).toBe('done');
  });

  it('should handle failed tasks', async () => {
    mock.onGet('http://localhost:3000/api/tools/tasks/task-1').reply(200, {
      id: 'task-1',
      status: 'failed',
      type: 'test',
      spaceId: 'space-1',
      error: 'Processing error',
    });

    await expect(client.waitForTask('task-1', 10, false)).rejects.toThrow('Task failed');
  });

  it('should handle task timeout', async () => {
    mock.onGet('http://localhost:3000/api/tools/tasks/task-1').reply(200, {
      id: 'task-1',
      status: 'pending',
      type: 'test',
      spaceId: 'space-1',
    });

    await expect(client.waitForTask('task-1', 1, false)).rejects.toThrow(
      'did not complete within'
    );
  }, 10000); // Increase timeout for this test

  it('should subscribe to task updates (mock SSE)', async () => {
    // Note: Testing real SSE is complex, so we test the basic subscription setup
    const mockTask = {
      id: 'task-1',
      status: 'completed' as const,
      type: 'test',
      spaceId: 'space-1',
      result: { output: 'done' },
    };

    // Mock as JSON response (SSE fallback)
    mock
      .onGet('http://localhost:3000/api/tools/tasks/task-1')
      .reply(200, mockTask, { 'content-type': 'application/json' });

    const updates: any[] = [];
    const onUpdate = (task: any) => {
      updates.push(task);
    };

    const cancel = await client.subscribeTaskDetail('task-1', onUpdate);

    // Give it a moment to process
    await new Promise((resolve) => setTimeout(resolve, 100));

    cancel();

    // Should have received at least one update
    expect(updates.length).toBeGreaterThan(0);
    expect(updates[0].id).toBe('task-1');
  });
});

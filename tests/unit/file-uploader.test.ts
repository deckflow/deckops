/**
 * Unit tests for File Uploader module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { FileUploader } from '../../src/core/file-uploader.js';
import { APIClient } from '../../src/core/api-client.js';

describe('FileUploader', () => {
  let mock: MockAdapter;
  let apiClient: APIClient;
  let uploader: FileUploader;
  let tempDir: string;

  beforeEach(async () => {
    mock = new MockAdapter(axios);
    apiClient = new APIClient('http://localhost:3000/api', 'test-token');
    uploader = new FileUploader(apiClient);

    // Create temp directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-upload-'));
  });

  afterEach(async () => {
    mock.restore();
    // Cleanup temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should upload file successfully (single part)', async () => {
    // Create test file
    const testFile = path.join(tempDir, 'test.pptx');
    await fs.writeFile(testFile, 'fake pptx data'.repeat(100));

    // Mock file upload authorization request
    mock
      .onPost('http://localhost:3000/api/spaces/space-1/file/auth')
      .reply(200, {
        id: 'file-123',
        key: 'file-key-123',
        hash: 'abc123',
        platform: 'oss',
        multipart: false,
        auth: {
          url: 'https://storage.example.com/upload',
          headers: {},
          Authorization: 'Bearer token',
        },
      });

    // Mock actual file upload
    mock.onPut('https://storage.example.com/upload').reply(200);

    const fileId = await uploader.uploadFile('space-1', testFile);

    expect(fileId).toBe('file-123');
  });

  it('should throw error when file not found', async () => {
    const nonExistentFile = path.join(tempDir, 'non-existent.txt');

    await expect(uploader.uploadFile('space-1', nonExistentFile)).rejects.toThrow(
      'File not found'
    );
  });

  it('should report progress during upload', async () => {
    // Create test file
    const testFile = path.join(tempDir, 'test.txt');
    await fs.writeFile(testFile, 'test data');

    // Mock file upload authorization
    mock
      .onPost('http://localhost:3000/api/spaces/space-1/file/auth')
      .reply(200, {
        id: 'file-456',
        key: 'file-key-456',
        hash: 'def456',
        platform: 'local',
        multipart: false,
        auth: {
          url: 'http://localhost:3000/upload',
          headers: {},
        },
      });

    // Mock actual upload
    mock.onPut('http://localhost:3000/upload').reply(200);

    const progressUpdates: number[] = [];
    const progressCallback = (progress: number) => {
      progressUpdates.push(progress);
    };

    await uploader.uploadFile('space-1', testFile, progressCallback);

    // Should have received progress updates
    expect(progressUpdates.length).toBeGreaterThan(0);
    // Final progress should be 1.0
    expect(progressUpdates[progressUpdates.length - 1]).toBe(1.0);
  });

  it('should handle file deduplication (already exists)', async () => {
    // Create test file
    const testFile = path.join(tempDir, 'duplicate.txt');
    await fs.writeFile(testFile, 'duplicate content');

    // Mock file upload authorization - no auth means file exists
    mock
      .onPost('http://localhost:3000/api/spaces/space-1/file/auth')
      .reply(200, {
        id: 'existing-file-789',
        key: 'file-key-789',
        hash: 'ghi789',
        platform: 'oss',
        multipart: false,
        // No 'auth' field = file already exists
      });

    const fileId = await uploader.uploadFile('space-1', testFile);

    // Should return existing file ID without uploading
    expect(fileId).toBe('existing-file-789');
  });

  it('should upload file with multipart (chunked)', async () => {
    // Create test file (large enough to trigger multipart)
    const testFile = path.join(tempDir, 'large.bin');
    const largeData = Buffer.alloc(25 * 1024 * 1024); // 25MB
    await fs.writeFile(testFile, largeData);

    // Mock multipart upload authorization
    mock
      .onPost('http://localhost:3000/api/spaces/space-1/file/auth')
      .reply(200, {
        id: 'file-multipart-123',
        key: 'file-key-mp-123',
        hash: 'jkl123',
        platform: 'oss',
        multipart: true,
        multipartPartSize: 10 * 1024 * 1024, // 10MB chunks
        multipartPartAuths: [
          {
            url: 'https://storage.example.com/upload/part1',
            headers: {},
          },
          {
            url: 'https://storage.example.com/upload/part2',
            headers: {},
          },
          {
            url: 'https://storage.example.com/upload/part3',
            headers: {},
          },
        ],
        auth: {
          url: 'https://storage.example.com/complete',
          headers: {},
        },
      });

    // Mock part uploads
    mock.onPut('https://storage.example.com/upload/part1').reply(200, '', { etag: '"etag1"' });
    mock.onPut('https://storage.example.com/upload/part2').reply(200, '', { etag: '"etag2"' });
    mock.onPut('https://storage.example.com/upload/part3').reply(200, '', { etag: '"etag3"' });

    // Mock completion
    mock.onPost('https://storage.example.com/complete').reply(200);

    const fileId = await uploader.uploadFile('space-1', testFile);

    expect(fileId).toBe('file-multipart-123');
  }, 15000); // Increase timeout for large file test
});

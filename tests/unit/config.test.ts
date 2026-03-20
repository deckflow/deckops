/**
 * Unit tests for Config module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { Config } from '../../src/core/config.js';

describe('Config', () => {
  let tempDir: string;
  let config: Config;

  beforeEach(async () => {
    // Create a temporary directory for each test
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-config-'));
    config = new Config(tempDir);
    await config.load();
  });

  afterEach(async () => {
    // Clean up temporary directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should create empty config', () => {
    expect(config.token).toBeUndefined();
    expect(config.spaceId).toBeUndefined();
  });

  it('should set and get token', async () => {
    await config.setToken('test-token-123');
    expect(config.token).toBe('test-token-123');

    // Reload to verify persistence
    const config2 = new Config(tempDir);
    await config2.load();
    expect(config2.token).toBe('test-token-123');
  });

  it('should set and get space ID', async () => {
    await config.setSpaceId('space-abc');
    expect(config.spaceId).toBe('space-abc');
  });

  it('should have API base default value', () => {
    expect(config.apiBase).toBe('https://app.deckflow.com/v1');
  });

  it('should set custom API base', async () => {
    await config.setApiBase('https://example.com/api');
    expect(config.apiBase).toBe('https://example.com/api');
  });

  it('should check if configured', async () => {
    expect(config.isConfigured()).toBe(false);

    await config.setToken('token');
    expect(config.isConfigured()).toBe(false);

    await config.setSpaceId('space');
    expect(config.isConfigured()).toBe(true);
  });

  it('should delete config key', async () => {
    await config.set('token', 'test-value');
    expect(config.get('token')).toBe('test-value');

    await config.delete('token');
    expect(config.get('token')).toBeUndefined();
  });

  it('should get all config', async () => {
    config.token = 'token';
    config.spaceId = 'space';
    await config.save();

    const allConfig = config.all();
    expect(allConfig.token).toBe('token');
    expect(allConfig.spaceId).toBe('space');
  });
});

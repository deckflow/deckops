import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrateConfig } from '../../src/config/migrate.js';
import { configPath, credentialsPath } from '../../src/config/paths.js';
import { resolveCredentials } from '../../src/config/credentials.js';
import { commonFlagsOf } from '../../src/cli/commands/run-ops.js';
import { readProductConfig, writeProductOption } from '../../src/config/product.js';
import { resolveAuthUuid, resetAuthUuidCacheForTests } from '../../src/cloud/auth-uuid.js';

const dirs: string[] = [];
const tmp = async () => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deckops-migration-')); dirs.push(dir); return dir; };
const write = async (file: string, data: unknown) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(data)); };
afterEach(async () => { vi.unstubAllEnvs(); resetAuthUuidCacheForTests(); await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

describe('migration contracts', () => {
  it('validates product options and preserves unrelated settings without writing credentials', async () => {
    const root = await tmp();
    vi.stubEnv('DECKFLOW_CONFIG_DIR', path.join(root, 'shared'));
    vi.stubEnv('DECKOPS_CONFIG_DIR', path.join(root, 'product'));
    await write(configPath(), { custom: 'keep' });
    writeProductOption('engine', 'local');
    writeProductOption('allow-upload', 'false');
    expect(readProductConfig()).toEqual({ engine: 'local', allowUpload: false });
    expect(() => writeProductOption('timeout', '-1')).toThrow('Invalid value');
    expect(() => writeProductOption('allow-upload', 'yes')).toThrow('Invalid value');
    expect(JSON.parse(await fs.readFile(configPath(), 'utf8')).custom).toBe('keep');
    await expect(fs.stat(credentialsPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('imports only valid missing fields, keeps sources and UUID, and is idempotent', async () => {
    const root = await tmp(); const sharedDir = path.join(root, 'shared');
    const fromParse = path.join(root, 'parse'); const fromTools = path.join(root, 'tools');
    await write(path.join(fromParse, 'config.json'), { engine: 'auto', timeout: -1, failOnDegraded: true, token: 'parse-token', unknown: 'skip' });
    await write(path.join(fromTools, 'config.json'), { token: 'tools-token', spaceId: 's1', webhook: 'https://example.test', retentionHours: 3 });
    await write(path.join(sharedDir, 'credentials'), { token: 'existing', custom: 42 });
    await write(path.join(sharedDir, 'deckops/config.json'), { engine: 'local', custom: 'keep' });
    await fs.writeFile(path.join(sharedDir, 'auth-uuid'), 'f47ac10b-58cc-4372-a567-0e02b2c3d479');
    const source = await fs.readFile(path.join(fromParse, 'config.json'), 'utf8');
    const result = await migrateConfig({ fromParse, fromTools, sharedDir });
    expect(JSON.stringify(result)).not.toContain('tools-token');
    expect(JSON.parse(await fs.readFile(path.join(sharedDir, 'credentials'), 'utf8'))).toEqual({ token: 'existing', custom: 42, spaceId: 's1' });
    expect(JSON.parse(await fs.readFile(path.join(sharedDir, 'deckops/config.json'), 'utf8'))).toEqual({ engine: 'local', custom: 'keep', failOnDegraded: true });
    expect(JSON.parse(await fs.readFile(path.join(sharedDir, 'decktools/config.json'), 'utf8'))).toEqual({ webhook: 'https://example.test', retentionHours: 3 });
    expect(await fs.readFile(path.join(fromParse, 'config.json'), 'utf8')).toBe(source);
    expect(await fs.readFile(path.join(sharedDir, 'auth-uuid'), 'utf8')).toBe('f47ac10b-58cc-4372-a567-0e02b2c3d479');
    expect((await fs.stat(path.join(sharedDir, 'credentials'))).mode & 0o777).toBe(0o600);
    expect((await migrateConfig({ fromParse, fromTools, sharedDir })).changes).toEqual([]);
  });

  it('dry-runs without writes and fails before writing when a target is malformed', async () => {
    const root = await tmp(); const sharedDir = path.join(root, 'shared'); const fromParse = path.join(root, 'parse'); const fromTools = path.join(root, 'tools');
    await write(path.join(fromParse, 'config.json'), { engine: 'local', token: 'secret' });
    expect((await migrateConfig({ sharedDir, fromParse, fromTools, dryRun: true })).changes).toHaveLength(2);
    await expect(fs.stat(sharedDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await write(path.join(sharedDir, 'deckops/config.json'), []);
    await expect(migrateConfig({ sharedDir, fromParse, fromTools })).rejects.toThrow('JSON object');
    await expect(fs.stat(path.join(sharedDir, 'credentials'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('isolates product paths, ignores old env names, and keeps shared UUID', async () => {
    const root = await tmp(); const shared = path.join(root, 'shared'); const product = path.join(root, 'product');
    vi.stubEnv('DECKFLOW_CONFIG_DIR', shared); vi.stubEnv('DECKOPS_CONFIG_DIR', product);
    vi.stubEnv('DECKPARSE_TOKEN', 'ignored'); vi.stubEnv('DECKTOOLS_TOKEN', 'ignored');
    vi.stubEnv('DECKOPS_TOKEN', ''); vi.stubEnv('DECKFLOW_TOKEN', '');
    vi.stubEnv('DECKOPS_AUTH_UUID', '');
    await write(path.join(shared, 'credentials'), { token: 'stored' });
    await write(path.join(product, 'config.json'), { engine: 'auto', allowUpload: false });
    await fs.writeFile(path.join(shared, 'auth-uuid'), 'f47ac10b-58cc-4372-a567-0e02b2c3d479');
    expect(configPath()).toBe(path.join(product, 'config.json'));
    expect(credentialsPath()).toBe(path.join(shared, 'credentials'));
    expect((await resolveCredentials()).token).toBe('stored');
    vi.stubEnv('DECKFLOW_TOKEN', 'shared-env'); vi.stubEnv('DECKOPS_TOKEN', 'product-env');
    expect((await resolveCredentials()).token).toBe('product-env');
    expect((await resolveCredentials({ token: 'flag' })).token).toBe('flag');
    vi.stubEnv('DECKOPS_ENGINE', 'local');
    expect(commonFlagsOf({}).engine).toBe('local');
    expect(commonFlagsOf({ engine: 'auto' }).engine).toBe('auto');
    expect(await resolveAuthUuid()).toBe('f47ac10b-58cc-4372-a567-0e02b2c3d479');
  });
});

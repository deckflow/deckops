import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, probe } from '../../src/index.js';
import { createFakeCloud, FIXTURE_MARKDOWN, type FakeCloud } from '../browser/fake-cloud.mjs';

let cloud: FakeCloud;
let work: string;
const env = { ...process.env };
beforeAll(async () => {
  cloud = await createFakeCloud();
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'deckops-sdk-'));
  process.env.DECKOPS_CACHE_DIR = path.join(work, 'cache');
  process.env.DECKFLOW_CONFIG_DIR = path.join(work, 'config');
  process.env.DECKOPS_CONFIG_DIR = path.join(work, 'config');
});
afterAll(async () => {
  await cloud.close();
  process.env = env;
  fs.rmSync(work, { recursive: true, force: true });
});

describe('Node SDK', () => {
  it('takes paths, resolves credentials on the first cloud call and returns content without writing files', async () => {
    const client = createClient({ apiBase: cloud.apiBase('sdk'), token: 'test-token', spaceId: 'test-space' });
    expect(cloud.state('sdk').requests).toHaveLength(0);
    const file = path.join(work, 'report.pdf');
    fs.writeFileSync(file, '%PDF sdk');
    const result = await client.convert(file, { imageRefs: 'path' });
    expect(result).toMatchObject({ to: 'markdown', content: FIXTURE_MARKDOWN, tasks: [{ type: 'document.convert' }] });
    expect(fs.readdirSync(work).sort()).toEqual(['cache', 'config', 'report.pdf']);
    const assets = await client.extract(file, { to: 'assets' });
    expect(assets.reusedParse).toBe(true);
    expect(cloud.state('sdk').uploads).toHaveLength(1);
  });

  it('rejects unknown client options, and probes locally without a client', async () => {
    expect(() => createClient({ engine: 'local' } as never)).toThrow(expect.objectContaining({ code: 'usage_error', message: 'Unknown client option: engine.' }));
    const report = await probe(path.resolve('tests/test-data/test.pdf'), { targets: ['page_count'] });
    expect(report).toMatchObject({ schema_version: 2, results: { 'pdf.page_count': { value: 3 } } });
    await expect(probe(path.join(work, 'missing.pdf'))).rejects.toMatchObject({ code: 'input_error' });
  });
});

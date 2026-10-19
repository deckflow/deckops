import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient, ParsedDocument } from '../../src/index.js';
import { createFakeCloud, type FakeCloud } from '../browser/fake-cloud.mjs';

let cloud: FakeCloud;
beforeAll(async () => { cloud = await createFakeCloud(); });
afterAll(async () => { await cloud.close(); });
const dirs: string[] = [];
async function temp() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deckops-sdk-')); dirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); vi.restoreAllMocks(); });

const clientFor = (name: string) => createClient({ apiBase: cloud.apiBase(name), token: 'test-token' });
const source = async (dir: string, name = 'doc.pdf') => { const file = path.join(dir, name); await fs.writeFile(file, 'fake document bytes'); return file; };

describe('Node SDK', () => {
  it('reads Markdown without writing stdout and reuses the cache', async () => {
    const dir = await temp();
    const file = await source(dir);
    const stdout = vi.spyOn(process.stdout, 'write');
    const client = clientFor('sdk-read');
    const result = await client.read(file, { cacheDir: path.join(dir, 'cache') });
    expect(result).toMatchObject({ schemaVersion: 'deckops.read.v2', format: 'markdown', report: { cacheHit: false } });
    expect(result.content).toContain('# Page one');
    expect(stdout).not.toHaveBeenCalled();
    expect((await client.read(file, { cacheDir: path.join(dir, 'cache') })).report.cacheHit).toBe(true);
    const ir = await client.read(file, { cacheDir: path.join(dir, 'cache'), format: 'ir' });
    expect(ir.content).toMatchObject({ irSchemaVersion: 'result.v3' });
  });

  it('parses to an artifact handle that returns the stored IR and converts by irKey', async () => {
    const dir = await temp();
    const client = clientFor('sdk-handle');
    const doc = await client.parse(await source(dir, 'slides.pptx'), { out: path.join(dir, 'slides') });
    expect(doc).toBeInstanceOf(ParsedDocument);
    expect(doc).toMatchObject({ dir: path.join(dir, 'slides'), taskId: 'task-1', irKey: 'fixture/task-1/ir.json', irSchemaVersion: 'result.v3' });
    expect(Date.parse(doc.expiresAt)).toBeGreaterThan(Date.now());
    expect(await doc.ir()).toMatchObject({ document: { elements: [{ text: 'Hello browser' }] } });

    const view = await doc.convert({ splitPages: true });
    expect(view).toMatchObject({ op: 'convert', format: 'pptx', taskId: 'task-2', parseTaskId: 'task-1', reusedParse: true });
    const reopened = await client.openArtifact(doc.dir);
    expect(reopened.manifest.views.markdown?.files).toHaveLength(3);
    expect((await reopened.convert({ splitPages: true })).taskId).toBeNull();

    const envelope = await client.parseEnvelope(path.join(dir, 'slides.pptx'), { out: doc.dir });
    expect(envelope).toMatchObject({ reusedParse: true, taskId: 'task-1' });
    expect(cloud.state('sdk-handle').tasks).toHaveLength(2);
  });

  it('rejects removed and unknown options instead of ignoring them', async () => {
    const dir = await temp();
    const file = await source(dir);
    const client = clientFor('sdk-options');
    await expect(client.read(file, { engine: 'local' } as never)).rejects.toMatchObject({ code: 'usage_error', message: 'Unknown read option: engine.' });
    await expect(client.parse(file, { preflight: 'off' } as never)).rejects.toMatchObject({ code: 'usage_error' });
    await expect(client.convert(file, { allowUpload: false } as never)).rejects.toMatchObject({ code: 'usage_error' });
    expect(() => createClient({ inspector: {} } as never)).toThrow('Unknown client option: inspector.');
    await expect(client.convert(file, { anchors: true, splitPages: true })).rejects.toMatchObject({ code: 'usage_error' });
    expect(cloud.state('sdk-options').requests).toHaveLength(0);
  });

  it('writes file output and a report, and rejects colliding paths before any request', async () => {
    const dir = await temp();
    const file = await source(dir);
    const client = clientFor('sdk-out');
    const out = path.join(dir, 'report.md'), reportFile = path.join(dir, 'report.json');
    const result = await client.read(file, { cacheDir: path.join(dir, 'cache'), out, reportFile });
    expect(result.content).toBeNull();
    expect(await fs.readFile(out, 'utf8')).toContain('# Page one');
    expect(JSON.parse(await fs.readFile(reportFile, 'utf8'))).toMatchObject({ schemaVersion: 'deckops.run.v2', parseTaskId: 'task-1' });
    await expect(client.read(file, { out: file })).rejects.toMatchObject({ code: 'usage_error' });
    await expect(client.read(file, { reportFile: '-' })).rejects.toMatchObject({ code: 'usage_error' });
    expect(cloud.state('sdk-out').tasks).toHaveLength(2);
  });
});

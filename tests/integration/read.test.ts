import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../../src/index.js';
import { runRead } from '../../src/core/read-op.js';
import { resolveInput } from '../../src/core/input.js';
const dirs: string[] = [];
async function temp() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deckops-read-')); dirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); vi.restoreAllMocks(); });
describe('Markdown-first content API', () => {
  it('returns Markdown and structured reports without writing stdout, then reuses the candidate', async () => {
    const cacheDir = await temp(); const client = createClient(); const file = path.resolve('tests/generated/test.docx');
    const stdout = vi.spyOn(process.stdout, 'write');
    const result = await client.read(file, { cacheDir, preflight: 'off' });
    expect(result.schemaVersion).toBe('deckops.read.v1'); expect(typeof result.content).toBe('string'); expect(result.content?.length).toBeGreaterThan(0);
    expect(result.report.decision?.policy.upload).toBe('deny'); expect(stdout).not.toHaveBeenCalled();
    const second = await client.read(file, { cacheDir, preflight: 'off', engine: 'auto' });
    expect(second.report.selected.cacheHit).toBe(true);
    const ir = await client.read(file, { cacheDir, preflight: 'off', format: 'ir' });
    expect(ir.content?.schemaVersion).toBe('deckir.v1');
  });
  it('writes file output without duplicating content and rejects collisions before parsing', async () => {
    const dir = await temp(); const client = createClient(); const file = path.resolve('tests/generated/test.docx');
    const out = path.join(dir, 'report.md'), reportFile = path.join(dir, 'report.json');
    const result = await client.read(file, { cacheDir: path.join(dir, 'cache'), preflight: 'off', out, reportFile });
    expect(result.content).toBeNull(); expect(await fs.readFile(out, 'utf8')).toContain('DeckOps deterministic');
    expect(JSON.parse(await fs.readFile(reportFile, 'utf8')).schemaVersion).toBe('deckops.run.v1');
    await expect(client.read(file, { out: file })).rejects.toMatchObject({ code: 'usage_error' });
    await expect(client.read(file, { reportFile: '-' })).rejects.toMatchObject({ code: 'usage_error' });
    await expect(client.read(file, { format: 'ir', out: path.join(dir, 'ir.json') })).rejects.toMatchObject({ code: 'usage_error' });
  });
  it('does not upload existing artifacts or fake source completeness', async () => {
    const dir = await temp(); const source = path.resolve('tests/generated/test.docx');
    const result = await createClient().read(source, { cacheDir: dir, preflight: 'off' });
    const cloud = vi.fn();
    const read = await runRead({ input: await resolveInput(result.report.artifactBase), inputLabel: result.report.artifactBase, flags: {}, common: { engine: 'auto', allowUpload: true }, cloud });
    expect(cloud).not.toHaveBeenCalled(); expect(read.report.completeness).toBe('unknown');
  });
});

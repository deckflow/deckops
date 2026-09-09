import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { createClient } from '../../src/index.js';
import { storeAsset } from '../../src/artifact/store-asset.js';
const dirs: string[] = [];
async function temp() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deckops-review-')); dirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true }))); });
describe('review: artifact delivery', () => {
  it('reports real output bytes both on initial conversion and cache hit', async () => {
    const dir = await temp(); const client = createClient();
    const parsed = await client.parseEnvelope(path.resolve('tests/generated/test.docx'), { out: path.join(dir, 'artifact'), preflight: 'off' });
    for (const out of parsed.outputs) expect(out.bytes).toBe((await fs.stat(out.file)).size);
    const first = await client.convert(parsed.artifact); const second = await client.convert(parsed.artifact);
    expect(second.engine).toBe('artifact-cache');
    expect(second.outputs).toEqual(first.outputs);
    for (const out of second.outputs) expect(out.bytes).toBeGreaterThan(0);
  });
  it('shares immutable image bytes between candidate and final artifact, including cached runs', async () => {
    const dir = await temp(); const source = path.join(dir, 'image.docx');
    const parts = { '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>body</w:t><w:drawing><a:blip r:embed="r1"/></w:drawing></w:r></w:p></w:body></w:document>', 'word/_rels/document.xml.rels': '<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/a.png"/></Relationships>' };
    await fs.writeFile(source, zipSync({ ...Object.fromEntries(Object.entries(parts).map(([k,v]) => [k,strToU8(v)])), 'word/media/a.png': new Uint8Array([137,80,78,71,13,10,26,10]) }));
    const client = createClient(); const opts = { cacheDir: path.join(dir, 'cache'), preflight: 'off' as const };
    for (let i = 0; i < 2; i++) {
      const result = await client.read(source, opts); const asset = result.assets[0]!;
      const candidate = path.join(result.report.artifactBase, 'candidates/local/assets', path.basename(asset.path));
      const a = await fs.stat(asset.path), b = await fs.stat(candidate);
      expect(a.ino).toBe(b.ino); expect(a.nlink).toBeGreaterThanOrEqual(2);
      expect(await fs.readFile(asset.path)).toEqual(await fs.readFile(candidate));
    }
  });
  it('never mutates a shared inode when repairing or replacing an asset', async () => {
    const dir = await temp(); const a = path.join(dir, 'a'), b = path.join(dir, 'b');
    await storeAsset(a, new Uint8Array([1]), []); await storeAsset(b, new Uint8Array([1]), [a]);
    await storeAsset(a, new Uint8Array([2]), [b]);
    expect([...await fs.readFile(a)]).toEqual([2]); expect([...await fs.readFile(b)]).toEqual([1]);
  });
});

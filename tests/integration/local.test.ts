import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readManifest } from '../../src/artifact/manifest.js';
import { runConvert } from '../../src/core/convert-op.js';
import { resolveInput } from '../../src/core/input.js';
import { runParse } from '../../src/core/parse-op.js';
import { validateDeckIR } from '../../src/ir/validate.js';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'deckparse-local-'));

describe('local community engine', () => {
  it.each([
    ['test.pdf', 'pdf'], ['test.pptx', 'pptx'], ['test.docx', 'docx'],
  ] as const)('parses and converts %s without a cloud client', async (fixture, format) => {
    const root = tmp(); const source = path.resolve('tests/test-data', fixture); const out = path.join(root, 'artifact');
    const parsed = await runParse({ input: await resolveInput(source), inputLabel: source, out, flags: {}, common: { engine: 'local' }, preflight: 'off' });
    expect(parsed).toMatchObject({ engine: 'local', format, reusedParse: false, irSchemaVersion: 'deckir.v1' });
    expect(parsed.irKey).toBeUndefined();
    const manifest = await readManifest(out);
    expect(manifest).toMatchObject({ manifestVersion: 2, parse: { engine: 'local', format, remote: null } });
    const ir = validateDeckIR(JSON.parse(fs.readFileSync(path.join(out, 'ir.json'), 'utf-8')));
    expect(ir.document.nodes.length).toBeGreaterThan(0);
    if (format === 'pptx' || format === 'pdf') expect(ir.document.pages.length).toBeGreaterThan(0);
    const converted = await runConvert({ input: await resolveInput(out), inputLabel: out, flags: {}, common: { engine: 'local' } });
    expect(converted).toMatchObject({ engine: 'local', format, taskId: null, reusedParse: true });
    expect(fs.readFileSync(path.join(out, 'views/markdown/index.md'), 'utf-8').length).toBeGreaterThan(20);
    const reused = await runParse({ input: await resolveInput(source), inputLabel: source, out, flags: {}, common: { engine: 'local' }, preflight: 'off' });
    expect(reused).toMatchObject({ engine: 'artifact-cache', reusedParse: true, taskId: null });
  }, 30_000);

  it('does not silently upload unsupported Keynote input', async () => {
    const source = path.resolve('tests/test-data/test.key'); let cloudCalls = 0;
    await expect(runParse({ input: await resolveInput(source), inputLabel: source, out: path.join(tmp(), 'artifact'), flags: {},
      common: { engine: 'auto' }, preflight: 'off', cloud: async () => { cloudCalls += 1; throw new Error('must not upload'); } })).rejects.toMatchObject({ code: 'unsupported' });
    expect(cloudCalls).toBe(0);
  });

  it('uses cloud for unsupported input only after auto upload authorization', async () => {
    const source = path.resolve('tests/test-data/test.key'); let cloudCalls = 0;
    const client = {
      parse: async () => { cloudCalls += 1; return { taskId: 'cloud-1', type: 'keynote.parseTextAndImage', irKey: 'remote/key.json', irSchemaVersion: 'keynote.v1', ir: { slides: [{ text: 'Cloud result' }] } }; },
      convert: async () => { throw new Error('not used'); },
    };
    const result = await runParse({ input: await resolveInput(source), inputLabel: source, out: path.join(tmp(), 'artifact'), flags: {},
      common: { engine: 'auto', allowUpload: true }, preflight: 'off', cloud: async () => client as never });
    expect(result).toMatchObject({ engine: 'cloud', taskId: 'cloud-1', irKey: 'remote/key.json' });
    expect(cloudCalls).toBe(1);
  });

  it('makes zero network requests for local file parsing and conversion', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'));
    try {
      const source = path.resolve('tests/test-data/test.docx'); const out = path.join(tmp(), 'artifact');
      await runParse({ input: await resolveInput(source), inputLabel: source, out, flags: {}, common: { engine: 'local' }, preflight: 'off' });
      await runConvert({ input: await resolveInput(out), inputLabel: out, flags: {}, common: { engine: 'local' } });
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
});

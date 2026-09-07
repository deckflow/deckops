import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readManifest } from '../../src/artifact/manifest.js';
import { runConvert } from '../../src/core/convert-op.js';
import { resolveInput } from '../../src/core/input.js';
import { runParse } from '../../src/core/parse-op.js';
import { validateDeckIR } from '../../src/ir/validate.js';
import { createClient } from '../../src/index.js';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'deckops-local-'));

describe('local community engine', () => {
  it.each([
    ['test.pdf', 'pdf'], ['test.pptx', 'pptx'], ['test.docx', 'docx'],
  ] as const)('parses and converts %s without a cloud client', async (fixture, format) => {
    const root = tmp(); const source = path.resolve('tests/generated', fixture); const out = path.join(root, 'artifact');
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
    if (format === 'pdf') {
      await expect(runConvert({ input: await resolveInput(out), inputLabel: out, flags: {}, common: { engine: 'local', failOnDegraded: true } }))
        .rejects.toMatchObject({ code: 'input_error' });
      const irFile = path.join(out, 'ir.json'); const manifestFile = path.join(out, 'manifest.json');
      const cachedIr = JSON.parse(fs.readFileSync(irFile, 'utf-8')); const cachedManifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
      const quality = { status: 'degraded', checks: [{ code: 'fixture_degraded', severity: 'warning', message: 'fixture degraded' }], coverage: {}, recommendation: 'cloud' };
      cachedIr.quality = quality; cachedManifest.quality = quality;
      fs.writeFileSync(irFile, JSON.stringify(cachedIr)); fs.writeFileSync(manifestFile, JSON.stringify(cachedManifest));
      await expect(runParse({ input: await resolveInput(source), inputLabel: source, out, flags: {}, common: { engine: 'local', failOnDegraded: true }, preflight: 'off' }))
        .rejects.toMatchObject({ code: 'input_error' });
    }
  }, 30_000);

  it('invalidates auto cache entries when the recorded parser major changes', async () => {
    const root = tmp(); const source = path.resolve('tests/generated/test.docx'); const out = path.join(root, 'artifact');
    await runParse({ input: await resolveInput(source), inputLabel: source, out, flags: {}, common: { engine: 'local' }, preflight: 'off' });
    const irFile = path.join(out, 'ir.json'); const manifestFile = path.join(out, 'manifest.json');
    const ir = JSON.parse(fs.readFileSync(irFile, 'utf-8')); const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
    ir.producer.version = '9.0.0'; manifest.parse.parser.version = '9.0.0';
    fs.writeFileSync(irFile, JSON.stringify(ir)); fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    let cloudCalls = 0;
    const reparsed = await runParse({ input: await resolveInput(source), inputLabel: source, out, flags: {}, common: { engine: 'auto', allowUpload: true }, preflight: 'off',
      cloud: async () => { cloudCalls += 1; throw new Error('cloud should not be needed'); } });
    expect(reparsed).toMatchObject({ engine: 'local', reusedParse: false }); expect(cloudCalls).toBe(0);
  }, 30_000);

  it.each(['local', 'auto'] as const)('invalidates pre-0.2 PDF parse caches in %s mode', async (engine) => {
    const root = tmp(); const source = path.resolve('tests/generated/test.pdf'); const out = path.join(root, 'artifact');
    try {
      const options = { input: await resolveInput(source), inputLabel: source, out, flags: {}, common: { engine }, preflight: 'off' as const };
      await runParse(options);
      const manifestFile = path.join(out, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
      expect(manifest.parse.parser.version).toBe('0.2.0');
      manifest.parse.parser.version = '0.1.2';
      fs.writeFileSync(manifestFile, JSON.stringify(manifest));
      expect(await runParse(options)).toMatchObject({ engine: 'local', reusedParse: false });
      expect(await runParse(options)).toMatchObject({ engine: 'artifact-cache', reusedParse: true });
      const current = await readManifest(out);
      expect(current).toMatchObject({ parse: { parser: { version: '0.2.0' } } });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  it('invalidates old local renderer views and removes stale split-page files', async () => {
    const root = tmp(); const source = path.resolve('tests/generated/test.pptx'); const out = path.join(root, 'artifact');
    await runParse({ input: await resolveInput(source), inputLabel: source, out, flags: {}, common: { engine: 'local' }, preflight: 'off' });
    await runConvert({ input: await resolveInput(out), inputLabel: out, flags: { splitPages: true }, common: { engine: 'local' } });
    const page = path.join(out, 'views/markdown/001.md'); expect(fs.existsSync(page)).toBe(true);
    const manifestFile = path.join(out, 'manifest.json'); const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
    manifest.views.markdown.rendererVersion = '0.0.0'; fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const rerendered = await runConvert({ input: await resolveInput(out), inputLabel: out, flags: { splitPages: true }, common: { engine: 'local' } });
    expect(rerendered.engine).toBe('local');
    await runConvert({ input: await resolveInput(out), inputLabel: out, flags: {}, common: { engine: 'local', force: true } });
    expect(fs.existsSync(page)).toBe(false);
  }, 30_000);

  it('does not silently upload unsupported Keynote input', async () => {
    const source = path.resolve('tests/generated/test.key'); let cloudCalls = 0;
    await expect(runParse({ input: await resolveInput(source), inputLabel: source, out: path.join(tmp(), 'artifact'), flags: {},
      common: { engine: 'auto' }, preflight: 'off', cloud: async () => { cloudCalls += 1; throw new Error('must not upload'); } })).rejects.toMatchObject({ code: 'unsupported' });
    expect(cloudCalls).toBe(0);
  });

  it('does not silently ignore cloud-only PDF profiles', async () => {
    const source = path.resolve('tests/generated/test.pdf'); let cloudCalls = 0;
    await expect(runParse({ input: await resolveInput(source), inputLabel: source, out: path.join(tmp(), 'artifact'), flags: { profile: 'quality' },
      common: { engine: 'local' }, preflight: 'off', cloud: async () => { cloudCalls += 1; throw new Error('must not upload'); } })).rejects.toMatchObject({ code: 'unsupported' });
    expect(cloudCalls).toBe(0);
  });

  it('uses cloud for unsupported input only after auto upload authorization', async () => {
    const source = path.resolve('tests/generated/test.key'); let cloudCalls = 0;
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
      const source = path.resolve('tests/generated/test.docx'); const out = path.join(tmp(), 'artifact');
      await runParse({ input: await resolveInput(source), inputLabel: source, out, flags: {}, common: { engine: 'local' }, preflight: 'off' });
      await runConvert({ input: await resolveInput(out), inputLabel: out, flags: {}, common: { engine: 'local' } });
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });

  it('validates Node SDK flags before starting local or cloud work', async () => {
    const source = path.resolve('tests/generated/test.docx'); const client = createClient();
    await expect(client.parseEnvelope(source, { trackedChanges: 'invalid' as never })).rejects.toMatchObject({ code: 'usage_error' });
    await expect(client.parseEnvelope(source, { allowUpload: true })).rejects.toMatchObject({ code: 'usage_error' });
  });
});

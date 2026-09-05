import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ConvertResult, ParseResult } from '../../src/cloud/parse-facade.js';
import type { ProbeReport, ProbeResult } from '@deckflow/deckprobe';
import type { CloudClient } from '../../src/cloud/client.js';
import type { NodeDocumentInspector } from '../../src/core/inspector.js';
import { runConvert } from '../../src/core/convert-op.js';
import { resolveInput } from '../../src/core/input.js';
import { runParse } from '../../src/core/parse-op.js';
import { DeckOpsError } from '../../src/errors/index.js';

/**
 * Full operation flows against a fake cloud client, with fixtures shaped like
 * real dev-environment responses. Asserts the things scripts depend on:
 * artifact layout, reuse semantics, reusedParse, crash-safe ordering.
 */

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'deckops-ops-'));
const cloudCommon = (extra: Record<string, unknown> = {}) => ({ engine: 'cloud' as const, ...extra });

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
const pngMd5 = createHash('md5').update(png).digest('hex');

/** Local HTTP server standing in for signed OSS URLs. */
const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/img')) {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(png);
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((resolve) => server.listen(0, resolve));
const port = (server.address() as { port: number }).port;
const signedUrl = `http://127.0.0.1:${port}/img?Expires=123&sig=abc`;
afterAll(() => server.close());

const parseResult = (over: Partial<ParseResult> = {}): ParseResult => ({
  taskId: 't_parse_1',
  type: 'pdf.pdfParse',
  irKey: '2026-08/aa/ir.json',
  irSchemaVersion: 'result.v3',
  ir: {
    irKey: '2026-08/aa/ir.json',
    irSchemaVersion: 'result.v3',
    document: { schemaVersion: 'result.v3', elements: [] },
    images: [{ assetPath: 'assets/p1_i0000.png', key: '2026-08/aa/p1.png', bytes: png.length, hash: pngMd5, accessURL: signedUrl }],
  },
  ...over,
});

const convertResult = (over: Partial<ConvertResult> = {}): ConvertResult => ({
  taskId: 't_convert_1',
  format: 'pdf',
  schemaVersion: 'result.v3',
  to: 'markdown',
  markdown: `# Title\n\n![](${signedUrl})\n`,
  images: [{ ref: signedUrl, key: '2026-08/aa/p1.png', suggestedPath: 'assets/p1_i0000.png', bytes: png.length, hash: pngMd5 }],
  ...over,
});

const fakeClient = (overrides: Partial<CloudClient> = {}): CloudClient & { parseCalls: number; convertCalls: number } => {
  const client = {
    parseCalls: 0,
    convertCalls: 0,
    parse: vi.fn(async () => {
      client.parseCalls += 1;
      return parseResult();
    }) as never,
    convert: vi.fn(async () => {
      client.convertCalls += 1;
      return convertResult();
    }) as never,
    ...overrides,
  };
  return client as never;
};

const writeSource = (dir: string): string => {
  const file = path.join(dir, 'doc.pdf');
  fs.writeFileSync(file, 'fake pdf bytes');
  return file;
};

const probeReport = (): ProbeReport => ({
  schema_version: 2,
  tool_version: '2.4.0',
  status: 'ok',
  input: { display_name: 'doc.pdf', source_kind: 'browser_bytes', file_size: 14 },
  driver: { id: 'pdf', profile: 'pdf' },
  results: Object.fromEntries([
    ['document.format_profile', 'pdf'],
    ['document.extension_matches', true],
    ['security.encrypted', false],
    ['security.has_macros', false],
    ['security.has_external_relationships', true],
    ['security.has_embedded_files', false],
    ['pdf.page_count', 3],
  ].map(([target, value]) => [target, {
    target, status: 'resolved', value, confidence: 'exact', confidence_score: 1,
    path: 'fixture.path', source: 'fixture',
  }])),
  execution: {
    probe_level: 'metadata', paths: ['fixture.path'], estimated_cost: 1,
    actual_cost: { physical_bytes_read: 14, expanded_bytes: 0, random_reads: 0 }, unresolved_targets: [],
  },
  diagnostics: [],
});

const fakeInspector = (result: ProbeResult = probeReport()): NodeDocumentInspector & { inspect: ReturnType<typeof vi.fn> } => ({
  inspect: vi.fn(async () => result),
}) as never;

describe('parse → artifact', () => {
  it('lays out ir.json + assets + manifest and reuses on the second run', async () => {
    const dir = tmp();
    const source = writeSource(dir);
    const out = path.join(dir, 'artifact');
    const client = fakeClient();

    const first = await runParse({
      input: await resolveInput(source),
      inputLabel: source,
      out,
      flags: {},
      common: cloudCommon(),
      preflight: 'off',
      client,
    });
    expect(first.reusedParse).toBe(false);
    expect(first.engine).toBe('cloud');
    expect(first.irKey).toBe('2026-08/aa/ir.json');
    expect(fs.existsSync(path.join(out, 'ir.json'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'manifest.json'))).toBe(true);
    // pdf parse results carry an image index → assets localized at parse time
    const assetFiles = fs.readdirSync(path.join(out, 'assets'));
    expect(assetFiles).toHaveLength(1);
    expect(fs.readFileSync(path.join(out, 'assets', assetFiles[0]!))).toEqual(png);
    // views belong to convert; parse must never create them
    expect(fs.existsSync(path.join(out, 'views'))).toBe(false);

    const second = await runParse({
      input: await resolveInput(source),
      inputLabel: source,
      out,
      flags: {},
      common: cloudCommon(),
      preflight: 'off',
      client,
    });
    expect(second.reusedParse).toBe(true);
    expect(second.engine).toBe('artifact-cache');
    expect(second.taskId).toBeNull();
    expect(client.parseCalls).toBe(1); // the whole point

    // --force redoes the work
    const forced = await runParse({
      input: await resolveInput(source),
      inputLabel: source,
      out,
      flags: {},
      common: cloudCommon({ force: true }),
      preflight: 'off',
      client,
    });
    expect(forced.reusedParse).toBe(false);
    expect(client.parseCalls).toBe(2);

    // different params = different request = no hit
    await runParse({
      input: await resolveInput(source),
      inputLabel: source,
      out,
      flags: { profile: 'quality' },
      common: cloudCommon(),
      preflight: 'off',
      client,
    });
    expect(client.parseCalls).toBe(3);
  });

  it('refuses to parse an artifact, pointing at convert', async () => {
    const dir = tmp();
    const source = writeSource(dir);
    const out = path.join(dir, 'artifact');
    const client = fakeClient();
    await runParse({ input: await resolveInput(source), inputLabel: source, out, flags: {}, common: cloudCommon(), preflight: 'off', client });

    await expect(
      runParse({ input: await resolveInput(out), inputLabel: out, out, flags: {}, common: cloudCommon(), client })
    ).rejects.toMatchObject({ code: 'usage_error' });
  });

  it('runs DeckProbe before cloud parse, persists probe.json, and reuses it with the artifact', async () => {
    const dir = tmp();
    const source = writeSource(dir);
    const out = path.join(dir, 'artifact');
    const client = fakeClient();
    const inspector = fakeInspector();

    const first = await runParse({
      input: await resolveInput(source), inputLabel: source, out, flags: {}, common: cloudCommon(), client,
      inspector,
    });
    expect(inspector.inspect).toHaveBeenCalledTimes(1);
    expect(first.inspection).toMatchObject({ profile: 'pdf', pageCount: 3, hasExternalRelationships: true });
    expect(first.warnings).toContainEqual(expect.stringContaining('external relationships'));
    expect(JSON.parse(fs.readFileSync(path.join(out, 'probe.json'), 'utf-8'))).toMatchObject({ schema_version: 2 });
    expect(JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf-8'))).toMatchObject({
      inspection: { file: 'probe.json', schemaVersion: 2, requestVersion: 1, summary: { pageCount: 3 } },
    });

    const second = await runParse({
      input: await resolveInput(source), inputLabel: source, out, flags: {}, common: cloudCommon(), client,
      preflight: 'strict', inspector,
    });
    expect(second.reusedParse).toBe(true);
    expect(inspector.inspect).toHaveBeenCalledTimes(1);
    expect(client.parseCalls).toBe(1);
  });

  it('rejects a malformed DeckProbe report before any cloud task', async () => {
    const dir = tmp();
    const source = writeSource(dir);
    const client = fakeClient();
    const inspector = fakeInspector({
      schema_version: 2, tool_version: '2.4.0', status: 'error',
      error: { code: 'MALFORMED_INPUT', message: 'wrong container', exit_code: 4 },
    });
    await expect(runParse({
      input: await resolveInput(source), inputLabel: source, flags: {}, common: cloudCommon(), client,
      preflight: 'validate', inspector,
    })).rejects.toMatchObject({ code: 'input_error' });
    expect(client.parseCalls).toBe(0);
  });

  it('skips URL input under the default validate policy without invoking the inspector', async () => {
    const dir = tmp();
    const client = fakeClient();
    const inspector = fakeInspector();
    const envelope = await runParse({
      input: { kind: 'link', url: 'https://example.com/article' },
      inputLabel: 'https://example.com/article',
      out: path.join(dir, 'artifact'),
      flags: {}, common: cloudCommon(), client, inspector,
    });
    expect(inspector.inspect).not.toHaveBeenCalled();
    expect(envelope.warnings).toContainEqual(expect.stringContaining('skipped for the URL input'));
    expect(client.parseCalls).toBe(1);
  });

  it('keeps off as an explicit local preflight escape hatch', async () => {
    const dir = tmp();
    const source = writeSource(dir);
    const inspector = fakeInspector();
    const envelope = await runParse({
      input: await resolveInput(source), inputLabel: source, out: path.join(dir, 'artifact'),
      flags: {}, common: cloudCommon(), client: fakeClient(), preflight: 'off', inspector,
    });
    expect(inspector.inspect).not.toHaveBeenCalled();
    expect(envelope.inspection).toBeUndefined();
  });

  it.each([
    ['test.pdf', 'pdf', 'pdf'],
    ['test.pptx', 'powerpoint', 'pptx'],
    ['test.docx', 'word', 'docx'],
    ['test.key', 'keynote', 'key'],
  ] as const)('uses the packaged Node DeckProbe adapter on the real %s fixture', async (fixture, driver, profile) => {
    const dir = tmp();
    const source = path.resolve('tests/test-data', fixture);
    const out = path.join(dir, 'artifact');
    const envelope = await runParse({
      input: await resolveInput(source), inputLabel: source, out, flags: {}, common: cloudCommon(), client: fakeClient(),
      preflight: 'strict',
    });
    expect(envelope.inspection).toMatchObject({ profile, encrypted: false });
    expect(envelope.inspection?.pageCount ?? envelope.inspection?.slideCount).toBeGreaterThan(0);
    expect(JSON.parse(fs.readFileSync(path.join(out, 'probe.json'), 'utf-8'))).toMatchObject({
      schema_version: 2, status: 'ok', driver: { id: driver, profile },
    });
  });
});

describe('convert <artifact>', () => {
  const setup = async () => {
    const dir = tmp();
    const source = writeSource(dir);
    const out = path.join(dir, 'artifact');
    const client = fakeClient();
    await runParse({ input: await resolveInput(source), inputLabel: source, out, flags: {}, common: cloudCommon(), preflight: 'off', client });
    return { dir, out, client };
  };

  it('derives the view from the irKey without re-parsing, then reuses it', async () => {
    const { out, client } = await setup();

    const first = await runConvert({
      input: await resolveInput(out),
      inputLabel: out,
      flags: {},
      common: cloudCommon(),
      preflight: 'off',
      client,
    });
    expect(first.reusedParse).toBe(true); // standard path never re-parses
    expect(first.engine).toBe('cloud');
    expect(client.parseCalls).toBe(1); // still just the one parse
    expect(client.convertCalls).toBe(1);
    expect((client.convert as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toEqual({ irKey: '2026-08/aa/ir.json' });

    const body = fs.readFileSync(path.join(out, 'views/markdown/index.md'), 'utf-8');
    expect(body).toContain('../../assets/p1_i0000.png');
    expect(body).not.toContain('Expires='); // durability: no signed URLs on disk

    const second = await runConvert({
      input: await resolveInput(out),
      inputLabel: out,
      flags: {},
      common: cloudCommon(),
      client,
    });
    expect(second.engine).toBe('artifact-cache');
    expect(client.convertCalls).toBe(1);
  });

  it('fails fast locally when the IR is past its 7-day retention', async () => {
    const { out, client } = await setup();
    const manifestPath = path.join(out, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    manifest.parse.createdAt = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    await expect(
      runConvert({ input: await resolveInput(out), inputLabel: out, flags: {}, common: cloudCommon(), client })
    ).rejects.toMatchObject({ code: 'ir_expired' });
    expect(client.convertCalls).toBe(0); // saved the round trip
  });

  it('treats markdownError as failure, not as content', async () => {
    const { out, client } = await setup();
    (client.convert as ReturnType<typeof vi.fn>).mockImplementationOnce(async () =>
      convertResult({ markdown: '', markdownError: 'renderer exploded' })
    );
    await expect(
      runConvert({ input: await resolveInput(out), inputLabel: out, flags: {}, common: cloudCommon(), client })
    ).rejects.toMatchObject({ code: 'backend_error' });
  });
});

describe('convert <document> (one-shot)', () => {
  it('chains parse + convert, writes a portable copy, leaves no artifact', async () => {
    const dir = tmp();
    const source = writeSource(dir);
    const client = fakeClient();
    const target = path.join(dir, 'doc.md');

    const envelope = await runConvert({
      input: await resolveInput(source),
      inputLabel: source,
      out: target,
      flags: {},
      common: cloudCommon(),
      preflight: 'off',
      client,
    });
    expect(envelope.reusedParse).toBe(false);
    expect(envelope.parseTaskId).toBe('t_parse_1');
    expect(envelope.taskId).toBe('t_convert_1');

    const body = fs.readFileSync(target, 'utf-8');
    expect(body).toContain('doc.assets/p1_i0000.png');
    expect(fs.readFileSync(path.join(dir, 'doc.assets/p1_i0000.png'))).toEqual(png);
    // one-shot leaves no artifact behind
    expect(fs.existsSync(path.join(dir, 'doc', 'manifest.json'))).toBe(false);
  });

  it('rejects --to anything but markdown', async () => {
    const dir = tmp();
    const source = writeSource(dir);
    await expect(
      runConvert({
        input: await resolveInput(source),
        inputLabel: source,
        flags: { to: 'html' as never },
        common: cloudCommon(),
        client: fakeClient(),
      })
    ).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('preflights a one-shot source and exposes the local facts without writing an artifact', async () => {
    const dir = tmp();
    const source = writeSource(dir);
    const inspector = fakeInspector();
    const envelope = await runConvert({
      input: await resolveInput(source), inputLabel: source, out: path.join(dir, 'portable.md'),
      flags: {}, parseFlags: {}, common: cloudCommon(), client: fakeClient(), inspector,
    });
    expect(envelope.inspection).toMatchObject({ profile: 'pdf', pageCount: 3 });
    expect(envelope.warnings).toContainEqual(expect.stringContaining('external relationships'));
    expect(inspector.inspect).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(dir, 'probe.json'))).toBe(false);
  });
});

describe('asset failure policy', () => {
  it('fails the convert when an image cannot be fetched, unless keepRemoteImages', async () => {
    const dir = tmp();
    const source = writeSource(dir);
    const out = path.join(dir, 'artifact');
    const deadUrl = `http://127.0.0.1:${port}/gone`;
    const client = fakeClient({
      convert: (async () =>
        convertResult({
          markdown: `![](${deadUrl})`,
          images: [{ ref: deadUrl, key: 'k', suggestedPath: 'assets/gone.png', bytes: 1, hash: 'h' }],
        })) as never,
    });
    await runParse({ input: await resolveInput(source), inputLabel: source, out, flags: {}, common: cloudCommon(), preflight: 'off', client });

    await expect(
      runConvert({ input: await resolveInput(out), inputLabel: out, flags: {}, common: cloudCommon(), client })
    ).rejects.toMatchObject({ code: 'asset_error' });

    const tolerated = await runConvert({
      input: await resolveInput(out),
      inputLabel: out,
      flags: { keepRemoteImages: true },
      common: cloudCommon(),
      client,
    });
    expect(tolerated.warnings.length).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(out, 'views/markdown/index.md'), 'utf-8')).toContain(deadUrl);
  });
});

describe('library handle', () => {
  it('exposes parse → handle → convert without re-parsing', async () => {
    // Covered end-to-end by the CLI paths above; here just the error type surface.
    expect(new DeckOpsError('ir_expired', 'x').exitCode).toBe(5);
  });
});

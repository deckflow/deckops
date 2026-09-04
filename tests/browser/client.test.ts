import { File as NodeFile } from 'node:buffer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient, DeckParseError } from '../../src/browser/index.js';
import type { ProbeReport } from '@deckflow/deckprobe';
import { createFakeCloud, type FakeCloud } from './fake-cloud.mjs';

let cloud: FakeCloud;
beforeAll(async () => { cloud = await createFakeCloud(); });
afterAll(async () => { await cloud.close(); });

const submissions = (name: string) => cloud.state(name).requests.filter((req) => req.path === '/tools/tasks' && req.method === 'POST');

const browserProbeReport = (format: 'pdf' | 'pptx' | 'docx' | 'keynote' = 'pdf'): ProbeReport => {
  const profile = { pdf: 'pdf', pptx: 'pptx', docx: 'docx', keynote: 'key' }[format];
  const formatFacts = {
    pdf: [['pdf.page_count', 2]],
    pptx: [['powerpoint.slide_count', 2], ['powerpoint.slide_size', { width: 10, height: 7.5 }]],
    docx: [['word.page_count', 2]],
    keynote: [['keynote.slide_count', 2]],
  }[format] as Array<[string, unknown]>;
  return ({
  schema_version: 2, tool_version: '2.4.0', status: 'ok',
  input: { display_name: `fixture.${format}`, source_kind: 'browser_bytes', file_size: 12 },
  driver: { id: profile, profile },
  results: Object.fromEntries([
    ['document.format_profile', profile], ['document.extension_matches', true], ['security.encrypted', false],
    ['security.has_macros', false], ['security.has_external_relationships', false],
    ['security.has_embedded_files', true], ...formatFacts,
  ].map(([target, value]) => [target, {
    target, status: 'resolved', value, confidence: 'exact', confidence_score: 1,
    path: 'fixture.path', source: 'fixture',
  }])),
  execution: {
    probe_level: 'metadata', paths: ['fixture.path'], estimated_cost: 1,
    actual_cost: { physical_bytes_read: 12, expanded_bytes: 0, random_reads: 0 }, unresolved_targets: [],
  },
  diagnostics: [],
  });
};

const fixtureInspector = { inspect: async (input: { format: 'pdf' | 'pptx' | 'docx' | 'keynote' }) => browserProbeReport(input.format) };
const clientFor = (name: string) => createClient({
  apiBase: cloud.apiBase(name), token: 'test-token', spaceId: 'test-space', inspector: fixtureInspector,
});

describe('browser SDK over real HTTP', () => {
  it('accepts a File, maps PDF options, and returns in-memory IR', async () => {
    const progress: unknown[] = [];
    // Node's standards-based File lacks only the browser directory-picker field.
    const file = new NodeFile(['%PDF fixture'], 'report.pdf') as unknown as File;
    const doc = await clientFor('file').parse(file, {
      profile: 'quality', includeImages: false, password: 'document-password', onProgress: (event) => progress.push(event),
    });
    expect(doc).toMatchObject({ taskId: 'task-1', type: 'pdf.pdfParse', irKey: 'fixture/task-1/ir.json', irSchemaVersion: 'result.v3' });
    expect(await doc.ir()).toMatchObject({ document: { elements: [{ text: 'Hello browser' }] } });
    expect(submissions('file')[0]?.body).toMatchObject({
      type: 'pdf.pdfParse', spaceId: 'test-space',
      params: { parseProfile: 'quality', includeImages: false, password: 'document-password' },
      files: [{ name: 'report.pdf', bytes: 12 }],
    });
    expect(progress).toContainEqual({ phase: 'parse', taskId: 'task-1', status: 'completed' });
    expect(cloud.state('file').requests.every((req) => req.headers['x-auth-token'] === 'test-token')).toBe(true);
    await doc.convert({ anchors: true });
    expect(cloud.state('file').tasks[1]?.params.markdownMeta).toBe(true);
  });

  it('runs the default validate preflight before upload and exposes its facts', async () => {
    const inspect = vi.fn(async () => browserProbeReport());
    const client = createClient({
      apiBase: cloud.apiBase('preflight'), token: 'test-token', spaceId: 'test-space', inspector: { inspect },
    });
    const progress: unknown[] = [];
    const file = new NodeFile(['%PDF fixture'], 'report.pdf') as unknown as File;
    const doc = await client.parse(file, { onProgress: (event) => progress.push(event) });
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(doc.inspection).toMatchObject({ profile: 'pdf', pageCount: 2, hasEmbeddedFiles: true });
    expect(doc.warnings).toContainEqual(expect.stringContaining('embedded files'));
    expect(await doc.inspectionReport()).toMatchObject({ schema_version: 2, tool_version: '2.4.0' });
    expect(progress).toEqual(expect.arrayContaining([
      { phase: 'preflight', status: 'running' }, { phase: 'preflight', status: 'completed' },
    ]));
    expect(submissions('preflight')).toHaveLength(1);
  });

  it('rejects a malformed local document before a browser request', async () => {
    const client = createClient({
      apiBase: cloud.apiBase('preflight-malformed'), token: 'test-token', spaceId: 'test-space',
      inspector: { inspect: async () => ({
        schema_version: 2 as const, tool_version: '2.4.0', status: 'error' as const,
        error: { code: 'MALFORMED_INPUT', message: 'wrong container', exit_code: 4 },
      }) },
    });
    await expect(client.parse(
      new NodeFile(['not a PDF'], 'report.pdf') as unknown as File,
      {}
    )).rejects.toMatchObject({ code: 'input_error' });
    expect(cloud.state('preflight-malformed').requests).toHaveLength(0);
  });

  it('preserves the explicit filename for a Blob and routes keynote options', async () => {
    await clientFor('blob').parse({ file: new Blob(['keynote bytes']), name: 'slides.key' }, { stayImageAreaRate: 0.2 });
    expect(submissions('blob')[0]?.body).toMatchObject({
      type: 'keynote.parseTextAndImage', params: { stayImageAreaRate: 0.2 }, files: [{ name: 'slides.key', bytes: 13 }],
    });
  });

  it.each([
    ['uint8', new Uint8Array([1, 2, 3])],
    ['arraybuffer', new Uint8Array([1, 2, 3]).buffer],
  ] as const)('accepts named %s input', async (name, file) => {
    await clientFor(name).parse({ file, name: 'notes.docx' });
    expect(submissions(name)[0]?.body).toMatchObject({ type: 'docx.parseTextAndImage', files: [{ name: 'notes.docx', bytes: 3 }] });
  });

  it('routes URL input and does not upload files', async () => {
    const doc = await clientFor('url').parse({ url: 'https://example.com/article' }, { mode: 'source' });
    expect(doc.type).toBe('html.getByURL');
    expect(submissions('url')[0]?.body).toMatchObject({ type: 'html.getByURL', params: { url: 'https://example.com/article', mode: 'source' }, fileIds: [] });
    expect(cloud.state('url').uploads).toHaveLength(0);
    expect(doc.warnings).toContainEqual(expect.stringContaining('skipped for the URL input'));
  });

  it('keeps off as an explicit Worker/WASM escape hatch', async () => {
    const inspect = vi.fn(async () => browserProbeReport());
    const client = createClient({
      apiBase: cloud.apiBase('preflight-off'), token: 'test-token', spaceId: 'test-space', inspector: { inspect },
    });
    const file = new NodeFile(['%PDF fixture'], 'report.pdf') as unknown as File;
    const doc = await client.parse(file, { preflight: 'off' });
    expect(inspect).not.toHaveBeenCalled();
    expect(doc.inspection).toBeUndefined();
    expect(submissions('preflight-off')).toHaveLength(1);
  });

  it('converts repeatedly by irKey, passes view options, and keeps pages/images in memory', async () => {
    const client = clientFor('convert');
    const doc = await client.parse({ file: new Blob(['slides']), name: 'slides.pptx' });
    const view = await doc.convert({ anchors: false, splitPages: true, strict: true });
    expect(view).toMatchObject({
      taskId: 'task-2', format: 'pptx', schemaVersion: 'result.v3', to: 'markdown', reusedParse: true,
      markdownPages: ['# Page one', '# Page two'],
      images: [{ key: 'fixture/image.png', suggestedPath: 'assets/image.png', bytes: 42, hash: 'fixture-md5' }],
    });
    expect(view.markdown).toContain(view.images[0]?.ref);
    expect(cloud.state('convert').tasks[1]?.params).toEqual({
      irKey: doc.irKey, to: 'markdown', markdownMeta: false, markdownPages: true, markdownStrict: true,
    });
    await client.convert({ irKey: doc.irKey }, { anchors: false });
    await client.convert({ taskId: doc.taskId });
    expect(cloud.state('convert').tasks.map((task) => task.type)).toEqual(['pptx.parse', 'parse.convert', 'parse.convert', 'parse.convert']);
    expect(cloud.state('convert').tasks[3]?.params).toEqual({ taskId: doc.taskId, to: 'markdown' });
    expect(cloud.state('convert').requests.filter((req) => req.path.includes('image.png'))).toHaveLength(0);
  });

  it('keeps per-operation spaces isolated during concurrent parse, wait, download, and conversion', async () => {
    const client = createClient({
      apiBase: cloud.apiBase('sse_spaces'), token: 'test-token', spaceId: 'space-A', inspector: fixtureInspector,
    });
    const [docA, docB] = await Promise.all([
      client.parse({ file: new Blob(['pdf']), name: 'a.pdf' }),
      client.parse({ url: 'https://example.com/b' }, { spaceId: 'space-B' }),
    ]);
    const view = await docB.convert();
    const tasks = cloud.state('sse_spaces').tasks;
    expect(tasks.find((task) => task.id === docA.taskId)?.spaceId).toBe('space-A');
    expect(tasks.find((task) => task.id === docB.taskId)?.spaceId).toBe('space-B');
    expect(tasks.find((task) => task.id === view.taskId)?.spaceId).toBe('space-B');
    expect(await client.getTask(docB.taskId, { spaceId: 'space-B' })).toMatchObject({ id: docB.taskId, spaceId: 'space-B' });
    for (const task of tasks) {
      for (const request of cloud.state('sse_spaces').requests.filter((req) => req.path.startsWith(`/tools/tasks/${task.id}`))) {
        if (request.query.spaceId !== undefined) expect(request.query.spaceId).toBe(task.spaceId);
      }
    }
    const again = await client.parse({ url: 'https://example.com/a' });
    expect(tasks.find((task) => task.id === again.taskId)?.spaceId).toBe('space-A');
  });

  it.each([4 * 1024 * 1024, 4 * 1024 * 1024 + 1])('preuploads a %i byte named Blob rather than submitting inline', async (size) => {
    const name = `large_${size}`;
    const progress: unknown[] = [];
    await clientFor(name).parse({ file: new Blob([new Uint8Array(size)]), name: 'large.pdf' }, { onProgress: (event) => progress.push(event) });
    expect(cloud.state(name).uploads).toMatchObject([{ name: 'large.pdf', bytes: size }]);
    expect(submissions(name)[0]?.body).toMatchObject({ fileIds: ['file-1'], type: 'pdf.pdfParse' });
    expect(submissions(name)[0]?.headers['content-type']).toContain('application/json');
    const upload = cloud.state(name).requests.find((req) => req.path === '/storage/file-1');
    expect(upload?.bytes).toBe(size);
    expect(upload?.headers['x-auth-token']).toBeUndefined();
    expect(progress).toContainEqual({ phase: 'upload', progress: 1 });
  });

  it('completes multipart uploads with returned ETags', async () => {
    const size = 4 * 1024 * 1024 + 1;
    await clientFor('multipart').parse({ file: new Uint8Array(size), name: 'large.pptx' });
    const parts = cloud.state('multipart').requests.filter((req) => req.path.includes('/part-'));
    expect(parts.map((req) => req.bytes).sort((a, b) => a - b)).toEqual([1, 2 * 1024 * 1024, 2 * 1024 * 1024]);
    const complete = cloud.state('multipart').requests.find((req) => req.path.endsWith('/complete'));
    expect(complete?.body).toContain('<ETag>fixture-etag</ETag>');
    expect(submissions('multipart')[0]?.body).toMatchObject({ fileIds: ['file-1'] });
  });

  it('reports SSE progress and closes the stream on completion', async () => {
    const events: unknown[] = [];
    await clientFor('sse').parse({ url: 'https://example.com/' }, { onProgress: (event) => events.push(event) });
    expect(events).toContainEqual({ phase: 'parse', taskId: 'task-1', status: 'running' });
    expect(events).toContainEqual({ phase: 'parse', taskId: 'task-1', status: 'completed' });
    await vi.waitFor(() => expect(cloud.state('sse').activeStreams).toBe(0));
    expect(cloud.state('sse').closedStreams).toBe(1);
  });

  it('falls back to polling when a proxy returns nonterminal JSON instead of SSE', async () => {
    const events: unknown[] = [];
    const doc = await clientFor('json-stream').parse({ url: 'https://example.com/' }, {
      pollInterval: 10, timeout: 2, onProgress: (event) => events.push(event),
    });
    expect(doc.irKey).toBe('fixture/task-1/ir.json');
    expect(events).toContainEqual({ phase: 'parse', taskId: 'task-1', status: 'completed' });
    const details = cloud.state('json-stream').requests.filter((req) => req.path === '/tools/tasks/task-1');
    expect(details.filter((req) => req.headers['response-event-stream'] === 'yes')).toHaveLength(1);
    expect(details.filter((req) => req.headers['response-event-stream'] !== 'yes').length).toBeGreaterThanOrEqual(2);
    expect(submissions('json-stream')).toHaveLength(1);
  });

  it('fails closed on 401, with no guest identity request or duplicated task', async () => {
    await expect(clientFor('unauthorized').parse({ url: 'https://example.com/' })).rejects.toMatchObject({ name: 'DeckParseError', code: 'auth_error' });
    expect(submissions('unauthorized')).toHaveLength(1);
    expect(cloud.state('unauthorized').requests).toHaveLength(1);
    expect(cloud.state('unauthorized').requests[0]?.headers['x-auth-token']).toBe('test-token');
  });

  it('also fails closed on the separate SSE transport 401 path', async () => {
    await expect(clientFor('sse-unauthorized').parse({ url: 'https://example.com/' })).rejects.toMatchObject({ code: 'auth_error' });
    expect(submissions('sse-unauthorized')).toHaveLength(1);
    expect(cloud.state('sse-unauthorized').requests.every((req) => req.headers['x-auth-token'] === 'test-token')).toBe(true);
    expect(cloud.state('sse-unauthorized').requests.some((req) => req.path === '/user')).toBe(false);
  });

  it('refreshes an expired token once and never sends an anonymous retry', async () => {
    const refresh = vi.fn(async () => 'fresh-token');
    const client = createClient({ apiBase: cloud.apiBase('refresh'), token: 'stale-token', spaceId: 'test-space', onUnauthorized: refresh });
    await client.parse({ url: 'https://example.com/' });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(submissions('refresh').map((req) => req.headers['x-auth-token'])).toEqual(['stale-token', 'fresh-token']);
    expect(cloud.state('refresh').tasks).toHaveLength(1);
  });

  it('fails closed when token refresh rejects', async () => {
    const client = createClient({
      apiBase: cloud.apiBase('unauthorized_refresh'), token: 'stale-token', spaceId: 'test-space',
      onUnauthorized: async () => { throw new Error('Session ended'); },
    });
    await expect(client.parse({ url: 'https://example.com/' })).rejects.toMatchObject({ code: 'auth_error' });
    expect(cloud.state('unauthorized_refresh').requests).toHaveLength(1);
  });

  it('rejects an empty refreshed token instead of retrying anonymously', async () => {
    const client = createClient({
      apiBase: cloud.apiBase('unauthorized_empty'), token: 'stale-token', spaceId: 'test-space',
      onUnauthorized: async () => '',
    });
    await expect(client.parse({ url: 'https://example.com/' })).rejects.toMatchObject({ code: 'auth_error' });
    expect(cloud.state('unauthorized_empty').requests).toHaveLength(1);
  });

  it('rejects refresh results that try to change identity or space on the existing client', async () => {
    const client = createClient({
      apiBase: cloud.apiBase('unauthorized_identity'), token: 'stale-token', spaceId: 'test-space',
      onUnauthorized: (async () => ({ token: 'other-token', spaceId: 'other-space' })) as never,
    });
    await expect(client.parse({ url: 'https://example.com/' })).rejects.toMatchObject({ code: 'auth_error' });
    expect(cloud.state('unauthorized_identity').requests).toHaveLength(1);
  });

  it('does not blindly retry a task-creation 502', async () => {
    await expect(clientFor('create-error').parse({ url: 'https://example.com/' })).rejects.toBeInstanceOf(DeckParseError);
    expect(submissions('create-error')).toHaveLength(1);
  }, 2_500);

  it.each([['quota', 'quota_error'], ['expired', 'ir_expired']] as const)('maps %s HTTP failures to a stable error code', async (name, code) => {
    await expect(clientFor(name).convert({ irKey: 'fixture/ir.json' })).rejects.toMatchObject({ name: 'DeckParseError', code });
  });

  it('treats markdownError and task failures as backend errors', async () => {
    await expect(clientFor('bad-markdown').convert({ irKey: 'fixture/ir.json' })).rejects.toMatchObject({ code: 'backend_error' });
    await expect(clientFor('failed-task').parse({ url: 'https://example.com/' })).rejects.toMatchObject({ code: 'backend_error' });
  });

  it('aborts an active SSE wait, closes the request, and never submits another task', async () => {
    const controller = new AbortController();
    const pending = clientFor('pending').parse({ url: 'https://example.com/' }, { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(cloud.state('pending').activeStreams).toBe(1));
    controller.abort();
    await rejected;
    await vi.waitFor(() => expect(cloud.state('pending').activeStreams).toBe(0));
    expect(cloud.state('pending').closedStreams).toBe(1);
    expect(submissions('pending')).toHaveLength(1);
    expect(cloud.state('pending').requests.some((req) => req.path.endsWith('/download'))).toBe(false);
  });

  it('aborts the in-flight create request rather than only abandoning its promise', async () => {
    const controller = new AbortController();
    const pending = clientFor('hanging-create').parse({ url: 'https://example.com/' }, { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(submissions('hanging-create')).toHaveLength(1));
    controller.abort();
    await rejected;
    await vi.waitFor(() => expect(cloud.state('hanging-create').abortedCreates).toBe(1));
    expect(submissions('hanging-create')).toHaveLength(1);
  });

  it('does not send requests for a pre-aborted operation', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(clientFor('pre-aborted').parse({ url: 'https://example.com/' }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(cloud.state('pre-aborted').requests).toHaveLength(0);
  });

  it('aborts a signed-upload request before any parse task is created', async () => {
    const controller = new AbortController();
    const pending = clientFor('hanging-upload').parse({ file: new Blob([new Uint8Array(4 * 1024 * 1024)]), name: 'large.pdf' }, { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const upload = () => cloud.state('hanging-upload').requests.find((req) => req.path === '/storage/file-1');
    await vi.waitFor(() => expect(upload()).toBeDefined());
    controller.abort(); await rejected;
    await vi.waitFor(() => expect(upload()?.closed).toBe(true));
    expect(submissions('hanging-upload')).toHaveLength(0);
  });

  it('aborts the result download after task completion', async () => {
    const controller = new AbortController();
    const pending = clientFor('hanging-download').parse({ url: 'https://example.com/' }, { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const download = () => cloud.state('hanging-download').requests.find((req) => req.path.endsWith('/download'));
    await vi.waitFor(() => expect(download()).toBeDefined());
    controller.abort(); await rejected;
    await vi.waitFor(() => expect(download()?.closed).toBe(true));
    expect(submissions('hanging-download')).toHaveLength(1);
  });

  it('enforces timeout in seconds and closes the open SSE request', async () => {
    const started = Date.now();
    await expect(clientFor('pending_timeout').parse({ url: 'https://example.com/' }, { timeout: 0.1 })).rejects.toMatchObject({ name: 'DeckParseError', taskId: 'task-1' });
    expect(Date.now() - started).toBeLessThan(2_000);
    await vi.waitFor(() => expect(cloud.state('pending_timeout').activeStreams).toBe(0));
    expect(submissions('pending_timeout')).toHaveLength(1);
  });

  it('exposes the created task id and can inspect it after local cancellation', async () => {
    const controller = new AbortController();
    const client = clientFor('pending_recover');
    let submittedId: string | undefined;
    const pending = client.parse({ url: 'https://example.com/' }, {
      signal: controller.signal,
      onProgress: (event) => { if (event.phase === 'parse') submittedId = event.taskId; },
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(submittedId).toBe('task-1'));
    controller.abort(); await rejected;
    expect(await client.getTask(submittedId!)).toMatchObject({ id: 'task-1', type: 'html.getByURL', status: 'running' });
    expect(submissions('pending_recover')).toHaveLength(1);
  });

  it('cancels polling promptly without waiting for the next polling interval', async () => {
    const controller = new AbortController();
    const pending = clientFor('pending_poll').parse({ url: 'https://example.com/' }, {
      signal: controller.signal, useEventStream: false, pollInterval: 5_000,
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(cloud.state('pending_poll').requests.some((req) => req.path === '/tools/tasks/task-1')).toBe(true));
    const started = Date.now(); controller.abort(); await rejected;
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(cloud.state('pending_poll').closedStreams).toBe(0);
    expect(submissions('pending_poll')).toHaveLength(1);
  });

  it('rejects invalid browser inputs and format-specific options before network work', async () => {
    const client = clientFor('invalid');
    for (const input of ['/tmp/report.pdf', new Blob(['pdf']), { file: new Blob(['pdf']), name: '' },
      { file: new Blob(['pdf']), name: 'report.exe' }, { file: new Blob([]), name: 'empty.pdf' },
      { url: 'file:///tmp/report.pdf' }, { url: 'https://user:secret@example.com/' }]) {
      await expect(client.parse(input as never)).rejects.toBeInstanceOf(DeckParseError);
    }
    await expect(client.parse({ file: new Blob(['slides']), name: 'slides.pptx' }, { profile: 'quality' })).rejects.toMatchObject({ code: 'usage_error' });
    await expect(client.convert({ irKey: 'a', taskId: 'b' } as never)).rejects.toBeInstanceOf(DeckParseError);
    await expect(client.convert({ irKey: 'a' }, { to: 'html' } as never)).rejects.toMatchObject({ code: 'unsupported' });
    expect(() => createClient({ apiKey: 'server-secret' } as never)).toThrow(DeckParseError);
    expect(cloud.state('invalid').requests).toHaveLength(0);
  });
});

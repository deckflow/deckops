import { createHash } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

/** A wire-protocol fixture, not a mocked SDK. Every operation uses real HTTP. */
/** The one image every fixture conversion references; served with its real md5. */
export const FIXTURE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FIXTURE_PNG_MD5 = createHash('md5').update(FIXTURE_PNG).digest('hex');
const md5 = (data) => createHash('md5').update(data).digest('hex');

/** document.* results per RFC §5.6: delivered Markdown links images by relative path. */
export const FIXTURE_MARKDOWN = '# Page one\n\n![](assets/image.png)\n\n---\n\n# Page two';
export const FIXTURE_MARKDOWN_PAGES = ['# Page one\n\n![](assets/image.png)', '# Page two'];
export const FIXTURE_DOCUMENT = {
  format: 'pdf', schemaVersion: 'result.v3', pages: 2,
  document: { elements: [{ type: 'text', text: 'Hello ops' }, { type: 'image', path: 'assets/image.png' }] },
  resources: [{ path: 'assets/image.png', bytes: FIXTURE_PNG.length, hash: FIXTURE_PNG_MD5, mediaType: 'image/png' }],
};
const RESULT_BYTES = { '.pdf': Buffer.from('%PDF-1.7 fixture'), '.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xe0]), '.webp': Buffer.from('RIFFxxxxWEBP'), '.mp4': Buffer.from('fixture-video') };
const DOCUMENT_FORMATS = { '.pdf': 'pdf', '.pptx': 'pptx', '.docx': 'docx', '.key': 'keynote' };
const ASSETS_EXPIRE_AT = '2026-10-27T08:00:00.000Z';

/** The capabilities a 4.0 server lists; `legacy-server` cases answer 404 instead. */
export const FIXTURE_CAPABILITIES = {
  server: { name: 'fake-cloud', capabilitiesVersion: 1 },
  tasks: { 'document.convert': { to: ['markdown'] }, 'document.extract': { to: ['json', 'assets'] } },
  parseRetentionDays: 7,
};

export async function createFakeCloud({ staticRoot, port = 0 } = {}) {
  const cases = new Map();
  let origin;
  const stateFor = (name) => {
    if (!cases.has(name)) {
      cases.set(name, { requests: [], tasks: [], uploads: [], activeStreams: 0, closedStreams: 0, abortedCreates: 0 });
    }
    return cases.get(name);
  };
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = async (req) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks);
  };
  const decodeBody = async (req, bytes) => {
    const contentType = req.headers['content-type'] ?? '';
    if (contentType.includes('multipart/form-data')) {
      const form = await new Request('http://fixture.invalid/', {
        method: 'POST', body: bytes, headers: { 'content-type': contentType },
      }).formData();
      const body = { files: [] };
      for (const [key, value] of form.entries()) {
        if (typeof value === 'string') body[key] = key === 'params' ? JSON.parse(value) : value;
        else body.files.push({ name: value.name, bytes: value.size });
      }
      return body;
    }
    if (contentType.includes('application/json') && bytes.length) return JSON.parse(bytes.toString());
    return bytes.length ? bytes.toString() : undefined;
  };
  const serveStatic = async (pathname, res) => {
    if (!staticRoot) return false;
    const file = pathname === '/' ? 'tests/browser/smoke.html'
      : pathname === '/smoke.js' ? 'tests/browser/smoke.js'
        : pathname === '/tests/generated/test.pdf' ? pathname.slice(1)
          : /^\/dist\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.js$/.test(pathname) ? pathname.slice(1) : undefined;
    if (!file) return false;
    try {
      const body = await fs.readFile(path.join(staticRoot, file));
      res.writeHead(200, {
        'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch (error) {
      json(res, 404, { message: `Build the browser bundle first: ${error.message}` });
    }
    return true;
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      // This fixture intentionally permits cross-origin browser requests. Cloud
      // deployment must configure the equivalent CORS policy independently.
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Auth-Token,X-Auth-UUID,response-event-stream');
      res.setHeader('Access-Control-Expose-Headers', 'ETag');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      const url = new URL(req.url, origin);
      if (url.pathname === '/__health') { json(res, 200, { ok: true }); return; }
      if (url.pathname.startsWith('/__stats/')) {
        json(res, 200, stateFor(decodeURIComponent(url.pathname.slice('/__stats/'.length))));
        return;
      }
      if (await serveStatic(url.pathname, res)) return;
      const match = /^\/api\/([^/]+)\/v1(\/.*)$/.exec(url.pathname);
      if (!match) { json(res, 404, { message: 'Unknown fixture route' }); return; }
      const [, caseName, route] = match;
      const state = stateFor(caseName);
      const bytes = await readBody(req);
      const body = await decodeBody(req, bytes);
      const request = { method: req.method, path: route, query: Object.fromEntries(url.searchParams), headers: req.headers, body, bytes: bytes.length };
      state.requests.push(request);
      res.once('close', () => { request.closed = true; });
      const kind = (name) => caseName === name || caseName.startsWith(`${name}_`);
      // Public routes: the capabilities list and signed result URLs need no credentials.
      if (route === '/tools/capabilities') {
        if (kind('legacy-server')) { json(res, 404, { message: 'Unknown route' }); return; }
        const tasks = kind('render-url') ? { ...FIXTURE_CAPABILITIES.tasks, 'convertor.html2png': { to: ['image'] } } : FIXTURE_CAPABILITIES.tasks;
        res.setHeader('Cache-Control', 'public, max-age=300');
        json(res, 200, { ...FIXTURE_CAPABILITIES, tasks }); return;
      }
      if (route.startsWith('/results/')) {
        // Signed result URLs: they authorize themselves and must not carry credentials.
        if (kind('dead-result')) { json(res, 404, { message: 'gone' }); return; }
        const name = route.split('/').pop();
        if (name.endsWith('.md')) { res.writeHead(200, { 'Content-Type': 'text/markdown' }); res.end(FIXTURE_MARKDOWN); return; }
        if (name === 'pages.json') { json(res, 200, FIXTURE_MARKDOWN_PAGES); return; }
        if (name === 'document.json') { json(res, 200, FIXTURE_DOCUMENT); return; }
        const extension = name.slice(name.lastIndexOf('.'));
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(kind('corrupt-result') ? Buffer.from('not the reported bytes') : RESULT_BYTES[extension] ?? FIXTURE_PNG); return;
      }
      const token = req.headers['x-auth-token'];
      if (kind('unauthorized') || (kind('refresh') && token !== 'fresh-token')) {
        json(res, 401, { code: 'auth_error', message: 'Expired browser token' }); return;
      }
      if (route === '/user') { json(res, 200, { id: 'fixture-space' }); return; }
      if (route.endsWith('/file/auth') && req.method === 'POST') {
        const id = `file-${state.uploads.length + 1}`;
        // File.status: pending until the owner confirms the stored object (M12).
        state.uploads.push({ ...body, id, status: 'pending', stored: false });
        const storageRoot = `${origin}/api/${caseName}/v1/storage/${id}`;
        if (kind('multipart')) {
          const partSize = 2 * 1024 * 1024;
          json(res, 200, {
            id, key: `fixture/${id}`, hash: body.hash, platform: 'oss', multipart: true,
            multipartUploadId: 'fixture-upload', multipartPartSize: partSize,
            auth: { url: `${storageRoot}/complete`, headers: {} },
            multipartPartAuths: Array.from({ length: Math.ceil(body.bytes / partSize) }, (_, index) => ({
              url: `${storageRoot}/part-${index + 1}`, headers: {},
            })),
          });
        } else {
          json(res, 200, {
            id, key: `fixture/${id}`, hash: body.hash, platform: 'oss', multipart: false,
            auth: { url: storageRoot, headers: {} },
          });
        }
        return;
      }
      if (route.startsWith('/storage/')) {
        // Keep byte counts, not a multi-megabyte string, in test diagnostics.
        request.body = route.endsWith('/complete') ? bytes.toString() : undefined;
        if (kind('hanging-upload')) return;
        const [, , fileId, part] = route.split('/');
        const stored = state.uploads.find((upload) => upload.id === fileId);
        if (stored && (!part || part === 'complete')) stored.stored = true;
        res.setHeader('ETag', '"fixture-etag"');
        json(res, 200, { ok: true }); return;
      }
      const statusMatch = /^\/files\/([^/]+)\/status\/uploaded$/.exec(route);
      if (statusMatch && req.method === 'PUT') {
        if (kind('legacy-server')) { json(res, 403, { code: 'notAllowed', message: 'No access' }); return; }
        const upload = state.uploads.find((item) => item.id === statusMatch[1]);
        if (!upload) { json(res, 404, { code: 'notFound', message: 'Resource not found' }); return; }
        if (!upload.stored) { json(res, 422, { code: 'fileUploadInvalid', message: 'The uploaded object does not exist yet', data: { id: upload.id } }); return; }
        if (kind('bad-upload')) {
          upload.status = 'failed';
          json(res, 422, { code: 'fileUploadInvalid', message: 'Uploaded bytes do not match the declared md5', data: { id: upload.id, expected: upload.hash } });
          return;
        }
        upload.status = 'uploaded';
        json(res, 200, { id: upload.id, status: 'uploaded' }); return;
      }
      if (route === '/tools/tasks' && req.method === 'POST') {
        if (kind('create-error')) { json(res, 502, { message: 'Transient gateway failure after submission' }); return; }
        if (kind('quota')) { json(res, 429, { code: 'quota_error', message: 'Quota reached' }); return; }
        if (kind('expired')) { json(res, 410, { code: 'ir_expired', message: 'IR expired' }); return; }
        if (kind('insufficient')) {
          json(res, 402, { code: 'insufficientPackage', message: 'Insufficient package balance', data: ['Insufficient package balance', { need: 3, remain: 1 }] });
          return;
        }
        // A test lists ids the server has forgotten (uploaded files expire).
        if ((body.fileIds ?? []).some((id) => state.expiredFiles?.includes(id))) {
          json(res, 404, { code: 'notFound', message: 'File not found or not owned by user' }); return;
        }
        // C1: document tasks only take files whose upload the server verified.
        const unverified = String(body.type).startsWith('document.') &&
          (body.fileIds ?? []).some((id) => state.uploads.find((upload) => upload.id === id)?.status !== 'uploaded');
        if (unverified) {
          json(res, 422, { code: 'documentSourceInvalid', message: 'File upload has not been verified: call PUT /files/:id/status/uploaded after uploading' });
          return;
        }
        const task = {
          id: `task-${state.tasks.length + 1}`, spaceId: body.spaceId ?? 'fixture-space',
          type: body.type, status: 'pending', params: body.params ?? {}, fileIds: body.fileIds ?? [],
          credits: 15, createdAt: '2026-10-20T08:00:00.000Z', completedAt: null, consumedMS: null,
        };
        state.tasks.push(task);
        if (kind('hanging-create')) {
          res.on('close', () => { state.abortedCreates += 1; });
          return;
        }
        json(res, 200, task); return;
      }
      const taskMatch = /^\/tools\/tasks\/([^/]+)(\/(download|start))?$/.exec(route);
      if (taskMatch) {
        const task = state.tasks.find((item) => item.id === taskMatch[1]);
        if (!task) { json(res, 404, { message: 'Task missing' }); return; }
        if (url.searchParams.has('spaceId') && url.searchParams.get('spaceId') !== task.spaceId) {
          json(res, 403, { message: 'Task request used a different space from task creation' }); return;
        }
        if (taskMatch[3] === 'start') { json(res, 200, { ...task, status: 'running' }); return; }
        if (taskMatch[3] === 'download') {
          if (kind('hanging-download')) return;
          // A test sets failDownloads to lose that many results after the task completed.
          if (state.failDownloads > 0) {
            state.failDownloads -= 1;
            json(res, 503, { message: 'Result download unavailable' }); return;
          }
          if (task.type.startsWith('document.') || task.type.startsWith('convertor.') || task.type === 'image.convertWebp') {
            json(res, 200, deliver(task, caseName, state)); return;
          }
          json(res, 404, { message: `No fixture result for ${task.type}` });
          return;
        }
        if (req.headers['response-event-stream'] === 'yes') {
          if (kind('sse-unauthorized')) { json(res, 401, { code: 'auth_error', message: 'Event stream token expired' }); return; }
          if (kind('json-stream')) { json(res, 200, { ...task, status: 'running' }); return; }
          state.activeStreams += 1;
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write(`data: ${JSON.stringify({ ...task, status: 'running' })}\n\n`);
          const timer = kind('pending') || state.forceStatus ? undefined : setTimeout(() => {
            res.end(`data: ${JSON.stringify({ ...task, status: 'completed' })}\n\n`);
          }, 15);
          res.once('close', () => {
            clearTimeout(timer);
            state.activeStreams -= 1;
            state.closedStreams += 1;
          });
          return;
        }
        const jsonStreamPending = kind('json-stream') && !state.requests.some((item) => item.headers['response-event-stream'] === 'yes');
        // A test can hold every task (forceStatus: 'running') or fail it, then release it.
        const status = state.forceStatus ?? (kind('failed-task') ? 'failed' : kind('pending') || kind('sse') || kind('sse-unauthorized') || jsonStreamPending ? 'running' : 'completed');
        json(res, 200, {
          ...task, status, ...(status === 'failed' ? { error: 'Fixture parser failure' } : {}),
          ...(status === 'completed' || status === 'failed' ? { completedAt: '2026-10-20T08:00:27.000Z', consumedMS: 27000 } : {}),
          // detail carries only the summary of a document result; the full one comes from download
          ...(status === 'completed' && task.type.startsWith('document.') ? { result: summary(task, state, caseName) } : {}),
        });
        return;
      }
      json(res, 404, { message: `Unhandled ${req.method} ${route}` });
    })().catch((error) => {
      if (!res.headersSent) json(res, 500, { message: error.message });
      else res.destroy(error);
    });
  });
  const filesBase = (caseName, task) => `${origin}/api/${caseName}/v1/results/${task.id}`;
  const sourceOf = (task, state) => state.uploads.find((upload) => upload.id === task.fileIds?.[0]);
  const formatOf = (task, state) => {
    if (task.params.url) return 'html';
    const name = sourceOf(task, state)?.name ?? '';
    return DOCUMENT_FORMATS[name.slice(name.lastIndexOf('.')).toLowerCase()] ?? 'pdf';
  };
  /** The server reuses a parse when the same space parsed the same bytes with the same options. */
  const reusedParse = (task, state) => {
    if (task.params.url) return false;
    const source = sourceOf(task, state);
    const parseKey = JSON.stringify(task.params.parse ?? {});
    return state.tasks.some((other) => other !== task && other.type.startsWith('document.') && other.spaceId === task.spaceId &&
      state.tasks.indexOf(other) < state.tasks.indexOf(task) && sourceOf(other, state)?.hash === source?.hash &&
      JSON.stringify(other.params.parse ?? {}) === parseKey);
  };
  const isKind = (caseName, name) => caseName === name || caseName.startsWith(`${name}_`);
  const warningsOf = (task, state, caseName) => {
    const format = formatOf(task, state);
    const warnings = [];
    if (task.params.anchors !== undefined && format !== 'pdf') warnings.push(`anchors is ignored for ${format} sources`);
    if (isKind(caseName, 'soft-render-error')) warnings.push('markdownError: renderer failed');
    return warnings;
  };
  const summary = (task, state, caseName) => ({
    to: task.params.to ?? 'markdown', format: formatOf(task, state), pages: 2, reusedParse: reusedParse(task, state),
    warnings: warningsOf(task, state, caseName),
  });
  const image = (caseName) => ({
    url: `${origin}/api/${caseName}/v1/results/image.png?sig=fixture`, path: 'assets/image.png',
    bytes: FIXTURE_PNG.length, hash: FIXTURE_PNG_MD5, mediaType: 'image/png',
  });
  function deliver(task, caseName, state) {
    const base = filesBase(caseName, task);
    const tuple = (name, bounds) => [`${base}/${name}?sig=fixture`, (RESULT_BYTES[name.slice(name.lastIndexOf('.'))] ?? FIXTURE_PNG).length,
      md5(RESULT_BYTES[name.slice(name.lastIndexOf('.'))] ?? FIXTURE_PNG), ...(bounds ? [bounds] : [])];
    const frames = state.frames ?? 3;
    const format = task.params.format === 'jpg' ? 'jpg' : 'png';
    switch (task.type) {
      case 'convertor.ppt2image':
      case 'convertor.pdf2image':
        return Array.from({ length: frames }, (_, index) => tuple(`${index + 1}.${format}`, { w: 1920, h: 1080, total: frames }));
      case 'convertor.keynote2image':
        return Array.from({ length: frames }, (_, index) => tuple(`${index + 1}.png`));
      case 'convertor.doc2pdf': return [tuple('document.pdf')];
      case 'convertor.ppt2video': return [tuple('video.mp4')];
      case 'convertor.html2png':
      case 'convertor.markdown2png': return tuple('page.png');
      case 'image.convertWebp': return tuple('frame.webp');
    }
    const head = summary(task, state, caseName);
    const tail = { assetsExpireAt: ASSETS_EXPIRE_AT, warnings: head.warnings };
    const shared = { to: head.to, format: head.format, pages: head.pages, reusedParse: head.reusedParse };
    if (task.type === 'document.convert') {
      const paged = task.params.splitPages && ['pptx', 'keynote'].includes(head.format);
      return {
        ...shared, markdownURL: `${base}/document.md?sig=fixture`, bytes: Buffer.byteLength(FIXTURE_MARKDOWN), hash: md5(FIXTURE_MARKDOWN),
        ...(paged ? { markdownPagesURL: `${base}/pages.json?sig=fixture` } : {}),
        images: [image(caseName)], ...tail,
      };
    }
    if (task.params.to === 'json') {
      const body = JSON.stringify(FIXTURE_DOCUMENT);
      return {
        ...shared, schemaVersion: 'result.v3', documentURL: `${base}/document.json?sig=fixture`,
        bytes: Buffer.byteLength(body), hash: md5(body), assets: [image(caseName)], ...tail,
      };
    }
    return { ...shared, assets: [image(caseName)], ...tail };
  }

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    apiBase: (name = 'success') => `${origin}/api/${name}/v1`,
    state: stateFor,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

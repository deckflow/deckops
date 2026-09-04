import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

/** A wire-protocol fixture, not a mocked SDK. Every operation uses real HTTP. */
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
        : pathname === '/tests/test-data/test.pdf' ? pathname.slice(1)
          : /^\/dist\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:js|wasm)$/.test(pathname) ? pathname.slice(1) : undefined;
    if (!file) return false;
    try {
      const body = await fs.readFile(path.join(staticRoot, file));
      res.writeHead(200, {
        'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8'
          : file.endsWith('.wasm') ? 'application/wasm'
            : file.endsWith('.pdf') ? 'application/pdf'
              : 'text/javascript; charset=utf-8',
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
      const token = req.headers['x-auth-token'];
      if (kind('unauthorized') || (kind('refresh') && token !== 'fresh-token')) {
        json(res, 401, { code: 'auth_error', message: 'Expired browser token' }); return;
      }
      if (route === '/user') { json(res, 200, { id: 'fixture-space' }); return; }
      if (route.endsWith('/file/auth') && req.method === 'POST') {
        const id = `file-${state.uploads.length + 1}`;
        state.uploads.push({ ...body, id });
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
        res.setHeader('ETag', '"fixture-etag"');
        json(res, 200, { ok: true }); return;
      }
      if (route === '/tools/tasks' && req.method === 'POST') {
        if (kind('create-error')) { json(res, 502, { message: 'Transient gateway failure after submission' }); return; }
        if (kind('quota')) { json(res, 429, { code: 'quota_error', message: 'Quota reached' }); return; }
        if (kind('expired')) { json(res, 410, { code: 'ir_expired', message: 'IR expired' }); return; }
        const task = {
          id: `task-${state.tasks.length + 1}`, spaceId: body.spaceId ?? 'fixture-space',
          type: body.type, status: 'pending', params: body.params ?? {}, fileIds: body.fileIds ?? [],
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
          if (task.type === 'parse.convert') {
            const ref = `${origin}/api/${caseName}/v1/image.png?expires=fixture`;
            const parsed = state.tasks.find((item) => item.type !== 'parse.convert' &&
              (item.id === task.params.taskId || task.params.irKey === `fixture/${item.id}/ir.json`));
            const format = ({ 'pdf.pdfParse': 'pdf', 'pptx.parse': 'pptx', 'docx.parseTextAndImage': 'docx',
              'keynote.parseTextAndImage': 'keynote', 'html.getByURL': 'html' })[parsed?.type] ?? 'pptx';
            json(res, 200, {
              format, schemaVersion: 'result.v3', to: 'markdown',
              markdown: `# Page one\n\n![](${ref})\n\n---\n\n# Page two`,
              ...(task.params.markdownPages && ['pptx', 'keynote'].includes(format) ? { markdownPages: ['# Page one', '# Page two'] } : {}),
              ...(kind('bad-markdown') ? { markdownError: 'Renderer failed' } : {}),
              images: [{ ref, key: 'fixture/image.png', suggestedPath: 'assets/image.png', bytes: 42, hash: 'fixture-md5' }],
            });
          } else {
            json(res, 200, {
              irKey: `fixture/${task.id}/ir.json`, irSchemaVersion: 'result.v3',
              document: { schemaVersion: 'result.v3', elements: [{ text: 'Hello browser' }] },
              images: [],
            });
          }
          return;
        }
        if (req.headers['response-event-stream'] === 'yes') {
          if (kind('sse-unauthorized')) { json(res, 401, { code: 'auth_error', message: 'Event stream token expired' }); return; }
          if (kind('json-stream')) { json(res, 200, { ...task, status: 'running' }); return; }
          state.activeStreams += 1;
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write(`data: ${JSON.stringify({ ...task, status: 'running' })}\n\n`);
          const timer = kind('pending') ? undefined : setTimeout(() => {
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
        const status = kind('failed-task') ? 'failed' : kind('pending') || kind('sse') || kind('sse-unauthorized') || jsonStreamPending ? 'running' : 'completed';
        json(res, 200, { ...task, status, ...(status === 'failed' ? { error: 'Fixture parser failure' } : {}) });
        return;
      }
      json(res, 404, { message: `Unhandled ${req.method} ${route}` });
    })().catch((error) => {
      if (!res.headersSent) json(res, 500, { message: error.message });
      else res.destroy(error);
    });
  });
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

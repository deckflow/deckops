import { createClient, DeckOpsError } from '/dist/browser/index.js';

const button = document.querySelector('#run');
const summary = document.querySelector('#summary');
const results = document.querySelector('#results');
const details = document.querySelector('#details');
let runNumber = 0;
const apiOrigin = new URLSearchParams(location.search).get('apiOrigin') ?? location.origin;
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const waitFor = async (test) => {
  const until = Date.now() + 3_000;
  while (!(await test())) {
    if (Date.now() > until) throw new Error('Timed out waiting for request state');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
button.addEventListener('click', async () => {
  button.disabled = true; results.replaceChildren(); details.textContent = ''; runNumber += 1;
  const state = (name) => fetch(`${apiOrigin}/__stats/${name}_${runNumber}`).then((res) => res.json());
  const client = (name, extra = {}) => createClient({
    apiBase: `${apiOrigin}/api/${name}_${runNumber}/v1`, token: 'browser-test-token', spaceId: 'browser-space', ...extra,
  });
  const checks = [
    ['Native browser environment', async () => {
      assert(typeof window.process === 'undefined' && typeof window.Buffer === 'undefined', 'Unexpected Node polyfills');
      assert(typeof createClient === 'function', 'Missing browser SDK export');
    }],
    ['DeckProbe Worker validates a real PDF before upload', async () => {
      const bytes = await fetch('/tests/generated/test.pdf').then((response) => response.blob());
      const events = [];
      const doc = await client('preflight').parse(new File([bytes], 'test.pdf'), {
        onProgress: (event) => events.push(event),
      });
      const report = await doc.inspectionReport();
      assert(doc.inspection?.profile === 'pdf' && report?.schema_version === 2, 'Missing DeckProbe facts');
      assert(events.some((event) => event.phase === 'preflight' && event.status === 'completed'), 'Missing preflight progress');
    }],
    ['Same-origin proxy accepts a relative API root without a browser token', async () => {
      await createClient({ apiBase: `/api/proxy_${runNumber}/v1` }).parse({ url: 'https://example.com/' });
      const recorded = await fetch(`/__stats/proxy_${runNumber}`).then((res) => res.json());
      assert(recorded.tasks.length === 1 && recorded.requests.every((req) => !req.headers['x-auth-token']), 'Proxy unexpectedly required a browser credential');
    }],
    ['File → IR → repeated conversion, pages and image descriptors', async () => {
      const api = client('file');
      const doc = await api.parse(new File(['PPTX local fixture'], 'browser.pptx'), { preflight: 'off' });
      assert(doc.irKey && (await doc.ir()).document, 'Missing in-memory IR');
      const view = await doc.convert({ splitPages: true, strict: true });
      assert(view.reusedParse === true && view.markdownPages.length === 2 && view.images.length === 1, 'Missing view metadata');
      await api.convert({ irKey: doc.irKey });
      const recorded = await state('file');
      assert(recorded.tasks.length === 3 && recorded.tasks.filter((task) => task.type !== 'parse.convert').length === 1, 'Conversion reparsed the file');
      assert(recorded.tasks[1].params.markdownStrict === true && recorded.tasks[1].params.markdownPages === true, 'View options missing');
    }],
    ['Named Blob and typed-array input', async () => {
      await client('blob').parse({ file: new Blob(['keynote']), name: 'slides.key' }, { stayImageAreaRate: 0.2, preflight: 'off' });
      await client('binary').parse({ file: new Uint8Array([1, 2, 3]), name: 'notes.docx' }, { preflight: 'off' });
      const recorded = await state('blob');
      const submission = recorded.requests.find((req) => req.path === '/tools/tasks');
      assert(submission.body.files[0].name === 'slides.key' && recorded.tasks[0].params.stayImageAreaRate === 0.2, 'Blob filename/options lost');
    }],
    ['Concurrent operations keep their own space through conversion', async () => {
      const api = client('sse_spaces', { spaceId: 'space-A' });
      const [docA, docB] = await Promise.all([
        api.parse({ url: 'https://example.com/a' }),
        api.parse({ url: 'https://example.com/b' }, { spaceId: 'space-B' }),
      ]);
      const view = await docB.convert();
      const recorded = await state('sse_spaces');
      assert(recorded.tasks.find((task) => task.id === docA.taskId).spaceId === 'space-A', 'Default space changed');
      assert(recorded.tasks.find((task) => task.id === docB.taskId).spaceId === 'space-B', 'Operation space lost');
      assert(recorded.tasks.find((task) => task.id === view.taskId).spaceId === 'space-B', 'Document conversion did not inherit its space');
      assert((await api.getTask(docB.taskId, { spaceId: 'space-B' })).id === docB.taskId, 'Cannot recover task in explicit space');
    }],
    ['URL input and SSE progress', async () => {
      const events = [];
      await client('sse').parse({ url: 'https://example.com/' }, { mode: 'source', onProgress: (event) => events.push(event) });
      const recorded = await state('sse');
      assert(recorded.tasks[0].params.mode === 'source', 'URL mode lost');
      assert(events.some((event) => event.status === 'running') && events.some((event) => event.status === 'completed'), 'Missing SSE progress');
    }],
    ['Proxy JSON response falls back from SSE to polling', async () => {
      const doc = await client('json-stream').parse({ url: 'https://example.com/' }, { pollInterval: 10, timeout: 2 });
      assert(doc.irKey, 'Polling did not produce IR');
      const recorded = await state('json-stream');
      assert(recorded.requests.filter((req) => req.path === '/tools/tasks/task-1').length >= 3, 'Missing polling fallback');
      assert(recorded.tasks.length === 1, 'Fallback resubmitted the task');
    }],
    ['≥4 MiB Blob uses signed pre-upload, not inline task body', async () => {
      await client('large').parse({ file: new Blob([new Uint8Array(4 * 1024 * 1024)]), name: 'large.pdf' }, { preflight: 'off' });
      const recorded = await state('large');
      assert(recorded.uploads.length === 1 && recorded.tasks[0].fileIds[0] === 'file-1', 'Large file was submitted inline');
      assert(recorded.requests.find((req) => req.path === '/storage/file-1').bytes === 4 * 1024 * 1024, 'Upload bytes differ');
    }],
    ['Multipart pre-upload reads exposed ETag headers', async () => {
      await client('multipart').parse({ file: new Blob([new Uint8Array(4 * 1024 * 1024 + 1)]), name: 'large.pptx' }, { preflight: 'off' });
      const recorded = await state('multipart');
      assert(recorded.requests.filter((req) => req.path.includes('/part-')).length === 3, 'Missing multipart requests');
      assert(recorded.requests.find((req) => req.path.endsWith('/complete')).body.includes('<ETag>fixture-etag</ETag>'), 'ETag missing');
    }],
    ['401 fails closed without guest downgrade', async () => {
      let error;
      try { await client('unauthorized').parse({ url: 'https://example.com/' }); } catch (caught) { error = caught; }
      assert(error instanceof DeckOpsError && error.code === 'auth_error', 'Expected stable authentication error');
      assert((await state('unauthorized')).requests.length === 1, 'Unauthorized request retried or downgraded');
      let streamError;
      try { await client('sse-unauthorized').parse({ url: 'https://example.com/' }); } catch (caught) { streamError = caught; }
      assert(streamError instanceof DeckOpsError && streamError.code === 'auth_error', 'SSE transport did not fail closed');
      assert((await state('sse-unauthorized')).requests.every((req) => req.headers['x-auth-token']), 'SSE retried anonymously');
    }],
    ['Token refresh retries once with the refreshed identity', async () => {
      let refreshes = 0;
      await client('refresh', { onUnauthorized: async () => { refreshes += 1; return 'fresh-token'; } }).parse({ url: 'https://example.com/' });
      const recorded = await state('refresh');
      assert(refreshes === 1 && recorded.tasks.length === 1, 'Refresh duplicated task');
      assert(recorded.requests.every((req) => req.headers['x-auth-token']), 'Anonymous retry');
    }],
    ['Task creation failure is not blindly retried', async () => {
      let error;
      try { await client('create-error').parse({ url: 'https://example.com/' }); } catch (caught) { error = caught; }
      assert(error instanceof DeckOpsError, 'Expected stable backend error');
      assert((await state('create-error')).requests.length === 1, 'Task submission repeated');
    }],
    ['Abort closes a live SSE wait without another task', async () => {
      const controller = new AbortController();
      const pending = client('pending').parse({ url: 'https://example.com/' }, { signal: controller.signal }).catch((error) => error);
      await waitFor(async () => (await state('pending')).activeStreams === 1);
      controller.abort();
      assert((await pending).name === 'AbortError', 'Expected AbortError');
      await waitFor(async () => (await state('pending')).activeStreams === 0);
      assert((await state('pending')).tasks.length === 1, 'Abort duplicated task');
    }],
    ['Abort disconnects an in-flight create request', async () => {
      const controller = new AbortController();
      const pending = client('hanging-create').parse({ url: 'https://example.com/' }, { signal: controller.signal }).catch((error) => error);
      await waitFor(async () => (await state('hanging-create')).tasks.length === 1);
      controller.abort();
      assert((await pending).name === 'AbortError', 'Expected AbortError');
      await waitFor(async () => (await state('hanging-create')).abortedCreates === 1);
    }],
    ['Timeout closes its event stream', async () => {
      let error;
      try { await client('pending_timeout').parse({ url: 'https://example.com/' }, { timeout: 0.1 }); } catch (caught) { error = caught; }
      assert(error instanceof DeckOpsError, 'Expected timeout error');
      assert(error.taskId === 'task-1', 'Timeout did not retain the created task id');
      await waitFor(async () => (await state('pending_timeout')).activeStreams === 0);
    }],
  ];
  let passed = 0;
  for (const [label, check] of checks) {
    summary.textContent = `Running ${passed + 1}/${checks.length}…`;
    const row = document.createElement('li');
    try {
      await check(); passed += 1; row.dataset.status = 'pass'; row.textContent = `PASS — ${label}`;
    } catch (error) {
      row.dataset.status = 'fail'; row.textContent = `FAIL — ${label}: ${error.message}`;
      details.textContent += `${label}\n${error.stack}\n\n`;
    }
    results.append(row);
  }
  summary.dataset.status = passed === checks.length ? 'pass' : 'fail';
  summary.textContent = `${passed === checks.length ? 'PASS' : 'FAIL'} — ${passed}/${checks.length} browser checks`;
  button.disabled = false;
});

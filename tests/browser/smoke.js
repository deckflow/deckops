import { createClient, DeckOpsError, isDeckOpsError } from '/dist/browser/index.js';

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
      assert(typeof createClient === 'function' && typeof isDeckOpsError === 'function', 'Missing browser SDK export');
    }],
    ['A real PDF File converts to Markdown with signed image links and progress', async () => {
      const bytes = await fetch('/tests/generated/test.pdf').then((response) => response.blob());
      const events = [];
      const result = await client('pdf').convert(new File([bytes], 'test.pdf'), { onProgress: (event) => events.push(event) });
      assert(result.content.includes(result.images[0].url) && result.images[0].url.includes('sig='), 'Image links are not signed URLs');
      assert(events.some((event) => event.phase === 'task' && event.status === 'completed'), 'Missing task progress');
      assert(events.some((event) => event.phase === 'download'), 'Missing download progress');
      assert((await state('pdf')).uploads[0].status === 'uploaded', 'Upload was not verified');
    }],
    ['Same-origin proxy accepts a relative API root without a browser token', async () => {
      await createClient({ apiBase: `/api/proxy_${runNumber}/v1` }).convert({ url: 'https://example.com/' });
      const recorded = await fetch(`/__stats/proxy_${runNumber}`).then((res) => res.json());
      assert(recorded.tasks.length === 1 && recorded.requests.every((req) => !req.headers['x-auth-token']), 'Proxy unexpectedly required a browser credential');
    }],
    ['One File uploads once for convert and extract', async () => {
      const api = client('reuse');
      const file = new File(['PPTX local fixture'], 'browser.pptx');
      const markdown = await api.convert(file, { splitPages: true });
      const json = await api.extract(file, { to: 'json' });
      const recorded = await state('reuse');
      assert(recorded.uploads.length === 1, 'The same File was uploaded twice');
      assert(markdown.contentPages.length === 2 && json.content.document && json.schemaVersion && json.reusedParse, 'Missing results');
    }],
    ['Named Blob and typed-array input', async () => {
      await client('blob').extract({ file: new Blob(['keynote']), name: 'slides.key' }, { to: 'assets', stayImageAreaRate: 0.2 });
      await client('binary').convert({ file: new Uint8Array([1, 2, 3]), name: 'notes.docx' });
      const recorded = await state('blob');
      assert(recorded.uploads[0].name === 'slides.key' && recorded.tasks[0].params.parse.stayImageAreaRate === 0.2, 'Blob filename/options lost');
    }],
    ['Concurrent calls keep their own space', async () => {
      const api = client('sse_spaces', { spaceId: 'space-A' });
      const [a, b] = await Promise.all([
        api.convert({ url: 'https://example.com/a' }),
        api.convert({ url: 'https://example.com/b' }, { spaceId: 'space-B' }),
      ]);
      const recorded = await state('sse_spaces');
      assert(recorded.tasks.find((task) => task.id === a.tasks[0].id).spaceId === 'space-A', 'Default space changed');
      assert(recorded.tasks.find((task) => task.id === b.tasks[0].id).spaceId === 'space-B', 'Call space lost');
      assert((await api.tasks.get(b.tasks[0].id, { spaceId: 'space-B' })).id === b.tasks[0].id, 'Cannot inspect a task in its space');
    }],
    ['URL input and SSE progress', async () => {
      const events = [];
      await client('sse').convert({ url: 'https://example.com/' }, { onProgress: (event) => events.push(event) });
      assert(events.some((event) => event.status === 'running') && events.some((event) => event.status === 'completed'), 'Missing SSE progress');
    }],
    ['Proxy JSON response falls back from SSE to polling', async () => {
      const result = await client('json-stream').convert({ url: 'https://example.com/' }, { pollInterval: 10, timeout: 2 });
      assert(result.content, 'Polling did not produce Markdown');
      const recorded = await state('json-stream');
      assert(recorded.requests.filter((req) => req.path === '/tools/tasks/task-1').length >= 3, 'Missing polling fallback');
      assert(recorded.tasks.length === 1, 'Fallback resubmitted the task');
    }],
    ['Signed upload carries no credentials and is verified before the task', async () => {
      await client('large').convert({ file: new Blob([new Uint8Array(4 * 1024 * 1024)]), name: 'large.pdf' });
      const recorded = await state('large');
      const upload = recorded.requests.find((req) => req.path === '/storage/file-1');
      assert(upload.bytes === 4 * 1024 * 1024 && !upload.headers['x-auth-token'], 'Upload bytes or credentials wrong');
      const paths = recorded.requests.map((req) => req.path);
      assert(paths.indexOf('/files/file-1/status/uploaded') < paths.indexOf('/tools/tasks'), 'Task created before verification');
    }],
    ['Multipart pre-upload reads exposed ETag headers', async () => {
      await client('multipart').convert({ file: new Blob([new Uint8Array(4 * 1024 * 1024 + 1)]), name: 'large.pptx' });
      const recorded = await state('multipart');
      assert(recorded.requests.filter((req) => req.path.includes('/part-')).length === 3, 'Missing multipart requests');
      assert(recorded.requests.find((req) => req.path.endsWith('/complete')).body.includes('<ETag>fixture-etag</ETag>'), 'ETag missing');
    }],
    ['Rendered frames download as Blobs across origins', async () => {
      const frames = await client('render').render(new File(['PPTX local fixture'], 'deck.pptx'), { to: 'image', pages: [2] });
      const blob = await frames.outputs[0].blob();
      assert(frames.outputs.length === 1 && frames.outputs[0].page === 2 && blob.size > 0, 'Frame download failed');
    }],
    ['401 fails closed without guest downgrade', async () => {
      let error;
      try { await client('unauthorized').convert({ url: 'https://example.com/' }); } catch (caught) { error = caught; }
      assert(isDeckOpsError(error, 'auth_error'), 'Expected stable authentication error');
      assert((await state('unauthorized')).requests.filter((req) => req.path === '/tools/tasks').length === 1, 'Unauthorized request retried');
      assert(!(await state('unauthorized')).requests.some((req) => req.path === '/user'), 'Downgraded to a guest');
      let streamError;
      try { await client('sse-unauthorized').convert({ url: 'https://example.com/' }); } catch (caught) { streamError = caught; }
      assert(isDeckOpsError(streamError, 'auth_error'), 'SSE transport did not fail closed');
    }],
    ['Token refresh retries once with the refreshed identity', async () => {
      let refreshes = 0;
      await client('refresh', { onUnauthorized: async () => { refreshes += 1; return 'fresh-token'; } }).convert({ url: 'https://example.com/' });
      const recorded = await state('refresh');
      assert(refreshes === 1 && recorded.tasks.length === 1, 'Refresh duplicated task');
    }],
    ['Task creation failure is not blindly retried', async () => {
      let error;
      try { await client('create-error').convert({ url: 'https://example.com/' }); } catch (caught) { error = caught; }
      assert(error instanceof DeckOpsError, 'Expected stable backend error');
      assert((await state('create-error')).requests.filter((req) => req.path === '/tools/tasks').length === 1, 'Task submission repeated');
    }],
    ['Abort closes a live SSE wait with the caller’s reason', async () => {
      const controller = new AbortController();
      const reason = new Error('left the page');
      const pending = client('pending').convert({ url: 'https://example.com/' }, { signal: controller.signal }).catch((error) => error);
      await waitFor(async () => (await state('pending')).activeStreams === 1);
      controller.abort(reason);
      assert((await pending) === reason, 'Abort did not reject with the caller’s reason');
      await waitFor(async () => (await state('pending')).activeStreams === 0);
      assert((await state('pending')).tasks.length === 1, 'Abort duplicated task');
    }],
    ['Abort disconnects an in-flight create request', async () => {
      const controller = new AbortController();
      const pending = client('hanging-create').convert({ url: 'https://example.com/' }, { signal: controller.signal }).catch((error) => error);
      await waitFor(async () => (await state('hanging-create')).tasks.length === 1);
      controller.abort();
      assert((await pending).name === 'AbortError', 'Expected AbortError');
      await waitFor(async () => (await state('hanging-create')).abortedCreates === 1);
    }],
    ['Timeout closes its event stream and names the task', async () => {
      let error;
      try { await client('pending_timeout').convert({ url: 'https://example.com/' }, { timeout: 0.1 }); } catch (caught) { error = caught; }
      assert(error instanceof DeckOpsError && error.details?.reason === 'timeout', 'Expected a timeout error');
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

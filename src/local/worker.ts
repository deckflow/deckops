import { parentPort } from 'node:worker_threads';
import { parseDocx } from './docx/parser.js';
import { parseHtmlSource } from './html/parser.js';
import { parsePptx } from './pptx/parser.js';
import type { WorkerRequest, WorkerResponse } from './worker-protocol.js';

if (!parentPort) throw new Error('deckops local worker must run in a worker thread.');

parentPort.once('message', (request: WorkerRequest) => {
  try {
    const candidate = request.kind === 'docx' ? parseDocx(request.data, request.source, request.limits, request.options)
      : request.kind === 'pptx' ? parsePptx(request.data, request.source, request.limits)
        : parseHtmlSource(request.html, request.source, request.baseUrl);
    parentPort!.postMessage({ ok: true, candidate } satisfies WorkerResponse);
  } catch (error) {
    const value = error as Error & { code?: string; hint?: string };
    parentPort!.postMessage({ ok: false, error: { name: value.name, message: value.message,
      ...(value.code ? { code: value.code } : {}), ...(value.hint ? { hint: value.hint } : {}), ...(value.stack ? { stack: value.stack } : {}) } } satisfies WorkerResponse);
  }
});

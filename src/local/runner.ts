import { parsePdf } from './pdf/adapter.js';
import { Worker } from 'node:worker_threads';
import { DeckOpsError } from '../errors/index.js';
import { parseDocx } from './docx/parser.js';
import { parseHtmlSource } from './html/parser.js';
import { parsePptx } from './pptx/parser.js';
import type { WorkerRequest, WorkerResponse } from './worker-protocol.js';

export async function runLocalWorker(request: WorkerRequest, signal: AbortSignal): Promise<import('../ir/schema.js').ParseCandidate> {
  signal.throwIfAborted();
  // Vitest executes TypeScript source directly; production bundles use the bounded worker entry.
  if (import.meta.url.endsWith('.ts')) return runDirect(request);
  const worker = new Worker(new URL('./local-worker.js', import.meta.url), {
    resourceLimits: { maxOldGenerationSizeMb: request.limits.workerHeapMb },
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => { if (settled) return; settled = true; signal.removeEventListener('abort', aborted); callback(); };
    const aborted = (): void => finish(() => { void worker.terminate(); reject(signal.reason instanceof Error ? signal.reason : new Error('Local parser aborted.')); });
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) { aborted(); return; }
    worker.once('message', (response: WorkerResponse) => finish(() => {
      void worker.terminate();
      if (response.ok) resolve(response.candidate);
      else reject(response.error.code ? new DeckOpsError(response.error.code as never, response.error.message, { ...(response.error.hint ? { hint: response.error.hint } : {}) }) : new Error(response.error.message));
    }));
    worker.once('error', (error) => finish(() => reject(error)));
    worker.once('exit', (code) => { if (code !== 0) finish(() => reject(new Error(`Local parser worker exited with code ${code}.`))); });
    const data = request.kind === 'docx' || request.kind === 'pptx' ? request.data : undefined;
    const transfer = data && data.buffer instanceof ArrayBuffer && data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? [data.buffer] : [];
    worker.postMessage(request, transfer);
  });
}

function runDirect(request: WorkerRequest) {
  if (request.kind === 'pdf') return parsePdf(request.input, request.source, request.limits, request.options);
  if (request.kind === 'docx') return Promise.resolve(parseDocx(request.data, request.source, request.limits, request.options));
  if (request.kind === 'pptx') return Promise.resolve(parsePptx(request.data, request.source, request.limits));
  return Promise.resolve(parseHtmlSource(request.html, request.source, request.baseUrl));
}

import type { ProbeCallOptions, ProbeResult } from '@deckflow/deckprobe';
import type { BrowserSource } from './input.js';

interface WorkerRequest {
  id: number;
  name: string;
  input: Blob | ArrayBuffer;
  options: ProbeCallOptions;
}

interface WorkerResponse {
  id: number;
  result?: ProbeResult;
  error?: { name: string; message: string };
}

interface Pending {
  resolve: (result: ProbeResult) => void;
  reject: (error: Error) => void;
}

export interface BrowserDocumentInspector {
  inspect(
    input: Extract<BrowserSource, { kind: 'file' }>,
    options: ProbeCallOptions,
    signal?: AbortSignal
  ): Promise<ProbeResult>;
}

/** Reuses one module Worker per DeckParse client and keeps WASM parsing off the UI thread. */
export function createBrowserDocumentInspector(): BrowserDocumentInspector {
  let worker: Worker | undefined;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  const ensureWorker = (): Worker => {
    if (worker) return worker;
    worker = new Worker(new URL('./probe-worker.js', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      const waiting = pending.get(event.data.id);
      if (!waiting) return;
      pending.delete(event.data.id);
      if (event.data.error) {
        const error = new Error(event.data.error.message);
        error.name = event.data.error.name;
        waiting.reject(error);
      } else if (event.data.result) {
        waiting.resolve(event.data.result);
      } else {
        waiting.reject(new Error('DeckProbe worker returned an empty response.'));
      }
    });
    worker.addEventListener('error', (event) => {
      const error = new Error(event.message || 'DeckProbe worker failed to load.');
      for (const waiting of pending.values()) waiting.reject(error);
      pending.clear();
      worker?.terminate();
      worker = undefined;
    });
    return worker;
  };

  return {
    inspect: async (input, options, signal) => {
      signal?.throwIfAborted();
      const active = ensureWorker();
      const id = nextId++;
      const data = input.data;
      let payload: Blob | ArrayBuffer;
      if (isBlob(data)) {
        payload = data;
      } else if (data instanceof ArrayBuffer) {
        payload = data.slice(0);
      } else {
        payload = data.slice().buffer as ArrayBuffer;
      }
      const request: WorkerRequest = { id, name: input.name, input: payload, options };
      const result = new Promise<ProbeResult>((resolve, reject) => pending.set(id, { resolve, reject }));
      if (payload instanceof ArrayBuffer) active.postMessage(request, [payload]);
      else active.postMessage(request);
      return waitForProbe(result, signal);
    },
  };
}

function isBlob(value: Blob | Uint8Array | ArrayBuffer): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

async function waitForProbe(result: Promise<ProbeResult>, signal: AbortSignal | undefined): Promise<ProbeResult> {
  if (!signal) return result;
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([result, aborted]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}

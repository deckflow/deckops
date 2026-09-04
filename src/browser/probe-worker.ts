import { probe, type ProbeCallOptions, type ProbeResult } from '@deckflow/deckprobe';

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

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
};

scope.onmessage = (event) => {
  void (async () => {
    const { id, name, input, options } = event.data;
    try {
      const result = await probe(input instanceof Blob ? input : new Uint8Array(input), { ...options, name });
      scope.postMessage({ id, result });
    } catch (error) {
      scope.postMessage({
        id,
        error: {
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  })();
};

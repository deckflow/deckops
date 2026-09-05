import { createParser, type ParsedEvent, type ReconnectInterval } from 'eventsource-parser';
import { delay, throwIfAborted } from './abort.js';
import type { HttpClient, NodeReadableLike } from './http-client.js';
import {
  DEFAULT_POLL_INTERVAL,
  DEFAULT_TIMEOUT,
  INLINE_TASK_FILES_MAX_BYTES,
  type CreateTaskParams,
  type DeckTask,
  type DeckTaskType,
  type PreparedUpload,
  type SubscribeTaskHandlers,
  type TaskDownloadOptions,
  type TaskDownResult,
  type TaskUploadInput,
  type TaskUploadOptions,
  type UploadInput,
  type WaitForTaskOptions,
} from './contracts.js';

type FilesLike = {
  prepare(input: UploadInput, options?: TaskUploadOptions & { spaceId?: (string) | undefined }): Promise<PreparedUpload>;
  uploadPrepared(
    file: PreparedUpload,
    options?: TaskUploadOptions & { spaceId?: (string) | undefined }
  ): Promise<{ id: string }>;
  upload(input: UploadInput, options?: TaskUploadOptions & { spaceId?: (string) | undefined }): Promise<{ id: string }>;
};

type EventStreamBody = NodeReadableLike | ReadableStream<Uint8Array> | string;

const SSE_RETRY_INTERVAL = 5000;
const SSE_MAX_RETRIES = 100;

/** The endpoint returned a snapshot, not a stream; polling can continue the wait. */
class EventStreamUnavailableError extends Error {}

export class TasksApi {
  private readonly webStreamReaders = new WeakMap<ReadableStream<Uint8Array>, ReadableStreamDefaultReader<Uint8Array>>();

  constructor(
    private readonly http: HttpClient,
    private readonly files?: FilesLike
  ) {}

  async create<T extends DeckTaskType>(params: CreateTaskParams<T>): Promise<DeckTask<T>> {
    throwIfAborted(params.signal);
    const spaceId = await this.http.resolveSpaceId(params.spaceId, params.signal);
    const prepared = await this.prepareTaskFiles(params);
    const totalBytes = prepared.reduce((sum, file) => sum + file.bytes, 0);
    const canInlineFiles =
      prepared.length > 0 &&
      !(params.fileIds?.length) &&
      totalBytes < INLINE_TASK_FILES_MAX_BYTES;

    if (canInlineFiles) {
      return await this.createWithInlineFiles(spaceId, params, prepared);
    }

    const fileIds = await this.resolveFileIds(spaceId, params, prepared);
    const payload: Record<string, unknown> = {
      fileIds,
      type: params.type,
      params: params.params ?? {},
    };

    if (spaceId) {
      payload.spaceId = spaceId;
    }
    if (params.name) {
      payload.name = params.name;
    }

    const res = await this.http.post<DeckTask<T>>('/tools/tasks', payload, { signal: params.signal });
    return res.data;
  }

  private async createWithInlineFiles<T extends DeckTaskType>(
    spaceId: string | undefined,
    params: CreateTaskParams<T>,
    files: PreparedUpload[]
  ): Promise<DeckTask<T>> {
    if (typeof globalThis.FormData === 'undefined' || typeof globalThis.Blob === 'undefined') {
      throw new Error('FormData and Blob are required for inline task file uploads in this runtime');
    }

    const form = new FormData();
    if (spaceId) {
      form.append('spaceId', spaceId);
    }
    form.append('type', params.type);
    form.append('params', JSON.stringify(params.params ?? {}));
    if (params.name) {
      form.append('name', params.name);
    }

    for (const file of files) {
      const blob =
        typeof Blob !== 'undefined' && file.data instanceof Blob
          ? file.data
          : new Blob([this.toArrayBuffer(file.data as Uint8Array)]);
      form.append('files', blob, file.name);
    }

    const res = await this.http.post<DeckTask<T>>('/tools/tasks', form, { signal: params.signal });
    params.upload?.onProgress?.(1);
    return res.data;
  }

  private toArrayBuffer(data: Uint8Array): ArrayBuffer {
    const copy = new ArrayBuffer(data.byteLength);
    new Uint8Array(copy).set(data);
    return copy;
  }

  private async prepareTaskFiles<T extends DeckTaskType>(
    params: CreateTaskParams<T>
  ): Promise<PreparedUpload[]> {
    if (!params.files?.length) {
      return [];
    }
    if (!this.files) {
      throw new Error('File upload is not available for this task client');
    }

    return await Promise.all(
      params.files.map(async (file) => {
        const { input, options } = this.normalizeTaskUpload(file, params.upload);
        return await this.files!.prepare(input, { ...options, signal: params.signal ?? options.signal });
      })
    );
  }

  private async resolveFileIds<T extends DeckTaskType>(
    spaceId: string | undefined,
    params: CreateTaskParams<T>,
    prepared: PreparedUpload[]
  ): Promise<string[]> {
    const fileIds = [...(params.fileIds ?? [])];
    if (!prepared.length) {
      return fileIds;
    }
    if (!this.files) {
      throw new Error('File upload is not available for this task client');
    }

    const uploaded = await Promise.all(
      prepared.map(async (file, index) => {
        const source = params.files![index]!;
        const { options } = this.normalizeTaskUpload(source, params.upload);
        const result = await this.files!.uploadPrepared(file, {
          ...options,
          spaceId,
          signal: params.signal ?? options.signal,
        });
        return result.id;
      })
    );
    return [...fileIds, ...uploaded];
  }

  private normalizeTaskUpload(
    file: TaskUploadInput,
    defaults: TaskUploadOptions = {}
  ): { input: UploadInput; options: TaskUploadOptions } {
    if (this.isTaskUploadObject(file)) {
      const { input, ...options } = file;
      return {
        input,
        options: {
          ...defaults,
          ...options,
        },
      };
    }

    return { input: file, options: defaults };
  }

  private isTaskUploadObject(file: TaskUploadInput): file is Extract<TaskUploadInput, { input: unknown }> {
    return typeof file === 'object' && file !== null && 'input' in file && !this.isBlob(file);
  }

  private isBlob(value: unknown): value is Blob {
    return typeof Blob !== 'undefined' && value instanceof Blob;
  }

  async get<T extends DeckTaskType = DeckTaskType>(
    taskId: string,
    options: { useEventStream?: (boolean) | undefined; signal?: (AbortSignal) | undefined; spaceId?: (string) | undefined } = {}
  ): Promise<DeckTask<T>> {
    const headers: Record<string, string> = {};
    if (options.useEventStream) {
      headers['response-event-stream'] = 'yes';
    }

    const res = await this.http.get<DeckTask<T> | string>(`/tools/tasks/${encodeURIComponent(taskId)}`, {
      headers,
      signal: options.signal,
      params: this.taskQueryParams(options.spaceId),
    });

    const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
    if (contentType.includes('event-stream') || contentType.includes('text/event-stream')) {
      const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      for (const line of text.split('\n')) {
        if (line.startsWith('data: ')) {
          try {
            return JSON.parse(line.slice(6)) as DeckTask<T>;
          } catch {
            // Keep scanning for the first valid event.
          }
        }
      }
    }

    return res.data as DeckTask<T>;
  }

  async down<T extends DeckTaskType = DeckTaskType>(
    taskId: string,
    options: TaskDownloadOptions = {}
  ): Promise<TaskDownResult<T>> {
    // Keep the legacy no-space download query unless a caller/facade selects a space explicitly.
    const params: Record<string, string> = options.spaceId ? { spaceId: options.spaceId } : {};

    const res = await this.http.get<TaskDownResult<T>>(
      `/tools/tasks/${encodeURIComponent(taskId)}/download`,
      { ...(Object.keys(params).length ? { params } : {}), signal: options.signal }
    );
    return res.data;
  }

  async wait<T extends DeckTaskType = DeckTaskType>(
    taskId: string,
    options: WaitForTaskOptions = {}
  ): Promise<DeckTask<T>> {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    throwIfAborted(options.signal);
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(`Task ${taskId} did not complete within ${timeout}s`)), timeout * 1000);
    try {
      return await this.waitInternal<T>(taskId, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      controller.abort();
    }
  }

  private async waitInternal<T extends DeckTaskType>(taskId: string, options: WaitForTaskOptions): Promise<DeckTask<T>> {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    const startedAt = Date.now();

    // Fast path: task may already be terminal before SSE connects (common for
    // quick guest-mode tasks after an explicit start). Avoid hanging on an SSE
    // connection that never emits a terminal event for an already-finished task.
    const current = await this.get<T>(taskId, { signal: options.signal, spaceId: options.spaceId });
    options.onProgress?.(current);
    if (current.status === 'completed') {
      return current;
    }
    if (current.status === 'failed') {
      throw new Error(`Task failed: ${current.error || 'Unknown error'}`);
    }

    const remainingTimeout = Math.max(timeout - (Date.now() - startedAt) / 1000, 0);
    if (options.useEventStream !== false) {
      return await this.waitWithEventStream<T>(
        taskId, remainingTimeout, options.onProgress, options.signal,
        options.pollInterval ?? DEFAULT_POLL_INTERVAL, options.spaceId
      );
    }
    return await this.waitWithPolling<T>(
      taskId,
      remainingTimeout,
      options.pollInterval ?? DEFAULT_POLL_INTERVAL,
      options.onProgress,
      options.signal,
      options.spaceId
    );
  }

  subscribe<T extends DeckTaskType = DeckTaskType>(
    taskId: string,
    handlers: SubscribeTaskHandlers<T>
  ): Promise<() => void> {
    throwIfAborted(handlers.signal);
    const abortController = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveRetryTimer: (() => void) | undefined;
    let activeStream: EventStreamBody | undefined;
    let closed = false;
    let retryCount = 0;

    const cancel = (): void => {
      closed = true;
      handlers.signal?.removeEventListener('abort', cancel);
      abortController.abort();
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      resolveRetryTimer?.();
      resolveRetryTimer = undefined;
      this.destroyStream(activeStream);
      activeStream = undefined;
    };
    handlers.signal?.addEventListener('abort', cancel, { once: true });

    const waitBeforeRetry = async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        resolveRetryTimer = resolve;
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          resolveRetryTimer = undefined;
          resolve();
        }, SSE_RETRY_INTERVAL);
      });
    };

    const run = async (): Promise<void> => {
      while (!closed) {
        try {
          await this.openTaskEventStream(taskId, handlers, abortController.signal, (stream) => {
            activeStream = stream;
          });
          return;
        } catch (error) {
          if (closed || this.isCanceledError(error)) {
            return;
          }
          if (!this.isSseTransportError(error) || retryCount >= SSE_MAX_RETRIES) {
            handlers.onError?.(error as Error);
            return;
          }

          retryCount += 1;
          await waitBeforeRetry();
        }
      }
    };

    void run().finally(() => handlers.signal?.removeEventListener('abort', cancel));

    return Promise.resolve(cancel);
  }

  private async openTaskEventStream<T extends DeckTaskType>(
    taskId: string,
    handlers: SubscribeTaskHandlers<T>,
    signal: AbortSignal,
    onStream: (stream: EventStreamBody | undefined) => void
  ): Promise<void> {
    throwIfAborted(signal);
    const res = await this.http.eventStream<DeckTask<T>>(`/tools/tasks/${encodeURIComponent(taskId)}`, {
      headers: { 'response-event-stream': 'yes' },
      signal,
      params: this.taskQueryParams(handlers.spaceId),
    });

    const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
    if (contentType.includes('application/json')) {
      // In Node, eventStream uses axios responseType:'stream', so even a JSON
      // body arrives as a Readable stream. Parse it before notifying handlers;
      // otherwise wait() never sees status=completed and hangs forever.
      const task = await this.parseJsonTaskBody<T>(res.data, signal);
      handlers.onUpdate(task);
      throwIfAborted(signal);
      if (task.status !== 'completed' && task.status !== 'failed') {
        throw new EventStreamUnavailableError('Task endpoint returned a non-terminal JSON snapshot instead of SSE');
      }
      return;
    }

    if (!contentType.includes('event-stream') && !contentType.includes('text/event-stream')) {
      throw new Error(`Unexpected Content-Type: ${contentType}`);
    }

    await new Promise<void>((resolve, reject) => {
      let terminal = false;
      const parser = createParser((event: ParsedEvent | ReconnectInterval) => {
        if (event.type !== 'event') {
          return;
        }
        try {
          const task = JSON.parse(event.data) as DeckTask<T>;
          handlers.onUpdate(task);
          if (task.status === 'completed' || task.status === 'failed') {
            terminal = true;
            this.destroyStream(stream);
            cleanup();
            resolve();
          }
        } catch (error) {
          handlers.onError?.(error as Error);
        }
      });

      const stream = res.data as EventStreamBody;
      const cleanup = (): void => {
        if (!this.isNodeReadable(stream)) {
          onStream(undefined);
          return;
        }
        stream.off('data', onData);
        stream.off('error', onError);
        stream.off('end', onEnd);
        stream.off('close', onClose);
        onStream(undefined);
      };
      const reconnect = (error: Error): void => {
        cleanup();
        if (terminal || signal.aborted) {
          resolve();
        } else {
          reject(error);
        }
      };
      const onData = (chunk: unknown): void => {
        parser.feed(this.streamChunkToText(chunk));
      };
      const onError = (error: Error): void => {
        reconnect(error);
      };
      const onEnd = (): void => {
        reconnect(new Error('SSE connection ended before task completion'));
      };
      const onClose = (): void => {
        reconnect(new Error('SSE connection closed before task completion'));
      };

      onStream(stream);

      if (typeof stream === 'string') {
        parser.feed(stream);
        if (!terminal) {
          reconnect(new Error('SSE connection ended before task completion'));
        }
        return;
      }

      if (this.isWebReadableStream(stream)) {
        void this.consumeWebStream(stream, signal, (chunk) => parser.feed(chunk))
          .then(() => {
            if (!terminal) {
              reconnect(new Error('SSE connection ended before task completion'));
            }
          })
          .catch((error) => reconnect(error as Error));
        return;
      }

      stream.on('data', onData);
      stream.on('error', onError);
      stream.on('end', onEnd);
      stream.on('close', onClose);
    });
  }

  private async parseJsonTaskBody<T extends DeckTaskType>(
    body: unknown,
    signal: AbortSignal
  ): Promise<DeckTask<T>> {
    if (
      typeof body === 'object' &&
      body !== null &&
      !this.isNodeReadable(body) &&
      !this.isWebReadableStream(body)
    ) {
      return body as DeckTask<T>;
    }

    const text = (await this.readBodyAsText(body, signal)).trim();
    if (!text) {
      throw new Error('Empty JSON body in task detail response');
    }
    return JSON.parse(text) as DeckTask<T>;
  }

  private async readBodyAsText(body: unknown, signal: AbortSignal): Promise<string> {
    if (typeof body === 'string') {
      return body;
    }

    if (this.isWebReadableStream(body)) {
      const chunks: string[] = [];
      await this.consumeWebStream(body, signal, (chunk) => {
        chunks.push(chunk);
      });
      return chunks.join('');
    }

    if (this.isNodeReadable(body)) {
      return await new Promise<string>((resolve, reject) => {
        const chunks: Uint8Array[] = [];
        const onData = (chunk: unknown): void => {
          if (chunk instanceof Uint8Array) {
            chunks.push(chunk);
            return;
          }
          chunks.push(new TextEncoder().encode(this.streamChunkToText(chunk)));
        };
        const onError = (error: Error): void => {
          cleanup();
          reject(error);
        };
        const onEnd = (): void => {
          cleanup();
          const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
          const merged = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.byteLength;
          }
          resolve(new TextDecoder().decode(merged));
        };
        const onAbort = (): void => {
          cleanup();
          body.destroy?.();
          reject(signal.reason ?? new Error('canceled'));
        };
        const cleanup = (): void => {
          body.off('data', onData);
          body.off('error', onError);
          body.off('end', onEnd);
          body.off('close', onEnd);
          signal.removeEventListener('abort', onAbort);
        };

        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        body.on('data', onData);
        body.on('error', onError);
        body.on('end', onEnd);
        body.on('close', onEnd);
      });
    }

    return String(body ?? '');
  }

  private isSseTransportError(error: unknown): boolean {
    if (error instanceof EventStreamUnavailableError) return false;
    if (typeof error !== 'object' || error === null) {
      return false;
    }

    const statusCode = (error as { statusCode?: (number) | undefined }).statusCode;
    if (typeof statusCode === 'number') {
      return false;
    }

    if (error instanceof Error && error.message.startsWith('Unexpected Content-Type:')) {
      return false;
    }

    return true;
  }

  private isCanceledError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }

    const err = error as { code?: (string) | undefined; name?: (string) | undefined; message?: (string) | undefined };
    return err.name === 'AbortError' || err.code === 'ERR_CANCELED' || err.message === 'canceled' || err.message?.includes('canceled') === true;
  }

  private destroyStream(stream: EventStreamBody | undefined): void {
    if (this.isWebReadableStream(stream)) {
      const reader = this.webStreamReaders.get(stream);
      if (reader) {
        void reader.cancel().catch(() => {});
      } else {
        void stream.cancel().catch(() => {});
      }
      return;
    }

    const destroy = stream && this.isNodeReadable(stream) ? stream.destroy : undefined;
    if (typeof destroy === 'function') {
      destroy.call(stream);
    }
  }

  private isNodeReadable(value: unknown): value is NodeReadableLike {
    return (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { on?: (unknown) | undefined }).on === 'function' &&
      typeof (value as { off?: (unknown) | undefined }).off === 'function'
    );
  }

  private isWebReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
    return (
      typeof ReadableStream !== 'undefined' &&
      value instanceof ReadableStream &&
      typeof value.getReader === 'function'
    );
  }

  private streamChunkToText(chunk: unknown): string {
    if (typeof chunk === 'string') {
      return chunk;
    }
    if (chunk instanceof Uint8Array) {
      return new TextDecoder().decode(chunk);
    }
    return String(chunk);
  }

  private async consumeWebStream(
    stream: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    onChunk: (chunk: string) => void
  ): Promise<void> {
    const reader = stream.getReader();
    this.webStreamReaders.set(stream, reader);
    const decoder = new TextDecoder();
    const abort = (): void => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });

    try {
      throwIfAborted(signal);
      for (;;) {
        const { done, value } = await reader.read();
        throwIfAborted(signal);
        if (done) {
          break;
        }
        onChunk(decoder.decode(value, { stream: true }));
      }
      const rest = decoder.decode();
      if (rest) {
        onChunk(rest);
      }
    } finally {
      this.webStreamReaders.delete(stream);
      signal.removeEventListener('abort', abort);
      reader.releaseLock();
    }
  }

  private async waitWithEventStream<T extends DeckTaskType>(
    taskId: string,
    timeout: number,
    onProgress?: (task: DeckTask) => void,
    signal?: AbortSignal,
    pollInterval = DEFAULT_POLL_INTERVAL,
    spaceId?: string
  ): Promise<DeckTask<T>> {
    return await new Promise<DeckTask<T>>((resolve, reject) => {
      throwIfAborted(signal);
      const start = Date.now();
      let cancel: (() => void) | undefined;
      let settled = false;
      let fallbackStarted = false;

      const remainingTimeout = (): number => {
        const elapsedSeconds = (Date.now() - start) / 1000;
        return Math.max(timeout - elapsedSeconds, 0);
      };

      const finish = (callback: () => void): void => {
        signal?.removeEventListener('abort', onAbort);
        clearInterval(timer);
        cancel?.();
        if (!settled) {
          settled = true;
          callback();
        }
      };
      const onAbort = (): void => finish(() => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')));
      signal?.addEventListener('abort', onAbort, { once: true });

      const fallbackToPolling = (): void => {
        if (settled || fallbackStarted) {
          return;
        }

        fallbackStarted = true;
        clearInterval(timer);
        cancel?.();
        this.waitWithPolling<T>(taskId, remainingTimeout(), pollInterval, onProgress, signal, spaceId)
          .then((task) => {
            finish(() => resolve(task));
          })
          .catch((error) => {
            finish(() => reject(error));
          });
      };

      const timer = setInterval(() => {
        if (Date.now() - start > timeout * 1000) {
          finish(() => reject(new Error(`Task ${taskId} did not complete within ${timeout}s`)));
        }
      }, 1000);

      void this.subscribe<T>(taskId, {
        signal,
        spaceId,
        onUpdate: (task) => {
          onProgress?.(task);
          if (task.status === 'completed') {
            finish(() => resolve(task));
          } else if (task.status === 'failed') {
            finish(() => reject(new Error(`Task failed: ${task.error || 'Unknown error'}`)));
          }
        },
        onError: (error) => {
          if (signal?.aborted || (error as { statusCode?: (number) | undefined }).statusCode === 401) {
            finish(() => reject(signal?.aborted ? signal.reason : error));
            return;
          }
          fallbackToPolling();
        },
      }).then((cancelFn) => {
        cancel = cancelFn;
        if (settled || fallbackStarted) {
          cancelFn();
        }
      }).catch((error) => finish(() => reject(error)));
    });
  }

  private async waitWithPolling<T extends DeckTaskType>(
    taskId: string,
    timeout: number,
    pollInterval: number,
    onProgress?: (task: DeckTask) => void,
    signal?: AbortSignal,
    spaceId?: string
  ): Promise<DeckTask<T>> {
    const start = Date.now();
    for (;;) {
      throwIfAborted(signal);
      if (Date.now() - start > timeout * 1000) {
        throw new Error(`Task ${taskId} did not complete within ${timeout}s`);
      }

      const task = await this.get<T>(taskId, { signal, spaceId });
      onProgress?.(task);

      if (task.status === 'completed') {
        return task;
      }
      if (task.status === 'failed') {
        throw new Error(`Task failed: ${task.error || 'Unknown error'}`);
      }

      await delay(pollInterval, signal);
    }
  }

  private taskQueryParams(spaceId?: string): Record<string, string> | undefined {
    const effectiveSpaceId = spaceId ?? this.http.spaceId;
    return effectiveSpaceId ? { spaceId: effectiveSpaceId } : undefined;
  }
}

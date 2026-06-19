import { createParser, type ParsedEvent, type ReconnectInterval } from 'eventsource-parser';
import type { HttpClient } from './http-client.js';
import {
  DEFAULT_POLL_INTERVAL,
  DEFAULT_TIMEOUT,
  type CreateTaskParams,
  type DeckTask,
  type DeckTaskType,
  type ListTasksParams,
  type SubscribeTaskHandlers,
  type TaskDownloadOptions,
  type TaskDownResult,
  type TaskListResponse,
  type TaskUploadInput,
  type TaskUploadOptions,
  type UploadInput,
  type WaitForTaskOptions,
} from './types.js';

type FilesLike = {
  upload(input: UploadInput, options?: TaskUploadOptions & { spaceId?: string }): Promise<{ id: string }>;
};

const SSE_RETRY_INTERVAL = 5000;
const SSE_MAX_RETRIES = 100;

export class TasksApi {
  constructor(
    private readonly http: HttpClient,
    private readonly files?: FilesLike
  ) {}

  async create<T extends DeckTaskType>(params: CreateTaskParams<T>): Promise<DeckTask<T>> {
    const spaceId = this.requireSpaceId(params.spaceId);
    const fileIds = await this.resolveFileIds(spaceId, params);
    const payload: Record<string, unknown> = {
      spaceId,
      fileIds,
      type: params.type,
      params: params.params ?? {},
    };

    if (params.name) {
      payload.name = params.name;
    }

    const res = await this.http.post<DeckTask<T>>('/tools/tasks', payload);
    return res.data;
  }

  private async resolveFileIds<T extends DeckTaskType>(spaceId: string, params: CreateTaskParams<T>): Promise<string[]> {
    const fileIds = [...(params.fileIds ?? [])];
    if (!params.files?.length) {
      return fileIds;
    }
    if (!this.files) {
      throw new Error('File upload is not available for this task client');
    }

    const uploaded = await Promise.all(
      params.files.map(async (file) => {
        const { input, options } = this.normalizeTaskUpload(file, params.upload);
        const result = await this.files!.upload(input, {
          ...options,
          spaceId,
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

  async list<T extends DeckTaskType = DeckTaskType>(params: ListTasksParams<T> = {}): Promise<TaskListResponse<T>> {
    const spaceId = this.requireSpaceId(params.spaceId);
    const query: Record<string, string | number> = {
      spaceId,
      _startIndex: params.startIndex ?? 0,
      _maxResults: params.maxResults ?? 50,
    };

    if (params.type) {
      query.type = params.type;
    }

    const res = await this.http.get<DeckTask<T>[]>('/tools/tasks', { params: query });
    const total = res.headers['x-content-record-total'];
    return {
      tasks: res.data,
      total: typeof total === 'string' ? Number.parseInt(total, 10) : res.data.length,
    };
  }

  async get<T extends DeckTaskType = DeckTaskType>(
    taskId: string,
    options: { useEventStream?: boolean } = {}
  ): Promise<DeckTask<T>> {
    const headers: Record<string, string> = {};
    if (options.useEventStream) {
      headers['response-event-stream'] = 'yes';
    }

    const res = await this.http.get<DeckTask<T> | string>(`/tools/tasks/${encodeURIComponent(taskId)}`, {
      headers,
      params: this.taskQueryParams(),
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

  async delete(taskId: string): Promise<void> {
    await this.http.delete(`/tools/tasks/${encodeURIComponent(taskId)}`, {
      params: this.taskQueryParams(),
    });
  }

  async down<T extends DeckTaskType = DeckTaskType>(
    taskId: string,
    options: TaskDownloadOptions = {}
  ): Promise<TaskDownResult<T>> {
    const params: Record<string, string> = {};
    if (options.type) {
      params._type = options.type;
    }

    const res = await this.http.get<TaskDownResult<T>>(
      `/tools/tasks/${encodeURIComponent(taskId)}/download`,
      Object.keys(params).length ? { params } : undefined
    );
    return res.data;
  }

  async wait<T extends DeckTaskType = DeckTaskType>(
    taskId: string,
    options: WaitForTaskOptions = {}
  ): Promise<DeckTask<T>> {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    if (options.useEventStream !== false) {
      return await this.waitWithEventStream<T>(taskId, timeout, options.onProgress);
    }
    return await this.waitWithPolling<T>(taskId, timeout, options.pollInterval ?? DEFAULT_POLL_INTERVAL, options.onProgress);
  }

  subscribe<T extends DeckTaskType = DeckTaskType>(
    taskId: string,
    handlers: SubscribeTaskHandlers<T>
  ): Promise<() => void> {
    const abortController = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveRetryTimer: (() => void) | undefined;
    let activeStream: NodeJS.ReadableStream | undefined;
    let closed = false;
    let retryCount = 0;

    const cancel = (): void => {
      closed = true;
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

    void run();

    return Promise.resolve(cancel);
  }

  private async openTaskEventStream<T extends DeckTaskType>(
    taskId: string,
    handlers: SubscribeTaskHandlers<T>,
    signal: AbortSignal,
    onStream: (stream: NodeJS.ReadableStream | undefined) => void
  ): Promise<void> {
    const res = await this.http.get<DeckTask<T> | NodeJS.ReadableStream>(
      `/tools/tasks/${encodeURIComponent(taskId)}`,
      {
        headers: { 'response-event-stream': 'yes' },
        responseType: 'stream',
        signal,
        params: this.taskQueryParams(),
        'axios-retry': { retries: 0 },
      }
    );

    const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
    if (contentType.includes('application/json')) {
      handlers.onUpdate(res.data as DeckTask<T>);
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

      const stream = res.data as NodeJS.ReadableStream;
      const cleanup = (): void => {
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
      const onData = (chunk: Buffer | string): void => {
        parser.feed(chunk.toString());
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
      stream.on('data', onData);
      stream.on('error', onError);
      stream.on('end', onEnd);
      stream.on('close', onClose);
    });
  }

  private isSseTransportError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }

    const statusCode = (error as { statusCode?: number }).statusCode;
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

    const err = error as { code?: string; message?: string };
    return err.code === 'ERR_CANCELED' || err.message === 'canceled' || err.message?.includes('canceled') === true;
  }

  private destroyStream(stream: NodeJS.ReadableStream | undefined): void {
    const destroy = (stream as { destroy?: () => void } | undefined)?.destroy;
    if (typeof destroy === 'function') {
      destroy.call(stream);
    }
  }

  private async waitWithEventStream<T extends DeckTaskType>(
    taskId: string,
    timeout: number,
    onProgress?: (task: DeckTask) => void
  ): Promise<DeckTask<T>> {
    return await new Promise<DeckTask<T>>((resolve, reject) => {
      const start = Date.now();
      let cancel: (() => void) | undefined;
      let settled = false;
      let fallbackStarted = false;

      const remainingTimeout = (): number => {
        const elapsedSeconds = (Date.now() - start) / 1000;
        return Math.max(timeout - elapsedSeconds, 0);
      };

      const finish = (callback: () => void): void => {
        clearInterval(timer);
        cancel?.();
        if (!settled) {
          settled = true;
          callback();
        }
      };

      const fallbackToPolling = (): void => {
        if (settled || fallbackStarted) {
          return;
        }

        fallbackStarted = true;
        clearInterval(timer);
        cancel?.();
        this.waitWithPolling<T>(taskId, remainingTimeout(), DEFAULT_POLL_INTERVAL, onProgress)
          .then((task) => {
            if (!settled) {
              settled = true;
              resolve(task);
            }
          })
          .catch((error) => {
            if (!settled) {
              settled = true;
              reject(error);
            }
          });
      };

      const timer = setInterval(() => {
        if (Date.now() - start > timeout * 1000) {
          finish(() => reject(new Error(`Task ${taskId} did not complete within ${timeout}s`)));
        }
      }, 1000);

      void this.subscribe<T>(taskId, {
        onUpdate: (task) => {
          onProgress?.(task);
          if (task.status === 'completed') {
            finish(() => resolve(task));
          } else if (task.status === 'failed') {
            finish(() => reject(new Error(`Task failed: ${task.error || 'Unknown error'}`)));
          }
        },
        onError: () => {
          fallbackToPolling();
        },
      }).then((cancelFn) => {
        cancel = cancelFn;
        if (settled || fallbackStarted) {
          cancelFn();
        }
      });
    });
  }

  private async waitWithPolling<T extends DeckTaskType>(
    taskId: string,
    timeout: number,
    pollInterval: number,
    onProgress?: (task: DeckTask) => void
  ): Promise<DeckTask<T>> {
    const start = Date.now();
    for (;;) {
      if (Date.now() - start > timeout * 1000) {
        throw new Error(`Task ${taskId} did not complete within ${timeout}s`);
      }

      const task = await this.get<T>(taskId);
      onProgress?.(task);

      if (task.status === 'completed') {
        return task;
      }
      if (task.status === 'failed') {
        throw new Error(`Task failed: ${task.error || 'Unknown error'}`);
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }

  private requireSpaceId(spaceId?: string): string {
    const value = spaceId ?? this.http.spaceId;
    if (!value) {
      throw new Error('spaceId is required');
    }
    return value;
  }

  private taskQueryParams(): Record<string, string> | undefined {
    return this.http.spaceId ? { spaceId: this.http.spaceId } : undefined;
  }
}

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

  async subscribe<T extends DeckTaskType = DeckTaskType>(
    taskId: string,
    handlers: SubscribeTaskHandlers<T>
  ): Promise<() => void> {
    const abortController = new AbortController();

    try {
      const res = await this.http.get<DeckTask<T> | NodeJS.ReadableStream>(
        `/tools/tasks/${encodeURIComponent(taskId)}`,
        {
          headers: { 'response-event-stream': 'yes' },
          responseType: 'stream',
          signal: abortController.signal,
          params: this.taskQueryParams(),
        }
      );

      const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
      if (contentType.includes('application/json')) {
        handlers.onUpdate(res.data as DeckTask<T>);
        return () => abortController.abort();
      }

      if (contentType.includes('event-stream') || contentType.includes('text/event-stream')) {
        const parser = createParser((event: ParsedEvent | ReconnectInterval) => {
          if (event.type !== 'event') {
            return;
          }
          try {
            const task = JSON.parse(event.data) as DeckTask<T>;
            handlers.onUpdate(task);
            if (task.status === 'completed' || task.status === 'failed') {
              abortController.abort();
            }
          } catch (error) {
            handlers.onError?.(error as Error);
          }
        });

        const stream = res.data as NodeJS.ReadableStream;
        stream.on('data', (chunk: Buffer) => {
          parser.feed(chunk.toString());
        });
        stream.on('error', (error: Error) => {
          handlers.onError?.(error);
        });
        return () => abortController.abort();
      }

      handlers.onError?.(new Error(`Unexpected Content-Type: ${contentType}`));
    } catch (error) {
      const err = error as { code?: string };
      if (err.code !== 'ERR_CANCELED') {
        handlers.onError?.(error as Error);
      }
    }

    return () => abortController.abort();
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

      const timer = setInterval(() => {
        if (Date.now() - start > timeout * 1000) {
          cancel?.();
          clearInterval(timer);
          if (!settled) {
            settled = true;
            reject(new Error(`Task ${taskId} did not complete within ${timeout}s`));
          }
        }
      }, 1000);

      void this.subscribe<T>(taskId, {
        onUpdate: (task) => {
          onProgress?.(task);
          if (task.status === 'completed') {
            clearInterval(timer);
            cancel?.();
            if (!settled) {
              settled = true;
              resolve(task);
            }
          } else if (task.status === 'failed') {
            clearInterval(timer);
            cancel?.();
            if (!settled) {
              settled = true;
              reject(new Error(`Task failed: ${task.error || 'Unknown error'}`));
            }
          }
        },
        onError: () => {
          clearInterval(timer);
          if (!settled) {
            settled = true;
            this.waitWithPolling<T>(taskId, timeout, DEFAULT_POLL_INTERVAL, onProgress).then(resolve).catch(reject);
          }
        },
      }).then((cancelFn) => {
        cancel = cancelFn;
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

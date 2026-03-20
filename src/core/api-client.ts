/**
 * API client for deckflow backend
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import axiosRetry from 'axios-retry';
import crypto from 'crypto';
import fs from 'fs';
import { createParser, type ParsedEvent, type ReconnectInterval } from 'eventsource-parser';
import { APIError } from '../utils/errors.js';
import type { Task, UploadAuthResponse, TaskListResponse } from '../types/api.js';

export class APIClient {
  private client: AxiosInstance;

  constructor(
    public readonly baseURL: string,
    public readonly token: string
  ) {
    // Remove trailing slash
    this.baseURL = baseURL.replace(/\/$/, '');

    // Create axios instance
    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        'X-Auth-Token': token,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    // Configure retry logic
    axiosRetry(this.client, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (error) => {
        // Retry on network errors or specific status codes
        return (
          axiosRetry.isNetworkOrIdempotentRequestError(error) ||
          [429, 500, 502, 503, 504].includes(error.response?.status || 0)
        );
      },
    });
  }

  /**
   * Build full URL from path
   */
  private url(path: string): string {
    return `${this.baseURL}/${path.replace(/^\//, '')}`;
  }

  /**
   * Create a new task
   */
  async addTask(
    spaceId: string,
    fileIds: string[],
    taskType: string,
    name?: string,
    params?: Record<string, unknown>
  ): Promise<Task> {
    try {
      const payload: Record<string, unknown> = {
        spaceId,
        fileIds,
        type: taskType,
        params: params || {},
      };

      if (name) {
        payload.name = name;
      }

      const response = await this.client.post<Task>('/tools/tasks', payload);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw APIError.fromAxiosError(error);
      }
      throw error;
    }
  }

  /**
   * List tasks with pagination
   */
  async listTasks(
    spaceId: string,
    taskType?: string,
    startIndex: number = 0,
    maxResults: number = 50
  ): Promise<TaskListResponse> {
    try {
      const params: Record<string, string | number> = {
        spaceId,
        _startIndex: startIndex,
        _maxResults: maxResults,
      };

      if (taskType) {
        params.type = taskType;
      }

      const response = await this.client.get<Task[]>('/tools/tasks', { params });

      // Get total count from header
      const total = response.headers['x-content-record-total'];

      return {
        tasks: response.data,
        total: total ? parseInt(total, 10) : response.data.length,
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw APIError.fromAxiosError(error);
      }
      throw error;
    }
  }

  /**
   * Get task details
   */
  async getTask(taskId: string, useEventStream: boolean = false): Promise<Task> {
    try {
      const headers: Record<string, string> = {};
      if (useEventStream) {
        headers['response-event-stream'] = 'yes';
      }

      const response = await this.client.get<Task>(`/tools/tasks/${taskId}`, { headers });

      const contentType = response.headers['content-type']?.toLowerCase() || '';

      // If JSON response
      if (contentType.includes('application/json')) {
        return response.data;
      }

      // If event-stream, parse first event
      if (contentType.includes('event-stream') || contentType.includes('text/event-stream')) {
        const text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
        const lines = text.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              return JSON.parse(line.slice(6)) as Task;
            } catch {
              continue;
            }
          }
        }
      }

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw APIError.fromAxiosError(error);
      }
      throw error;
    }
  }

  /**
   * Subscribe to task detail updates via Server-Sent Events
   */
  async subscribeTaskDetail(
    taskId: string,
    onUpdate: (task: Task) => void,
    onError?: (error: Error) => void
  ): Promise<() => void> {
    const abortController = new AbortController();

    try {
      const response = await this.client.get(`/tools/tasks/${taskId}`, {
        headers: {
          'response-event-stream': 'yes',
        },
        responseType: 'stream',
        signal: abortController.signal,
      });

      const contentType = response.headers['content-type']?.toLowerCase() || '';

      // If JSON response, call update once and return
      if (contentType.includes('application/json')) {
        onUpdate(response.data as Task);
        return () => abortController.abort();
      }

      // If event-stream, process the stream
      if (contentType.includes('event-stream') || contentType.includes('text/event-stream')) {
        const parser = createParser((event: ParsedEvent | ReconnectInterval) => {
          if (event.type === 'event') {
            try {
              const task = JSON.parse(event.data) as Task;
              onUpdate(task);

              // Auto-stop on completion
              if (task.status === 'completed' || task.status === 'failed') {
                abortController.abort();
              }
            } catch (err) {
              onError?.(err as Error);
            }
          }
        });

        // Process stream chunks
        response.data.on('data', (chunk: Buffer) => {
          parser.feed(chunk.toString());
        });

        response.data.on('error', (error: Error) => {
          onError?.(error);
        });
      } else {
        onError?.(new Error(`Unexpected Content-Type: ${contentType}`));
      }
    } catch (error) {
      if (!axios.isAxiosError(error) || error.code !== 'ERR_CANCELED') {
        onError?.(error as Error);
      }
    }

    return () => abortController.abort();
  }

  /**
   * Delete a task
   */
  async deleteTask(taskId: string): Promise<void> {
    try {
      await this.client.delete(`/tools/tasks/${taskId}`);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw APIError.fromAxiosError(error);
      }
      throw error;
    }
  }

  /**
   * Wait for task to complete
   */
  async waitForTask(
    taskId: string,
    timeout: number = 300,
    useEventStream: boolean = true,
    progressCallback?: (task: Task) => void
  ): Promise<Task> {
    if (useEventStream) {
      // Try event-stream first
      return new Promise((resolve, reject) => {
        const startTime = Date.now();
        let cancel: (() => void) | null = null;
        let resolved = false;

        const checkTimeout = setInterval(() => {
          if (Date.now() - startTime > timeout * 1000) {
            cancel?.();
            clearInterval(checkTimeout);
            if (!resolved) {
              resolved = true;
              reject(new Error(`Task ${taskId} did not complete within ${timeout}s`));
            }
          }
        }, 1000);

        this.subscribeTaskDetail(
          taskId,
          (task) => {
            progressCallback?.(task);

            if (task.status === 'completed') {
              clearInterval(checkTimeout);
              cancel?.();
              if (!resolved) {
                resolved = true;
                resolve(task);
              }
            } else if (task.status === 'failed') {
              clearInterval(checkTimeout);
              cancel?.();
              if (!resolved) {
                resolved = true;
                reject(new Error(`Task failed: ${task.error || 'Unknown error'}`));
              }
            }
          },
          (error) => {
            // Fall back to polling on SSE error
            clearInterval(checkTimeout);
            if (!resolved) {
              resolved = true;
              this.waitForTaskPolling(taskId, timeout, progressCallback)
                .then(resolve)
                .catch(reject);
            }
          }
        ).then((cancelFn) => {
          cancel = cancelFn;
        });
      });
    }

    // Use polling
    return this.waitForTaskPolling(taskId, timeout, progressCallback);
  }

  /**
   * Wait for task using polling (fallback)
   */
  private async waitForTaskPolling(
    taskId: string,
    timeout: number,
    progressCallback?: (task: Task) => void
  ): Promise<Task> {
    const startTime = Date.now();
    const pollInterval = 2000; // 2 seconds

    while (true) {
      if (Date.now() - startTime > timeout * 1000) {
        throw new Error(`Task ${taskId} did not complete within ${timeout}s`);
      }

      const task = await this.getTask(taskId);
      progressCallback?.(task);

      if (task.status === 'completed') {
        return task;
      } else if (task.status === 'failed') {
        throw new Error(`Task failed: ${task.error || 'Unknown error'}`);
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }

  /**
   * Request file upload authorization
   */
  async requestFileUpload(
    spaceId: string,
    name: string,
    bytes: number,
    hash: string,
    chunkSize: number
  ): Promise<UploadAuthResponse> {
    try {
      const response = await this.client.post<UploadAuthResponse>(
        `/spaces/${spaceId}/file/auth`,
        {
          name,
          bytes,
          hash,
          chunkSize,
        }
      );

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw APIError.fromAxiosError(error);
      }
      throw error;
    }
  }

  /**
   * Calculate MD5 hash of file
   */
  static calculateMD5(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('md5');
      const stream = fs.createReadStream(filePath);

      stream.on('data', (data) => hash.update(data));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }
}

import axios, { type AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import { resolveAuthUuid } from './auth-uuid.js';
import { APIError } from './errors.js';
import { DEFAULT_ROOT, type CreateDeckOptions } from './types.js';

type RetriableConfig = Record<string, unknown> & {
  headers?: Record<string, string>;
  url?: string;
  params?: Record<string, unknown>;
  data?: unknown;
  __deckopsCheckoutRetried?: boolean;
  __deckopsAuthRetried?: boolean;
};

export type NodeReadableLike = {
  on(event: 'data', listener: (chunk: unknown) => void): NodeReadableLike;
  on(event: 'error', listener: (error: Error) => void): NodeReadableLike;
  on(event: 'end' | 'close', listener: () => void): NodeReadableLike;
  off(event: 'data', listener: (chunk: unknown) => void): NodeReadableLike;
  off(event: 'error', listener: (error: Error) => void): NodeReadableLike;
  off(event: 'end' | 'close', listener: () => void): NodeReadableLike;
  destroy?: () => void;
};

export class HttpClient {
  private client: AxiosInstance;
  private readonly authUuidPromise: Promise<string>;
  public readonly root: string;
  public token?: string;
  public apiKey?: string;
  public spaceId?: string;
  private readonly onUnauthorized?: CreateDeckOptions['onUnauthorized'];
  private readonly onPaymentRequired?: CreateDeckOptions['onPaymentRequired'];

  constructor(options: CreateDeckOptions = {}) {
    this.root = (options.root ?? DEFAULT_ROOT).replace(/\/$/, '');
    this.token = options.token;
    this.apiKey = options.apiKey;
    this.spaceId = options.spaceId;
    this.onUnauthorized = options.onUnauthorized;
    this.onPaymentRequired = options.onPaymentRequired;
    this.authUuidPromise = resolveAuthUuid(options);

    this.client = axios.create({
      baseURL: this.root,
      headers: this.buildAuthHeaders(),
      timeout: 30000,
    });

    this.client.interceptors.request.use(async (config) => {
      config.headers = config.headers ?? {};
      config.headers['X-Auth-UUID'] = await this.authUuidPromise;
      return config;
    });

    this.client.interceptors.response.use(
      (res) => res,
      async (error) => {
        if (!axios.isAxiosError(error)) {
          throw error;
        }

        const status = error.response?.status;
        const cfg = error.config as RetriableConfig | undefined;

        if (status === 402 && options.onPaymentRequired && cfg && !cfg.__deckopsCheckoutRetried) {
          cfg.__deckopsCheckoutRetried = true;
          await options.onPaymentRequired();
          return await this.client.request(cfg);
        }

        if (status === 401 && options.onUnauthorized && cfg && !cfg.__deckopsAuthRetried) {
          cfg.__deckopsAuthRetried = true;
          const oldSpaceId = this.spaceId;
          const auth = await options.onUnauthorized();
          const nextToken = typeof auth === 'string' ? auth : auth.token;
          const nextSpaceId = typeof auth === 'string' ? this.spaceId : auth.spaceId;

          this.setToken(nextToken);
          if (nextSpaceId) {
            this.setSpaceId(nextSpaceId);
          }
          this.rewriteRequestSpaceId(cfg, oldSpaceId, nextSpaceId);

          cfg.headers = { ...(cfg.headers ?? {}), ...this.buildAuthHeaders() };
          return await this.client.request(cfg);
        }

        throw error;
      }
    );

    axiosRetry(this.client, {
      retries: 3,
      retryDelay: (...args) => axiosRetry.exponentialDelay(...args),
      retryCondition: (error) =>
        axiosRetry.isNetworkOrIdempotentRequestError(error) ||
        [429, 500, 502, 503, 504].includes(error.response?.status || 0),
    });
  }

  setToken(token: string | undefined): void {
    this.token = token;
    this.applyAuthHeaders();
  }

  setApiKey(apiKey: string | undefined): void {
    this.apiKey = apiKey;
    this.applyAuthHeaders();
  }

  setSpaceId(spaceId: string | undefined): void {
    this.spaceId = spaceId;
  }

  getAuthUuid(): Promise<string> {
    return this.authUuidPromise;
  }

  url(path: string): string {
    return `${this.root}/${path.replace(/^\//, '')}`;
  }

  async get<T>(path: string, config?: Record<string, unknown>): Promise<{ data: T; headers: Record<string, unknown> }> {
    try {
      const res = await this.client.get<T>(this.url(path), config);
      return { data: res.data, headers: res.headers as Record<string, unknown> };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw APIError.fromAxiosError(error);
      }
      throw error;
    }
  }

  async post<T>(
    path: string,
    data?: unknown,
    config?: Record<string, unknown>
  ): Promise<{ data: T; headers: Record<string, unknown> }> {
    try {
      const res = await this.client.post<T>(this.url(path), data, config);
      return { data: res.data, headers: res.headers as Record<string, unknown> };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw APIError.fromAxiosError(error);
      }
      throw error;
    }
  }

  async delete(path: string, config?: Record<string, unknown>): Promise<void> {
    try {
      await this.client.delete(this.url(path), config);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw APIError.fromAxiosError(error);
      }
      throw error;
    }
  }

  async eventStream<T>(
    path: string,
    config: {
      headers?: Record<string, string>;
      params?: Record<string, string>;
      signal?: AbortSignal;
    } = {}
  ): Promise<{ data: T | ReadableStream<Uint8Array> | NodeReadableLike; headers: Record<string, unknown> }> {
    if (this.shouldUseFetchStream()) {
      return await this.fetchEventStream<T>(path, config);
    }

    return await this.get<T | NodeReadableLike>(path, {
      headers: config.headers,
      responseType: 'stream',
      signal: config.signal,
      params: config.params,
      'axios-retry': { retries: 0 },
    });
  }

  private buildAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.token) {
      headers['X-Auth-Token'] = this.token;
    }
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private shouldUseFetchStream(): boolean {
    return (
      typeof fetch === 'function' &&
      typeof ReadableStream !== 'undefined' &&
      !(typeof process !== 'undefined' && process.versions?.node)
    );
  }

  private async fetchEventStream<T>(
    path: string,
    config: {
      headers?: Record<string, string>;
      params?: Record<string, string>;
      signal?: AbortSignal;
    }
  ): Promise<{ data: T | ReadableStream<Uint8Array>; headers: Record<string, unknown> }> {
    let checkoutRetried = false;
    let authRetried = false;
    const params = { ...(config.params ?? {}) };

    for (;;) {
      const headers = {
        ...this.buildAuthHeaders(),
        'X-Auth-UUID': await this.authUuidPromise,
        ...(config.headers ?? {}),
      };
      const response = await fetch(this.urlWithParams(path, params), {
        method: 'GET',
        headers,
        signal: config.signal,
      });
      const responseHeaders = this.headersFromFetch(response.headers);

      if (response.status === 402 && this.onPaymentRequired && !checkoutRetried) {
        checkoutRetried = true;
        await this.onPaymentRequired();
        continue;
      }

      if (response.status === 401 && this.onUnauthorized && !authRetried) {
        authRetried = true;
        const oldSpaceId = this.spaceId;
        const auth = await this.onUnauthorized();
        const nextToken = typeof auth === 'string' ? auth : auth.token;
        const nextSpaceId = typeof auth === 'string' ? this.spaceId : auth.spaceId;
        this.setToken(nextToken);
        if (nextSpaceId) {
          this.setSpaceId(nextSpaceId);
        }
        if (oldSpaceId && nextSpaceId && params.spaceId === oldSpaceId) {
          params.spaceId = nextSpaceId;
        }
        continue;
      }

      if (!response.ok) {
        throw Object.assign(new Error(`Request failed with status ${response.status}`), {
          statusCode: response.status,
        });
      }

      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (contentType.includes('application/json')) {
        return { data: (await response.json()) as T, headers: responseHeaders };
      }

      if (!response.body) {
        throw new Error('Response body is not available for event stream');
      }

      return { data: response.body, headers: responseHeaders };
    }
  }

  private urlWithParams(path: string, params?: Record<string, string>): string {
    const url = new URL(this.url(path));
    for (const [key, value] of Object.entries(params ?? {})) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  private headersFromFetch(headers: Headers): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  private applyAuthHeaders(): void {
    const headers = this.buildAuthHeaders();
    delete this.client.defaults.headers.common['X-Auth-Token'];
    delete this.client.defaults.headers.common.Authorization;
    for (const [key, value] of Object.entries(headers)) {
      this.client.defaults.headers.common[key] = value;
    }
  }

  private rewriteRequestSpaceId(cfg: RetriableConfig, oldSpaceId?: string, newSpaceId?: string): void {
    if (!oldSpaceId || !newSpaceId || oldSpaceId === newSpaceId) {
      return;
    }

    const encodedOld = encodeURIComponent(oldSpaceId);
    const encodedNew = encodeURIComponent(newSpaceId);

    if (typeof cfg.url === 'string') {
      cfg.url = cfg.url.replace(`/spaces/${encodedOld}/`, `/spaces/${encodedNew}/`);
    }

    if (cfg.params && cfg.params.spaceId === oldSpaceId) {
      cfg.params.spaceId = newSpaceId;
    }

    if (!cfg.data) {
      return;
    }

    if (typeof cfg.data === 'string') {
      try {
        const parsed = JSON.parse(cfg.data) as Record<string, unknown>;
        if (parsed.spaceId === oldSpaceId) {
          parsed.spaceId = newSpaceId;
          cfg.data = JSON.stringify(parsed);
        }
      } catch {
        // Ignore non-JSON request bodies.
      }
    } else if (typeof cfg.data === 'object' && (cfg.data as Record<string, unknown>).spaceId === oldSpaceId) {
      (cfg.data as Record<string, unknown>).spaceId = newSpaceId;
    }
  }
}

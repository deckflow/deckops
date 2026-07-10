import axios, { AxiosHeaders, type AxiosInstance } from 'axios';
import { resolveAuthUuid } from './auth-uuid.js';
import { APIError, getRetryDelaysMs, isRetriableAxiosError } from './errors.js';
import { DEFAULT_ROOT, type CreateDeckOptions, type UserSelf } from './types.js';

type RetriableConfig = Record<string, unknown> & {
  headers?: Record<string, string>;
  url?: string;
  params?: Record<string, unknown>;
  data?: unknown;
  __deckopsCheckoutRetried?: boolean;
  __deckopsAuthRetried?: boolean;
};

type AuthRefreshResult = { token: string; spaceId?: string } | string;

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
  private spaceIdExplicit = false;
  private resolvedSpaceIdPromise?: Promise<string>;
  private authRefreshPromise?: Promise<AuthRefreshResult>;
  private readonly onUnauthorized?: CreateDeckOptions['onUnauthorized'];
  private readonly onPaymentRequired?: CreateDeckOptions['onPaymentRequired'];

  constructor(options: CreateDeckOptions = {}) {
    this.root = (options.root ?? DEFAULT_ROOT).replace(/\/$/, '');
    this.token = options.token;
    this.apiKey = options.apiKey;
    this.spaceId = options.spaceId;
    this.spaceIdExplicit = Boolean(options.spaceId);
    this.onUnauthorized = options.onUnauthorized;
    this.onPaymentRequired = options.onPaymentRequired;
    this.authUuidPromise = resolveAuthUuid(options);

    this.client = axios.create({
      baseURL: this.root,
      headers: this.buildAuthHeaders(),
      timeout: 30000,
    });

    this.client.interceptors.request.use(async (config) => {
      const authUuid = await this.authUuidPromise;
      const authHeaders = this.buildAuthHeaders();
      const headers = config.headers;

      if (headers && typeof (headers as { set?: unknown }).set === 'function') {
        const mutable = headers as { set: (key: string, value: string) => void };
        for (const [key, value] of Object.entries(authHeaders)) {
          mutable.set(key, value);
        }
        mutable.set('X-Auth-UUID', authUuid);
        return config;
      }

      config.headers = AxiosHeaders.from({
        ...(headers as Record<string, string> | undefined),
        ...authHeaders,
        'X-Auth-UUID': authUuid,
      });
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

        if (status === 402 && cfg && !cfg.__deckopsCheckoutRetried) {
          if (options.onPaymentRequired) {
            cfg.__deckopsCheckoutRetried = true;
            await options.onPaymentRequired();
            return await this.client.request(cfg);
          }
          throw APIError.paymentRequired(error);
        }

        if (status === 401 && cfg && !cfg.__deckopsAuthRetried) {
          if (this.isApiKeyAuth()) {
            throw APIError.unauthorizedApiKey(error);
          }
          if (this.onUnauthorized) {
            cfg.__deckopsAuthRetried = true;
            const oldSpaceId = this.spaceId;
            const auth = await this.refreshAuth();
            this.applyAuthResult(auth, cfg, oldSpaceId);
            return await this.client.request(cfg);
          }
          throw APIError.unauthorizedToken(error);
        }

        throw error;
      }
    );
  }

  private async withRetry<T>(request: () => Promise<T>): Promise<T> {
    const delays = getRetryDelaysMs();
    let lastError: unknown;

    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) {
        await this.sleep(delays[attempt - 1] ?? delays[delays.length - 1]!);
      }
      try {
        return await request();
      } catch (error) {
        lastError = error;
        if (!axios.isAxiosError(error) || !isRetriableAxiosError(error) || attempt >= delays.length) {
          throw error;
        }
      }
    }

    throw lastError;
  }

  setToken(token: string | undefined): void {
    this.token = token;
    this.clearAutoResolvedSpaceId();
    this.applyAuthHeaders();
  }

  setApiKey(apiKey: string | undefined): void {
    this.apiKey = apiKey;
    this.clearAutoResolvedSpaceId();
    this.applyAuthHeaders();
  }

  setSpaceId(spaceId: string | undefined): void {
    this.spaceId = spaceId;
    this.spaceIdExplicit = Boolean(spaceId);
    this.resolvedSpaceIdPromise = undefined;
  }

  async resolveSpaceId(spaceId?: string): Promise<string> {
    if (spaceId) {
      return spaceId;
    }
    if (this.spaceId) {
      return this.spaceId;
    }

    if (!this.resolvedSpaceIdPromise) {
      this.resolvedSpaceIdPromise = this.fetchDefaultSpaceId();
    }

    try {
      return await this.resolvedSpaceIdPromise;
    } catch (error) {
      this.resolvedSpaceIdPromise = undefined;
      throw error;
    }
  }

  private async fetchDefaultSpaceId(): Promise<string> {
    if (!this.token && !this.apiKey) {
      throw new Error('spaceId is required');
    }

    const res = await this.get<UserSelf>('/user');
    const id = res.data.id;
    if (!id) {
      throw new Error('user.self did not return an id');
    }

    this.spaceId = id;
    return id;
  }

  private clearAutoResolvedSpaceId(): void {
    if (this.spaceIdExplicit) {
      return;
    }
    this.spaceId = undefined;
    this.resolvedSpaceIdPromise = undefined;
  }

  getAuthUuid(): Promise<string> {
    return this.authUuidPromise;
  }

  url(path: string): string {
    return `${this.root}/${path.replace(/^\//, '')}`;
  }

  async get<T>(path: string, config?: Record<string, unknown>): Promise<{ data: T; headers: Record<string, unknown> }> {
    try {
      const request = () => this.client.get<T>(this.url(path), config);
      const res =
        config?.responseType === 'stream' ? await request() : await this.withRetry(request);
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
      const res = await this.withRetry(() => this.client.post<T>(this.url(path), data, config));
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
      await this.withRetry(() => this.client.delete(this.url(path), config));
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

    for (let networkRetry = 0; ; networkRetry++) {
      const retryDelays = getRetryDelaysMs();
      if (networkRetry > 0) {
        await this.sleep(retryDelays[networkRetry - 1] ?? retryDelays[retryDelays.length - 1]!);
      }

      let response: Response;
      try {
        const headers = {
          ...this.buildAuthHeaders(),
          'X-Auth-UUID': await this.authUuidPromise,
          ...(config.headers ?? {}),
        };
        response = await fetch(this.urlWithParams(path, params), {
          method: 'GET',
          headers,
          signal: config.signal,
        });
      } catch (error) {
        if (networkRetry < getRetryDelaysMs().length && this.isRetriableFetchError(error)) {
          continue;
        }
        throw error;
      }

      const responseHeaders = this.headersFromFetch(response.headers);

      if (response.status === 402 && !checkoutRetried) {
        if (this.onPaymentRequired) {
          checkoutRetried = true;
          await this.onPaymentRequired();
          networkRetry = 0;
          continue;
        }
        throw await this.readFetchAPIError(response, responseHeaders);
      }

      if (response.status === 401 && !authRetried) {
        if (this.isApiKeyAuth()) {
          throw await this.readFetchAPIError(response, responseHeaders, 'Authentication failed. Please update your API key.');
        }
        if (this.onUnauthorized) {
          authRetried = true;
          const oldSpaceId = this.spaceId;
          const auth = await this.refreshAuth();
          const nextSpaceId = this.applyAuthResult(auth, undefined, oldSpaceId);
          if (oldSpaceId && nextSpaceId && params.spaceId === oldSpaceId) {
            params.spaceId = nextSpaceId;
          }
          networkRetry = 0;
          continue;
        }
        throw await this.readFetchAPIError(response, responseHeaders, 'Authentication expired. Please log in again.');
      }

      if (!response.ok) {
        if (networkRetry < getRetryDelaysMs().length && (response.status === 604 || response.status === 502)) {
          continue;
        }
        throw await this.readFetchAPIError(response, responseHeaders);
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

  private isApiKeyAuth(): boolean {
    return Boolean(this.apiKey && !this.token);
  }

  private isRetriableFetchError(error: unknown): boolean {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return false;
    }
    if (!(error instanceof Error)) {
      return true;
    }
    const message = error.message.toLowerCase();
    return message.includes('network') || message.includes('timeout') || message.includes('fetch failed');
  }

  private async readFetchAPIError(
    response: Response,
    headers: Record<string, unknown>,
    fallbackMessage?: string
  ): Promise<APIError> {
    const text = await response.text();
    let data: unknown = text;
    if (text) {
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        // Keep plain text body.
      }
    }
    const apiError = APIError.fromResponse(response.status, data, headers);
    if (fallbackMessage) {
      const requestIdSuffix = apiError.requestId ? ` [X-RequestId: ${apiError.requestId}]` : '';
      return new APIError(
        `API Error (${response.status}): ${fallbackMessage}${requestIdSuffix}`,
        response.status,
        apiError.responseData,
        apiError.requestId
      );
    }
    return apiError;
  }

  private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      if (signal?.aborted) {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    });
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

  private refreshAuth(): Promise<AuthRefreshResult> {
    if (!this.onUnauthorized) {
      return Promise.reject(new Error('onUnauthorized is not configured'));
    }
    if (!this.authRefreshPromise) {
      this.authRefreshPromise = this.onUnauthorized().finally(() => {
        this.authRefreshPromise = undefined;
      });
    }
    return this.authRefreshPromise;
  }

  private applyAuthResult(
    auth: AuthRefreshResult,
    cfg?: RetriableConfig,
    oldSpaceId?: string
  ): string | undefined {
    const nextToken = typeof auth === 'string' ? auth : auth.token;
    const nextSpaceId = typeof auth === 'string' ? this.spaceId : auth.spaceId;
    const previousSpaceId = oldSpaceId ?? this.spaceId;

    this.setToken(nextToken);
    if (nextSpaceId) {
      this.setSpaceId(nextSpaceId);
    }
    if (cfg) {
      this.rewriteRequestSpaceId(cfg, previousSpaceId, nextSpaceId);
      cfg.headers = { ...(cfg.headers ?? {}), ...this.buildAuthHeaders() };
    }

    return nextSpaceId;
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

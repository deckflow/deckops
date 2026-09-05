import axios, { AxiosHeaders, type AxiosInstance } from 'axios';
import { delay, throwIfAborted, withSignal } from './abort.js';
import type { DeckRuntime } from './runtime.js';
import { APIError, getRetryDelaysMs, isRetriableAxiosError } from './errors.js';
import { DEFAULT_ROOT, type CreateDeckOptions, type UserSelf } from './contracts.js';

type RetriableConfig = Record<string, unknown> & {
  headers?: Record<string, string>;
  url?: string;
  params?: Record<string, unknown>;
  data?: (unknown) | undefined;
  __deckopsCheckoutRetried?: (boolean) | undefined;
  __deckopsAuthRetried?: (boolean) | undefined;
  signal?: AbortSignal;
};

type AuthRefreshResult = { token: string; spaceId?: (string) | undefined } | string;

export type NodeReadableLike = {
  on(event: 'data', listener: (chunk: unknown) => void): NodeReadableLike;
  on(event: 'error', listener: (error: Error) => void): NodeReadableLike;
  on(event: 'end' | 'close', listener: () => void): NodeReadableLike;
  off(event: 'data', listener: (chunk: unknown) => void): NodeReadableLike;
  off(event: 'error', listener: (error: Error) => void): NodeReadableLike;
  off(event: 'end' | 'close', listener: () => void): NodeReadableLike;
  destroy?: (() => void) | undefined;
};

export class HttpClient {
  private client: AxiosInstance;
  private readonly authUuidPromise: Promise<string>;
  public readonly root: string;
  public token?: (string) | undefined;
  public apiKey?: (string) | undefined;
  public spaceId?: (string) | undefined;
  private spaceIdExplicit = false;
  private resolvedSpaceIdPromise?: (Promise<string>) | undefined;
  private authRefreshPromise?: (Promise<AuthRefreshResult>) | undefined;
  private guestDowngradePromise?: (Promise<string>) | undefined;
  /** Set after credentials are cleared due to 401; later parallel 401s still retry as guest. */
  private authDowngradedToGuest = false;
  private readonly onUnauthorized?: (CreateDeckOptions['onUnauthorized']) | undefined;
  private readonly onPaymentRequired?: (CreateDeckOptions['onPaymentRequired']) | undefined;
  private readonly allowGuestFallback: boolean;
  private readonly retryMutations: boolean;

  constructor(options: CreateDeckOptions, private readonly runtime: DeckRuntime) {
    this.root = (options.root ?? DEFAULT_ROOT).replace(/\/$/, '');
    this.token = options.token;
    this.apiKey = options.apiKey;
    this.spaceId = options.spaceId;
    this.spaceIdExplicit = Boolean(options.spaceId);
    this.onUnauthorized = options.onUnauthorized;
    this.onPaymentRequired = options.onPaymentRequired;
    this.allowGuestFallback = options.allowGuestFallback ?? true;
    this.retryMutations = options.retryMutations ?? true;
    this.authUuidPromise = runtime.resolveAuthUuid(options);

    this.client = axios.create({
      baseURL: this.root,
      headers: this.buildAuthHeaders(),
      timeout: 30000,
    });

    this.client.interceptors.request.use(async (config) => {
      const authUuid = await withSignal(this.authUuidPromise, config.signal as AbortSignal | undefined);
      throwIfAborted(config.signal as AbortSignal | undefined);
      const authHeaders = this.buildAuthHeaders();
      const isFormData = typeof FormData !== 'undefined' && config.data instanceof FormData;
      if (isFormData) {
        delete authHeaders['Content-Type'];
      }
      const headers = config.headers;

      if (headers && typeof (headers as { set?: (unknown) | undefined }).set === 'function') {
        const mutable = headers as {
          set: (key: string, value: string) => void;
          delete?: ((key: string) => void) | undefined;
        };
        mutable.delete?.('X-Auth-Token');
        mutable.delete?.('Authorization');
        if (isFormData) {
          mutable.delete?.('Content-Type');
        }
        for (const [key, value] of Object.entries(authHeaders)) {
          mutable.set(key, value);
        }
        mutable.set('X-Auth-UUID', authUuid);
        return config;
      }

      const plain = { ...(headers as Record<string, string> | undefined) };
      delete plain['X-Auth-Token'];
      delete plain.Authorization;
      if (isFormData) {
        delete plain['Content-Type'];
      }
      config.headers = AxiosHeaders.from({
        ...plain,
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
        throwIfAborted(cfg?.signal);

        if (status === 402 && cfg && !cfg.__deckopsCheckoutRetried) {
          if (options.onPaymentRequired) {
            cfg.__deckopsCheckoutRetried = true;
            await withSignal(options.onPaymentRequired(), cfg.signal);
            return await this.client.request(cfg);
          }
          throw APIError.paymentRequired(error);
        }

        if (status === 401 && cfg && !cfg.__deckopsAuthRetried) {
          cfg.__deckopsAuthRetried = true;
          const oldSpaceId = this.spaceIdFromConfig(cfg) ?? this.spaceId;

          if (this.onUnauthorized && this.token && !this.isApiKeyAuth()) {
            let auth: AuthRefreshResult | undefined;
            try {
              auth = await withSignal(this.refreshAuth(), cfg.signal);
            } catch {
              throwIfAborted(cfg.signal);
              if (!this.allowGuestFallback) throw error;
            }
            if (auth && (typeof auth === 'string' ? auth : auth.token)) {
              this.applyAuthResult(auth, cfg, oldSpaceId);
              return await this.client.request(cfg);
            }
          }

          if (this.allowGuestFallback && (this.hasCredentials() || this.authDowngradedToGuest || this.guestDowngradePromise)) {
            const guestSpaceId = await withSignal(this.ensureGuestMode(), cfg.signal);
            this.rewriteRequestSpaceId(cfg, oldSpaceId, guestSpaceId);
            cfg.headers = this.guestRequestHeaders(cfg.headers);
            return await this.client.request(cfg);
          }
        }

        throw error;
      }
    );
  }

  private async withRetry<T>(request: () => Promise<T>, signal?: AbortSignal, retry = true): Promise<T> {
    const delays = getRetryDelaysMs();
    let lastError: unknown;

    for (let attempt = 0; attempt <= delays.length; attempt++) {
      throwIfAborted(signal);
      if (attempt > 0) {
        await delay(delays[attempt - 1] ?? delays[delays.length - 1]!, signal);
      }
      try {
        return await request();
      } catch (error) {
        throwIfAborted(signal);
        lastError = error;
        if (!retry || axios.isCancel(error) || !axios.isAxiosError(error) || !isRetriableAxiosError(error) || attempt >= delays.length) {
          throw error;
        }
      }
    }

    throw lastError;
  }

  setToken(token: string | undefined): void {
    this.token = token;
    if (token) {
      this.authDowngradedToGuest = false;
    }
    this.clearAutoResolvedSpaceId();
    this.applyAuthHeaders();
  }

  setApiKey(apiKey: string | undefined): void {
    this.apiKey = apiKey;
    if (apiKey) {
      this.authDowngradedToGuest = false;
    }
    this.clearAutoResolvedSpaceId();
    this.applyAuthHeaders();
  }

  setSpaceId(spaceId: string | undefined): void {
    this.spaceId = spaceId;
    this.spaceIdExplicit = Boolean(spaceId);
    this.resolvedSpaceIdPromise = undefined;
  }

  async resolveSpaceId(spaceId?: string, signal?: AbortSignal): Promise<string | undefined> {
    throwIfAborted(signal);
    if (spaceId) {
      return spaceId;
    }
    if (this.spaceId) {
      return this.spaceId;
    }

    // A cancellable lookup owns its request so aborting one caller never cancels another caller.
    if (signal) return await this.fetchDefaultSpaceId(signal);

    // Resolve from GET /user. The endpoint only requires X-Auth-UUID, so
    // it works for both authenticated users and guests. The server enforces
    // guest usage limits and rate quotas based on X-Auth-UUID.
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

  private async fetchDefaultSpaceId(signal?: AbortSignal): Promise<string> {
    const res = await this.get<UserSelf>('/user', { signal });
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
        config?.responseType === 'stream' ? await request() : await this.withRetry(request, config?.signal as AbortSignal | undefined);
      return { data: res.data, headers: res.headers as Record<string, unknown> };
    } catch (error) {
      throwIfAborted(config?.signal as AbortSignal | undefined);
      if (axios.isCancel(error)) throw error;
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
      const res = await this.withRetry(() => this.client.post<T>(this.url(path), data, config), config?.signal as AbortSignal | undefined, this.retryMutations);
      return { data: res.data, headers: res.headers as Record<string, unknown> };
    } catch (error) {
      throwIfAborted(config?.signal as AbortSignal | undefined);
      if (axios.isCancel(error)) throw error;
      if (axios.isAxiosError(error)) {
        throw APIError.fromAxiosError(error);
      }
      throw error;
    }
  }

  async eventStream<T>(
    path: string,
    config: {
      headers?: (Record<string, string>) | undefined;
      params?: (Record<string, string>) | undefined;
      signal?: (AbortSignal) | undefined;
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
    return this.runtime.useFetchStreams === true;
  }

  private async fetchEventStream<T>(
    path: string,
    config: {
      headers?: (Record<string, string>) | undefined;
      params?: (Record<string, string>) | undefined;
      signal?: (AbortSignal) | undefined;
    }
  ): Promise<{ data: T | ReadableStream<Uint8Array>; headers: Record<string, unknown> }> {
    let checkoutRetried = false;
    let authRetried = false;
    const params = { ...(config.params ?? {}) };

    for (let networkRetry = 0; ; networkRetry++) {
      throwIfAborted(config.signal);
      const retryDelays = getRetryDelaysMs();
      if (networkRetry > 0) {
        await delay(retryDelays[networkRetry - 1] ?? retryDelays[retryDelays.length - 1]!, config.signal);
      }

      let response: Response;
      try {
        const headers = {
          ...this.buildAuthHeaders(),
          'X-Auth-UUID': await withSignal(this.authUuidPromise, config.signal),
          ...(config.headers ?? {}),
        };
        response = await fetch(this.urlWithParams(path, params), {
          method: 'GET',
          headers,
          ...(config.signal ? { signal: config.signal } : {}),
        });
      } catch (error) {
        throwIfAborted(config.signal);
        if (networkRetry < getRetryDelaysMs().length && this.isRetriableFetchError(error)) {
          continue;
        }
        throw error;
      }

      const responseHeaders = this.headersFromFetch(response.headers);

      if (response.status === 402 && !checkoutRetried) {
        if (this.onPaymentRequired) {
          checkoutRetried = true;
          await withSignal(this.onPaymentRequired(), config.signal);
          networkRetry = 0;
          continue;
        }
        throw await this.readFetchAPIError(response, responseHeaders);
      }

      if (response.status === 401 && !authRetried) {
        authRetried = true;
        const oldSpaceId = params.spaceId ?? this.spaceId;

        if (this.onUnauthorized && this.token && !this.isApiKeyAuth()) {
          try {
            const auth = await withSignal(this.refreshAuth(), config.signal);
            if (!(typeof auth === 'string' ? auth : auth.token)) throw new Error('Token refresh returned no token');
            const nextSpaceId = this.applyAuthResult(auth, undefined, oldSpaceId);
            if (oldSpaceId && nextSpaceId && params.spaceId === oldSpaceId) {
              params.spaceId = nextSpaceId;
            }
            networkRetry = 0;
            continue;
          } catch {
            throwIfAborted(config.signal);
            if (!this.allowGuestFallback) throw await this.readFetchAPIError(response, responseHeaders);
          }
        }

        if (this.allowGuestFallback && (this.hasCredentials() || this.authDowngradedToGuest || this.guestDowngradePromise)) {
          const guestSpaceId = await withSignal(this.ensureGuestMode(), config.signal);
          if (oldSpaceId && params.spaceId === oldSpaceId) {
            params.spaceId = guestSpaceId;
          }
          networkRetry = 0;
          continue;
        }
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

  private hasCredentials(): boolean {
    return Boolean(this.token || this.apiKey);
  }

  /**
   * Clear expired credentials and resolve a guest space via GET /user
   * (X-Auth-UUID only). Concurrent 401s share one downgrade.
   */
  private ensureGuestMode(): Promise<string> {
    if (!this.hasCredentials() && this.spaceId && !this.guestDowngradePromise) {
      return Promise.resolve(this.spaceId);
    }
    return this.downgradeToGuest();
  }

  private downgradeToGuest(): Promise<string> {
    if (!this.guestDowngradePromise) {
      this.authDowngradedToGuest = true;
      this.guestDowngradePromise = (async () => {
        this.token = undefined;
        this.apiKey = undefined;
        this.applyAuthHeaders();
        this.spaceId = undefined;
        this.spaceIdExplicit = false;
        this.resolvedSpaceIdPromise = undefined;

        const guestSpaceId = await this.resolveSpaceId();
        if (!guestSpaceId) {
          throw new Error('Failed to resolve guest space id after auth downgrade');
        }
        return guestSpaceId;
      })().finally(() => {
        this.guestDowngradePromise = undefined;
      });
    }
    return this.guestDowngradePromise;
  }

  private guestRequestHeaders(headers?: Record<string, string>): Record<string, string> {
    const next = { ...(headers ?? {}) };
    delete next['X-Auth-Token'];
    delete next.Authorization;
    return { ...next, ...this.buildAuthHeaders() };
  }

  private spaceIdFromConfig(cfg: RetriableConfig): string | undefined {
    if (cfg.params && typeof cfg.params.spaceId === 'string') {
      return cfg.params.spaceId;
    }

    if (typeof FormData !== 'undefined' && cfg.data instanceof FormData) {
      const spaceId = cfg.data.get('spaceId');
      return typeof spaceId === 'string' ? spaceId : undefined;
    }

    if (typeof cfg.data === 'string') {
      try {
        const parsed = JSON.parse(cfg.data) as Record<string, unknown>;
        if (typeof parsed.spaceId === 'string') {
          return parsed.spaceId;
        }
      } catch {
        // Ignore non-JSON bodies.
      }
    } else if (cfg.data && typeof cfg.data === 'object') {
      const spaceId = (cfg.data as Record<string, unknown>).spaceId;
      if (typeof spaceId === 'string') {
        return spaceId;
      }
    }

    if (typeof cfg.url === 'string') {
      const match = cfg.url.match(/\/spaces\/([^/?#]+)\//);
      if (match?.[1]) {
        return decodeURIComponent(match[1]);
      }
    }

    return undefined;
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
      this.authRefreshPromise = this.onUnauthorized()
        .then((auth) => {
          const token = typeof auth === 'string' ? auth : auth?.token;
          if (typeof token !== 'string' || !token.trim()) {
            throw new Error('onUnauthorized must return a non-empty token');
          }
          return auth;
        })
        .finally(() => {
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
    const common = this.client.defaults.headers.common as {
      delete?: ((key: string) => void) | undefined;
      [key: string]: unknown;
    };
    if (typeof common.delete === 'function') {
      common.delete('X-Auth-Token');
      common.delete('Authorization');
    } else {
      delete common['X-Auth-Token'];
      delete common.Authorization;
    }
    for (const [key, value] of Object.entries(headers)) {
      common[key] = value;
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

    if (typeof FormData !== 'undefined' && cfg.data instanceof FormData) {
      if (cfg.data.get('spaceId') === oldSpaceId) cfg.data.set('spaceId', newSpaceId);
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

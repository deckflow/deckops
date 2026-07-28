import type { AxiosError } from 'axios';
import type { MetadataValue } from './types.js';

function tryHeaderValue(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) {
    return v.trim();
  }
  if (Array.isArray(v) && typeof v[0] === 'string' && v[0].trim()) {
    return v[0].trim();
  }
  return undefined;
}

function isRequestIdHeaderName(name: string): boolean {
  const n = name.trim().toLowerCase().replace(/_/g, '-');
  return n === 'x-request-id' || n === 'x-requestid' || n === 'request-id';
}

function extractRequestIdFromHeaders(headers: unknown): string | undefined {
  if (headers == null) {
    return undefined;
  }

  const names = [
    'x-request-id',
    'X-Request-Id',
    'X-RequestId',
    'x-requestid',
    'X-RequestID',
    'request-id',
    'Request-Id',
  ];

  if (typeof (headers as { get?: (name: string) => unknown }).get === 'function') {
    const get = (headers as { get: (name: string) => unknown }).get.bind(headers);
    for (const name of names) {
      const v = tryHeaderValue(get(name));
      if (v) {
        return v;
      }
    }
  }

  if (typeof (headers as { toJSON?: (asStrings?: boolean) => Record<string, unknown> }).toJSON === 'function') {
    const flat = (headers as { toJSON: (asStrings?: boolean) => Record<string, unknown> }).toJSON(true);
    for (const [key, value] of Object.entries(flat)) {
      if (isRequestIdHeaderName(key)) {
        const v = tryHeaderValue(value);
        if (v) {
          return v;
        }
      }
    }
  }

  if (typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (isRequestIdHeaderName(key)) {
        const v = tryHeaderValue(value);
        if (v) {
          return v;
        }
      }
    }
  }

  return undefined;
}

function extractRequestIdFromBody(data: unknown): string | undefined {
  if (data == null) {
    return undefined;
  }

  let obj: unknown = data;
  if (typeof data === 'string') {
    try {
      obj = JSON.parse(data) as unknown;
    } catch {
      return undefined;
    }
  }

  if (typeof obj !== 'object' || obj === null) {
    return undefined;
  }

  const d = obj as Record<string, unknown>;
  for (const key of [
    'requestId',
    'request_id',
    'RequestId',
    'xRequestId',
    'XRequestId',
    'traceId',
    'trace_id',
    'TraceId',
    'correlationId',
    'correlation_id',
  ]) {
    const v = d[key];
    if (typeof v === 'string' && v.trim()) {
      return v.trim();
    }
  }

  return undefined;
}

function extractErrorMessage(data: unknown, fallback = 'Request failed'): string {
  if (data == null) {
    return fallback;
  }
  if (typeof data === 'string') {
    return data.length > 500 ? `${data.slice(0, 500)}...` : data;
  }
  if (typeof data === 'object') {
    const body = data as Record<string, unknown>;
    const candidate = body.message ?? body.error ?? body.msg;
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return fallback;
}

function formatAPIErrorMessage(status: number | undefined, message: string, requestId?: string): string {
  const base = `API Error (${status ?? 'unknown'}): ${message}`;
  return requestId ? `${base} [X-RequestId: ${requestId}]` : base;
}

export const RETRY_DELAYS_MS = [5000, 10000, 20000] as const;

let retryDelaysMs: readonly number[] = RETRY_DELAYS_MS;

export function setRetryDelaysForTests(delays: readonly number[]): void {
  retryDelaysMs = delays;
}

export function resetRetryDelaysForTests(): void {
  retryDelaysMs = RETRY_DELAYS_MS;
}

export function getRetryDelaysMs(): readonly number[] {
  return retryDelaysMs;
}

export function isRetriableHTTPStatus(status?: number): boolean {
  // Only transient upstream/gateway failures — never 4xx business errors (403, 404, …).
  return status === 604 || status === 502;
}

export function isRetriableAxiosError(error: AxiosError): boolean {
  if (!error.response) {
    return (
      error.code === 'ECONNABORTED' ||
      error.code === 'ETIMEDOUT' ||
      error.code === 'ENOTFOUND' ||
      error.code === 'ECONNREFUSED' ||
      error.code === 'ERR_NETWORK' ||
      error.message.toLowerCase().includes('network')
    );
  }
  return isRetriableHTTPStatus(error.response.status);
}

export class APIError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public responseData?: MetadataValue,
    public readonly requestId?: string
  ) {
    super(message);
    this.name = 'APIError';
  }

  static fromAxiosError(error: AxiosError): APIError {
    const status = error.response?.status;
    const data = error.response?.data;
    const requestId =
      extractRequestIdFromHeaders(error.response?.headers) ?? extractRequestIdFromBody(data);
    const errorMessage = extractErrorMessage(data, error.message || 'Unknown API error');

    return new APIError(
      formatAPIErrorMessage(status, errorMessage, requestId),
      status,
      data as MetadataValue | undefined,
      requestId
    );
  }

  static fromResponse(status: number, data: unknown, headers: unknown): APIError {
    const requestId = extractRequestIdFromHeaders(headers) ?? extractRequestIdFromBody(data);
    const errorMessage = extractErrorMessage(data, `Request failed with status ${status}`);

    return new APIError(
      formatAPIErrorMessage(status, errorMessage, requestId),
      status,
      data as MetadataValue | undefined,
      requestId
    );
  }

  static unauthorizedApiKey(error: AxiosError): APIError {
    const requestId =
      extractRequestIdFromHeaders(error.response?.headers) ?? extractRequestIdFromBody(error.response?.data);
    const message = 'Authentication failed. Please update your API key.';
    return new APIError(formatAPIErrorMessage(401, message, requestId), 401, undefined, requestId);
  }

  static unauthorizedToken(error: AxiosError): APIError {
    const requestId =
      extractRequestIdFromHeaders(error.response?.headers) ?? extractRequestIdFromBody(error.response?.data);
    const message = 'Authentication expired. Please log in again.';
    return new APIError(formatAPIErrorMessage(401, message, requestId), 401, undefined, requestId);
  }

  static paymentRequired(error: AxiosError): APIError {
    const requestId =
      extractRequestIdFromHeaders(error.response?.headers) ?? extractRequestIdFromBody(error.response?.data);
    const message = 'Payment is required. Please complete checkout and try again.';
    return new APIError(formatAPIErrorMessage(402, message, requestId), 402, undefined, requestId);
  }
}

/**
 * Whether an error is worth retrying.
 *
 * Retries exist for transient network / upstream issues only.
 * Explicit application errors (403, 401, 404, 4xx in general) must fail immediately.
 */
export function isRetriableError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && (error as { isAxiosError?: boolean }).isAxiosError) {
    return isRetriableAxiosError(error as AxiosError);
  }

  if (error instanceof APIError) {
    return typeof error.statusCode === 'number' ? isRetriableHTTPStatus(error.statusCode) : false;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message;
  const statusMatch = /(?:API Error \(|Failed to download [^:]+: )(\d{3})\b/i.exec(message);
  if (statusMatch) {
    return isRetriableHTTPStatus(Number.parseInt(statusMatch[1]!, 10));
  }

  const lower = message.toLowerCase();
  return (
    lower.includes('network') ||
    lower.includes('timeout') ||
    lower.includes('fetch failed') ||
    lower.includes('econnaborted') ||
    lower.includes('etimedout') ||
    lower.includes('enotfound') ||
    lower.includes('econnrefused') ||
    lower.includes('err_network')
  );
}

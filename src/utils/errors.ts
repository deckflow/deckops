/**
 * Error handling utilities
 */

import chalk from 'chalk';

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

/**
 * Read request correlation id from axios response headers (AxiosHeaders.toJSON, .get, plain object).
 */
function extractRequestIdFromHeaders(headers: unknown): string | undefined {
  if (headers == null) {
    return undefined;
  }

  const headerNamesToTry = [
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
    for (const name of headerNamesToTry) {
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
    for (const key of Object.keys(headers as Record<string, unknown>)) {
      if (isRequestIdHeaderName(key)) {
        const v = tryHeaderValue((headers as Record<string, unknown>)[key]);
        if (v) {
          return v;
        }
      }
    }
    for (const key in headers as Record<string, unknown>) {
      if (Object.prototype.hasOwnProperty.call(headers, key) && isRequestIdHeaderName(key)) {
        const v = tryHeaderValue((headers as Record<string, unknown>)[key]);
        if (v) {
          return v;
        }
      }
    }
  }

  return undefined;
}

/**
 * Some APIs return correlation id only in JSON error bodies.
 */
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
  const keys = [
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
  ];

  for (const k of keys) {
    const v = d[k];
    if (typeof v === 'string' && v.trim()) {
      return v.trim();
    }
  }

  return undefined;
}

const MAX_RESPONSE_BODY_CHARS = 32_000;

/**
 * Pretty-print API response body for terminal / logs (truncates very large payloads).
 */
export function formatResponseBody(data: unknown): string {
  if (data === undefined || data === null) {
    return '(empty)';
  }

  let text: string;
  if (typeof data === 'string') {
    text = data;
  } else if (typeof data === 'object') {
    try {
      text = JSON.stringify(data, null, 2);
    } catch {
      text = String(data);
    }
  } else {
    text = String(data);
  }

  if (text.length > MAX_RESPONSE_BODY_CHARS) {
    return `${text.slice(0, MAX_RESPONSE_BODY_CHARS)}\n... (${text.length - MAX_RESPONSE_BODY_CHARS} more characters truncated)`;
  }

  return text;
}

/**
 * Custom API error class
 */
export class APIError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public responseData?: unknown,
    public readonly requestId?: string
  ) {
    super(message);
    this.name = 'APIError';
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Create APIError from axios error
   */
  static fromAxiosError(error: any): APIError {
    const status = error.response?.status;
    const data = error.response?.data;
    const requestId =
      extractRequestIdFromHeaders(error.response?.headers) ?? extractRequestIdFromBody(data);

    let errorMessage = 'Unknown API error';

    if (data) {
      if (typeof data === 'object' && data !== null) {
        // Extract error message from various possible fields (full body printed separately)
        const msg = (data as any).message;
        const errField = (data as any).error;
        const msgField = (data as any).msg;
        if (typeof msg === 'string' && msg.trim()) {
          errorMessage = msg.trim();
        } else if (typeof errField === 'string' && errField.trim()) {
          errorMessage = errField.trim();
        } else if (typeof msgField === 'string' && msgField.trim()) {
          errorMessage = msgField.trim();
        } else if (typeof errField === 'object' && errField !== null) {
          errorMessage = JSON.stringify(errField);
        } else {
          errorMessage = 'Request failed (see response body below)';
        }
      } else if (typeof data === 'string') {
        errorMessage = data.length > 500 ? `${data.slice(0, 500)}…` : data;
      }
    } else if (error.message) {
      errorMessage = error.message;
    }

    const base = `API Error (${status || 'unknown'}): ${errorMessage}`;
    const message = requestId ? `${base} [X-RequestId: ${requestId}]` : base;

    return new APIError(message, status, data, requestId);
  }
}

/**
 * Output error message in JSON or human-readable format
 */
export function outputError(error: Error | APIError, jsonMode: boolean): void {
  if (jsonMode) {
    const errorObj: any = {
      error: error.message,
      code: error.name,
    };

    if (error instanceof APIError) {
      if (error.requestId) {
        errorObj.requestId = error.requestId;
      }
      if (error.responseData !== undefined) {
        errorObj.body = error.responseData;
        errorObj.bodyText = formatResponseBody(error.responseData);
      }
    }

    console.error(JSON.stringify(errorObj, null, 2));
  } else {
    console.error(chalk.red(`Error: ${error.message}`));

    if (error instanceof APIError && error.responseData !== undefined) {
      console.error(chalk.gray('Response body:'));
      console.error(formatResponseBody(error.responseData));
    }
  }
}

/**
 * Exit codes matching Python version
 */
export const ExitCode = {
  SUCCESS: 0,
  ERROR: 1,
  USAGE_ERROR: 2,
} as const;

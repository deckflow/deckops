import type { AxiosError } from 'axios';

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

export class APIError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public responseData?: unknown,
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

    let errorMessage = error.message || 'Unknown API error';
    if (data) {
      if (typeof data === 'string') {
        errorMessage = data.length > 500 ? `${data.slice(0, 500)}...` : data;
      } else if (typeof data === 'object') {
        const body = data as Record<string, unknown>;
        const candidate = body.message ?? body.error ?? body.msg;
        if (typeof candidate === 'string' && candidate.trim()) {
          errorMessage = candidate.trim();
        } else {
          errorMessage = 'Request failed';
        }
      }
    }

    const base = `API Error (${status || 'unknown'}): ${errorMessage}`;
    return new APIError(requestId ? `${base} [X-RequestId: ${requestId}]` : base, status, data, requestId);
  }
}

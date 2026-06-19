/**
 * Unit tests for error utilities
 */

import { describe, it, expect } from 'vitest';
import { APIError, formatResponseBody, outputError } from '../../src/utils/errors.js';

describe('APIError', () => {
  it('fromAxiosError appends X-RequestId from response headers', () => {
    const err = APIError.fromAxiosError({
      response: {
        status: 404,
        data: { message: 'Resource not found' },
        headers: { 'x-request-id': 'req-abc-123' },
      },
    });

    expect(err.message).toContain('Resource not found');
    expect(err.message).toContain('[X-RequestId: req-abc-123]');
    expect(err.requestId).toBe('req-abc-123');
  });

  it('fromAxiosError works without request id header', () => {
    const err = APIError.fromAxiosError({
      response: {
        status: 500,
        data: { message: 'Internal' },
        headers: {},
      },
    });

    expect(err.message).not.toContain('X-RequestId');
    expect(err.requestId).toBeUndefined();
  });

  it('fromAxiosError reads requestId from JSON error body when header missing', () => {
    const err = APIError.fromAxiosError({
      response: {
        status: 404,
        data: { message: 'Resource not found', requestId: 'body-rid-99' },
        headers: {},
      },
    });

    expect(err.requestId).toBe('body-rid-99');
    expect(err.message).toContain('[X-RequestId: body-rid-99]');
  });

  it('fromAxiosError reads x-request-id via toJSON-style headers', () => {
    const err = APIError.fromAxiosError({
      response: {
        status: 404,
        data: { message: 'nope' },
        headers: {
          toJSON() {
            return { 'X-Request-Id': 'hdr-json-1' };
          },
        },
      },
    });

    expect(err.requestId).toBe('hdr-json-1');
  });
});

describe('outputError', () => {
  it('includes requestId in JSON mode for APIError', () => {
    const logs: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };

    try {
      const e = new APIError('API Error (404): x', 404, { foo: 1 }, 'rid-1');
      outputError(e, true);
      const parsed = JSON.parse(logs[0] ?? '{}') as {
        requestId?: string;
        body?: unknown;
        bodyText?: string;
      };
      expect(parsed.requestId).toBe('rid-1');
      expect(parsed.body).toEqual({ foo: 1 });
      expect(parsed.bodyText).toContain('"foo": 1');
    } finally {
      console.error = orig;
    }
  });

  it('prints Response body in human mode for APIError', () => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(
        args
          .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
          .join(' ')
      );
    };

    try {
      const e = new APIError('API Error (400): bad', 400, { reason: 'x' });
      outputError(e, false);
      expect(lines.some((l) => l.includes('Response body:'))).toBe(true);
      expect(lines.some((l) => l.includes('"reason"'))).toBe(true);
    } finally {
      console.error = orig;
    }
  });
});

describe('formatResponseBody', () => {
  it('formats objects as indented JSON', () => {
    expect(formatResponseBody({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it('returns placeholder for null', () => {
    expect(formatResponseBody(null)).toBe('(empty)');
  });
});

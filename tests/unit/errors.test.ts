import { APIError, TaskFailedError, TaskTimeoutError, UploadUnconfirmedError } from '../../src/cloud/errors.js';
import { describe, expect, it } from 'vitest';
import { translateError as translate } from '../../src/shared/errors.js';
import { EXIT_CODES } from '../../src/errors/index.js';

describe('error translation', () => {
  it('maps backend body codes to precise ir_* codes with actionable hints', () => {
    const cases = [
      ['irExpired', 'ir_expired', 5],
      ['irNotFound', 'ir_not_found', 5],
      ['irSchemaUnsupported', 'ir_schema_unsupported', 5],
      ['irInvalid', 'ir_invalid', 5],
      ['guestTaskOverLimit', 'quota_error', 8],
    ] as const;
    for (const [bodyCode, code, exit] of cases) {
      const translated = translate(new APIError('boom', 422, { code: bodyCode } as never));
      expect(translated.code).toBe(code);
      expect(translated.exitCode).toBe(exit);
    }
  });

  it('points a request that got no response at the network', () => {
    const translated = translate(new APIError('Cannot reach the DeckFlow API (GET https://example.test/v1/user): timeout of 30000ms exceeded'));
    expect(translated.code).toBe('backend_error');
    expect(translated.hint).toContain('network or proxy');
    expect(translate(new APIError('x', 500)).hint).toBeUndefined();
  });

  it('falls back to HTTP status when the body carries no code', () => {
    expect(translate(new APIError('x', 401)).code).toBe('auth_error');
    expect(translate(new APIError('x', 410)).code).toBe('ir_expired');
    expect(translate(new APIError('x', 429)).code).toBe('quota_error');
    expect(translate(new APIError('x', 500)).code).toBe('backend_error');
  });

  it('keeps the server body for quota and upload-verification failures', () => {
    const quota = { code: 'insufficientPackage', message: 'Insufficient package balance', data: ['Insufficient package balance', { need: 3 }] };
    expect(translate(new APIError('x', 402, quota as never))).toMatchObject({ code: 'quota_error', details: quota });
    expect(translate(new APIError('x', 402))).toMatchObject({ code: 'quota_error' });
    const invalid = { code: 'fileUploadInvalid', message: 'md5 differs' };
    expect(translate(new APIError('x', 422, invalid as never))).toMatchObject({ code: 'input_error', details: invalid });
    expect(translate(new APIError('x', 500, { code: 'unknown' } as never)).details).toBeUndefined();
  });

  it('reports task failures and timeouts as backend errors with the task and the reason', () => {
    expect(translate(new TaskFailedError('t1', 'parser crashed'))).toMatchObject({
      code: 'backend_error', taskId: 't1', message: 'Task failed: parser crashed', details: { reason: 'failed' },
    });
    expect(translate(new TaskTimeoutError('t2', 30))).toMatchObject({
      code: 'backend_error', taskId: 't2', details: { reason: 'timeout', timeoutSeconds: 30 }, hint: expect.stringContaining('--timeout'),
    });
  });

  it('reports a rejected upload verification as input_error with the file id', () => {
    const cause = new APIError('API Error (422): md5 differs', 422, { code: 'fileUploadInvalid', message: 'md5 differs' } as never);
    expect(translate(new UploadUnconfirmedError('file-9', 'deck.pptx', { cause }))).toMatchObject({
      code: 'input_error', message: 'DeckOps Cloud could not verify the upload of deck.pptx.',
      details: { fileId: 'file-9', code: 'fileUploadInvalid', message: 'md5 differs' },
    });
  });

  it('exit codes cover every error code exactly once', () => {
    expect(Object.values(EXIT_CODES).every((code) => code >= 2 && code <= 8)).toBe(true);
  });
});

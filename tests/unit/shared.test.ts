import { describe, expect, it } from 'vitest';
import { TaskTimeoutError } from '../../src/cloud/errors.js';
import { DeckOpsError } from '../../src/errors/index.js';
import { translateError } from '../../src/shared/errors.js';

const apiError = (statusCode: number | undefined, code?: string): Error => Object.assign(new Error('backend failure'), {
  name: 'APIError',
  statusCode,
  ...(code === undefined ? {} : { responseData: { code } }),
});

describe('shared error translation', () => {
  it('preserves body-code mapping when the SDK error has no HTTP status', () => {
    const cases = [
      ['irExpired', 'ir_expired'],
      ['irNotFound', 'ir_not_found'],
      ['irSchemaUnsupported', 'ir_schema_unsupported'],
      ['irInvalid', 'ir_invalid'],
      ['guestTaskOverLimit', 'quota_error'],
    ] as const;
    for (const [bodyCode, code] of cases) {
      const original = apiError(undefined, bodyCode);
      expect(translateError(original)).toMatchObject({ code, cause: original });
      expect(translateError(original, 'browser')).toMatchObject({ code, cause: original });
    }
    expect(translateError(apiError(undefined)).code).toBe('backend_error');
  });

  it('recognizes SDK API errors structurally and keeps task metadata', () => {
    const original = apiError(422, 'irExpired');
    const translated = translateError(original, 'browser', 'task-123');
    expect(translated).toMatchObject({ code: 'ir_expired', message: 'backend failure', taskId: 'task-123', cause: original });
    expect(translateError(apiError(401), 'browser').code).toBe('auth_error');
    expect(translateError(apiError(410), 'browser').code).toBe('ir_expired');
    expect(translateError(apiError(429), 'browser').code).toBe('quota_error');
    expect(translateError(apiError(500), 'browser').code).toBe('backend_error');
  });

  it('preserves the Node hints and gives browser callers actionable non-CLI hints', () => {
    expect(translateError(apiError(401)).hint)
      .toBe('Run `deckops auth login`, or check `deckops config list` for a stale credential.');
    expect(translateError(apiError(404)).hint).toContain('`deckops config list`');
    expect(translateError(new TaskTimeoutError('t1', 60)).hint)
      .toBe('The task keeps running in the cloud. Raise --timeout, or check it later with its taskId.');
    for (const error of [apiError(401), apiError(404), apiError(410), apiError(429), apiError(422, 'irNotFound'), new TaskTimeoutError('t1', 60)]) {
      const translated = translateError(error, 'browser');
      expect(translated.hint).toBeTruthy();
      expect(translated.hint).not.toMatch(/deckops|--timeout/);
    }
  });

  it('preserves DeckOpsError identity and handles ordinary errors and unknown values', () => {
    const known = DeckOpsError.input('Missing input', { taskId: 'existing-task' });
    expect(translateError(known, 'browser', 'other-task')).toBe(known);
    expect(translateError(new Error('oops'), 'browser', 'task-id')).toMatchObject({ code: 'backend_error', taskId: 'task-id' });
    expect(translateError('oops', 'browser', 'task-id')).toMatchObject({ code: 'backend_error', message: 'oops', taskId: 'task-id' });
  });
});

import { DeckOpsError, type ErrorCode } from '../errors/index.js';

/** Backend body codes → our codes. The precise `ir_*` codes pass through verbatim. */
const BODY_CODE_MAP: Record<string, ErrorCode> = {
  irNotFound: 'ir_not_found',
  irExpired: 'ir_expired',
  irSchemaUnsupported: 'ir_schema_unsupported',
  irInvalid: 'ir_invalid',
  guestTaskOverLimit: 'quota_error',
};

const NODE_HINTS: Partial<Record<ErrorCode, string>> = {
  ir_expired: 'The IR is past its 7-day retention. Re-run `deckops parse <source> --force` and retry.',
  ir_not_found: 'The reference is wrong or belongs to another space. Re-run `deckops parse <source>`.',
  ir_schema_unsupported: 'The IR was produced by an incompatible parser version. Re-parse the source.',
  quota_error: 'Guest quota exhausted for today. Run `deckops auth login` for higher limits.',
  auth_error: 'Run `deckops auth login`, or check `deckops config list` for a stale credential.',
};

const BROWSER_HINTS: Partial<Record<ErrorCode, string>> = {
  ir_expired: 'The IR is past its cloud retention. Parse the source again and retry.',
  ir_not_found: 'The reference is wrong or belongs to another space. Check the spaceId or parse the source again.',
  ir_schema_unsupported: 'The IR was produced by an incompatible parser version. Parse the source again.',
  quota_error: 'The current quota is exhausted. Sign in with an account that has available quota and retry.',
  auth_error: 'The access token is missing or expired. Refresh the user access token and retry.',
};

const NODE_NOT_FOUND_HINT =
  'A 404 on task creation often means a spaceId inherited from another environment — `deckops config list` shows every value and where it came from.';

const BROWSER_NOT_FOUND_HINT =
  'Check that apiBase and spaceId belong to the same environment and that the current user can access the space.';

interface ApiErrorLike extends Error {
  statusCode?: number | undefined;
  responseData?: unknown;
}

/** Avoid a runtime dependency on either SDK entry or its particular Error class. */
function isApiError(error: unknown): error is ApiErrorLike {
  if (!(error instanceof Error) || error.name !== 'APIError') {
    return false;
  }
  const statusCode = (error as Partial<ApiErrorLike>).statusCode;
  // SDK APIError also represents failures with a body code but no HTTP status.
  return statusCode === undefined || typeof statusCode === 'number';
}

export function translateError(
  error: unknown,
  context: 'node' | 'browser' = 'node',
  taskId?: string
): DeckOpsError {
  if (error instanceof DeckOpsError) {
    return error;
  }

  const task = taskId === undefined ? {} : { taskId };
  if (isApiError(error)) {
    const body = error.responseData as { code?: string; message?: string } | undefined;
    const bodyCode = typeof body === 'object' && body !== null ? body.code : undefined;
    const mapped = bodyCode ? BODY_CODE_MAP[bodyCode] : undefined;
    const code: ErrorCode =
      mapped ??
      (error.statusCode === 401
        ? 'auth_error'
        : error.statusCode === 410
          ? 'ir_expired'
          : error.statusCode === 429
            ? 'quota_error'
            : 'backend_error');
    const hints = context === 'node' ? NODE_HINTS : BROWSER_HINTS;
    const notFoundHint = context === 'node' ? NODE_NOT_FOUND_HINT : BROWSER_NOT_FOUND_HINT;
    const hint = hints[code] ?? (code === 'backend_error' && error.statusCode === 404 ? notFoundHint : undefined);
    return new DeckOpsError(code, error.message, { ...(hint ? { hint } : {}), ...task, cause: error });
  }

  if (error instanceof Error) {
    // The SDK refuses parse results without an irKey: backend older than the split.
    if (/returned no irKey/.test(error.message)) {
      return DeckOpsError.backend(error.message, {
        hint: 'The backend needs @deckflow/platform-slave >= 0.22.0.',
        ...task,
        cause: error,
      });
    }
    if (/did not complete within/.test(error.message)) {
      return DeckOpsError.backend(error.message, {
        hint: context === 'node'
          ? 'Raise --timeout, or check the task later with its taskId.'
          : 'Increase the timeout, or check the task later with its taskId.',
        ...task,
        cause: error,
      });
    }
    return DeckOpsError.backend(error.message, { ...task, cause: error });
  }

  return DeckOpsError.backend(String(error), task);
}

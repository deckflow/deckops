import { DeckOpsError, type ErrorCode } from '../errors/index.js';

/** Backend body codes → our codes. The precise `ir_*` codes pass through verbatim. */
const BODY_CODE_MAP: Record<string, ErrorCode> = {
  irNotFound: 'ir_not_found',
  irExpired: 'ir_expired',
  irSchemaUnsupported: 'ir_schema_unsupported',
  irInvalid: 'ir_invalid',
  guestTaskOverLimit: 'quota_error',
  insufficientPackage: 'quota_error',
  documentSourceInvalid: 'input_error',
  fileUploadInvalid: 'input_error',
};

/** Body codes whose body the caller acts on: a top-up dialog, or the file that failed verification. */
const KEEP_BODY: ReadonlySet<string> = new Set(['insufficientPackage', 'guestTaskOverLimit', 'documentSourceInvalid', 'fileUploadInvalid']);

const NODE_HINTS: Partial<Record<ErrorCode, string>> = {
  ir_expired: 'The cloud no longer holds that parse. Run the command again.',
  ir_not_found: 'The cloud does not know that parse in this space. Run the command again.',
  ir_schema_unsupported: 'The cloud parse came from an incompatible parser version. Run the command again.',
  quota_error: 'The account or guest quota is exhausted. Top up the package, or run `deckops auth login` for higher limits.',
  auth_error: 'Run `deckops auth login`, or check `deckops config list` for a stale credential.',
};

const BROWSER_HINTS: Partial<Record<ErrorCode, string>> = {
  ir_expired: 'The cloud no longer holds that parse. Retry the operation.',
  ir_not_found: 'The cloud does not know that parse in this space. Check the spaceId and retry.',
  ir_schema_unsupported: 'The cloud parse came from an incompatible parser version. Retry the operation.',
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

interface TaskErrorLike extends Error {
  taskId?: string | undefined;
  timeoutSeconds?: number | undefined;
}

/** Task failures and timeouts from the transport, recognised by name like the API error. */
function isTaskError(error: unknown, name: 'TaskFailedError' | 'TaskTimeoutError'): error is TaskErrorLike {
  return error instanceof Error && error.name === name;
}

function bodyOf(error: unknown): Record<string, unknown> | undefined {
  const body = (error as { responseData?: unknown } | undefined)?.responseData;
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? { ...(body as Record<string, unknown>) } : undefined;
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
          : error.statusCode === 429 || error.statusCode === 402
            ? 'quota_error'
            : 'backend_error');
    // A top-up dialog reads the package details from the server's own body.
    const details = code === 'quota_error' || (bodyCode !== undefined && KEEP_BODY.has(bodyCode)) ? bodyOf(error) : undefined;
    const hints = context === 'node' ? NODE_HINTS : BROWSER_HINTS;
    const notFoundHint = context === 'node' ? NODE_NOT_FOUND_HINT : BROWSER_NOT_FOUND_HINT;
    // 没有状态码也没有响应体：请求根本没到服务端（连不上、超时），多半是网络或代理。
    const unreachable = error.statusCode === undefined && error.responseData === undefined;
    const unreachableHint = context === 'node'
      ? 'The request got no response. Check the network or proxy for that host; `deckops config list` shows the API root in use.'
      : 'The request got no response. Check the network connection and retry.';
    const hint = hints[code] ?? (code === 'backend_error' && error.statusCode === 404 ? notFoundHint : unreachable ? unreachableHint : undefined);
    return new DeckOpsError(code, error.message, { ...(hint ? { hint } : {}), ...task, ...(details ? { details } : {}), cause: error });
  }

  if (isTaskError(error, 'TaskTimeoutError') || isTaskError(error, 'TaskFailedError')) {
    const timeout = error.name === 'TaskTimeoutError';
    const id = error.taskId ?? taskId;
    return DeckOpsError.backend(error.message, {
      ...(timeout ? { hint: context === 'node'
        ? 'The task keeps running in the cloud. Raise --timeout, or check it later with its taskId.'
        : 'The task keeps running in the cloud. Increase the timeout, or check it later with its taskId.' } : {}),
      ...(id === undefined ? {} : { taskId: id }),
      details: timeout ? { reason: 'timeout', ...(error.timeoutSeconds !== undefined ? { timeoutSeconds: error.timeoutSeconds } : {}) } : { reason: 'failed' },
      cause: error,
    });
  }

  if (error instanceof Error && error.name === 'UploadUnconfirmedError') {
    // The server compared the stored object with the declared size and md5, and they differ.
    const { fileId } = error as Error & { fileId?: string };
    const body = bodyOf((error as { cause?: unknown }).cause);
    return DeckOpsError.input(error.message, {
      hint: 'Upload it again. If this repeats, the file may be changing while it uploads.',
      details: { ...(fileId ? { fileId } : {}), ...(body ?? {}) },
      cause: error,
    });
  }

  if (error instanceof Error && error.name === 'DownloadError') {
    return DeckOpsError.backend(error.message, { hint: 'The result URL could not be fetched. Retry the command.', ...task, cause: error });
  }

  if (error instanceof Error) {
    return DeckOpsError.backend(error.message, { ...task, cause: error });
  }

  return DeckOpsError.backend(String(error), task);
}

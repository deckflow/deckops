import { EXIT_CODES, type ErrorCode } from './codes.js';

export interface DeckOpsErrorOptions {
  hint?: string;
  cause?: unknown;
  /** Cloud task id, when the failure came out of a task. */
  taskId?: string;
  /** Machine-readable context, e.g. the server's error body or `{ reason: 'timeout' }`. */
  details?: Record<string, unknown>;
}

export class DeckOpsError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly taskId: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, options: DeckOpsErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DeckOpsError';
    this.code = code;
    this.hint = options.hint;
    this.taskId = options.taskId;
    this.details = options.details;
  }

  get exitCode(): number {
    return EXIT_CODES[this.code];
  }

  static usage(message: string, options?: DeckOpsErrorOptions): DeckOpsError {
    return new DeckOpsError('usage_error', message, options);
  }

  static unsupported(message: string, options?: DeckOpsErrorOptions): DeckOpsError {
    return new DeckOpsError('unsupported', message, options);
  }

  static auth(message: string, options?: DeckOpsErrorOptions): DeckOpsError {
    return new DeckOpsError('auth_error', message, options);
  }

  static input(message: string, options?: DeckOpsErrorOptions): DeckOpsError {
    return new DeckOpsError('input_error', message, options);
  }

  static asset(message: string, options?: DeckOpsErrorOptions): DeckOpsError {
    return new DeckOpsError('asset_error', message, options);
  }

  static backend(message: string, options?: DeckOpsErrorOptions): DeckOpsError {
    return new DeckOpsError('backend_error', message, options);
  }

  static notImplemented(message: string, options?: DeckOpsErrorOptions): DeckOpsError {
    return new DeckOpsError('not_implemented', message, options);
  }

  static quota(message: string, options?: DeckOpsErrorOptions): DeckOpsError {
    return new DeckOpsError('quota_error', message, options);
  }
}

/** Narrows to a DeckOpsError, optionally with a given code. Works across bundled copies of the SDK. */
export function isDeckOpsError(error: unknown, code?: ErrorCode): error is DeckOpsError {
  if (!(error instanceof Error) || error.name !== 'DeckOpsError') return false;
  return code === undefined || (error as { code?: unknown }).code === code;
}

import type { ConvertFlags, ParseFlags, ParseTaskType } from '../types.js';
import type { ConvertImage } from '../cloud/parse/types.js';

/**
 * Inputs are values. A bare path string or `{ file: path }` is accepted only when the
 * runtime can read files (Node); browsers reject it before any request.
 */
export type ClientInput =
  | File
  | { file: Blob | Uint8Array | ArrayBuffer; name: string }
  | { file: string; name?: string }
  | { url: string }
  | string;

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface TaskInfo {
  id: string;
  spaceId: string;
  type: string;
  status: TaskStatus;
  error?: string | null;
}

export type ProgressEvent =
  | { phase: 'upload'; progress: number }
  | { phase: 'parse' | 'convert'; taskId: string; spaceId: string; status: TaskStatus };

export interface ClientOptions {
  /** Cloud API root or an authenticated same-origin proxy, e.g. /api/deckops. */
  apiBase?: string;
  /** User-scoped credential sent as X-Auth-Token. */
  token?: string;
  /** Server API key. Never ship it to a browser; the browser entry rejects it. */
  apiKey?: string;
  spaceId?: string;
  /** Refresh the same user's token once after a 401; changing accounts/spaces requires a new client. */
  onUnauthorized?: () => Promise<string>;
}

export interface OperationOptions {
  spaceId?: string;
  /** Task wait timeout in seconds (not milliseconds). Defaults to 300. */
  timeout?: number;
  /** Cancels local upload/request/waiting, not an already-created cloud task. */
  signal?: AbortSignal;
  /** Task events contain the id immediately after submission, for later recovery. */
  onProgress?: (event: ProgressEvent) => void;
  /** Prefer SSE, falling back to polling. Set false for polling only. */
  useEventStream?: boolean;
  /** Polling interval in milliseconds. Defaults to 2000. */
  pollInterval?: number;
}

export interface ParseOptions extends ParseFlags, OperationOptions {
  /**
   * Invoked right before the task-creation request is sent. A failure before it created no
   * task; a failure after it without a response leaves the task's existence unknown.
   */
  onSubmit?: () => void;
}

export interface ConvertOptions extends Pick<ConvertFlags, 'to' | 'anchors' | 'splitPages' | 'strict'>, OperationOptions {}

export type ConvertRef = { irKey: string; taskId?: never } | { taskId: string; irKey?: never };

export interface ConvertResult {
  taskId: string;
  format: 'pdf' | 'pptx' | 'docx' | 'keynote' | 'html';
  schemaVersion: string;
  to: 'markdown';
  markdown: string;
  markdownPages?: string[];
  /** Signed, expiring image URLs. Durable copies are the caller's concern. */
  images: ConvertImage[];
  /** Conversion references stored IR; it never resubmits the source. */
  reusedParse: true;
}

export interface ParseResult<R = unknown> {
  taskId: string;
  spaceId: string;
  type: ParseTaskType | 'html.getByURL';
  irKey: string;
  irSchemaVersion: string;
  /** The server response, verbatim. */
  ir: R;
}

export type { ConvertImage };

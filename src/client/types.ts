import type {
  ConvertOptions, ConvertResult, ExtractAssetsResult, ExtractJsonResult, ExtractOptions, ExtractResult, ProgressEvent, RenderOptions,
  RenderResult, TaskStatus,
} from '../ops/types.js';

export type {
  ConvertOptions, ConvertResult, DocumentFormat, ExtractAssetsResult, ExtractJsonResult, ExtractOptions, ExtractResult, ImageFormat,
  OpsResult, ParseOptions, ProgressEvent, Quality, RemoteFile, RenderOptions, RenderResult, TaskRef, TaskStatus,
} from '../ops/types.js';

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
  /**
   * Device id sent as X-Auth-UUID (a UUID v4). Without it the browser reuses localStorage `df_uuid`
   * and Node the id saved under ~/.deckflow.
   */
  authUuid?: string;
}

export interface OperationOptions {
  spaceId?: string;
  /** Seconds for the whole call — upload, every task and the result download. Defaults to 300. */
  timeout?: number;
  /** Cancels the call (it rejects with `signal.reason`); tasks already created keep running in the cloud. */
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
  /** Prefer SSE, falling back to polling. Set false for polling only. */
  useEventStream?: boolean;
  /** Polling interval in milliseconds. Defaults to 2000. */
  pollInterval?: number;
}

export type RenderCallOptions = RenderOptions & OperationOptions;

export type ConvertCallOptions = ConvertOptions & OperationOptions & {
  /** Markdown image links: signed URLs (`url`, default) or the relative `images[].path` (`path`). */
  imageRefs?: 'url' | 'path';
};

export type ExtractCallOptions = ExtractOptions & OperationOptions;

export interface TaskInfo {
  id: string;
  spaceId: string;
  type: string;
  status: TaskStatus;
  error?: string | null;
  /** Credits the server bills for the task. */
  credits?: number;
  /** Milliseconds the task ran; null until it ends. */
  consumedMS?: number | null;
  createdAt?: string;
  /** Null until the task ends. */
  completedAt?: string | null;
}

export interface UploadedFile {
  id: string;
  name: string;
  bytes: number;
}

export interface TaskCallOptions {
  spaceId?: string;
  signal?: AbortSignal;
}

export interface OpsClient<Input = ClientInput> {
  render(input: Input, options: RenderCallOptions): Promise<RenderResult>;
  convert(input: Input, options?: ConvertCallOptions): Promise<ConvertResult>;
  extract(input: Input, options: ExtractCallOptions & { to: 'json' }): Promise<ExtractJsonResult>;
  extract(input: Input, options: ExtractCallOptions & { to: 'assets' }): Promise<ExtractAssetsResult>;
  extract(input: Input, options: ExtractCallOptions): Promise<ExtractResult>;
  /** Low level: inspect, wait for or download a task by id without submitting it again. */
  tasks: {
    get(taskId: string, options?: TaskCallOptions): Promise<TaskInfo>;
    wait(taskId: string, options?: TaskCallOptions & Pick<OperationOptions, 'timeout' | 'useEventStream' | 'pollInterval'>): Promise<TaskInfo>;
    /** The task's delivered result, as the server sends it. */
    download(taskId: string, options?: TaskCallOptions): Promise<unknown>;
  };
  /** Low level: upload once and reuse the id; the operations reuse it for the same file too. */
  files: {
    upload(input: Input, options?: Pick<OperationOptions, 'spaceId' | 'signal' | 'onProgress'>): Promise<UploadedFile>;
  };
}

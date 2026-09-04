import type { ConvertFlags, ParseFlags, ParseTaskType } from '../types.js';
import type { DeckProbeReport, PreflightMode, PreflightSummary } from '../shared/preflight.js';
import type { BrowserDocumentInspector } from './inspector.js';

/** Browser inputs are values, never local filesystem paths. */
export type BrowserInput =
  | File
  | { file: Blob | Uint8Array | ArrayBuffer; name: string }
  | { url: string };

export type BrowserTaskStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface BrowserTask {
  id: string;
  spaceId: string;
  type: string;
  status: BrowserTaskStatus;
  error?: string | null;
}

export type BrowserProgress =
  | { phase: 'preflight'; status: 'running' | 'completed' }
  | { phase: 'upload'; progress: number }
  | { phase: 'parse' | 'convert'; taskId: string; status: BrowserTaskStatus };

export interface BrowserClientOptions {
  /** Cloud API root or an authenticated same-origin proxy, e.g. /api/deckparse. */
  apiBase?: string;
  /** User-scoped browser credential. Never put a server API key in browser code. */
  token?: string;
  spaceId?: string;
  /** Refresh the same user's token once after a 401; changing accounts/spaces requires a new client. */
  onUnauthorized?: () => Promise<string>;
  /** Optional custom local inspector; DeckParse uses its DeckProbe Worker adapter by default. */
  inspector?: BrowserDocumentInspector;
}

export interface BrowserOperationOptions {
  spaceId?: string;
  /** Task wait timeout in seconds (not milliseconds). Defaults to 300. */
  timeout?: number;
  /** Cancels local upload/request/waiting, not an already-created cloud task. */
  signal?: AbortSignal;
  /** Task events contain the id immediately after submission, for later recovery. */
  onProgress?: (event: BrowserProgress) => void;
  /** Prefer SSE, falling back to polling. Set false for polling only. */
  useEventStream?: boolean;
  /** Polling interval in milliseconds. Defaults to 2000. */
  pollInterval?: number;
}

export interface BrowserParseOptions extends ParseFlags, BrowserOperationOptions {
  /** Defaults to validate for local files. URLs are skipped; use off to avoid Worker/WASM startup. */
  preflight?: PreflightMode;
}

export interface BrowserConvertOptions
  extends Pick<ConvertFlags, 'to' | 'anchors' | 'splitPages' | 'strict'>,
    BrowserOperationOptions {}

export type BrowserConvertRef = { irKey: string; taskId?: never } | { taskId: string; irKey?: never };

export interface BrowserImage {
  /** Signed, expiring URL used in the Markdown. Suitable for temporary preview only. */
  ref: string;
  /** Stable identity, not a promise of indefinite cloud retention. */
  key: string;
  suggestedPath: string;
  bytes?: number;
  hash?: string;
}

export interface BrowserConvertResult {
  taskId: string;
  format: 'pdf' | 'pptx' | 'docx' | 'keynote' | 'html';
  schemaVersion: string;
  to: 'markdown';
  markdown: string;
  markdownPages?: string[];
  images: BrowserImage[];
  /** Conversion references stored IR; it never resubmits the source. */
  reusedParse: true;
}

export interface BrowserParseResult<R = unknown> {
  taskId: string;
  type: ParseTaskType | 'html.getByURL';
  irKey: string;
  irSchemaVersion: string;
  ir: R;
}

export type { DeckProbeReport, PreflightMode, PreflightSummary };

import type { OpsTaskType } from '../cloud/contracts.js';

/** The three cloud verbs. `probe` runs locally and never goes through the route table. */
export type Verb = 'render' | 'extract' | 'convert';

/** Input families. A URL is a locator, not a format: it renders and parses as a web page. */
export type InputFamily = 'pdf' | 'pptx' | 'ppt' | 'docx' | 'key' | 'html' | 'md' | 'url';

export type Target = 'image' | 'video' | 'markdown' | 'json' | 'assets';

export type ImageFormat = 'png' | 'jpg' | 'webp';
export type Quality = 'low' | 'medium' | 'high';

/** Options for the server's own parse of a document. Each applies to some formats only. */
export interface ParseOptions {
  /** pdf: precision / cost tier. */
  profile?: 'fast' | 'balanced' | 'quality';
  /** pdf: the open password. A password parse is never reused. */
  password?: string;
  /** pdf: extract embedded images. */
  includeImages?: boolean;
  /** keynote: the minimum image area kept, 0–1. */
  stayImageAreaRate?: number;
}

export interface RenderOptions {
  to: 'image' | 'video';
  /** 1-based pages to keep. The cloud renders every page; the selection applies to the result. */
  pages?: number[];
  quality?: Quality;
  imageFormat?: ImageFormat;
  /** Long edge in pixels. */
  width?: number;
  scale?: number;
}

export interface ConvertOptions extends ParseOptions {
  to?: 'markdown';
  /** pdf: provenance comments per element. */
  anchors?: boolean;
  /** pptx / keynote: also return one Markdown string per slide. */
  splitPages?: boolean;
  /** Fail instead of returning a warning when the Markdown cannot be rendered. */
  strict?: boolean;
}

export interface ExtractOptions extends ParseOptions {
  to: 'json' | 'assets';
}

/** Every verb option, as the parameter mapping sees it. */
export type OpsOptions = Omit<RenderOptions, 'to'> & Omit<ConvertOptions, 'to'> & { to: Target };

export type OptionName = Exclude<keyof OpsOptions, 'to'>;

/** What a step returns: a list of file tuples, or one of the document results. */
export type StepResult = 'files' | 'markdown' | 'json' | 'assets';

/** The input of the first step: an uploaded file or a URL. Later steps get the previous step's files. */
export interface StepInput {
  url?: string;
}

export interface Step {
  type: OpsTaskType;
  /** User options → task params. Mapping functions live in `params.ts`, never in the table. */
  params: (options: OpsOptions, input: StepInput, warnings: string[]) => Record<string, unknown>;
  result: StepResult;
  /** Run once per file of the previous step (per rendered frame). */
  each?: true;
}

/** The task (and target) the server must list in `/tools/capabilities` before the route is used. */
export interface Requirement {
  task: OpsTaskType;
  to?: string;
}

export interface Route {
  verb: Verb;
  from: readonly InputFamily[];
  to: Target;
  steps: readonly Step[];
  /** User options this route honours; anything else is a usage error. */
  options: readonly OptionName[];
  /** Image encodings the route can produce; webp always adds a conversion per frame. */
  imageFormats?: readonly ImageFormat[];
  requires?: Requirement;
  /** A known fidelity trade-off, reported as a warning. */
  caveat?: string;
}

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

/** A cloud task one call created. A chain creates one per step (and per frame for webp). */
export interface TaskRef {
  type: string;
  id: string;
}

/**
 * Each call reports only its own events: `upload` (0–1; 1 at once when a file is reused), `task`
 * (once on creation, then on every status change; `completed` precedes `download`) and `download`.
 */
export type ProgressEvent =
  | { phase: 'upload'; progress: number }
  | { phase: 'task'; type: string; id: string; spaceId: string; status: TaskStatus }
  | { phase: 'download'; progress: number };

/** A result file in cloud storage. `url` is signed; nothing here is a storage reference. */
export interface RemoteFile {
  url: string;
  /** Suggested relative path, e.g. `001.png` or `assets/p1_i0000.png`. */
  path: string;
  bytes: number;
  hash: string;
  mediaType?: string;
  /** 1-based page or frame of a render. */
  page?: number;
  width?: number;
  height?: number;
  /** Fetch the file. The signed URL needs no credentials. */
  blob(options?: { signal?: AbortSignal }): Promise<Blob>;
}

export interface OpsResult {
  tasks: TaskRef[];
  outputs: RemoteFile[];
  warnings: string[];
}

/** The source format the server parsed. */
export type DocumentFormat = 'pdf' | 'pptx' | 'docx' | 'keynote' | 'html';

interface DocumentResult extends OpsResult {
  format: DocumentFormat;
  pages: number | null;
  /** The server reused a parse of the same file from the last seven days: no new parse, no charge. */
  reusedParse: boolean;
  /** Until when the result URLs and assets stay available. */
  assetsExpireAt?: string;
}

export interface RenderResult extends OpsResult {
  to: 'image' | 'video';
  /** Frames the cloud rendered, before any page selection. */
  pages: number;
}

export interface ConvertResult extends DocumentResult {
  to: 'markdown';
  /** The Markdown. Image links are signed URLs, or the relative `images[].path` with `imageRefs: 'path'`. */
  content: string;
  /** One Markdown string per slide, with `splitPages` on pptx / keynote. */
  contentPages?: string[];
  images: RemoteFile[];
}

export interface ExtractJsonResult extends DocumentResult {
  to: 'json';
  /** The server's structured document, parsed. Asset references are relative paths. */
  content: unknown;
  schemaVersion: string;
  assets: RemoteFile[];
}

export interface ExtractAssetsResult extends DocumentResult {
  to: 'assets';
  assets: RemoteFile[];
}

export type ExtractResult = ExtractJsonResult | ExtractAssetsResult;

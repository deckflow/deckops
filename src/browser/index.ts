import { browserRuntime } from '../cloud/browser.js';
import { createClientWith } from '../client/index.js';
import type { ClientOptions, OpsClient } from '../client/types.js';

export { DeckOpsError, ERROR_CODES, isDeckOpsError, type ErrorCode } from '../errors/index.js';
export type {
  ConvertCallOptions, ConvertResult, DocumentFormat, ExtractAssetsResult, ExtractCallOptions, ExtractJsonResult, ExtractResult,
  ImageFormat, OperationOptions, OpsResult, ParseOptions, ProgressEvent, Quality, RemoteFile, RenderCallOptions, RenderResult,
  TaskCallOptions, TaskInfo, TaskRef, TaskStatus, UploadedFile,
} from '../client/types.js';

/** Browser inputs are values, never local filesystem paths. */
export type BrowserInput = File | { file: Blob | Uint8Array | ArrayBuffer; name: string } | { url: string };
/** Never put a server API key in browser code; the browser client has no `apiKey` option. */
export type BrowserClientOptions = Omit<ClientOptions, 'apiKey'>;
export type BrowserClient = OpsClient<BrowserInput>;

/** Explicit browser entry; importing this module is also safe during SSR. */
export function createClient(options: BrowserClientOptions = {}): BrowserClient {
  const { run: _internal, ...client } = createClientWith<BrowserInput>(options, browserRuntime, 'browser');
  return client;
}

import { browserRuntime } from '../cloud/browser.js';
import { createClientWith, CloudParsedDocument, type DeckClient } from '../client/index.js';
import type { ClientOptions } from '../client/types.js';

export { DeckOpsError, ERROR_CODES, type ErrorCode } from '../errors/index.js';
export { CloudParsedDocument as BrowserParsedDocument };
export type {
  ConvertImage as BrowserImage, ConvertOptions as BrowserConvertOptions,
  ConvertRef as BrowserConvertRef, ConvertResult as BrowserConvertResult, OperationOptions as BrowserOperationOptions,
  ParseOptions as BrowserParseOptions, ParseResult as BrowserParseResult, ProgressEvent as BrowserProgress,
  TaskInfo as BrowserTask, TaskStatus as BrowserTaskStatus,
} from '../client/types.js';

/** Browser inputs are values, never local filesystem paths. */
export type BrowserInput = File | { file: Blob | Uint8Array | ArrayBuffer; name: string } | { url: string };
/** Never put a server API key in browser code; the browser client has no `apiKey` option. */
export type BrowserClientOptions = Omit<ClientOptions, 'apiKey'>;
export type BrowserClient = DeckClient<BrowserInput>;

/** Explicit browser entry; importing this module is also safe during SSR. */
export function createClient(options: BrowserClientOptions = {}): BrowserClient {
  return createClientWith<BrowserInput>(options, browserRuntime, 'browser');
}

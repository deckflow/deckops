/** Node entry: the ops client with Node inputs and shared credentials, plus local probe. */

export { createClient, probe, type ClientOptions, type DeckOpsClient, type NodeInput, type ProbeCallOptions } from './node/sdk.js';
export type { ProbeOptions, ProbeReport } from './ops/probe.js';
export type {
  ConvertCallOptions, ExtractCallOptions, OperationOptions, RenderCallOptions, TaskCallOptions, TaskInfo, UploadedFile,
} from './client/types.js';
export type {
  ConvertOptions, ConvertResult, DocumentFormat, ExtractAssetsResult, ExtractJsonResult, ExtractOptions, ExtractResult, ImageFormat,
  OpsResult, ParseOptions, ProgressEvent, Quality, RemoteFile, RenderOptions, RenderResult, TaskRef, TaskStatus,
} from './ops/types.js';
export { DeckOpsError, ERROR_CODES, EXIT_CODES, isDeckOpsError, type ErrorCode } from './errors/index.js';
export { resolveCredentials, writeSharedCredentials, type ResolvedCredentials } from './config/index.js';
export type { CommonFlags, Envelope, ErrorEnvelope, OpsEnvelope, OutputFile } from './types.js';

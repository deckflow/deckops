/** Node entry: the SDK with filesystem artifacts and shared credentials. */

export {
  createClient, parse, convert, read, openArtifact, ParsedDocument,
  type ArtifactConvertOptions, type ClientOptions, type ConvertInputOptions, type DeckOpsClient, type ParseInputOptions, type ReadInputOptions,
} from './node/sdk.js';
export type { ReadReport, ReadResult } from './node/read-op.js';
export { DeckOpsError, ERROR_CODES, EXIT_CODES, type ErrorCode } from './errors/index.js';
export { resolveCredentials, writeSharedCredentials, type ResolvedCredentials } from './config/index.js';
export type {
  CommonFlags, ConvertEnvelope, ConvertFlags, ConvertImage, Envelope, ErrorEnvelope, IrFormat, Manifest, ManifestAsset, ManifestV3,
  ManifestView, OutputFile, ParseEnvelope, ParseFlags, ParseTaskType, ParseType,
} from './types.js';

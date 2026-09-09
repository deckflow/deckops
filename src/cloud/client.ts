import { statSync } from 'node:fs';
import path from 'node:path';
import { createNodeTransport } from './node.js';
import type { TransportClient } from './transport.js';
import type {
  ConvertOptions as SdkConvertOptions, ConvertRef, ConvertResult,
  ParseOptions as SdkParseOptions, ParseResult, ParseSource,
} from './parse-facade.js';
import type { ResolvedCredentials } from '../config/index.js';
import { PRE_UPLOAD_THRESHOLD } from '../shared/constants.js';
import { translateError } from '../shared/errors.js';

export { PRE_UPLOAD_THRESHOLD } from '../shared/constants.js';
export { translateError as translate } from '../shared/errors.js';

/**
 * Product boundary: inject resolved credentials and translate cloud errors.
 * Transport, upload, task orchestration and DTOs are owned by this repository.
 */

export interface CloudClient {
  parse<R = unknown>(source: ParseSource, options?: SdkParseOptions): Promise<ParseResult<R>>;
  convert(ref: ConvertRef, options?: SdkConvertOptions): Promise<ConvertResult>;
}

export function createCloudClient(credentials: ResolvedCredentials): CloudClient {
  const deck: TransportClient = createNodeTransport({
    root: credentials.apiBase,
    retryMutations: false,
    ...(credentials.token ? { token: credentials.token } : {}),
    ...(credentials.apiKey ? { apiKey: credentials.apiKey } : {}),
    ...(credentials.spaceId ? { spaceId: credentials.spaceId } : {}),
  });

  return {
    parse: async (source, options) => {
      try {
        return await deck.parse(await preUploadLarge(deck, source, options?.signal), options);
      } catch (error) {
        throw translateError(error);
      }
    },
    convert: async (ref, options) => {
      try {
        return await deck.convert(ref, options);
      } catch (error) {
        throw translateError(error);
      }
    },
  };
}

async function preUploadLarge(deck: TransportClient, source: ParseSource, signal?: AbortSignal): Promise<ParseSource> {
  signal?.throwIfAborted();
  const large = largeUpload(source);
  if (!large) {
    return source;
  }
  const uploaded = await deck.files.upload(large.input, { name: large.name, ...(signal ? { signal } : {}) });
  return { fileId: uploaded.id, name: large.name };
}

function largeUpload(source: ParseSource): { input: string | Uint8Array; name: string } | undefined {
  if (typeof source === 'string') {
    try {
      if (statSync(source).size >= PRE_UPLOAD_THRESHOLD) {
        return { input: source, name: path.basename(source) };
      }
    } catch {
      // Missing files fail later with the transport's own message.
    }
    return undefined;
  }
  if (typeof source === 'object' && source !== null && 'file' in source) {
    const { file } = source;
    if (typeof file === 'string') {
      return largeUpload(file);
    }
    if (typeof file === 'object' && file !== null && 'input' in file) {
      const nested = file as { input: unknown; name?: (string) | undefined };
      if (nested.input instanceof Uint8Array && nested.input.byteLength >= PRE_UPLOAD_THRESHOLD) {
        return { input: nested.input, name: nested.name ?? source.name ?? 'upload.bin' };
      }
    }
  }
  return undefined;
}

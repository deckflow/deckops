import type { DeckRuntime } from '../cloud/runtime.js';
import { DeckOpsError } from '../errors/index.js';
import { familyOf } from '../ops/plan.js';
import type { OpsSource } from '../ops/run.js';
import { MAX_SOURCE_BYTES } from '../shared/constants.js';
import type { ClientInput } from './types.js';

export interface SourceBytes {
  data: Blob | Uint8Array | ArrayBuffer;
  bytes: number;
  /** The caller's own object, when there is one: the same object is never uploaded twice. */
  identity?: object;
}

export interface InputSource extends OpsSource {
  /** Read the bytes. A path is read only after the route is known to accept it. */
  read?(signal?: AbortSignal): Promise<SourceBytes>;
}

/** Classify an input by name or URL without reading it. */
export function describeInput(input: ClientInput, runtime: DeckRuntime): InputSource {
  if (isBlob(input)) {
    const name = (input as Blob & { name?: unknown }).name;
    if (typeof name !== 'string' || !name.trim()) {
      throw DeckOpsError.input('A Blob needs a filename. Pass { file: blob, name: "document.pdf" }.');
    }
    return valueSource(input, name);
  }
  if (typeof input === 'string') return pathSource(input, undefined, runtime);
  if (typeof input !== 'object' || input === null) {
    throw DeckOpsError.input('Use a File, { file, name }, { url }, or (Node only) a file path.');
  }
  if ('url' in input) {
    if ('file' in input || typeof input.url !== 'string') {
      throw DeckOpsError.input('Pass exactly one source: { url } or { file, name }.');
    }
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw DeckOpsError.input('The source URL must be an absolute HTTP(S) URL.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw DeckOpsError.input('Use an HTTP(S) source URL without embedded credentials.');
    }
    return { family: 'url', name: url.href, url: url.href };
  }
  if ('file' in input) {
    if (typeof input.file === 'string') return pathSource(input.file, input.name, runtime);
    if ('name' in input && typeof input.name === 'string' && input.name.trim()) {
      const data = input.file;
      if (isBlob(data) || data instanceof Uint8Array || data instanceof ArrayBuffer) return valueSource(data, input.name);
    }
  }
  throw DeckOpsError.input('Binary input needs { file: Blob | Uint8Array | ArrayBuffer, name: "document.pdf" }.');
}

/** A value's size is known up front, so an empty or oversized one fails before any request. */
function valueSource(data: Blob | Uint8Array | ArrayBuffer, name: string): InputSource {
  const source = checked({ data, bytes: isBlob(data) ? data.size : data.byteLength, identity: data });
  return { family: familyOf(name), name, read: async () => source };
}

function pathSource(file: string, name: string | undefined, runtime: DeckRuntime): InputSource {
  const readFile = runtime.readFile;
  if (!readFile) {
    throw DeckOpsError.input('Use a File, { file, name }, or { url }. Browser inputs cannot be filesystem paths.');
  }
  const label = name ?? file.split(/[\\/]/).pop() ?? file;
  return {
    family: familyOf(label), name: label,
    read: async (signal) => {
      let read: { data: Uint8Array };
      try {
        read = await readFile(file, signal);
      } catch (cause) {
        signal?.throwIfAborted();
        throw DeckOpsError.input(`Cannot read ${file}.`, { cause });
      }
      return checked({ data: read.data, bytes: read.data.byteLength });
    },
  };
}

function checked(source: SourceBytes): SourceBytes {
  if (source.bytes === 0) throw DeckOpsError.input('The input file is empty.');
  if (source.bytes > MAX_SOURCE_BYTES) {
    throw DeckOpsError.input(`The input is ${(source.bytes / 1024 / 1024).toFixed(1)} MiB; DeckOps Cloud accepts sources up to ${MAX_SOURCE_BYTES / 1024 / 1024} MiB.`);
  }
  return source;
}

function isBlob(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

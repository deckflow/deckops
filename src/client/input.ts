import { DeckOpsError } from '../errors/index.js';
import type { DeckRuntime } from '../cloud/runtime.js';
import { routeExtension } from '../shared/input.js';
import { formatForTaskType, type FormatKey } from '../shared/validation.js';
import type { ClientInput } from './types.js';

export type ResolvedSource =
  | { kind: 'file'; data: Blob | Uint8Array | ArrayBuffer; name: string; bytes: number; format: Exclude<FormatKey, 'link'> }
  | { kind: 'url'; url: string; format: 'link' };

export async function resolveInput(input: ClientInput, runtime: DeckRuntime, signal?: AbortSignal): Promise<ResolvedSource> {
  if (isBlob(input)) {
    const name = (input as Blob & { name?: unknown }).name;
    if (typeof name !== 'string' || !name.trim()) {
      throw DeckOpsError.input('A Blob needs a filename. Pass { file: blob, name: "document.pdf" }.');
    }
    return fileSource(input, name);
  }
  if (typeof input === 'string') return pathSource(input, undefined, runtime, signal);
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
    return { kind: 'url', url: url.href, format: 'link' };
  }
  if ('file' in input) {
    if (typeof input.file === 'string') return pathSource(input.file, input.name, runtime, signal);
    if ('name' in input && typeof input.name === 'string' && input.name.trim()) {
      const data = input.file;
      if (isBlob(data) || data instanceof Uint8Array || data instanceof ArrayBuffer) {
        return fileSource(data, input.name);
      }
    }
  }
  throw DeckOpsError.input('Binary input needs { file: Blob | Uint8Array | ArrayBuffer, name: "document.pdf" }.');
}

async function pathSource(file: string, name: string | undefined, runtime: DeckRuntime, signal?: AbortSignal): Promise<ResolvedSource> {
  if (!runtime.readFile) {
    throw DeckOpsError.input('Use a File, { file, name }, or { url }. Browser inputs cannot be filesystem paths.');
  }
  let read: { data: Uint8Array; name: string };
  try {
    read = await runtime.readFile(file, signal);
  } catch (cause) {
    throw DeckOpsError.input(`Cannot read ${file}.`, { cause });
  }
  return fileSource(read.data, name ?? read.name);
}

function fileSource(data: Blob | Uint8Array | ArrayBuffer, name: string): ResolvedSource {
  const type = routeExtension(name);
  const format = formatForTaskType(type);
  if (!format || format === 'link') {
    throw DeckOpsError.unsupported(`No file parser is registered for ${name}.`);
  }
  const bytes = isBlob(data) ? data.size : data.byteLength;
  if (bytes === 0) {
    throw DeckOpsError.input('The input file is empty.');
  }
  return { kind: 'file', data, name, bytes, format };
}

function isBlob(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

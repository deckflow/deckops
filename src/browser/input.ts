import { DeckParseError } from '../errors/index.js';
import { routeExtension } from '../shared/input.js';
import { formatForTaskType, type FormatKey } from '../shared/validation.js';
import type { BrowserInput } from './types.js';

export type BrowserSource =
  | { kind: 'file'; data: Blob | Uint8Array | ArrayBuffer; name: string; bytes: number; format: Exclude<FormatKey, 'link'> }
  | { kind: 'url'; url: string; format: 'link' };

export function resolveBrowserInput(input: BrowserInput): BrowserSource {
  if (isBlob(input)) {
    const name = (input as Blob & { name?: unknown }).name;
    if (typeof name !== 'string' || !name.trim()) {
      throw DeckParseError.input('A Blob needs a filename. Pass { file: blob, name: "document.pdf" }.');
    }
    return fileSource(input, name);
  }
  if (typeof input !== 'object' || input === null) {
    throw DeckParseError.input('Use a File, { file, name }, or { url }. Browser inputs cannot be filesystem paths.');
  }
  if ('url' in input) {
    if ('file' in input || typeof input.url !== 'string') {
      throw DeckParseError.input('Pass exactly one source: { url } or { file, name }.');
    }
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw DeckParseError.input('The source URL must be an absolute HTTP(S) URL.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw DeckParseError.input('Use an HTTP(S) source URL without embedded credentials.');
    }
    return { kind: 'url', url: url.href, format: 'link' };
  }
  if ('file' in input && 'name' in input && typeof input.name === 'string' && input.name.trim()) {
    const data = input.file;
    if (isBlob(data) || data instanceof Uint8Array || data instanceof ArrayBuffer) {
      return fileSource(data, input.name);
    }
  }
  throw DeckParseError.input('Binary input needs { file: Blob | Uint8Array | ArrayBuffer, name: "document.pdf" }.');
}

function fileSource(data: Blob | Uint8Array | ArrayBuffer, name: string): BrowserSource {
  const type = routeExtension(name);
  const format = formatForTaskType(type);
  if (!format || format === 'link') {
    throw DeckParseError.unsupported(`No file parser is registered for ${name}.`);
  }
  const bytes = isBlob(data) ? data.size : data.byteLength;
  if (bytes === 0) {
    throw DeckParseError.input('The input file is empty.');
  }
  return { kind: 'file', data, name, bytes, format };
}

function isBlob(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

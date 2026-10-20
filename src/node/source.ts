import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DeckOpsError } from '../errors/index.js';
import { MAX_SOURCE_BYTES } from '../shared/constants.js';

/**
 * Command-line inputs: `-` is stdin (with `--from`), http(s) is a URL, anything else a file.
 * A file is read once and checked unchanged afterwards; those bytes are what gets uploaded.
 */

export type NodeSource =
  | { kind: 'file'; data: Uint8Array; name: string; sha256: string; path?: string }
  | { kind: 'url'; url: string };

export interface ReadSourceOptions {
  /** Extension for stdin, where there is no file name (e.g. `pdf`). */
  from?: string;
  signal?: AbortSignal;
  /** Injected for tests. */
  readStdin?: () => Buffer;
}

export function isUrl(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

export function stdinName(from: string | undefined): string {
  if (!from) throw DeckOpsError.usage('Reading from stdin needs --from <ext> to name its format (e.g. --from pdf).');
  return `stdin${from.startsWith('.') ? from : `.${from}`}`.toLowerCase();
}

export async function readSource(input: string, options: ReadSourceOptions = {}): Promise<NodeSource> {
  if (input === '-') {
    const name = stdinName(options.from);
    const data = options.readStdin ? options.readStdin() : readFileSync(0);
    if (data.byteLength === 0) throw DeckOpsError.input('stdin was empty.');
    assertSize(name, data.byteLength);
    return { kind: 'file', data, name, sha256: sha256(data) };
  }
  if (isUrl(input)) return { kind: 'url', url: input };
  if (options.from !== undefined) throw DeckOpsError.usage('--from only applies to stdin input (-).');

  const before = await statFile(input);
  assertSize(input, before.size);
  const data = await fs.readFile(input, options.signal ? { signal: options.signal } : {});
  const after = await fs.stat(input);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || data.byteLength !== before.size) {
    throw DeckOpsError.input(`${input} changed while it was being read.`);
  }
  if (data.byteLength === 0) throw DeckOpsError.input(`${input} is empty.`);
  return { kind: 'file', data, name: path.basename(input), sha256: sha256(data), path: input };
}

/** A local file that must exist and be a regular file. */
export async function statFile(input: string): Promise<import('node:fs').Stats> {
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.stat(input);
  } catch {
    throw DeckOpsError.input(`No such file: ${input}`);
  }
  if (stat.isDirectory()) {
    const manifest = await fs.stat(path.join(input, 'manifest.json')).then(() => true, () => false);
    throw DeckOpsError.input(`${input} is a directory, not a document.`, manifest
      ? { hint: 'DeckOps 4 has no artifact directories. Pass the source document; the cloud reuses its parse for 7 days.' }
      : {});
  }
  return stat;
}

/** Base path for default outputs: next to a file source, or named after a URL's host. */
export function defaultStem(input: string, source: NodeSource | undefined, from?: string): string {
  if (input === '-') return path.basename(stdinName(from), path.extname(stdinName(from)));
  if (source?.kind === 'url' || isUrl(input)) {
    try {
      return new URL(input).hostname.replace(/[^\w.-]+/g, '-') || 'page';
    } catch {
      return 'page';
    }
  }
  return input.slice(0, input.length - path.extname(input).length);
}

function assertSize(name: string, bytes: number): void {
  if (bytes > MAX_SOURCE_BYTES) {
    throw DeckOpsError.input(`${name} is ${(bytes / 1024 / 1024).toFixed(1)} MiB; DeckOps Cloud accepts sources up to ${MAX_SOURCE_BYTES / 1024 / 1024} MiB.`);
  }
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

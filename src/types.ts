/** Public command-line contracts (4.0): flags and the `--json` envelopes, the same for every verb. */

import type { DocumentFormat, TaskRef } from './ops/types.js';

export interface CommonFlags {
  signal?: AbortSignal;
  spaceId?: string;
  /** Seconds for the whole operation, result downloads included. */
  timeout?: number;
  /** Submit a new task even when an interrupted run left one to continue. */
  force?: boolean;
}

/** A file the command wrote. */
export interface OutputFile {
  file: string;
  bytes: number;
  page?: number;
  width?: number;
  height?: number;
}

export interface OpsEnvelope {
  ok: true;
  op: 'render' | 'extract' | 'convert';
  input: string;
  to: string;
  /** The cloud tasks this run used, in order; a chain has several. */
  tasks: TaskRef[];
  outputs: OutputFile[];
  /** Document verbs: the source format, page count and whether the server reused its parse. */
  format?: DocumentFormat;
  pages?: number | null;
  reusedParse?: boolean;
  schemaVersion?: string;
  /** With `-o -` only: the Markdown text or the extracted JSON. */
  content?: unknown;
  /** With `-o -` and `--split-pages`: one Markdown string per slide. */
  contentPages?: string[];
  warnings: string[];
  durationMs: number;
}

export interface ErrorEnvelope {
  ok: false;
  op: 'probe' | 'render' | 'extract' | 'convert' | 'install';
  error: { code: string; message: string; hint?: string; taskId?: string };
}

export type Envelope = OpsEnvelope | ErrorEnvelope;

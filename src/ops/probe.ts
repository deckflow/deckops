import { DeckOpsError, type ErrorCode } from '../errors/index.js';

/**
 * Probe runs locally with the free, open-source DeckProbe engine: no credentials, no network, no
 * quota. This is the only module allowed to load `@deckflow/deckprobe`, an optional dependency,
 * and it must not reach the cloud, auth or config layers.
 */

export interface ProbeOptions {
  /** Facts to resolve, e.g. `page_count`. Defaults to the engine's set for the format. */
  targets?: string[];
  level?: 'header' | 'metadata' | 'deep';
  minimumConfidence?: 'none' | 'low' | 'medium' | 'high' | 'exact';
  budget?: { maxPhysicalBytes?: number; maxExpandedBytes?: number; maxArchiveEntries?: number; timeoutMs?: number };
}

export interface ProbeRunOptions {
  signal?: AbortSignal;
  /** Wall-clock limit for the engine, in milliseconds. */
  deadlineMs?: number;
  maxInputBytes?: number;
}

/** DeckProbe's schema-2 report, returned unchanged. */
export interface ProbeReport {
  schema_version: 2;
  tool_version: string;
  status: 'ok' | 'partial';
  input: { display_name: string; source_kind: string; file_size: number };
  results: Record<string, { target: string; status: string; value?: unknown; confidence: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

interface ErrorReport {
  status: 'error';
  error: { code: string; message: string; exit_code: number };
}

interface Engine {
  probeFile(path: string, options?: ProbeOptions, runtime?: ProbeRunOptions & { backend?: 'auto' }): Promise<ProbeReport | ErrorReport>;
}

const PROBE_ERRORS: Record<string, ErrorCode> = {
  CLI_SYNTAX: 'usage_error',
  INVALID_REQUEST: 'usage_error',
  UNSUPPORTED_TARGET: 'unsupported',
  UNSUPPORTED_FORMAT: 'unsupported',
  SOURCE_IO: 'input_error',
  MALFORMED_INPUT: 'input_error',
  BUDGET_EXCEEDED: 'input_error',
  PARSER_FAILURE: 'input_error',
};

/** Probe a file on disk. The native engine is used when its platform package is present, WASM otherwise. */
export async function probeFile(path: string, options: ProbeOptions = {}, run: ProbeRunOptions = {}): Promise<ProbeReport> {
  const engine = await loadEngine();
  const result = await engine.probeFile(path, options, {
    backend: 'auto',
    ...(run.deadlineMs !== undefined ? { deadlineMs: run.deadlineMs } : {}),
    ...(run.maxInputBytes !== undefined ? { maxInputBytes: run.maxInputBytes } : {}),
    ...(run.signal ? { signal: run.signal } : {}),
  });
  run.signal?.throwIfAborted();
  if (result.status === 'error') {
    const code = PROBE_ERRORS[result.error.code] ?? 'input_error';
    throw new DeckOpsError(code, result.error.message, { details: { probe: result } });
  }
  return result;
}

async function loadEngine(): Promise<Engine> {
  try {
    // External in the build: the engine and its WebAssembly stay in the optional package.
    return await import('@deckflow/deckprobe') as unknown as Engine;
  } catch (cause) {
    throw DeckOpsError.unsupported('deckops probe needs the optional package @deckflow/deckprobe, which is not installed.', {
      hint: 'Install DeckOps without --omit=optional, or add it next to DeckOps: npm install @deckflow/deckprobe@2.7.0',
      cause,
    });
  }
}

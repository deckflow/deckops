import { createBrowserTransport } from '../cloud/browser.js';
import type { ParseSource } from '../cloud/parse-facade.js';
import type { DeckTask, WaitForTaskOptions } from '../cloud/contracts.js';
import { DeckParseError } from '../errors/index.js';
import { PRE_UPLOAD_THRESHOLD } from '../shared/constants.js';
import { translateError } from '../shared/errors.js';
import { parseParams, convertParams } from '../shared/params.js';
import { formatForTaskType, validateParseFlagsForFormat, validateConvertFlagsForFormat } from '../shared/validation.js';
import { resolveBrowserInput } from './input.js';
import { createBrowserDocumentInspector } from './inspector.js';
import {
  assessPreflight,
  DEFAULT_PREFLIGHT_MODE,
  preflightProbeOptions,
  type DeckProbeReport,
  type PreflightOutcome,
  type PreflightSummary,
} from '../shared/preflight.js';
import type {
  BrowserClientOptions,
  BrowserConvertOptions,
  BrowserConvertRef,
  BrowserConvertResult,
  BrowserInput,
  BrowserOperationOptions,
  BrowserParseOptions,
  BrowserParseResult,
  BrowserTask,
} from './types.js';

export { DeckParseError, ERROR_CODES, type ErrorCode } from '../errors/index.js';
export type * from './types.js';

/** An in-memory result: no directories, implicit disk writes, or automatic asset downloads. */
export class BrowserParsedDocument<R = unknown> {
  readonly taskId: string;
  readonly type: BrowserParseResult<R>['type'];
  readonly irKey: string;
  readonly irSchemaVersion: string;
  readonly inspection: PreflightSummary | undefined;
  readonly warnings: readonly string[];
  private readonly snapshot: R;
  private readonly localReport: DeckProbeReport | undefined;

  constructor(
    parsed: BrowserParseResult<R>,
    private readonly convertView: (options?: BrowserConvertOptions) => Promise<BrowserConvertResult>,
    inspected: PreflightOutcome = { warnings: [] }
  ) {
    this.taskId = parsed.taskId;
    this.type = parsed.type;
    this.irKey = parsed.irKey;
    this.irSchemaVersion = parsed.irSchemaVersion;
    this.snapshot = parsed.ir;
    this.inspection = inspected.summary;
    this.localReport = inspected.report;
    this.warnings = inspected.warnings;
  }

  /** Returns the in-memory server response. Does not refetch it or extend cloud retention. */
  async ir(): Promise<R> {
    return this.snapshot;
  }

  async inspectionReport(): Promise<DeckProbeReport | undefined> {
    return this.localReport;
  }

  async convert(options: BrowserConvertOptions = {}): Promise<BrowserConvertResult> {
    const format = formatForTaskType(this.type);
    if (format) validateConvertFlagsForFormat(format, options);
    return this.convertView(options);
  }
}

export interface BrowserClient {
  parse<R = unknown>(input: BrowserInput, options?: BrowserParseOptions): Promise<BrowserParsedDocument<R>>;
  /** Accepts only an IR reference or parse task id, never a source file. */
  convert(ref: BrowserConvertRef, options?: BrowserConvertOptions): Promise<BrowserConvertResult>;
  /** Inspect a submitted task after a local timeout/disconnect without submitting it again. */
  getTask(taskId: string, options?: { signal?: AbortSignal; spaceId?: string }): Promise<BrowserTask>;
}

/** Explicit browser entry; importing this module is also safe during SSR. */
export function createClient(options: BrowserClientOptions = {}): BrowserClient {
  assertOptions(options, ['apiBase', 'token', 'spaceId', 'onUnauthorized', 'inspector'], 'client');
  if (options.token !== undefined) nonemptyString(options.token, 'token');
  if (options.spaceId !== undefined) nonemptyString(options.spaceId, 'spaceId');
  if (options.onUnauthorized !== undefined && typeof options.onUnauthorized !== 'function') {
    throw DeckParseError.usage('onUnauthorized must be a function.');
  }
  if (options.inspector !== undefined && typeof options.inspector.inspect !== 'function') {
    throw DeckParseError.usage('inspector must provide an inspect() function.');
  }
  const localInspector = options.inspector ?? createBrowserDocumentInspector();
  const deck = createBrowserTransport({
    ...(options.apiBase !== undefined ? { root: apiRoot(options.apiBase) } : {}),
    ...(options.token !== undefined ? { token: options.token } : {}),
    ...(options.spaceId !== undefined ? { spaceId: options.spaceId } : {}),
    ...(options.onUnauthorized !== undefined ? { onUnauthorized: async () => {
      // Token refresh must not implicitly move an in-flight upload/document
      // to a different space. Account changes need an explicit new client.
      const token = await options.onUnauthorized!();
      if (typeof token !== 'string' || !token.trim()) {
        throw DeckParseError.auth('Token refresh must return a nonempty token for the same user.');
      }
      return token;
    } } : {}),
    // Set explicitly as well as using the upstream browser defaults.
    allowGuestFallback: false,
    retryMutations: false,
  });

  const convert = async (ref: BrowserConvertRef, settings: BrowserConvertOptions = {}): Promise<BrowserConvertResult> => {
    assertOptions(ref, ['irKey', 'taskId'], 'conversion reference');
    if ((ref.irKey !== undefined) === (ref.taskId !== undefined)) {
      throw DeckParseError.input('Provide exactly one of irKey or the parse taskId.');
    }
    nonemptyString(ref.irKey ?? ref.taskId, 'IR reference');
    validateOperation(settings, ['to', 'anchors', 'splitPages', 'strict']);
    if (settings.to !== undefined && settings.to !== 'markdown') {
      throw DeckParseError.unsupported('Only conversion to markdown is supported.');
    }
    validateBooleans(settings, ['anchors', 'splitPages', 'strict']);
    let taskId: string | undefined;
    try {
      throwIfAborted(settings.signal);
      const result = await deck.convert(ref, {
        to: 'markdown',
        ...convertParams(settings),
        ...(settings.spaceId !== undefined ? { spaceId: settings.spaceId } : {}),
        ...(settings.signal !== undefined ? { signal: settings.signal } : {}),
        onTask: (task) => {
          taskId = task.id;
          reportTask('convert', settings, task);
        },
        wait: waitOptions('convert', settings),
      });
      throwIfAborted(settings.signal);
      if (result.markdownError) {
        throw DeckParseError.backend(`Markdown rendering failed: ${result.markdownError}`, { taskId: result.taskId });
      }
      return { ...result, reusedParse: true };
    } catch (error) {
      rethrow(error, settings.signal, taskId);
    }
  };

  return {
    convert,
    async parse<R = unknown>(input: BrowserInput, settings: BrowserParseOptions = {}): Promise<BrowserParsedDocument<R>> {
      validateOperation(settings, ['profile', 'password', 'includeImages', 'stayImageAreaRate', 'mode', 'preflight']);
      validateBooleans(settings, ['includeImages']);
      if (settings.profile !== undefined && !['fast', 'balanced', 'quality'].includes(settings.profile)) {
        throw DeckParseError.usage('profile must be fast, balanced, or quality.');
      }
      if (settings.mode !== undefined && !['source', 'runtime'].includes(settings.mode)) {
        throw DeckParseError.usage('mode must be source or runtime.');
      }
      if (settings.password !== undefined && typeof settings.password !== 'string') {
        throw DeckParseError.usage('password must be a string.');
      }
      if (settings.stayImageAreaRate !== undefined &&
          (!Number.isFinite(settings.stayImageAreaRate) || settings.stayImageAreaRate < 0 || settings.stayImageAreaRate > 1)) {
        throw DeckParseError.usage('stayImageAreaRate must be a number between 0 and 1.');
      }
      if (settings.preflight !== undefined && !['off', 'validate', 'strict'].includes(settings.preflight)) {
        throw DeckParseError.usage('preflight must be off, validate, or strict.');
      }
      throwIfAborted(settings.signal);
      const inputSource = resolveBrowserInput(input);
      validateParseFlagsForFormat(inputSource.format, settings);
      let taskId: string | undefined;
      // Leave the default to the SDK: it may have refreshed/resolved it since
      // construction. Only per-operation overrides should be sent explicitly.
      let spaceId = settings.spaceId;
      try {
        let inspected: PreflightOutcome = { warnings: [] };
        const preflightMode = settings.preflight ?? DEFAULT_PREFLIGHT_MODE;
        if (preflightMode !== 'off') {
          if (inputSource.kind === 'url') {
            inspected.warnings.push('DeckProbe preflight is local-only and was skipped for the URL input.');
          } else {
            settings.onProgress?.({ phase: 'preflight', status: 'running' });
            try {
              const result = await localInspector.inspect(
                inputSource,
                preflightProbeOptions(inputSource.format),
                settings.signal
              );
              inspected = assessPreflight(result, {
                mode: preflightMode,
                format: inputSource.format,
                passwordProvided: Boolean(settings.password),
              });
            } catch (error) {
              if (error instanceof DeckParseError) throw error;
              if (preflightMode === 'strict') {
                throw DeckParseError.input(`DeckProbe preflight failed to run: ${errorMessage(error)}`, {
                  hint: 'Retry with preflight validate/off.',
                  cause: error,
                });
              }
              inspected = { warnings: [`DeckProbe preflight failed to run: ${errorMessage(error)}. Cloud parsing will continue.`] };
            }
            throwIfAborted(settings.signal);
            settings.onProgress?.({ phase: 'preflight', status: 'completed' });
          }
        }
        const onUpload = (progress: number): void => settings.onProgress?.({ phase: 'upload', progress });
        let source: ParseSource;
        if (inputSource.kind === 'url') {
          source = { url: inputSource.url, ...(settings.mode !== undefined ? { mode: settings.mode } : {}) };
        } else if (inputSource.bytes >= PRE_UPLOAD_THRESHOLD) {
          const uploaded = await deck.files.upload(inputSource.data, {
            name: inputSource.name,
            onProgress: onUpload,
            ...(spaceId !== undefined ? { spaceId } : {}),
            ...(settings.signal !== undefined ? { signal: settings.signal } : {}),
          });
          throwIfAborted(settings.signal);
          source = { fileId: uploaded.id, name: inputSource.name };
        } else {
          // The name must reach upload normalization, not only parser routing.
          source = { file: { input: inputSource.data, name: inputSource.name }, name: inputSource.name };
        }
        const parsed = await deck.parse<R>(source, {
          ...parseParams(settings, false),
          ...(spaceId !== undefined ? { spaceId } : {}),
          ...(settings.signal !== undefined ? { signal: settings.signal } : {}),
          upload: { onProgress: onUpload },
          onTask: (task) => {
            taskId = task.id;
            spaceId = task.spaceId;
            reportTask('parse', settings, task);
          },
          wait: waitOptions('parse', settings),
        });
        throwIfAborted(settings.signal);
        return new BrowserParsedDocument(parsed, (convertOptions = {}) =>
          convert({ irKey: parsed.irKey }, { ...(spaceId !== undefined ? { spaceId } : {}), ...convertOptions }),
          inspected
        );
      } catch (error) {
        rethrow(error, settings.signal, taskId);
      }
    },
    async getTask(taskId, settings = {}) {
      nonemptyString(taskId, 'taskId');
      assertOptions(settings, ['signal', 'spaceId'], 'task');
      if (settings.spaceId !== undefined) nonemptyString(settings.spaceId, 'spaceId');
      try {
        throwIfAborted(settings.signal);
        const task = await deck.tasks.get(taskId, settings);
        throwIfAborted(settings.signal);
        return { id: task.id, spaceId: task.spaceId, type: task.type, status: task.status,
          ...(task.error !== undefined ? { error: task.error } : {}) };
      } catch (error) {
        rethrow(error, settings.signal, taskId);
      }
    },
  };
}

function reportTask(phase: 'parse' | 'convert', options: BrowserOperationOptions, task: DeckTask): void {
  options.onProgress?.({ phase, taskId: task.id, status: task.status });
}

function waitOptions(phase: 'parse' | 'convert', options: BrowserOperationOptions): WaitForTaskOptions {
  return {
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.useEventStream !== undefined ? { useEventStream: options.useEventStream } : {}),
    ...(options.pollInterval !== undefined ? { pollInterval: options.pollInterval } : {}),
    onProgress: (task) => reportTask(phase, options, task),
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

function rethrow(error: unknown, signal: AbortSignal | undefined, taskId?: string): never {
  throwIfAborted(signal);
  if (error instanceof Error && error.name === 'AbortError') throw error;
  throw translateError(error, 'browser', taskId);
}

function assertOptions(value: unknown, allowed: readonly string[], label: string): asserts value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw DeckParseError.usage(`${label} options must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      const hint = key === 'apiKey'
        ? 'Keep server API keys on your backend. Use a browser user token or an authenticated proxy.'
        : 'The browser SDK accepts values and returns data; filesystem and CLI options are not supported.';
      throw DeckParseError.usage(`Unknown ${label} option: ${key}.`, { hint });
    }
  }
}

function validateOperation(options: BrowserOperationOptions, flags: readonly string[]): void {
  assertOptions(options, ['spaceId', 'timeout', 'signal', 'onProgress', 'useEventStream', 'pollInterval', ...flags], 'operation');
  if (options.spaceId !== undefined) nonemptyString(options.spaceId, 'spaceId');
  for (const key of ['timeout', 'pollInterval'] as const) {
    if (options[key] !== undefined && (!Number.isFinite(options[key]) || options[key]! <= 0)) {
      throw DeckParseError.usage(`${key} must be a positive finite number.`);
    }
  }
  if (options.onProgress !== undefined && typeof options.onProgress !== 'function') {
    throw DeckParseError.usage('onProgress must be a function.');
  }
  validateBooleans(options, ['useEventStream']);
}

function validateBooleans(options: object, names: readonly string[]): void {
  const record = options as Record<string, unknown>;
  for (const name of names) {
    if (record[name] !== undefined && typeof record[name] !== 'boolean') {
      throw DeckParseError.usage(`${name} must be a boolean.`);
    }
  }
}

function nonemptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw DeckParseError.input(`${label} must be a nonempty string.`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function apiRoot(value: string): string {
  nonemptyString(value, 'apiBase');
  try {
    const base = typeof location === 'undefined' ? undefined : location.href;
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('invalid API root');
    }
    return url.href.replace(/\/$/, '');
  } catch {
    throw DeckParseError.usage('apiBase must be an HTTP(S) API root, or a relative URL when running in a browser.');
  }
}

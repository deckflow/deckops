import { createTransport, type TransportClient } from '../cloud/transport.js';
import type { DeckRuntime } from '../cloud/runtime.js';
import type { ParseSource } from '../cloud/parse-facade.js';
import type { DeckTask, WaitForTaskOptions } from '../cloud/contracts.js';
import { DECK_TASK_TYPES } from '../cloud/contracts.js';
import { DeckOpsError } from '../errors/index.js';
import { PRE_UPLOAD_THRESHOLD } from '../shared/constants.js';
import { translateError } from '../shared/errors.js';
import { parseParams, convertParams } from '../shared/params.js';
import { formatForTaskType, validateParseFlagsForFormat, validateConvertFlagsForFormat } from '../shared/validation.js';
import type { ParseTaskType } from '../types.js';
import { resolveInput } from './input.js';
import type {
  ClientInput, ClientOptions, ConvertOptions, ConvertRef, ConvertResult, OperationOptions, ParseOptions, ParseResult, TaskInfo,
} from './types.js';

export type * from './types.js';

/**
 * The isomorphic SDK facade: input normalization, large-file pre-upload, task waiting and
 * error translation. It never touches a filesystem; Node adds artifacts in `node/`.
 */

export type HintContext = 'node' | 'browser';
export type ParseType = ParseTaskType | 'html.getByURL';

/** An in-memory result: the server response plus a bound convert(). */
export class CloudParsedDocument<R = unknown> {
  readonly taskId: string;
  readonly spaceId: string;
  readonly type: ParseType;
  readonly irKey: string;
  readonly irSchemaVersion: string;
  private readonly snapshot: R;

  constructor(parsed: ParseResult<R>, private readonly convertView: (options?: ConvertOptions) => Promise<ConvertResult>) {
    this.taskId = parsed.taskId;
    this.spaceId = parsed.spaceId;
    this.type = parsed.type;
    this.irKey = parsed.irKey;
    this.irSchemaVersion = parsed.irSchemaVersion;
    this.snapshot = parsed.ir;
  }

  /** Returns the in-memory server response. Does not refetch it or extend cloud retention. */
  async ir(): Promise<R> {
    return this.snapshot;
  }

  async convert(options: ConvertOptions = {}): Promise<ConvertResult> {
    const format = formatForTaskType(this.type);
    if (format) validateConvertFlagsForFormat(format, options);
    return this.convertView(options);
  }
}

export interface DeckClient<Input = ClientInput> {
  parse<R = unknown>(input: Input, options?: ParseOptions): Promise<CloudParsedDocument<R>>;
  /** Accepts only an IR reference or parse task id, never a source file. */
  convert(ref: ConvertRef, options?: ConvertOptions): Promise<ConvertResult>;
  /** Wait for a parse task an earlier call submitted and fetch its result: no upload, no new task. */
  resume<R = unknown>(taskId: string, type: ParseType, options?: OperationOptions): Promise<CloudParsedDocument<R>>;
  /** Inspect a submitted task after a local timeout/disconnect without submitting it again. */
  getTask(taskId: string, options?: { signal?: AbortSignal; spaceId?: string }): Promise<TaskInfo>;
}

const CLIENT_OPTIONS = ['apiBase', 'token', 'apiKey', 'spaceId', 'onUnauthorized'];
const PARSE_TYPES: readonly string[] = DECK_TASK_TYPES.filter((type) => type !== 'parse.convert');

export function createClientWith<Input extends ClientInput = ClientInput>(
  options: ClientOptions, runtime: DeckRuntime, context: HintContext
): DeckClient<Input> {
  if (context === 'browser' && typeof options === 'object' && options !== null && 'apiKey' in options) {
    throw DeckOpsError.usage('Unknown client option: apiKey.', {
      hint: 'Keep server API keys on your backend. Use a browser user token or an authenticated proxy.',
    });
  }
  assertOptions(options, context === 'browser' ? CLIENT_OPTIONS.filter((key) => key !== 'apiKey') : CLIENT_OPTIONS, 'client', context);
  for (const key of ['token', 'apiKey', 'spaceId'] as const) {
    if (options[key] !== undefined) nonemptyString(options[key], key);
  }
  if (options.onUnauthorized !== undefined && typeof options.onUnauthorized !== 'function') {
    throw DeckOpsError.usage('onUnauthorized must be a function.');
  }
  const deck: TransportClient = createTransport({
    ...(options.apiBase !== undefined ? { root: apiRoot(options.apiBase) } : {}),
    ...(options.token !== undefined ? { token: options.token } : {}),
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.spaceId !== undefined ? { spaceId: options.spaceId } : {}),
    ...(options.onUnauthorized !== undefined ? { onUnauthorized: async () => {
      // Token refresh must not implicitly move an in-flight upload/document
      // to a different space. Account changes need an explicit new client.
      const token = await options.onUnauthorized!();
      if (typeof token !== 'string' || !token.trim()) {
        throw DeckOpsError.auth('Token refresh must return a nonempty token for the same user.');
      }
      return token;
    } } : {}),
    // A rejected credential is auth_error, never a silent guest; task POSTs are never replayed.
    allowGuestFallback: false,
    retryMutations: false,
  }, runtime);

  const convert = async (ref: ConvertRef, settings: ConvertOptions = {}): Promise<ConvertResult> => {
    assertOptions(ref, ['irKey', 'taskId'], 'conversion reference', context);
    if ((ref.irKey !== undefined) === (ref.taskId !== undefined)) {
      throw DeckOpsError.input('Provide exactly one of irKey or the parse taskId.');
    }
    nonemptyString(ref.irKey ?? ref.taskId, 'IR reference');
    validateOperation(settings, ['to', 'anchors', 'splitPages', 'strict'], context);
    if (settings.to !== undefined && settings.to !== 'markdown') {
      throw DeckOpsError.unsupported('Only conversion to markdown is supported.');
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
        throw DeckOpsError.backend(`Markdown rendering failed: ${result.markdownError}`, { taskId: result.taskId });
      }
      return { ...result, reusedParse: true };
    } catch (error) {
      rethrow(error, context, settings.signal, taskId);
    }
  };

  const document = <R>(parsed: ParseResult<R>): CloudParsedDocument<R> =>
    new CloudParsedDocument(parsed, (convertOptions = {}) =>
      convert({ irKey: parsed.irKey }, { ...(parsed.spaceId ? { spaceId: parsed.spaceId } : {}), ...convertOptions }));

  return {
    convert,
    async parse<R = unknown>(input: Input, settings: ParseOptions = {}): Promise<CloudParsedDocument<R>> {
      validateOperation(settings, ['profile', 'password', 'includeImages', 'stayImageAreaRate', 'mode', 'onSubmit'], context);
      validateBooleans(settings, ['includeImages']);
      if (settings.profile !== undefined && !['fast', 'balanced', 'quality'].includes(settings.profile)) {
        throw DeckOpsError.usage('profile must be fast, balanced, or quality.');
      }
      if (settings.mode !== undefined && !['source', 'runtime'].includes(settings.mode)) {
        throw DeckOpsError.usage('mode must be source or runtime.');
      }
      if (settings.password !== undefined && typeof settings.password !== 'string') {
        throw DeckOpsError.usage('password must be a string.');
      }
      if (settings.stayImageAreaRate !== undefined &&
          (!Number.isFinite(settings.stayImageAreaRate) || settings.stayImageAreaRate < 0 || settings.stayImageAreaRate > 1)) {
        throw DeckOpsError.usage('stayImageAreaRate must be a number between 0 and 1.');
      }
      if (settings.onSubmit !== undefined && typeof settings.onSubmit !== 'function') {
        throw DeckOpsError.usage('onSubmit must be a function.');
      }
      throwIfAborted(settings.signal);
      const inputSource = await resolveInput(input, runtime, settings.signal);
      const { onSubmit, ...flags } = settings;
      validateParseFlagsForFormat(inputSource.format, flags);
      let taskId: string | undefined;
      // Leave the default to the transport: it may have resolved it since construction.
      // Only per-operation overrides are sent explicitly.
      let spaceId = settings.spaceId;
      try {
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
          ...parseParams(flags, false),
          ...(spaceId !== undefined ? { spaceId } : {}),
          ...(settings.signal !== undefined ? { signal: settings.signal } : {}),
          ...(onSubmit !== undefined ? { onSubmit } : {}),
          upload: { onProgress: onUpload },
          onTask: (task) => {
            taskId = task.id;
            spaceId = task.spaceId;
            reportTask('parse', settings, task);
          },
          wait: waitOptions('parse', settings),
        });
        throwIfAborted(settings.signal);
        return document({ ...parsed, spaceId: spaceId ?? '' });
      } catch (error) {
        rethrow(error, context, settings.signal, taskId);
      }
    },
    async resume<R = unknown>(taskId: string, type: ParseType, settings: OperationOptions = {}): Promise<CloudParsedDocument<R>> {
      nonemptyString(taskId, 'taskId');
      if (!PARSE_TYPES.includes(type)) throw DeckOpsError.usage(`Unknown parse task type: ${String(type)}.`);
      validateOperation(settings, [], context);
      let spaceId = settings.spaceId;
      try {
        throwIfAborted(settings.signal);
        const parsed = await deck.resume<R>(taskId, type, {
          ...(spaceId !== undefined ? { spaceId } : {}),
          ...(settings.signal !== undefined ? { signal: settings.signal } : {}),
          wait: waitOptions('parse', { ...settings, onProgress: (event) => {
            if (event.phase === 'parse') spaceId = event.spaceId;
            settings.onProgress?.(event);
          } }),
        });
        throwIfAborted(settings.signal);
        return document({ ...parsed, spaceId: spaceId ?? '' });
      } catch (error) {
        rethrow(error, context, settings.signal, taskId);
      }
    },
    async getTask(taskId, settings = {}) {
      nonemptyString(taskId, 'taskId');
      assertOptions(settings, ['signal', 'spaceId'], 'task', context);
      if (settings.spaceId !== undefined) nonemptyString(settings.spaceId, 'spaceId');
      try {
        throwIfAborted(settings.signal);
        const task = await deck.tasks.get(taskId, settings);
        throwIfAborted(settings.signal);
        return { id: task.id, spaceId: task.spaceId, type: task.type, status: task.status,
          ...(task.error !== undefined ? { error: task.error } : {}) };
      } catch (error) {
        rethrow(error, context, settings.signal, taskId);
      }
    },
  };
}

function reportTask(phase: 'parse' | 'convert', options: OperationOptions, task: DeckTask): void {
  options.onProgress?.({ phase, taskId: task.id, spaceId: task.spaceId, status: task.status });
}

function waitOptions(phase: 'parse' | 'convert', options: OperationOptions): WaitForTaskOptions {
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

function rethrow(error: unknown, context: HintContext, signal: AbortSignal | undefined, taskId?: string): never {
  throwIfAborted(signal);
  if (error instanceof Error && error.name === 'AbortError') throw error;
  throw translateError(error, context, taskId);
}

function assertOptions(value: unknown, allowed: readonly string[], label: string, context: HintContext): asserts value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw DeckOpsError.usage(`${label} options must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      const hint = context === 'browser'
        ? 'The browser SDK accepts values and returns data; filesystem and CLI options are not supported.'
        : 'Artifact, output and cache options belong to the Node operations, not the cloud client.';
      throw DeckOpsError.usage(`Unknown ${label} option: ${key}.`, { hint });
    }
  }
}

function validateOperation(options: OperationOptions, flags: readonly string[], context: HintContext): void {
  assertOptions(options, ['spaceId', 'timeout', 'signal', 'onProgress', 'useEventStream', 'pollInterval', ...flags], 'operation', context);
  if (options.spaceId !== undefined) nonemptyString(options.spaceId, 'spaceId');
  for (const key of ['timeout', 'pollInterval'] as const) {
    if (options[key] !== undefined && (!Number.isFinite(options[key]) || options[key]! <= 0)) {
      throw DeckOpsError.usage(`${key} must be a positive finite number.`);
    }
  }
  if (options.onProgress !== undefined && typeof options.onProgress !== 'function') {
    throw DeckOpsError.usage('onProgress must be a function.');
  }
  validateBooleans(options, ['useEventStream']);
}

function validateBooleans(options: object, names: readonly string[]): void {
  const record = options as Record<string, unknown>;
  for (const name of names) {
    if (record[name] !== undefined && typeof record[name] !== 'boolean') {
      throw DeckOpsError.usage(`${name} must be a boolean.`);
    }
  }
}

function nonemptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw DeckOpsError.input(`${label} must be a nonempty string.`);
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
    throw DeckOpsError.usage('apiBase must be an HTTP(S) API root, or a relative URL when running in a browser.');
  }
}

import { createTransport, type TransportClient } from '../cloud/transport.js';
import type { DeckRuntime } from '../cloud/runtime.js';
import type { DeckTask } from '../cloud/contracts.js';
import { DeckOpsError } from '../errors/index.js';
import { planRoute } from '../ops/plan.js';
import { runOps, type OpsEnv, type OpsResultFor } from '../ops/run.js';
import type { OpsOptions, ProgressEvent, TaskRef, Verb } from '../ops/types.js';
import { translateError } from '../shared/errors.js';
import { describeInput, type InputSource, type SourceBytes } from './input.js';
import { UploadCache } from './uploads.js';
import type {
  ClientInput, ClientOptions, ExtractCallOptions, OperationOptions, OpsClient, TaskInfo,
} from './types.js';

export type * from './types.js';

/**
 * The isomorphic SDK: render, convert and extract over the route table, plus low-level tasks and
 * files. It never touches a filesystem; Node adds output files and the upload index in `node/`.
 */

export type HintContext = 'node' | 'browser';

/** The default budget of one call, in seconds. */
export const DEFAULT_CALL_TIMEOUT = 300;
/** setTimeout's ceiling. */
const MAX_TIMEOUT_SECONDS = 2_147_483;
const MAX_PAGE = 10_000;

const CLIENT_OPTIONS = ['apiBase', 'token', 'apiKey', 'spaceId', 'onUnauthorized'];
const OPERATION_OPTIONS = ['spaceId', 'timeout', 'signal', 'onProgress', 'useEventStream', 'pollInterval'];
const PARSE_OPTIONS = ['profile', 'password', 'includeImages', 'stayImageAreaRate'];
const VERB_OPTIONS: Record<Verb, readonly string[]> = {
  render: ['to', 'pages', 'quality', 'imageFormat', 'width', 'scale'],
  convert: ['to', 'anchors', 'splitPages', 'strict', 'imageRefs', ...PARSE_OPTIONS],
  extract: ['to', ...PARSE_OPTIONS],
};
const TARGETS: Record<Verb, readonly string[]> = { render: ['image', 'video'], convert: ['markdown'], extract: ['json', 'assets'] };

/** Internal hooks for the Node layer's submission journal. */
export interface CallInternals {
  /** Continue this submitted task instead of uploading and creating it again. */
  resume?: TaskRef;
  /** Before the first task's request leaves. */
  onDispatch?: () => Promise<void>;
  /** The first task was created. */
  onCreated?: (ref: TaskRef, spaceId: string) => Promise<void>;
}

export function createClientWith<Input extends ClientInput = ClientInput>(
  options: ClientOptions, runtime: DeckRuntime, context: HintContext,
): OpsClient<Input> & { run<V extends Verb>(verb: V, input: Input, settings: object, internals?: CallInternals): Promise<OpsResultFor<V>> } {
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
  const transport: TransportClient = createTransport({
    ...(options.apiBase !== undefined ? { root: apiRoot(options.apiBase) } : {}),
    ...(options.token !== undefined ? { token: options.token } : {}),
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.spaceId !== undefined ? { spaceId: options.spaceId } : {}),
    ...(options.onUnauthorized !== undefined ? { onUnauthorized: async () => {
      // A refresh must not move an in-flight upload or task to another space or account.
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
  const uploads = new UploadCache(runtime.fileIds, transport.root);

  /** Servers with capabilities v1 verify uploads; older ones have no such endpoint and no document tasks. */
  const confirmsUploads = async (signal: AbortSignal): Promise<boolean> =>
    ((await transport.capabilities(signal)).server?.capabilitiesVersion ?? 0) >= 1;

  /** One upload of the call's source, reusing an id this client already has. */
  const uploadSource = async (
    source: SourceBytes, name: string, spaceId: string, signal: AbortSignal, emit: (event: ProgressEvent) => void, persist = true,
  ): Promise<{ id: string; reused: boolean }> => {
    const send = async () => (await transport.files.upload(source.data, {
      name, spaceId, signal, confirm: await confirmsUploads(signal), onProgress: (progress) => emit({ phase: 'upload', progress }),
    })).id;
    let result: { id: string; reused: boolean };
    try {
      result = await uploads.fileId(spaceId, source, send, persist);
    } catch (error) {
      // Another call's upload this one joined was cancelled: upload it ourselves.
      if (signal.aborted || !(error instanceof Error && error.name === 'AbortError')) throw error;
      result = await uploads.fileId(spaceId, source, send, persist);
    }
    if (result.reused) emit({ phase: 'upload', progress: 1 });
    return result;
  };

  async function run<V extends Verb>(verb: V, input: Input, settings: object, internals: CallInternals = {}): Promise<OpsResultFor<V>> {
    const call = settings as OperationOptions & Record<string, unknown>;
    validateOperation(call, VERB_OPTIONS[verb], context);
    const opsOptions = toOpsOptions(verb, call);
    const imageRefs = (call.imageRefs as 'url' | 'path' | undefined) ?? 'url';
    const timeout = call.timeout ?? DEFAULT_CALL_TIMEOUT;
    const budget = createBudget(timeout, call.signal);
    const created: TaskRef[] = [];
    try {
      const source: InputSource = describeInput(input, runtime);
      // Every option is checked against the route before any request.
      planRoute(verb, source.family, source.name, opsOptions);
      const emit = (event: ProgressEvent): void => call.onProgress?.(event);
      const spaceId = await transport.resolveSpaceId(call.spaceId, budget.signal) ?? '';
      let bytes: SourceBytes | undefined;
      let reused = false;
      const env: OpsEnv = {
        tasks: transport.tasks,
        spaceId,
        signal: budget.signal,
        remaining: budget.remaining,
        wait: {
          ...(call.useEventStream !== undefined ? { useEventStream: call.useEventStream } : {}),
          ...(call.pollInterval !== undefined ? { pollInterval: call.pollInterval } : {}),
        },
        apiRoot: transport.root,
        capabilities: (signal) => transport.capabilities(signal),
        upload: async () => {
          bytes ??= await source.read!(budget.signal);
          // A password-protected source is never remembered on disk.
          const uploaded = await uploadSource(bytes, source.name, spaceId, budget.signal, emit, call.password === undefined);
          reused = uploaded.reused;
          return uploaded.id;
        },
        uploadIntermediate: async (blob, name) => (await transport.files.upload(blob, {
          name, spaceId, signal: budget.signal, confirm: await confirmsUploads(budget.signal),
          onProgress: (progress) => emit({ phase: 'upload', progress }),
        })).id,
        emit,
        imageRefs,
        created,
        resume: internals.resume,
        onDispatch: internals.onDispatch,
        onCreated: internals.onCreated,
      };
      try {
        return await runOps(verb, source, opsOptions, env);
      } catch (error) {
        // An id this client reused has expired on the server: upload again, once.
        if (!reused || created.length > 0 || !isStaleFile(error) || !bytes) throw error;
        await uploads.forget(spaceId, bytes);
        return await runOps(verb, source, opsOptions, env);
      }
    } catch (error) {
      throw callError(error, verb, call.signal, budget, timeout, created, context);
    } finally {
      budget.dispose();
    }
  }

  const taskInfo = (task: DeckTask): TaskInfo => ({
    id: task.id, spaceId: task.spaceId, type: task.type, status: task.status,
    ...(task.error !== undefined ? { error: task.error } : {}),
  });

  const lowLevel = async <T>(taskId: string, settings: object, allowed: readonly string[], action: () => Promise<T>): Promise<T> => {
    nonemptyString(taskId, 'taskId');
    assertOptions(settings, ['signal', 'spaceId', ...allowed], 'task', context);
    const values = settings as { signal?: AbortSignal; spaceId?: string };
    if (values.spaceId !== undefined) nonemptyString(values.spaceId, 'spaceId');
    try {
      values.signal?.throwIfAborted();
      const result = await action();
      values.signal?.throwIfAborted();
      return result;
    } catch (error) {
      values.signal?.throwIfAborted();
      throw translateError(error, context, taskId);
    }
  };

  return {
    run,
    render: (input, settings) => run('render', input, settings),
    convert: (input, settings = {}) => run('convert', input, settings),
    extract: ((input: Input, settings: ExtractCallOptions) => run('extract', input, settings)) as OpsClient<Input>['extract'],
    tasks: {
      get: (taskId, settings = {}) => lowLevel(taskId, settings, [], async () => taskInfo(await transport.tasks.get(taskId, settings))),
      wait: (taskId, settings = {}) => lowLevel(taskId, settings, ['timeout', 'useEventStream', 'pollInterval'], async () => {
        validateOperation(settings, [], context);
        return taskInfo(await transport.tasks.wait(taskId, { ...settings, timeout: settings.timeout ?? DEFAULT_CALL_TIMEOUT }));
      }),
      download: (taskId, settings = {}) => lowLevel(taskId, settings, [], () => transport.tasks.down(taskId, settings)),
    },
    files: {
      async upload(input, settings = {}) {
        assertOptions(settings, ['spaceId', 'signal', 'onProgress'], 'upload', context);
        const signal = settings.signal ?? new AbortController().signal;
        try {
          signal.throwIfAborted();
          const source = describeInput(input, runtime);
          if (!source.read) throw DeckOpsError.input('A URL is not a file to upload.');
          const bytes = await source.read(signal);
          const spaceId = await transport.resolveSpaceId(settings.spaceId, signal) ?? '';
          const uploaded = await uploadSource(bytes, source.name, spaceId, signal, (event) => settings.onProgress?.(event));
          return { id: uploaded.id, name: source.name, bytes: bytes.bytes };
        } catch (error) {
          signal.throwIfAborted();
          throw translateError(error, context);
        }
      },
    },
  };
}

/** One deadline for the whole call, merged with the caller's signal. */
function createBudget(seconds: number, user?: AbortSignal) {
  const controller = new AbortController();
  const deadline = Date.now() + seconds * 1000;
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort(new DOMException(`The call did not finish within ${seconds}s.`, 'TimeoutError'));
  }, seconds * 1000);
  const onAbort = (): void => controller.abort(user?.reason);
  if (user?.aborted) onAbort();
  else user?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    remaining: (): number => Math.max((deadline - Date.now()) / 1000, 0),
    get expired(): boolean { return expired; },
    dispose(): void {
      clearTimeout(timer);
      user?.removeEventListener('abort', onAbort);
    },
  };
}

function callError(
  error: unknown, verb: Verb, signal: AbortSignal | undefined, budget: { expired: boolean }, timeout: number,
  created: TaskRef[], context: HintContext,
): unknown {
  // A cancelled call rejects with the caller's own reason, never wrapped.
  if (signal?.aborted) return signal.reason ?? new DOMException('Aborted', 'AbortError');
  const taskId = created[created.length - 1]?.id;
  if (budget.expired) {
    return DeckOpsError.backend(`${verb} did not finish within ${timeout}s.`, {
      hint: context === 'node'
        ? 'Tasks already created keep running in the cloud. Raise --timeout and run the command again.'
        : 'Tasks already created keep running in the cloud. Increase the timeout, or check the task later with its taskId.',
      ...(taskId !== undefined ? { taskId } : {}),
      details: { reason: 'timeout', timeoutSeconds: timeout },
      cause: error,
    });
  }
  const translated = translateError(error, context, taskId);
  // A failure after a task ran (a page beyond the result, say) still names that task.
  if (translated.taskId === undefined && taskId !== undefined) {
    return new DeckOpsError(translated.code, translated.message, {
      ...(translated.hint !== undefined ? { hint: translated.hint } : {}),
      ...(translated.details !== undefined ? { details: translated.details } : {}),
      taskId, cause: translated.cause ?? error,
    });
  }
  return translated;
}

/** The server forgot an uploaded file id (old files expire): `ttask.add` answers 404 "File not found". */
function isStaleFile(error: unknown): boolean {
  return error instanceof Error && error.name === 'APIError' && (error as { statusCode?: number }).statusCode === 404 &&
    /File not found/i.test(error.message);
}

function toOpsOptions(verb: Verb, call: Record<string, unknown>): OpsOptions {
  const to = call.to ?? (verb === 'convert' ? 'markdown' : undefined);
  if (to === undefined) throw DeckOpsError.usage(`${verb} needs a target: to: ${TARGETS[verb].map((item) => `'${item}'`).join(' | ')}.`);
  if (typeof to !== 'string' || !TARGETS[verb].includes(to)) {
    throw DeckOpsError.unsupported(`${verb} cannot produce ${String(to)}.`, { hint: `${verb} supports ${TARGETS[verb].join(', ')}.` });
  }
  validateValues(call);
  const options: Record<string, unknown> = { to };
  for (const key of VERB_OPTIONS[verb]) {
    if (key !== 'to' && key !== 'imageRefs' && call[key] !== undefined) options[key] = call[key];
  }
  if (Array.isArray(options.pages)) options.pages = [...new Set(options.pages as number[])].sort((a, b) => a - b);
  return options as OpsOptions;
}

function validateValues(call: Record<string, unknown>): void {
  oneOf(call, 'quality', ['low', 'medium', 'high']);
  oneOf(call, 'imageFormat', ['png', 'jpg', 'webp']);
  oneOf(call, 'profile', ['fast', 'balanced', 'quality']);
  oneOf(call, 'imageRefs', ['url', 'path']);
  validateBooleans(call, ['anchors', 'splitPages', 'strict', 'includeImages']);
  if (call.pages !== undefined && (!Array.isArray(call.pages) || !call.pages.length ||
      !call.pages.every((page) => Number.isSafeInteger(page) && page >= 1 && page <= MAX_PAGE))) {
    throw DeckOpsError.usage(`pages must be a nonempty list of page numbers from 1 to ${MAX_PAGE}.`);
  }
  if (call.width !== undefined && !(Number.isSafeInteger(call.width) && (call.width as number) > 0)) {
    throw DeckOpsError.usage('width must be a positive whole number of pixels.');
  }
  if (call.scale !== undefined && !(typeof call.scale === 'number' && Number.isFinite(call.scale) && call.scale > 0)) {
    throw DeckOpsError.usage('scale must be a positive number.');
  }
  if (call.password !== undefined && typeof call.password !== 'string') throw DeckOpsError.usage('password must be a string.');
  if (call.stayImageAreaRate !== undefined && !(typeof call.stayImageAreaRate === 'number' &&
      call.stayImageAreaRate >= 0 && call.stayImageAreaRate <= 1)) {
    throw DeckOpsError.usage('stayImageAreaRate must be a number between 0 and 1.');
  }
}

function oneOf(call: Record<string, unknown>, key: string, values: readonly string[]): void {
  if (call[key] !== undefined && !values.includes(call[key] as string)) {
    throw DeckOpsError.usage(`${key} must be ${values.join(', ')}.`);
  }
}

function assertOptions(value: unknown, allowed: readonly string[], label: string, context: HintContext): asserts value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw DeckOpsError.usage(`${label} options must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      const hint = context === 'browser'
        ? 'The browser SDK accepts values and returns data; filesystem and CLI options are not supported.'
        : 'Output and cache options belong to the Node operations, not the cloud client.';
      throw DeckOpsError.usage(`Unknown ${label} option: ${key}.`, { hint });
    }
  }
}

function validateOperation(options: object, flags: readonly string[], context: HintContext): void {
  assertOptions(options, [...OPERATION_OPTIONS, ...flags], 'operation', context);
  const values = options as OperationOptions;
  if (values.spaceId !== undefined) nonemptyString(values.spaceId, 'spaceId');
  if (values.timeout !== undefined && (!Number.isFinite(values.timeout) || values.timeout <= 0 || values.timeout > MAX_TIMEOUT_SECONDS)) {
    throw DeckOpsError.usage('timeout must be a positive number of seconds.');
  }
  if (values.pollInterval !== undefined && (!Number.isFinite(values.pollInterval) || values.pollInterval <= 0)) {
    throw DeckOpsError.usage('pollInterval must be a positive finite number.');
  }
  if (values.onProgress !== undefined && typeof values.onProgress !== 'function') {
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


import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import type { CallInternals } from '../client/index.js';
import type { ResolvedCredentials } from '../config/index.js';
import { DeckOpsError } from '../errors/index.js';
import { familyOf, planRoute } from '../ops/plan.js';
import { probeFile, type ProbeOptions, type ProbeReport } from '../ops/probe.js';
import type {
  ConvertOptions, ConvertResult, ExtractOptions, ExtractResult, OpsOptions, ProgressEvent, RemoteFile, RenderOptions, RenderResult, Verb,
} from '../ops/types.js';
import { MAX_SOURCE_BYTES } from '../shared/constants.js';
import type { CommonFlags, OpsEnvelope, OutputFile } from '../types.js';
import { cacheKey, submissions } from './cache.js';
import type { CloudClient } from './cloud.js';
import { defaultStem, isUrl, readSource, statFile, stdinName, type NodeSource } from './source.js';
import { withinOperationTimeout } from './timeout.js';
import { download, inside, replaceDirectory, writeText, type DownloadItem } from './write.js';
import { rewriteImageRefs } from '../ops/results.js';

/**
 * The command-line operations: run a verb through the cloud client, then write what it returned.
 * The whole run — upload, every task and every download — shares one `--timeout` budget.
 */

export const DEFAULT_TIMEOUT_SECONDS = 300;

export interface CloudAccess {
  client: CloudClient;
  credentials: ResolvedCredentials;
}

interface Request<O> {
  /** The source argument: a path, `-`, or a URL. */
  input: string;
  from?: string;
  /** `-o`: a path, `-` for stdout, or undefined for the verb's default. */
  out?: string;
  options: O;
  common: CommonFlags;
  cloud: () => Promise<CloudAccess>;
}

export type RenderRequest = Request<RenderOptions>;
export type ConvertRequest = Request<ConvertOptions & { keepRemoteImages?: boolean }>;
export type ExtractRequest = Request<ExtractOptions>;

interface Written {
  outputs: OutputFile[];
  content?: unknown;
  contentPages?: string[];
}

export async function runRender(request: RenderRequest): Promise<OpsEnvelope> {
  if (request.out === '-') throw DeckOpsError.usage('render writes image or video files; -o - (stdout) is not available.');
  const stem = defaultStem(request.input, undefined, request.from);
  return await runCloud('render', request, request.options, async (result: RenderResult, signal) => {
    const files = result.outputs;
    const toDirectory = request.out === undefined ? files.length !== 1 : await isDirectoryTarget(request.out);
    const items: DownloadItem[] = files.map((file, index) => {
      const extension = path.extname(file.path);
      if (toDirectory) return { file, target: inside(request.out ?? stem, file.path) };
      const base = request.out ?? `${stem}${extension}`;
      if (files.length === 1) return { file, target: base };
      const named = base.slice(0, base.length - path.extname(base).length);
      return { file, target: `${named}-${String(file.page ?? index + 1).padStart(3, '0')}${extension}` };
    });
    return { outputs: await download(items, signal) };
  });
}

export async function runConvert(request: ConvertRequest): Promise<OpsEnvelope> {
  const { keepRemoteImages, ...options } = request.options;
  const out = request.out ?? `${defaultStem(request.input, undefined, request.from)}.md`;
  // Written Markdown links its downloaded images by relative path; stdout and remote mode keep signed URLs.
  const local = out !== '-' && !keepRemoteImages;
  const settings: ConvertOptions & { imageRefs: 'url' | 'path' } = { ...options, imageRefs: local ? 'path' : 'url' };
  return await runCloud('convert', { ...request, out }, settings, async (result: ConvertResult, signal) => {
    if (out === '-') return { outputs: [], content: result.content, ...(result.contentPages ? { contentPages: result.contentPages } : {}) };
    const stem = out.slice(0, out.length - path.extname(out).length);
    // Images first: a Markdown file never points at images that failed to arrive.
    const assets = local ? await writeAssets(stem, result.images, signal) : { outputs: [], links: new Map<string, string>() };
    const relink = (text: string): string => local ? rewriteImageRefs(text, result.images.map((image) => ({ ...image, url: markdownLink(assets.links.get(image.path)!) }))) : text;
    const outputs = [await writeText(out, relink(result.content)), ...assets.outputs];
    for (const [index, page] of (result.contentPages ?? []).entries()) {
      outputs.push(await writeText(`${stem}-${String(index + 1).padStart(3, '0')}.md`, relink(page)));
    }
    return { outputs };
  });
}

export async function runExtract(request: ExtractRequest): Promise<OpsEnvelope> {
  const stem = defaultStem(request.input, undefined, request.from);
  const json = request.options.to === 'json';
  if (!json && request.out === '-') throw DeckOpsError.usage('extract --to assets writes files; -o - (stdout) is not available.');
  const out = request.out ?? (json ? `${stem}.json` : stem);
  return await runCloud('extract', { ...request, out }, request.options, async (result: ExtractResult, signal) => {
    if (result.to === 'json') {
      if (out === '-') return { outputs: [], content: result.content };
      const assets = await writeAssets(out.slice(0, out.length - path.extname(out).length), result.assets, signal);
      const document = relinkJson(result.content, assets.links);
      return { outputs: [await writeText(out, `${JSON.stringify(document, null, 2)}\n`), ...assets.outputs] };
    }
    return { outputs: await download(result.assets.map((file) => ({ file, target: inside(out, file.path) })), signal) };
  });
}

/** Local and free: no credentials, no network, no quota. URLs are not fetched. */
export async function runProbe(request: { input: string; from?: string; options: ProbeOptions; common: Pick<CommonFlags, 'signal' | 'timeout'> }): Promise<ProbeReport> {
  if (isUrl(request.input)) {
    throw DeckOpsError.unsupported('probe reads local files and never fetches a URL.', {
      hint: 'Download the file first; extract and convert fetch URLs in the cloud.',
    });
  }
  const run = {
    ...(request.common.signal ? { signal: request.common.signal } : {}),
    deadlineMs: Math.ceil((request.common.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000),
    maxInputBytes: MAX_SOURCE_BYTES,
  };
  if (request.input !== '-') {
    if (request.from !== undefined) throw DeckOpsError.usage('--from only applies to stdin input (-).');
    await statFile(request.input);
    return await probeFile(request.input, request.options, run);
  }
  // The engine reads files: stdin goes through a private temporary copy.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deckops-probe-'));
  try {
    const file = path.join(dir, stdinName(request.from));
    await fs.writeFile(file, readFileSync(0), { mode: 0o600 });
    return await probeFile(file, request.options, run);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * A document's images in its own `<stem>.assets/` directory, so documents written to one
 * directory never collide. Returns each server path's link relative to the written file.
 */
async function writeAssets(stem: string, files: readonly RemoteFile[], signal: AbortSignal): Promise<{ outputs: OutputFile[]; links: Map<string, string> }> {
  const name = `${path.basename(stem)}.assets`;
  const placed = files.map((file) => ({ file, relative: file.path.replace(/^assets\//, '') }));
  const outputs = await replaceDirectory(path.join(path.dirname(stem), name), placed, signal);
  return { outputs, links: new Map(placed.map((item) => [item.file.path, `${name}/${item.relative}`])) };
}

/** JSON asset references are relative paths: point each one at the downloaded copy. */
function relinkJson(value: unknown, links: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return links.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => relinkJson(item, links));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relinkJson(item, links)]));
  }
  return value;
}

/** A Markdown link target: spaces and parentheses would end it early. */
function markdownLink(relative: string): string {
  return relative.replace(/[\s()]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

/** Plan before reading, run under one budget, continue an interrupted task, then write. */
async function runCloud<R extends RenderResult | ConvertResult | ExtractResult>(
  verb: Verb, request: Request<object>, settings: object, write: (result: R, signal: AbortSignal) => Promise<Written>,
): Promise<OpsEnvelope> {
  const startedAt = Date.now();
  const { input, common } = request;
  const name = input === '-' ? stdinName(request.from) : input;
  const opsOptions = toOpsOptions(verb, settings);
  // Unsupported inputs and options fail before anything is read or uploaded.
  const plan = planRoute(verb, isUrl(input) ? 'url' : familyOf(name), name, opsOptions);
  await assertDistinct(input, request.out);
  const timeout = common.timeout ?? DEFAULT_TIMEOUT_SECONDS;
  const deadline = startedAt + timeout * 1000;

  let lastTask: string | undefined;
  return await withinOperationTimeout(timeout * 1000, common.signal, async (signal) => {
    const source = await readSource(input, { ...(request.from !== undefined ? { from: request.from } : {}), signal });
    const { client, credentials } = await request.cloud();
    const call = {
      ...settings, signal,
      onProgress: (event: ProgressEvent) => { if (event.phase === 'task') lastTask = event.id; },
      ...(common.spaceId !== undefined ? { spaceId: common.spaceId } : {}),
      timeout: Math.max((deadline - Date.now()) / 1000, 0.001),
    };
    const clientInput = source.kind === 'url' ? { url: source.url } : { file: source.data, name: source.name };
    // A password-protected or multi-task run is not journaled: no secret on disk, no partial chain to continue.
    const journal = (settings as { password?: unknown }).password === undefined && plan.steps.length === 1
      ? journalKey(verb, source, opsOptions, credentials, common.spaceId) : undefined;
    const run = await submitOrResume<R>(client, verb, clientInput, call, journal, common.force === true, signal);
    const written = await write(run.result, signal);
    await run.done();
    const result = run.result as R & { format?: OpsEnvelope['format']; pages?: number | null; reusedParse?: boolean; schemaVersion?: string };
    return {
      ok: true, op: verb, input, to: opsOptions.to, tasks: result.tasks, outputs: written.outputs,
      ...(result.format !== undefined ? { format: result.format } : {}),
      pages: result.pages ?? null,
      ...(result.reusedParse !== undefined ? { reusedParse: result.reusedParse } : {}),
      ...(result.schemaVersion !== undefined ? { schemaVersion: result.schemaVersion } : {}),
      ...(written.content !== undefined ? { content: written.content } : {}),
      ...(written.contentPages ? { contentPages: written.contentPages } : {}),
      warnings: [...run.warnings, ...result.warnings],
      durationMs: Date.now() - startedAt,
    };
  }, 'If a cloud task was created, running the same command again continues it.', () => lastTask);
}

/**
 * Submit, recording the task in the journal, or continue the task an interrupted run recorded:
 * nothing is uploaded or billed again. The entry is dropped only after the outputs are written.
 */
async function submitOrResume<R>(
  client: CloudClient, verb: Verb, input: object, call: object, journal: string | undefined, force: boolean, signal: AbortSignal,
): Promise<{ result: R; warnings: string[]; done: () => Promise<void> }> {
  const run = (settings: object, internals?: CallInternals) =>
    client.run(verb, input as never, settings, internals) as Promise<R>;
  if (!journal) return { result: await run(call), warnings: [], done: async () => {} };
  const done = () => submissions.delete(journal);
  const entry = await submissions.get(journal);

  if (entry && !force) {
    if (!entry.taskId || !entry.type) {
      throw DeckOpsError.backend('An earlier run sent this request, but no task id came back.', {
        hint: 'Run again with --force to submit anew; if the earlier task was created, it may be billed separately.',
      });
    }
    try {
      const result = await run({ ...call, ...(entry.spaceId ? { spaceId: entry.spaceId } : {}) }, { resume: { type: entry.type, id: entry.taskId } });
      return { result, warnings: [`Continued cloud task ${entry.taskId} from an earlier run; nothing was uploaded or submitted again.`], done };
    } catch (error) {
      // The task failed or is gone: forget it so the next run submits anew. Network trouble keeps it.
      if (!signal.aborted && isTerminal(error)) {
        await done();
        throw DeckOpsError.backend(`The cloud task ${entry.taskId} from an earlier run cannot be continued: ${messageOf(error)}`, {
          taskId: entry.taskId, hint: 'Run the same command again to submit a new task.', cause: error,
        });
      }
      throw error;
    }
  }

  const warnings = entry
    ? [`Submitted anew with --force over an unfinished earlier request${entry.taskId ? ` (task ${entry.taskId})` : ''}; if that task was created, it may be billed separately.`]
    : [];
  let dispatched = false;
  let created = false;
  try {
    const result = await run(call, {
      onDispatch: async () => {
        dispatched = true;
        await submissions.set(journal, { status: 'submission_unknown' });
      },
      onCreated: async (ref, spaceId) => {
        created = true;
        await submissions.set(journal, { status: 'submitted', taskId: ref.id, type: ref.type, spaceId });
      },
    });
    return { result, warnings, done };
  } catch (error) {
    // The server refused the request outright (login, quota, parameters): no task exists.
    if (dispatched && !created && rejectedByServer(error)) await done();
    throw error;
  }
}

function journalKey(verb: Verb, source: NodeSource, options: OpsOptions, credentials: ResolvedCredentials, spaceId: string | undefined): string {
  const identity = createHash('sha256').update(credentials.apiKey ?? credentials.token ?? 'guest').digest('hex').slice(0, 16);
  const sorted = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)));
  return cacheKey(['submission', credentials.apiBase, identity, spaceId ?? credentials.spaceId ?? '', verb, sorted,
    source.kind === 'url' ? source.url : source.sha256]);
}

/** The verb options the route table checks; client-only settings stay out. */
function toOpsOptions(verb: Verb, settings: object): OpsOptions {
  const { imageRefs: _imageRefs, ...rest } = settings as Record<string, unknown>;
  return { ...rest, to: rest.to ?? (verb === 'convert' ? 'markdown' : rest.to) } as OpsOptions;
}

/** The output must not overwrite the source. */
async function assertDistinct(input: string, out: string | undefined): Promise<void> {
  if (out === undefined || out === '-' || input === '-' || isUrl(input)) return;
  const canonical = async (file: string): Promise<string> => await fs.realpath(file)
    .catch(() => fs.realpath(path.dirname(file)).then((parent) => path.join(parent, path.basename(file))).catch(() => path.resolve(file)));
  if (await canonical(input) === await canonical(out)) throw DeckOpsError.usage('The output path must differ from the source.');
}

async function isDirectoryTarget(out: string): Promise<boolean> {
  if (/[\\/]$/.test(out) || path.extname(out) === '') return true;
  return (await fs.stat(out).catch(() => undefined))?.isDirectory() === true;
}

/** The task itself is over: it failed, or the task or its result cannot be found. */
function isTerminal(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = (current as { cause?: unknown }).cause) {
    if ((current as { details?: { reason?: unknown } }).details?.reason === 'failed') return true;
    if (/^Task failed:|returned no task status/.test(current.message)) return true;
    const status = (current as { statusCode?: unknown }).statusCode;
    if (status === 403 || status === 404 || status === 410) return true;
  }
  return false;
}

/** The server answered 4xx: the request was refused and no task was created. 5xx may have created one. */
function rejectedByServer(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = (current as { cause?: unknown }).cause) {
    const status = (current as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) return true;
  }
  return false;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CloudParsedDocument, DeckClient, ParseOptions } from '../client/legacy.js';
import { DeckOpsError } from '../errors/index.js';
import { MAX_SOURCE_BYTES } from '../shared/constants.js';
import { parseParams } from '../shared/params.js';
import { irFormatForTaskType } from '../shared/validation.js';
import type { CommonFlags, Manifest, OutputFile, ParseEnvelope, ParseFlags, ParseType } from '../types.js';
import { VERSION } from '../version.js';
import {
  assetsDir, defaultArtifactDir, expired, IR_RETENTION_MS, irPath, isLegacyArtifact, legacyArtifactError, manifestPath,
  normalizeParseParams, parseHit, readManifest, submissionPath, viewDir, writeManifest,
} from './artifact.js';
import type { ResolvedInput } from './input.js';
import { withinOperationTimeout } from './timeout.js';

export interface ParseOpOptions {
  input: ResolvedInput; inputLabel: string; out?: string; flags: ParseFlags; common: CommonFlags;
  client: () => Promise<DeckClient>;
}

export type SourceInput = Exclude<ResolvedInput, { kind: 'artifact' }>;

/** Frozen source bytes (or URL) plus the identity the manifest records. */
export interface FrozenSource { data?: Uint8Array; url?: string; name: string; sha256: string; bytes: number }

interface Submission {
  sourceHash: string; params: Record<string, unknown>; status: 'submitted' | 'submission_unknown';
  taskId?: string; spaceId?: string; updatedAt: string;
}

export async function runParse(options: ParseOpOptions): Promise<ParseEnvelope> {
  if (options.input.kind === 'artifact') {
    throw DeckOpsError.usage(`${options.inputLabel} is already an artifact.`, { hint: 'Run deckops convert to derive a view.' });
  }
  const dir = options.out ?? defaultDirFor(options.input);
  const lockPath = path.resolve(dir) + '.lock';
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  let lock: Awaited<ReturnType<typeof fs.open>>;
  try { lock = await fs.open(lockPath, 'wx', 0o600); }
  catch (cause) {
    throw DeckOpsError.input('Artifact is already in use or its lock cannot be created.', {
      hint: `Retry when the active operation finishes. A stale lock after a crash can be inspected at ${lockPath}.`, cause,
    });
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await withinOperationTimeout(operationTimeoutMs(options.common), options.common.signal,
      (signal) => parseLocked(options, options.input as SourceInput, dir, signal),
      'If a cloud task was created, rerunning the same command resumes it.');
  } finally { await lock.close(); await fs.rm(lockPath, { force: true }); }
}

async function parseLocked(options: ParseOpOptions, input: SourceInput, dir: string, signal: AbortSignal): Promise<ParseEnvelope> {
  const startedAt = Date.now();
  const { flags, common, inputLabel } = options;
  const warnings: string[] = [];
  // A 2.x artifact is never mixed with v3 files: it stays untouched unless --force replaces it whole.
  const legacy = await isLegacyArtifact(dir);
  if (legacy && !common.force) throw legacyArtifactError(dir);
  const source = await freezeSource(input, signal);
  const type: ParseType = input.kind === 'link' ? 'html.getByURL' : input.taskType;
  const params = normalizeParseParams(parseParams(flags, input.kind === 'link'));
  // A URL is never a cache hit: its content may have changed since the last parse.
  if (!common.force && input.kind !== 'link') {
    const existing = await readManifest(dir).catch(() => undefined);
    if (existing && parseHit(dir, existing, source.sha256, params)) {
      if (!expired(existing)) return envelope(inputLabel, dir, existing, { reused: true, startedAt, outputs: await outputsOf(dir), warnings });
      warnings.push(`The cloud IR behind ${dir} expired on ${existing.parse.expiresAt}; parsing the source again.`);
    }
  }
  const journal = readSubmission(dir, source.sha256, params);
  const client = await options.client();
  const operation = {
    ...(common.spaceId ? { spaceId: common.spaceId } : {}),
    ...(common.timeout ? { timeout: common.timeout } : {}),
    signal,
  };
  let parsed: CloudParsedDocument;
  if (journal && !common.force) {
    // The previous run submitted but got no result. With a task id, wait for that task and
    // fetch its result: nothing is uploaded or billed again. Without one there is nothing to
    // look up; refuse rather than risk paying twice.
    if (!journal.taskId) {
      throw DeckOpsError.backend('A previous cloud submission may have reached the cloud, but no task id came back.', {
        hint: 'Run again with --force to resubmit; if the earlier task was created, it may be billed separately.',
      });
    }
    try {
      parsed = await client.resume(journal.taskId, type, { ...operation, ...(journal.spaceId ? { spaceId: journal.spaceId } : {}) });
    } catch (error) {
      // The task failed or is gone: forget it so the next run submits anew. Network trouble keeps it.
      if (!signal.aborted && isTerminalTaskError(error)) {
        rmSync(submissionPath(dir), { force: true });
        throw DeckOpsError.backend(`The cloud task ${journal.taskId} from an earlier run cannot be resumed: ${errorMessage(error)}`, {
          taskId: journal.taskId, hint: 'Run the same command again to submit a new task.', cause: error,
        });
      }
      throw error;
    }
    warnings.push(`Resumed cloud task ${journal.taskId} submitted by an earlier run; nothing was uploaded or submitted again.`);
  } else {
    if (journal) {
      warnings.push(`Resubmitted with --force over an unresolved cloud submission${journal.taskId ? ` (task ${journal.taskId})` : ''}; if that task was created, it may be billed separately.`);
    }
    const record = (state: Pick<Submission, 'status' | 'taskId' | 'spaceId'>): void =>
      writeSubmission(dir, { sourceHash: source.sha256, params, ...state, updatedAt: new Date().toISOString() });
    let dispatched = false;
    let taskId: string | undefined;
    try {
      parsed = await client.parse(sourceInput(input, source), {
        ...parseFlagsOnly(flags), ...operation,
        onSubmit: () => { dispatched = true; record({ status: 'submission_unknown' }); },
        onProgress: (event) => {
          if (event.phase === 'parse' && taskId === undefined) { taskId = event.taskId; record({ status: 'submitted', taskId, spaceId: event.spaceId }); }
        },
      });
    } catch (error) {
      // The server refused the task request outright (expired login, quota, bad params): no task exists.
      if (dispatched && taskId === undefined && rejectedByServer(error)) rmSync(submissionPath(dir), { force: true });
      throw error;
    }
  }
  signal.throwIfAborted();
  if (legacy) await fs.rm(dir, { recursive: true, force: true });
  const { manifest, outputs } = await persist(dir, parsed, source, params);
  rmSync(submissionPath(dir), { force: true });
  return envelope(inputLabel, dir, manifest, { reused: false, startedAt, outputs, warnings });
}

/** Read the source once and verify it did not change meanwhile; the bytes are the snapshot. */
export async function freezeSource(input: SourceInput, signal?: AbortSignal): Promise<FrozenSource> {
  if (input.kind === 'link') return { url: input.url, name: input.url, sha256: sha256(input.url), bytes: 0 };
  if (input.kind === 'stdin') {
    assertSourceSize(input.name, input.data.byteLength);
    return { data: input.data, name: input.name, sha256: sha256(input.data), bytes: input.data.byteLength };
  }
  const before = await fs.stat(input.file);
  assertSourceSize(input.name, before.size);
  const data = await fs.readFile(input.file, { signal });
  const after = await fs.stat(input.file);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || data.byteLength !== before.size) {
    throw DeckOpsError.input('Source changed while it was being read.');
  }
  return { data, name: input.name, sha256: sha256(data), bytes: data.byteLength };
}

function assertSourceSize(name: string, bytes: number): void {
  if (bytes > MAX_SOURCE_BYTES) {
    throw DeckOpsError.input(`${name} is ${(bytes / 1024 / 1024).toFixed(1)} MiB; DeckOps Cloud accepts sources up to ${MAX_SOURCE_BYTES / 1024 / 1024} MiB.`);
  }
}

export function sourceInput(input: SourceInput, source: FrozenSource): { file: Uint8Array; name: string } | { url: string } {
  return input.kind === 'link' ? { url: input.url } : { file: source.data!, name: source.name };
}

/** Only the flags the cloud client accepts; artifact and output options stay here. */
export function parseFlagsOnly(flags: ParseFlags): Pick<ParseOptions, 'profile' | 'password' | 'includeImages' | 'stayImageAreaRate' | 'mode'> {
  return {
    ...(flags.profile !== undefined ? { profile: flags.profile } : {}),
    ...(flags.password !== undefined ? { password: flags.password } : {}),
    ...(flags.includeImages !== undefined ? { includeImages: flags.includeImages } : {}),
    ...(flags.stayImageAreaRate !== undefined ? { stayImageAreaRate: flags.stayImageAreaRate } : {}),
    ...(flags.mode !== undefined ? { mode: flags.mode } : {}),
  };
}

export function operationTimeoutMs(common: CommonFlags): number {
  if (common.timeout === undefined) return 120_000;
  const value = Math.ceil(common.timeout * 1000);
  if (!Number.isFinite(common.timeout) || common.timeout <= 0 || value > 2_147_483_647) {
    throw DeckOpsError.usage('timeout must be a positive number of seconds within the Node.js timer range.');
  }
  return value;
}

async function persist(dir: string, parsed: CloudParsedDocument, source: FrozenSource, params: Record<string, unknown>): Promise<{ manifest: Manifest; outputs: OutputFile[] }> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // A fresh parse invalidates every derived view and its downloaded images.
  await fs.rm(viewDir(dir, 'markdown'), { recursive: true, force: true });
  await fs.rm(assetsDir(dir), { recursive: true, force: true });
  const irJson = `${JSON.stringify(await parsed.ir(), null, 2)}\n`;
  await fs.writeFile(irPath(dir), irJson, 'utf8');
  const createdAt = new Date();
  const manifest: Manifest = {
    manifestVersion: 3,
    source: { sha256: source.sha256, name: source.name, bytes: source.bytes },
    parse: {
      taskId: parsed.taskId, type: parsed.type, irKey: parsed.irKey, irSchemaVersion: parsed.irSchemaVersion, params,
      createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + IR_RETENTION_MS).toISOString(),
    },
    views: {}, assets: {}, producer: { deckops: VERSION },
  };
  await writeManifest(dir, manifest);
  return { manifest, outputs: await outputsOf(dir) };
}

async function outputsOf(dir: string): Promise<OutputFile[]> {
  return Promise.all([irPath(dir), manifestPath(dir)].map(async (file) => ({ file, bytes: (await fs.stat(file)).size })));
}

function readSubmission(dir: string, sourceHash: string, params: Record<string, unknown>): Submission | undefined {
  let journal: Partial<Submission>;
  try { journal = JSON.parse(readFileSync(submissionPath(dir), 'utf8')) as Partial<Submission>; }
  catch { return undefined; }
  if (journal.sourceHash !== sourceHash || JSON.stringify(journal.params) !== JSON.stringify(params)) return undefined;
  if (journal.status !== 'submitted' && journal.status !== 'submission_unknown') return undefined;
  return journal as Submission;
}

function writeSubmission(dir: string, submission: Submission): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = submissionPath(dir); const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(submission)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

function envelope(input: string, dir: string, manifest: Manifest, extra: { reused: boolean; startedAt: number; outputs: OutputFile[]; warnings: string[] }): ParseEnvelope {
  return {
    ok: true, op: 'parse', input, type: manifest.parse.type, format: irFormatForTaskType(manifest.parse.type),
    taskId: manifest.parse.taskId, irKey: manifest.parse.irKey, irSchemaVersion: manifest.parse.irSchemaVersion,
    expiresAt: manifest.parse.expiresAt, reusedParse: extra.reused, artifact: dir,
    outputs: extra.outputs, warnings: extra.warnings, durationMs: Date.now() - extra.startedAt,
  };
}

export function defaultDirFor(input: SourceInput): string {
  if (input.kind === 'document') return defaultArtifactDir(input.file);
  if (input.kind === 'stdin') return 'stdin';
  const url = new URL(input.url);
  return `${url.hostname}${url.pathname}`.replace(/[^\w.-]+/g, '-').replace(/-+$/, '') || 'page';
}

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The server answered 4xx: the request was refused and no task was created. 5xx may have created one. */
function rejectedByServer(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = (current as { cause?: unknown }).cause) {
    const status = (current as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) return true;
  }
  return false;
}

/** The task itself is over: the cloud reports it failed, or the task/result cannot be found. */
function isTerminalTaskError(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = (current as { cause?: unknown }).cause) {
    if (/^Task failed:|returned no task status/.test(current.message)) return true;
    const status = (current as { statusCode?: unknown }).statusCode;
    if (status === 403 || status === 404 || status === 410) return true;
    if (current instanceof DeckOpsError && (current.code === 'ir_not_found' || current.code === 'ir_expired')) return true;
  }
  return false;
}

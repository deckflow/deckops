import pLimit from 'p-limit';
import type { WaitForTaskOptions } from '../cloud/contracts.js';
import { fetchSignedBlob } from '../cloud/download.js';
import type { TasksApi } from '../cloud/tasks.js';
import { DeckOpsError } from '../errors/index.js';
import { extensionOf } from './plan.js';
import { filesFromTuples, remoteFile } from './results.js';
import type { OpsOptions, RemoteFile, Step, TaskRef, TaskStatus } from './types.js';

/** Frames converted at once by a per-frame step. */
const EACH_CONCURRENCY = 4;

export interface ChainEnv {
  tasks: Pick<TasksApi, 'create' | 'wait' | 'down'>;
  spaceId: string;
  signal: AbortSignal;
  /** Seconds left in the call's budget. */
  remaining(): number;
  wait: Pick<WaitForTaskOptions, 'useEventStream' | 'pollInterval'>;
  /** A task was created (`status` as created) or changed status. */
  taskEvent(ref: TaskRef, spaceId: string, status: TaskStatus): void;
  /** Upload a step's output so the next step can take it as input. */
  uploadIntermediate(blob: Blob, name: string): Promise<string>;
  /** Continue this task instead of creating the first step's task. */
  resume?: TaskRef | undefined;
  /** Before the first task's request leaves; a failure after it may have created the task. */
  onDispatch?: (() => Promise<void>) | undefined;
  /** The first task exists; awaited before waiting on it. */
  onCreated?: ((ref: TaskRef, spaceId: string) => Promise<void>) | undefined;
}

export type ChainInput = { fileId: string } | { url: string };

export interface ChainOutput {
  /** The last step's raw result. */
  raw: unknown;
  /** Files of a render, after page selection. */
  files?: RemoteFile[];
  /** Frames rendered before page selection. */
  total: number;
}

/**
 * Run a route's steps. A step's files feed the next step by download and re-upload: the task API
 * takes uploaded files, not another task's output. Page selection happens before any per-frame
 * step, so frames the caller did not ask for are never converted again.
 */
export async function runChain(
  steps: readonly Step[], input: ChainInput, options: OpsOptions, warnings: string[], env: ChainEnv,
): Promise<ChainOutput> {
  if (env.resume && steps.length !== 1) {
    throw DeckOpsError.usage('Only a single-task operation can be resumed by task id.');
  }
  let raw: unknown;
  let files: RemoteFile[] | undefined;
  let total = 0;
  for (const [index, step] of steps.entries()) {
    if (step.each) {
      if (!files) throw DeckOpsError.backend(`${step.type} has no frames to convert.`);
      const limit = pLimit(EACH_CONCURRENCY);
      files = await Promise.all(files.map((frame) => limit(async () => {
        const fileId = await carry(frame, env);
        const [converted] = filesFromTuples(await runStep(step, { fileId }, options, warnings, env), step.type);
        const extension = extensionOf(converted!.path);
        return remoteFile({
          url: converted!.url, bytes: converted!.bytes, hash: converted!.hash,
          path: `${String(frame.page).padStart(3, '0')}${extension}`,
          ...(converted!.mediaType ? { mediaType: converted!.mediaType } : {}),
          ...(frame.page !== undefined ? { page: frame.page } : {}),
          ...(frame.width !== undefined ? { width: frame.width } : {}),
          ...(frame.height !== undefined ? { height: frame.height } : {}),
        });
      })));
      continue;
    }
    const stepInput = index === 0 ? input : { fileId: await carry(files![0]!, env) };
    raw = await runStep(step, stepInput, options, warnings, env, index === 0 ? env.resume : undefined, index === 0);
    if (step.result !== 'files') continue;
    files = filesFromTuples(raw, step.type);
    const next = steps[index + 1];
    if (next === undefined || next.each) {
      total = files.length;
      if (options.pages) files = selectPages(files, options.pages);
    }
  }
  return { raw, ...(files ? { files } : {}), total };
}

async function runStep(
  step: Step, input: ChainInput, options: OpsOptions, warnings: string[], env: ChainEnv, resume?: TaskRef, first = false,
): Promise<unknown> {
  let ref: TaskRef;
  let spaceId = env.spaceId;
  if (resume) {
    ref = resume;
  } else {
    const params = step.params(options, 'url' in input ? { url: input.url } : {}, warnings);
    const created = await env.tasks.create({
      type: step.type, spaceId, params, signal: env.signal,
      ...('fileId' in input ? { fileIds: [input.fileId] } : {}),
      ...(first && env.onDispatch ? { onDispatch: env.onDispatch } : {}),
    });
    ref = { type: step.type, id: created.id };
    spaceId = created.spaceId || spaceId;
    env.taskEvent(ref, spaceId, created.status);
    if (first) await env.onCreated?.(ref, spaceId);
  }
  await env.tasks.wait(ref.id, {
    ...env.wait, spaceId, signal: env.signal, timeout: Math.max(env.remaining(), 0.001),
    onProgress: (task) => env.taskEvent(ref, spaceId, task.status),
  });
  return await env.tasks.down(ref.id, { spaceId, signal: env.signal });
}

/** Hand one output to the next step. */
async function carry(file: RemoteFile, env: ChainEnv): Promise<string> {
  const blob = await fetchSignedBlob(file.url, env.signal);
  return await env.uploadIntermediate(blob, `step-${file.path}`);
}

/** Keep the selected pages; a page beyond the rendered count is an error, not a silent drop. */
function selectPages(files: RemoteFile[], pages: readonly number[]): RemoteFile[] {
  const missing = pages.filter((page) => page > files.length);
  if (missing.length) {
    throw DeckOpsError.usage(
      `Requested page${missing.length > 1 ? 's' : ''} ${missing.join(', ')} but the document rendered ${files.length} page${files.length === 1 ? '' : 's'}.`,
    );
  }
  const wanted = new Set(pages);
  return files.filter((file) => file.page !== undefined && wanted.has(file.page));
}

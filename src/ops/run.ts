import { supportsTask, type Capabilities } from '../cloud/capabilities.js';
import { fetchSignedJson, fetchSignedText } from '../cloud/download.js';
import { DeckOpsError } from '../errors/index.js';
import { runChain, type ChainEnv, type ChainInput } from './chain.js';
import { planRoute } from './plan.js';
import { assetFiles, deliveredFile, documentDelivery, rewriteImageRefs } from './results.js';
import type {
  ConvertResult, ExtractResult, InputFamily, OpsOptions, ProgressEvent, RenderResult, Requirement, Step, TaskRef, Verb,
} from './types.js';

/** What one call works on: an uploadable file or a URL. */
export interface OpsSource {
  family: InputFamily | undefined;
  /** File name or URL, for messages and format detection. */
  name: string;
  url?: string;
}

export interface OpsEnv extends Omit<ChainEnv, 'taskEvent'> {
  apiRoot: string;
  capabilities(signal: AbortSignal): Promise<Capabilities>;
  /** Upload the call's source file; reports upload progress. */
  upload(): Promise<string>;
  emit(event: ProgressEvent): void;
  /** Rewrite Markdown image links to signed URLs (`url`) or keep the relative paths (`path`). */
  imageRefs: 'url' | 'path';
  /** Every task this call created, in order. */
  created: TaskRef[];
}

export type OpsResultFor<V extends Verb> = V extends 'render' ? RenderResult : V extends 'convert' ? ConvertResult : ExtractResult;

/** One render / convert / extract call: plan, gate, upload, run the chain, normalize. */
export async function runOps<V extends Verb>(verb: V, source: OpsSource, options: OpsOptions, env: OpsEnv): Promise<OpsResultFor<V>> {
  const plan = planRoute(verb, source.family, source.name, options);
  const warnings = [...plan.warnings];
  if (plan.route.requires) await requireCapability(plan.route.requires, source, env);

  // A resumed call continues an existing task, so its source is neither uploaded nor sent again.
  const input: ChainInput = env.resume ? { fileId: '' }
    : source.url === undefined ? { fileId: await env.upload() } : { url: source.url };
  const statuses = new Map<string, string>();
  const output = await runChain(plan.steps, input, options, warnings, {
    ...env,
    taskEvent: (ref, spaceId, status) => {
      if (!statuses.has(ref.id)) env.created.push(ref);
      if (statuses.get(ref.id) === status) return;
      statuses.set(ref.id, status);
      env.emit({ phase: 'task', type: ref.type, id: ref.id, spaceId, status });
    },
  });
  const last = plan.steps[plan.steps.length - 1]!;
  return await (last.result === 'files'
    ? renderResult(options, output.files ?? [], output.total, warnings, env)
    : documentResult(last, output.raw, warnings, env)) as OpsResultFor<V>;
}

function renderResult(
  options: OpsOptions, files: RenderResult['outputs'], total: number, warnings: string[], env: OpsEnv,
): RenderResult {
  return { to: options.to as RenderResult['to'], pages: total, tasks: env.created, outputs: files, warnings };
}

async function documentResult(step: Step, raw: unknown, warnings: string[], env: OpsEnv): Promise<ConvertResult | ExtractResult> {
  const { body, ...delivery } = documentDelivery(raw, step.type);
  const shared = { ...delivery, warnings: [...warnings, ...delivery.warnings], tasks: env.created };
  if (step.result === 'assets') {
    const assets = assetFiles(body.assets);
    return { ...shared, to: 'assets', assets, outputs: assets };
  }

  env.emit({ phase: 'download', progress: 0 });
  if (step.result === 'markdown') {
    const images = assetFiles(body.images);
    const markdown = deliveredFile(body, 'markdownURL', 'document.md', step.type);
    const content = await fetchSignedText(markdown.url, env.signal);
    const pages = typeof body.markdownPagesURL === 'string' ? await fetchSignedJson(body.markdownPagesURL, env.signal) : undefined;
    if (pages !== undefined && !(Array.isArray(pages) && pages.every((page) => typeof page === 'string'))) {
      throw DeckOpsError.backend(`${step.type} returned per-page Markdown that is not a list of strings.`);
    }
    env.emit({ phase: 'download', progress: 1 });
    const links = (text: string): string => env.imageRefs === 'url' ? rewriteImageRefs(text, images) : text;
    return {
      ...shared, to: 'markdown', content: links(content),
      ...(pages ? { contentPages: (pages as string[]).map(links) } : {}),
      images, outputs: [markdown, ...images],
    };
  }

  const assets = assetFiles(body.assets);
  const document = deliveredFile(body, 'documentURL', 'document.json', step.type);
  const content = await fetchSignedJson(document.url, env.signal);
  env.emit({ phase: 'download', progress: 1 });
  return {
    ...shared, to: 'json', content,
    schemaVersion: typeof body.schemaVersion === 'string' ? body.schemaVersion : '',
    assets, outputs: [document, ...assets],
  };
}

/** The version gate: a route that needs a newer server fails before anything is uploaded. */
async function requireCapability(requirement: Requirement, source: OpsSource, env: OpsEnv): Promise<void> {
  const capabilities = await env.capabilities(env.signal);
  if (supportsTask(capabilities, requirement.task, requirement.to)) return;
  if (requirement.task.startsWith('document.')) {
    throw DeckOpsError.unsupported(
      `The DeckOps Cloud at ${env.apiRoot} does not offer ${requirement.task}${requirement.to ? ` to ${requirement.to}` : ''}.`,
      { hint: 'DeckOps 4 needs a server with document tasks. Upgrade the server, or keep DeckOps 3 for this one.' },
    );
  }
  throw DeckOpsError.unsupported(
    `The DeckOps Cloud at ${env.apiRoot} cannot run ${requirement.task} for ${source.family === 'url' ? 'a URL' : source.name} yet.`,
    source.family === 'url' ? { hint: 'Save the page as .html and render the file.' } : {},
  );
}

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ConvertResult, DeckClient } from '../client/index.js';
import { DeckOpsError } from '../errors/index.js';
import { irFormatForTaskType } from '../shared/validation.js';
import type { CommonFlags, ConvertEnvelope, ConvertFlags, Manifest, OutputFile, ParseFlags } from '../types.js';
import { assetsDir, expired, viewDir, viewHit, writeManifest } from './artifact.js';
import type { ResolvedInput } from './input.js';
import { localizeImages, rewriteLinks, type LocalizedAssets } from './localize.js';
import { freezeSource, operationTimeoutMs, parseFlagsOnly, sourceInput, type SourceInput } from './parse-op.js';
import { withinOperationTimeout } from './timeout.js';

export interface ConvertOpOptions {
  input: ResolvedInput; inputLabel: string; out?: string; flags: ConvertFlags; parseFlags?: ParseFlags; common: CommonFlags;
  client: () => Promise<DeckClient>;
}

export async function runConvert(options: ConvertOpOptions): Promise<ConvertEnvelope> {
  if ((options.flags.to ?? 'markdown') !== 'markdown') throw DeckOpsError.unsupported(`--to ${String(options.flags.to)} is not supported yet.`);
  let content: string | undefined;
  const work: ConvertWork = { ...options, onContent: (value) => { content = value; } };
  const result = options.input.kind === 'artifact'
    ? await convertArtifact(work, options.input.dir, options.input.manifest)
    : await convertOneShot(work, options.input);
  return { ...result, ...(content !== undefined ? { content } : {}) };
}

interface ConvertWork extends ConvertOpOptions { onContent: (markdown: string) => void }

/** Artifact → irKey → parse.convert → images localized into assets/ → views/markdown/. */
async function convertArtifact(options: ConvertWork, dir: string, manifest: Manifest): Promise<ConvertEnvelope> {
  const startedAt = Date.now();
  const { flags, common } = options;
  const viewParams = viewParamsFor(flags);
  const view = manifest.views.markdown;
  const format = irFormatForTaskType(manifest.parse.type);
  if (!options.out && !common.force && viewHit(dir, view, viewParams)) {
    const outputs = await Promise.all(view!.files.map(async (file) => ({ file: path.join(dir, file), bytes: (await fs.stat(path.join(dir, file))).size })));
    return envelope(options, { startedAt, format, taskId: null, parseTaskId: manifest.parse.taskId, reusedParse: true, outputs, warnings: [] });
  }
  if (expired(manifest)) {
    throw new DeckOpsError('ir_expired', `The cloud IR behind ${dir} has expired.`, { hint: `Re-run \`deckops parse ${manifest.source.name} --force\`.` });
  }
  const client = await options.client();
  const result = await withinOperationTimeout(operationTimeoutMs(common), common.signal,
    (signal) => callConvert(client, { irKey: manifest.parse.irKey }, flags, common, signal));
  const localized = await localizeImages({
    images: result.images, destDir: assetsDir(dir), linkPrefix: '../../assets/',
    ...(flags.keepRemoteImages !== undefined ? { keepRemote: flags.keepRemoteImages } : {}),
  });
  const outputs: OutputFile[] = Object.values(localized.saved).map((asset) => ({ file: path.join(assetsDir(dir), asset.file), bytes: asset.bytes }));
  const target = viewDir(dir, 'markdown');
  await fs.rm(target, { recursive: true, force: true }); await fs.mkdir(target, { recursive: true });
  const files: string[] = [];
  const write = async (name: string, text: string): Promise<void> => {
    const body = rewriteLinks(text, localized.rewrites); const file = path.join(target, name);
    await fs.writeFile(file, body, 'utf-8'); files.push(path.join('views', 'markdown', name)); outputs.push({ file, bytes: Buffer.byteLength(body) });
  };
  await write('index.md', result.markdown);
  if (flags.splitPages && result.markdownPages) {
    for (const [index, page] of result.markdownPages.entries()) await write(`${String(index + 1).padStart(3, '0')}.md`, page);
  }
  manifest.views.markdown = { taskId: result.taskId, schemaVersion: result.schemaVersion, params: viewParams, files, createdAt: new Date().toISOString() };
  for (const [file, asset] of Object.entries(localized.saved)) {
    manifest.assets[`assets/${file}`] = { key: asset.key, hash: asset.hash, bytes: asset.bytes, ...(asset.mediaType ? { mediaType: asset.mediaType } : {}) };
  }
  await writeManifest(dir, manifest);
  const warnings = [...localized.warnings];
  if (options.out) {
    const portable = await writePortable(options.out, result, flags, options);
    outputs.push(...portable.outputs); warnings.push(...portable.warnings);
  }
  return envelope(options, { startedAt, format, taskId: result.taskId, parseTaskId: manifest.parse.taskId, reusedParse: true, outputs, warnings });
}

/** Document → parse → convert → portable Markdown; no artifact is left behind. */
async function convertOneShot(options: ConvertWork, input: SourceInput): Promise<ConvertEnvelope> {
  const startedAt = Date.now();
  const { flags, common } = options;
  const client = await options.client();
  const { parsed, result } = await withinOperationTimeout(operationTimeoutMs(common), common.signal, async (signal) => {
    const source = await freezeSource(input, signal);
    const parsed = await client.parse(sourceInput(input, source), {
      ...parseFlagsOnly(options.parseFlags ?? {}),
      ...(common.spaceId ? { spaceId: common.spaceId } : {}), ...(common.timeout ? { timeout: common.timeout } : {}), signal,
    });
    const result = await callConvert(client, { irKey: parsed.irKey }, flags, { ...common, ...(parsed.spaceId ? { spaceId: parsed.spaceId } : {}) }, signal);
    return { parsed, result };
  }, 'A one-shot convert leaves no artifact to resume; `deckops parse` records the task for reruns.');
  const portable = await writePortable(options.out ?? defaultPortableName(input, options.inputLabel), result, flags, options);
  return envelope(options, { startedAt, format: result.format, taskId: result.taskId, parseTaskId: parsed.taskId, reusedParse: false,
    outputs: portable.outputs, warnings: portable.warnings });
}

async function callConvert(client: DeckClient, ref: { irKey: string }, flags: ConvertFlags, common: CommonFlags, signal: AbortSignal): Promise<ConvertResult> {
  return client.convert(ref, {
    to: 'markdown',
    ...(flags.anchors !== undefined ? { anchors: flags.anchors } : {}),
    ...(flags.splitPages !== undefined ? { splitPages: flags.splitPages } : {}),
    ...(flags.strict !== undefined ? { strict: flags.strict } : {}),
    ...(common.spaceId ? { spaceId: common.spaceId } : {}),
    ...(common.timeout ? { timeout: common.timeout } : {}),
    signal,
  });
}

/** `-o FILE` writes FILE.md plus FILE.assets/; `-o -` localizes into the cache and hands back the text. */
async function writePortable(target: string, result: ConvertResult, flags: ConvertFlags, options: { onContent: (markdown: string) => void }): Promise<{ outputs: OutputFile[]; warnings: string[] }> {
  const keep = flags.keepRemoteImages !== undefined ? { keepRemote: flags.keepRemoteImages } : {};
  if (target === '-') {
    const dir = await stdoutAssetDir();
    const localized = await localizeImages({ images: result.images, destDir: dir, linkPrefix: `${dir}/`, ...keep });
    options.onContent(rewriteLinks(result.markdown, localized.rewrites));
    return { outputs: assetOutputs(dir, localized), warnings: localized.warnings };
  }
  const base = target.endsWith('.md') ? target.slice(0, -3) : target;
  const mdPath = `${base}.md`; const assetsName = `${path.basename(base)}.assets`;
  const assetDir = path.join(path.dirname(mdPath), assetsName);
  const localized = await localizeImages({ images: result.images, destDir: assetDir, linkPrefix: `${assetsName}/`, ...keep });
  await fs.mkdir(path.dirname(path.resolve(mdPath)), { recursive: true });
  const body = rewriteLinks(result.markdown, localized.rewrites);
  await fs.writeFile(mdPath, body, 'utf-8');
  return { outputs: [{ file: mdPath, bytes: Buffer.byteLength(body) }, ...assetOutputs(assetDir, localized)], warnings: localized.warnings };
}

function assetOutputs(dir: string, localized: LocalizedAssets): OutputFile[] {
  return Object.values(localized.saved).map((asset) => ({ file: path.join(dir, asset.file), bytes: asset.bytes }));
}

async function stdoutAssetDir(): Promise<string> {
  const root = path.resolve(process.env.DECKOPS_CACHE_DIR ?? path.join(os.homedir(), '.cache', 'deckops'), 'exports');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  return fs.mkdtemp(path.join(root, 'assets-'));
}

function viewParamsFor(flags: ConvertFlags): Record<string, unknown> {
  return {
    ...(flags.anchors !== undefined ? { anchors: flags.anchors } : {}),
    ...(flags.splitPages !== undefined ? { splitPages: flags.splitPages } : {}),
    ...(flags.strict !== undefined ? { strict: flags.strict } : {}),
    ...(flags.keepRemoteImages !== undefined ? { keepRemoteImages: flags.keepRemoteImages } : {}),
  };
}

function defaultPortableName(input: SourceInput, label: string): string {
  if (input.kind === 'document') { const ext = path.extname(input.file); return input.file.slice(0, -ext.length); }
  if (input.kind === 'stdin') return 'stdin';
  try { return new URL(input.url).hostname.replace(/[^\w.-]+/g, '-') || 'page'; } catch { return label; }
}

function envelope(options: ConvertWork, extra: Omit<ConvertEnvelope, 'ok' | 'op' | 'input' | 'to' | 'durationMs' | 'content'> & { startedAt: number }): ConvertEnvelope {
  const { startedAt, ...rest } = extra;
  return { ok: true, op: 'convert', input: options.inputLabel, to: 'markdown', ...rest, durationMs: Date.now() - startedAt };
}

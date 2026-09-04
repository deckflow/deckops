import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ConvertResult, IrFormat } from '@deckops/sdk';
import { localizeImages, rewriteLinks } from '../assets/localize.js';
import { assetsDir, irPath, viewDir } from '../artifact/layout.js';
import { locallyExpired, viewHit, writeManifest } from '../artifact/manifest.js';
import type { CloudClient } from '../cloud/client.js';
import { routeParse } from '../engine/router.js';
import { DeckParseError } from '../errors/index.js';
import { candidateAssetOutputPath } from '../ir/assets.js';
import type { DeckIR, ParseCandidate } from '../ir/schema.js';
import { validateDeckIR } from '../ir/validate.js';
import type { SourceIdentity } from '../local/common.js';
import type { PreflightMode } from '../shared/preflight.js';
import { convertParams } from '../shared/params.js';
import type { CommonFlags, ConvertEnvelope, ConvertFlags, Manifest, ManifestV2, OutputFile, ParseFlags } from '../types.js';
import { MARKDOWN_RENDERER_VERSION, renderMarkdown } from '../views/markdown.js';
import type { NodeDocumentInspector } from './inspector.js';
import type { ResolvedInput } from './input.js';
import { runSourcePreflight } from './parse-op.js';

export interface ConvertOpOptions {
  input: ResolvedInput; inputLabel: string; out?: string; flags: ConvertFlags; parseFlags?: ParseFlags; common: CommonFlags;
  client?: CloudClient; cloud?: () => Promise<CloudClient>; preflight?: PreflightMode; inspector?: NodeDocumentInspector;
}

export async function runConvert(options: ConvertOpOptions): Promise<ConvertEnvelope> {
  if ((options.flags.to ?? 'markdown') !== 'markdown') throw DeckParseError.unsupported(`--to ${String(options.flags.to)} is not supported yet.`);
  if (options.input.kind === 'artifact') {
    if (options.preflight && options.preflight !== 'off') throw DeckParseError.usage('Preflight applies to source documents, not an existing artifact.');
    return convertArtifact(options, options.input.dir, options.input.manifest);
  }
  return convertOneShot(options);
}

async function convertArtifact(options: ConvertOpOptions, dir: string, manifest: Manifest): Promise<ConvertEnvelope> {
  const startedAt = Date.now();
  const useCloud = manifest.manifestVersion === 1 || options.common.engine === 'cloud';
  if (manifest.manifestVersion === 1 && options.common.engine === 'local') {
    throw DeckParseError.unsupported('Manifest v1 contains cloud-native IR, not deckir.v1.', { hint: 'Convert it with --engine cloud or parse the source again to create artifact v2.' });
  }
  const viewParams = { ...viewParamsFor(options.flags), rendererEngine: useCloud ? 'cloud' : 'local' };
  const view = manifest.views.markdown;
  if (!options.common.force && viewHit(dir, view, viewParams)) {
    return envelope(options, { startedAt, engine: 'artifact-cache', format: formatOf(manifest), taskId: null, reusedParse: true,
      outputs: view!.files.map((file) => ({ file: path.join(dir, file), bytes: 0 })), warnings: [], ...(manifest.manifestVersion === 2 ? { quality: manifest.quality } : {}) });
  }
  if (useCloud) return convertArtifactCloud(options, dir, manifest, viewParams, startedAt);
  return convertArtifactLocal(options, dir, manifest as ManifestV2, viewParams, startedAt);
}

async function convertArtifactLocal(options: ConvertOpOptions, dir: string, manifest: ManifestV2, viewParams: Record<string, unknown>, startedAt: number): Promise<ConvertEnvelope> {
  const ir = validateDeckIR(JSON.parse(await fs.readFile(irPath(dir), 'utf-8')));
  if (options.common.failOnDegraded && ir.quality.status === 'degraded') throw DeckParseError.input('Artifact quality is degraded.', ir.quality.checks[0]?.message ? { hint: ir.quality.checks[0].message } : {});
  const rendered = renderMarkdown(ir, { anchors: options.flags.anchors, splitPages: options.flags.splitPages, assetPrefix: '../../assets/' });
  const outputs = await writeArtifactMarkdown(dir, rendered.markdown, rendered.pages);
  manifest.views.markdown = { engine: 'local', rendererVersion: MARKDOWN_RENDERER_VERSION, params: viewParams,
    files: outputs.map((output) => path.relative(dir, output.file)), createdAt: new Date().toISOString() };
  await writeManifest(dir, manifest);
  if (options.out) outputs.push(...await writePortableLocal(options.out, ir, dir, options.flags));
  return envelope(options, { startedAt, engine: 'local', format: ir.format as IrFormat, taskId: null, reusedParse: true,
    outputs, warnings: rendered.warnings, quality: ir.quality });
}

async function convertArtifactCloud(options: ConvertOpOptions, dir: string, manifest: Manifest, viewParams: Record<string, unknown>, startedAt: number): Promise<ConvertEnvelope> {
  const remote = manifest.manifestVersion === 1 ? { irKey: manifest.parse.irKey } : manifest.parse.remote;
  if (!remote) throw DeckParseError.usage('This local artifact has no cloud IR reference.', { hint: 'Re-run parse with --engine cloud; convert never uploads or re-parses an artifact.' });
  if (locallyExpired(manifest)) throw new DeckParseError('ir_expired', `The cloud IR behind ${dir} has expired.`, { hint: `Re-run parse for ${manifest.source.name} with --engine cloud --force.` });
  const client = await requireCloud(options);
  const result = await callConvert(client, { irKey: remote.irKey }, options.flags, options.common);
  const materialized = await materializeCloud(dir, result, options.flags);
  if (manifest.manifestVersion === 2) manifest.views.markdown = { engine: 'cloud', rendererVersion: result.schemaVersion,
    taskId: result.taskId, params: viewParams, files: materialized.files, createdAt: new Date().toISOString() };
  else manifest.views.markdown = { taskId: result.taskId, params: viewParams, files: materialized.files, createdAt: new Date().toISOString() };
  for (const [file, asset] of Object.entries(materialized.savedAssets)) {
    const relative = `assets/${file}`;
    const hash = manifest.manifestVersion === 2 ? createHash('sha256').update(await fs.readFile(path.join(dir, relative))).digest('hex') : asset.hash;
    manifest.assets[relative] = { key: asset.key, hash, bytes: asset.bytes };
  }
  await writeManifest(dir, manifest);
  if (options.out) { const portable = await writePortableCloud(options.out, result, options.flags); materialized.outputs.push(...portable.outputs); materialized.warnings.push(...portable.warnings); }
  return envelope(options, { startedAt, engine: 'cloud', format: result.format, taskId: result.taskId, reusedParse: true,
    outputs: materialized.outputs, warnings: materialized.warnings, ...(manifest.manifestVersion === 2 ? { quality: manifest.quality } : {}) });
}

async function convertOneShot(options: ConvertOpOptions): Promise<ConvertEnvelope> {
  const startedAt = Date.now(); const input = options.input;
  if (input.kind === 'artifact') throw new Error('unreachable');
  const inspected = await runSourcePreflight({ input, flags: options.parseFlags ?? {}, ...(options.preflight ? { mode: options.preflight } : {}), ...(options.inspector ? { inspector: options.inspector } : {}) });
  const source = await sourceIdentity(input);
  const cloud = cloudFactory(options);
  const candidate = await routeParse({ input: { input, inputLabel: options.inputLabel, source },
    parse: { flags: options.parseFlags ?? {}, common: options.common }, ...(cloud ? { cloud } : {}),
    signal: AbortSignal.timeout((options.common.timeout ?? 120) * 1000) });
  if (options.common.engine === 'cloud' && candidate.remote) {
    const result = await callConvert(await requireCloud(options), { irKey: candidate.remote.irKey }, options.flags, options.common);
    const target = options.out ?? defaultPortableName(input, options.inputLabel);
    const portable = await writePortableCloud(target, result, options.flags);
    return { ok: true, op: 'convert', input: options.inputLabel, to: 'markdown', engine: 'cloud', format: result.format,
      taskId: result.taskId, parseTaskId: candidate.remote.taskId, ...(inspected.summary ? { inspection: inspected.summary } : {}),
      reusedParse: false, quality: candidate.quality, outputs: portable.outputs, warnings: [...inspected.warnings, ...(candidate.warnings ?? []), ...portable.warnings], durationMs: Date.now() - startedAt };
  }
  const target = options.out ?? defaultPortableName(input, options.inputLabel);
  const tempDir = await fs.mkdtemp(path.join(process.cwd(), '.deckparse-assets-'));
  try {
    await writeCandidateAssets(tempDir, candidate);
    const outputs = await writePortableLocal(target, candidate.ir, tempDir, options.flags);
    return { ok: true, op: 'convert', input: options.inputLabel, to: 'markdown', engine: 'local', format: candidate.ir.format as IrFormat,
      taskId: null, ...(candidate.remote ? { parseTaskId: candidate.remote.taskId } : {}), ...(inspected.summary ? { inspection: inspected.summary } : {}),
      reusedParse: false, quality: candidate.quality, outputs, warnings: [...inspected.warnings, ...(candidate.warnings ?? [])], durationMs: Date.now() - startedAt };
  } finally { await fs.rm(tempDir, { recursive: true, force: true }); }
}

async function writeArtifactMarkdown(dir: string, markdown: string, pages?: string[]): Promise<OutputFile[]> {
  const target = viewDir(dir, 'markdown'); await fs.mkdir(target, { recursive: true }); const outputs: OutputFile[] = [];
  const write = async (name: string, body: string): Promise<void> => { const file = path.join(target, name); await fs.writeFile(file, body, 'utf-8'); outputs.push({ file, bytes: Buffer.byteLength(body) }); };
  await write('index.md', markdown); if (pages) for (const [index, page] of pages.entries()) await write(`${String(index + 1).padStart(3, '0')}.md`, page);
  return outputs;
}

async function writePortableLocal(target: string, ir: DeckIR, artifactDir: string, flags: ConvertFlags): Promise<OutputFile[]> {
  if (target === '-') { process.stdout.write(renderMarkdown(ir, { anchors: flags.anchors }).markdown); return []; }
  const base = target.endsWith('.md') ? target.slice(0, -3) : target; const mdPath = `${base}.md`; const assetsName = `${path.basename(base)}.assets`;
  const rendered = renderMarkdown(ir, { anchors: flags.anchors, assetPrefix: `${assetsName}/` });
  await fs.mkdir(path.dirname(path.resolve(mdPath)), { recursive: true }); await fs.writeFile(mdPath, rendered.markdown, 'utf-8');
  const outputs: OutputFile[] = [{ file: mdPath, bytes: Buffer.byteLength(rendered.markdown) }];
  for (const asset of ir.document.assets) {
    const from = path.join(artifactDir, asset.path); const to = path.join(path.dirname(mdPath), assetsName, path.basename(asset.path));
    try { await fs.mkdir(path.dirname(to), { recursive: true }); await fs.copyFile(from, to); outputs.push({ file: to, bytes: asset.bytes }); } catch { /* missing assets remain visible as broken links and quality warnings */ }
  }
  return outputs;
}

async function writeCandidateAssets(dir: string, candidate: ParseCandidate): Promise<void> {
  for (const asset of candidate.assets) { const target = path.join(dir, candidateAssetOutputPath(asset)); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, asset.data); }
}

async function callConvert(client: CloudClient, ref: { irKey: string }, flags: ConvertFlags, common: CommonFlags): Promise<ConvertResult> {
  const result = await client.convert(ref, { to: 'markdown', ...convertParams(flags), ...(common.spaceId ? { spaceId: common.spaceId } : {}), ...(common.timeout ? { wait: { timeout: common.timeout } } : {}) });
  if (result.markdownError) throw DeckParseError.backend(`Markdown rendering failed: ${result.markdownError}`, { taskId: result.taskId });
  return result;
}

async function materializeCloud(dir: string, result: ConvertResult, flags: ConvertFlags) {
  const localized = await localizeImages({ images: result.images, destDir: assetsDir(dir), linkPrefix: '../../assets/', ...(flags.keepRemoteImages !== undefined ? { keepRemote: flags.keepRemoteImages } : {}) });
  const outputs: OutputFile[] = Object.values(localized.saved).map((asset) => ({ file: path.join(dir, 'assets', asset.file), bytes: asset.bytes }));
  const target = viewDir(dir, 'markdown'); await fs.mkdir(target, { recursive: true }); const files: string[] = [];
  const write = async (name: string, text: string) => { const body = rewriteLinks(text, localized.rewrites); const file = path.join(target, name); await fs.writeFile(file, body, 'utf-8'); files.push(path.join('views', 'markdown', name)); outputs.push({ file, bytes: Buffer.byteLength(body) }); };
  await write('index.md', result.markdown); if (flags.splitPages && result.markdownPages) for (const [index, page] of result.markdownPages.entries()) await write(`${String(index + 1).padStart(3, '0')}.md`, page);
  return { outputs, warnings: localized.warnings, files, savedAssets: localized.saved };
}

async function writePortableCloud(target: string, result: ConvertResult, flags: ConvertFlags): Promise<{ outputs: OutputFile[]; warnings: string[] }> {
  if (target === '-') { process.stdout.write(result.markdown); return { outputs: [], warnings: ['stdout keeps remote image links; they expire in hours.'] }; }
  const base = target.endsWith('.md') ? target.slice(0, -3) : target; const mdPath = `${base}.md`; const assetsName = `${path.basename(base)}.assets`;
  const localized = await localizeImages({ images: result.images, destDir: path.join(path.dirname(mdPath), assetsName), linkPrefix: `${assetsName}/`, ...(flags.keepRemoteImages !== undefined ? { keepRemote: flags.keepRemoteImages } : {}) });
  await fs.mkdir(path.dirname(path.resolve(mdPath)), { recursive: true }); const body = rewriteLinks(result.markdown, localized.rewrites); await fs.writeFile(mdPath, body, 'utf-8');
  return { outputs: [{ file: mdPath, bytes: Buffer.byteLength(body) }, ...Object.values(localized.saved).map((asset) => ({ file: path.join(path.dirname(mdPath), assetsName, asset.file), bytes: asset.bytes }))], warnings: localized.warnings };
}

function viewParamsFor(flags: ConvertFlags): Record<string, unknown> { return { ...(flags.anchors !== undefined ? { anchors: flags.anchors } : {}), ...(flags.splitPages !== undefined ? { splitPages: flags.splitPages } : {}) }; }
function formatOf(manifest: Manifest): IrFormat { if (manifest.manifestVersion === 2) return manifest.parse.format as IrFormat; return manifest.parse.type === 'pdf.pdfParse' ? 'pdf' : manifest.parse.type === 'pptx.parse' ? 'pptx' : manifest.parse.type === 'docx.parseTextAndImage' ? 'docx' : manifest.parse.type === 'keynote.parseTextAndImage' ? 'keynote' : 'html'; }
function defaultPortableName(input: Exclude<ResolvedInput, { kind: 'artifact' }>, label: string): string { if (input.kind === 'document') { const ext = path.extname(input.file); return input.file.slice(0, -ext.length); } if (input.kind === 'stdin') return 'stdin'; try { return new URL(input.url).hostname.replace(/[^\w.-]+/g, '-') || 'page'; } catch { return label; } }
async function sourceIdentity(input: Exclude<ResolvedInput, { kind: 'artifact' }>): Promise<SourceIdentity> { if (input.kind === 'link') return { sha256: createHash('sha256').update(input.url).digest('hex'), name: input.url, bytes: 0 }; const bytes = input.kind === 'document' ? await fs.readFile(input.file) : input.data; return { sha256: createHash('sha256').update(bytes).digest('hex'), name: input.name, bytes: bytes.byteLength }; }
function cloudFactory(options: ConvertOpOptions): (() => Promise<CloudClient>) | undefined { return options.cloud ?? (options.client ? async () => options.client! : undefined); }
async function requireCloud(options: ConvertOpOptions): Promise<CloudClient> { const factory = cloudFactory(options); if (!factory) throw DeckParseError.usage('Cloud conversion was requested but no cloud client is configured.'); return factory(); }
function envelope(options: ConvertOpOptions, extra: { startedAt: number; engine: ConvertEnvelope['engine']; format: IrFormat; taskId: string | null; reusedParse: boolean; outputs: OutputFile[]; warnings: string[]; quality?: import('../ir/schema.js').QualityReport }): ConvertEnvelope { return { ok: true, op: 'convert', input: options.inputLabel, to: 'markdown', engine: extra.engine, format: extra.format, taskId: extra.taskId, reusedParse: extra.reusedParse, ...(extra.quality ? { quality: extra.quality } : {}), outputs: extra.outputs, warnings: extra.warnings, durationMs: Date.now() - extra.startedAt }; }

import { readProductConfig } from '../../config/product.js';
import { DeckOpsError } from '../../errors/index.js';
import { cloudClient } from '../../node/cloud.js';
import { runConvert, runExtract, runProbe, runRender, type CloudAccess } from '../../node/ops.js';
import type { ConvertOptions, ExtractOptions, ParseOptions, RenderOptions } from '../../ops/types.js';
import type { ProbeOptions } from '../../ops/probe.js';
import { translateError } from '../../shared/errors.js';
import type { CommonFlags } from '../../types.js';
import { printEnvelope, printError, printProbe, type OutputContext } from '../output.js';

/**
 * Shared command driver for the verbs: map flags, run, render, exit. Exit codes come from the
 * error code table — the process exits non-zero on any failure.
 */

export interface RawCliOptions {
  output?: string;
  from?: string;
  space?: string;
  timeout?: string;
  force?: boolean;
  apiKey?: string;
  token?: string;
  apiBase?: string;
  json?: boolean;
  quiet?: boolean;
  to?: string;
  // render
  pages?: string;
  quality?: string;
  imageFormat?: string;
  width?: string;
  scale?: string;
  // parse
  profile?: string;
  password?: string;
  images?: boolean;
  stayImageAreaRate?: string;
  // convert
  anchors?: boolean;
  splitPages?: boolean;
  strict?: boolean;
  keepRemoteImages?: boolean;
  // probe
  targets?: string;
  level?: string;
  minimumConfidence?: string;
  // removed in 4.0
  format?: string;
  mode?: string;
}

type Op = 'probe' | 'render' | 'extract' | 'convert';

export async function runProbeCommand(input: string, options: RawCliOptions): Promise<void> {
  const ctx = contextOf(options);
  try {
    const probeOptions: ProbeOptions = {
      ...(options.targets !== undefined ? { targets: list(options.targets, '--targets') } : {}),
      ...(options.level !== undefined ? { level: oneOf(options.level, ['header', 'metadata', 'deep'], '--level') } : {}),
      ...(options.minimumConfidence !== undefined
        ? { minimumConfidence: oneOf(options.minimumConfidence, ['none', 'low', 'medium', 'high', 'exact'], '--minimum-confidence') } : {}),
    };
    const timeout = timeoutOf(options);
    // Probe never resolves credentials or creates a cloud client.
    const report = await runProbe({
      input, ...(options.from !== undefined ? { from: options.from } : {}), options: probeOptions,
      common: timeout !== undefined ? { timeout } : {},
    });
    printProbe(report);
  } catch (error) {
    fail(error, 'probe', ctx);
  }
}

export async function runRenderCommand(input: string, options: RawCliOptions): Promise<void> {
  const ctx = contextOf(options);
  try {
    if (options.to === undefined) throw DeckOpsError.usage('render needs --to image or --to video.');
    const render: RenderOptions = {
      to: options.to as RenderOptions['to'],
      ...(options.pages !== undefined ? { pages: parsePages(options.pages) } : {}),
      ...(options.quality !== undefined ? { quality: options.quality as NonNullable<RenderOptions['quality']> } : {}),
      ...(options.imageFormat !== undefined ? { imageFormat: options.imageFormat as NonNullable<RenderOptions['imageFormat']> } : {}),
      ...(options.width !== undefined ? { width: Number(options.width) } : {}),
      ...(options.scale !== undefined ? { scale: Number(options.scale) } : {}),
    };
    printEnvelope(await runRender({ ...requestOf(input, options), options: render }), ctx);
  } catch (error) {
    fail(error, 'render', ctx);
  }
}

export async function runExtractCommand(input: string, options: RawCliOptions): Promise<void> {
  const ctx = contextOf(options);
  try {
    if (options.to === undefined) throw DeckOpsError.usage('extract needs --to json or --to assets.');
    const extract: ExtractOptions = { to: options.to as ExtractOptions['to'], ...parseOptionsOf(options) };
    printEnvelope(await runExtract({ ...requestOf(input, options), options: extract }), ctx);
  } catch (error) {
    fail(error, 'extract', ctx);
  }
}

/** `deckops SOURCE` is `convert SOURCE -o -`: Markdown on stdout. */
export async function runConvertCommand(input: string, options: RawCliOptions, defaults: { output?: string } = {}): Promise<void> {
  const ctx = contextOf(options);
  try {
    if (options.format !== undefined) {
      throw DeckOpsError.usage('--format was removed in DeckOps 4.', { hint: 'For the structured document run: deckops extract SOURCE --to json -o -' });
    }
    const convert: ConvertOptions & { keepRemoteImages?: boolean } = {
      ...(options.to !== undefined ? { to: options.to as 'markdown' } : {}),
      ...(options.anchors !== undefined ? { anchors: options.anchors } : {}),
      ...(options.splitPages !== undefined ? { splitPages: options.splitPages } : {}),
      ...(options.strict !== undefined ? { strict: options.strict } : {}),
      ...(options.keepRemoteImages !== undefined ? { keepRemoteImages: options.keepRemoteImages } : {}),
      ...parseOptionsOf(options),
    };
    const request = requestOf(input, options);
    const output = request.out ?? defaults.output;
    printEnvelope(await runConvert({ ...request, ...(output !== undefined ? { out: output } : {}), options: convert }), ctx);
  } catch (error) {
    fail(error, 'convert', ctx);
  }
}

function requestOf(input: string, options: RawCliOptions) {
  return {
    input,
    ...(options.from !== undefined ? { from: options.from } : {}),
    ...(options.output !== undefined ? { out: options.output } : {}),
    common: commonFlagsOf(options),
    cloud: cloudFor(options),
  };
}

export function commonFlagsOf(options: RawCliOptions): CommonFlags {
  const timeout = timeoutOf(options);
  return {
    ...(options.space !== undefined ? { spaceId: options.space } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(options.force !== undefined ? { force: options.force } : {}),
  };
}

function timeoutOf(options: RawCliOptions): number | undefined {
  const timeout = options.timeout === undefined ? readProductConfig().timeout : Number(options.timeout);
  if (timeout !== undefined && !(Number.isFinite(timeout) && timeout > 0 && timeout <= 2_147_483)) {
    throw DeckOpsError.usage('--timeout must be a positive number of seconds.');
  }
  return timeout;
}

function parseOptionsOf(options: RawCliOptions): ParseOptions {
  if (options.mode !== undefined) {
    throw DeckOpsError.usage('--mode was removed in DeckOps 4: the cloud always reads a URL as the rendered page.');
  }
  return {
    ...(options.profile !== undefined ? { profile: options.profile as NonNullable<ParseOptions['profile']> } : {}),
    ...(options.password !== undefined ? { password: options.password } : {}),
    // commander's --no-images sets images: false; only forward the negation.
    ...(options.images === false ? { includeImages: false } : {}),
    ...(options.stayImageAreaRate !== undefined ? { stayImageAreaRate: Number(options.stayImageAreaRate) } : {}),
  };
}

/** One cloud client per command, created only when a verb needs the cloud. */
function cloudFor(options: RawCliOptions): () => Promise<CloudAccess> {
  let pending: Promise<CloudAccess> | undefined;
  return () => (pending ??= cloudClient({
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.token ? { token: options.token } : {}),
    ...(options.apiBase ? { apiBase: options.apiBase } : {}),
    ...(options.space ? { spaceId: options.space } : {}),
  }));
}

/** `3`, `1-5`, `1,3,5-7`: 1-based, inclusive, sorted and unique. */
export function parsePages(spec: string): number[] {
  const pages = new Set<number>();
  for (const part of spec.split(',').map((item) => item.trim()).filter(Boolean)) {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    const [start, end] = range ? [Number(range[1]), Number(range[2])] : /^\d+$/.test(part) ? [Number(part), Number(part)] : [NaN, NaN];
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > 10_000) {
      throw DeckOpsError.usage(`Invalid page selection: ${part}.`, { hint: 'Use a page number (3), a range (1-5), or a list (1,3,5-7).' });
    }
    for (let page = start; page <= end; page += 1) pages.add(page);
  }
  if (!pages.size) throw DeckOpsError.usage('Empty page selection.', { hint: 'Use a page number (3), a range (1-5), or a list (1,3,5-7).' });
  return [...pages].sort((a, b) => a - b);
}

function list(value: string, flag: string): string[] {
  const items = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (!items.length) throw DeckOpsError.usage(`${flag} needs at least one name.`);
  return items;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], flag: string): T {
  if (!allowed.includes(value as T)) throw DeckOpsError.usage(`${flag} must be ${allowed.join(', ')}.`);
  return value as T;
}

function contextOf(options: RawCliOptions): OutputContext {
  return { json: Boolean(options.json), quiet: Boolean(options.quiet) };
}

function fail(error: unknown, op: Op, ctx: OutputContext): never {
  const translated = error instanceof DeckOpsError ? error : translateError(error);
  printError(translated, op, ctx);
  process.exit(translated.exitCode);
}

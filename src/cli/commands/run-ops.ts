import type { DeckClient } from '../../client/legacy.js';
import { translateError as translate } from '../../shared/errors.js';
import { cloudClient } from '../../node/cloud.js';
import { runConvert } from '../../node/convert-op.js';
import { resolveInput } from '../../node/input.js';
import { runParse } from '../../node/parse-op.js';
import { runRead } from '../../node/read-op.js';
import { validateConvertFlags, validateParseFlags } from '../../node/validation.js';
import { DeckOpsError } from '../../errors/index.js';
import { readProductConfig } from '../../config/product.js';
import type { CommonFlags, ConvertFlags, ParseFlags } from '../../types.js';
import { printEnvelope, printError, printWarnings, type OutputContext } from '../output.js';

/**
 * Shared command driver for the verbs: resolve input, validate flags,
 * build the client, run, render, exit. Exit codes come from the error code
 * table — the process exits non-zero on any failure.
 */

export interface RawCliOptions {
  format?: string;
  report?: string;
  from?: string;
  output?: string;
  json?: boolean;
  quiet?: boolean;
  force?: boolean;
  space?: string;
  timeout?: string;
  apiKey?: string;
  token?: string;
  apiBase?: string;
  // parse-side
  profile?: string;
  password?: string;
  images?: boolean;
  stayImageAreaRate?: string;
  mode?: string;
  // convert-side
  to?: string;
  anchors?: boolean;
  splitPages?: boolean;
  strict?: boolean;
  keepRemoteImages?: boolean;
}

export function parseFlagsOf(options: RawCliOptions): ParseFlags {
  const flags: ParseFlags = {};
  if (options.profile !== undefined) flags.profile = options.profile as NonNullable<ParseFlags['profile']>;
  if (options.password !== undefined) flags.password = options.password;
  // commander's --no-images sets images: false; only forward the negation.
  if (options.images === false) flags.includeImages = false;
  if (options.stayImageAreaRate !== undefined) flags.stayImageAreaRate = Number(options.stayImageAreaRate);
  if (options.mode !== undefined) flags.mode = options.mode as NonNullable<ParseFlags['mode']>;
  return flags;
}

export function convertFlagsOf(options: RawCliOptions): ConvertFlags {
  const flags: ConvertFlags = {};
  if (options.to !== undefined) flags.to = options.to as NonNullable<ConvertFlags['to']>;
  if (options.anchors !== undefined) flags.anchors = options.anchors;
  if (options.splitPages !== undefined) flags.splitPages = options.splitPages;
  if (options.strict !== undefined) flags.strict = options.strict;
  if (options.keepRemoteImages !== undefined) flags.keepRemoteImages = options.keepRemoteImages;
  return flags;
}

export function commonFlagsOf(options: RawCliOptions): CommonFlags {
  const timeout = options.timeout === undefined ? readProductConfig().timeout : Number(options.timeout);
  if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout <= 0)) throw DeckOpsError.usage('--timeout must be a positive integer number of seconds.');
  return {
    ...(options.space !== undefined ? { spaceId: options.space } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(options.force !== undefined ? { force: options.force } : {}),
  };
}

/** One client per command: read parses and converts through the same transport and resolved space. */
function clientFor(options: RawCliOptions): () => Promise<DeckClient> {
  let cached: DeckClient | undefined;
  return async () => (cached ??= await cloudClient({
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.token ? { token: options.token } : {}),
    ...(options.apiBase ? { apiBase: options.apiBase } : {}),
    ...(options.space ? { spaceId: options.space } : {}),
  }));
}

export async function runParseCommand(inputArg: string, options: RawCliOptions): Promise<void> {
  const ctx: OutputContext = { json: Boolean(options.json), quiet: Boolean(options.quiet) };
  try {
    const input = await resolveInput(inputArg, options.from ? { from: options.from } : {});
    const flags = parseFlagsOf(options);
    validateParseFlags(input, flags);
    rejectConvertFlagsOnParse(options);

    const envelope = await runParse({
      input,
      inputLabel: inputArg,
      ...(options.output ? { out: options.output } : {}),
      flags,
      common: commonFlagsOf(options),
      client: clientFor(options),
    });
    printEnvelope(envelope, ctx);
  } catch (error) {
    fail(error, 'parse', ctx);
  }
}

export async function runConvertCommand(inputArg: string, options: RawCliOptions): Promise<void> {
  const ctx: OutputContext = { json: Boolean(options.json), quiet: Boolean(options.quiet) };
  try {
    const input = await resolveInput(inputArg, options.from ? { from: options.from } : {});
    const parseFlags = parseFlagsOf(options);
    const convertFlags = convertFlagsOf(options);
    validateParseFlags(input, parseFlags);
    validateConvertFlags(input, convertFlags);

    const envelope = await runConvert({
      input,
      inputLabel: inputArg,
      ...(options.output ? { out: options.output } : {}),
      flags: convertFlags,
      parseFlags,
      common: commonFlagsOf(options),
      client: clientFor(options),
    });
    printEnvelope(envelope, ctx);
  } catch (error) {
    fail(error, 'convert', ctx);
  }
}

export async function runReadCommand(inputArg: string, options: RawCliOptions): Promise<void> {
  const ctx: OutputContext = { json: Boolean(options.json), quiet: Boolean(options.quiet) };
  try {
    const input = await resolveInput(inputArg, options.from ? { from: options.from } : {});
    const flags = parseFlagsOf(options);
    validateParseFlags(input, flags);
    const result = await runRead({
      input, inputLabel: inputArg, flags, common: commonFlagsOf(options), client: clientFor(options),
      ...(options.output !== undefined ? { out: options.output } : {}),
      ...(options.format !== undefined ? { format: options.format as 'markdown' | 'ir' } : {}),
      ...(options.report ? { reportFile: options.report } : {}),
      ...(options.anchors !== undefined ? { anchors: options.anchors } : {}),
    });
    if (ctx.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    if (result.content !== null) process.stdout.write(typeof result.content === 'string' ? result.content : `${JSON.stringify(result.content)}\n`);
    if (ctx.quiet) return;
    printWarnings(result.report.warnings);
    if (result.format === 'ir') process.stderr.write(`artifactBase: ${result.report.artifactBase}\n`);
  } catch (error) {
    fail(error, 'read', ctx);
  }
}

/** `deckops parse doc.pdf --anchors` is a category error, not a silent no-op. */
function rejectConvertFlagsOnParse(options: RawCliOptions): void {
  const set = (['to', 'anchors', 'splitPages', 'strict', 'keepRemoteImages'] as const).filter(
    (name) => options[name] !== undefined && options[name] !== false
  );
  if (set.length > 0) {
    throw DeckOpsError.usage(
      `${set.map((name) => `--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`).join(', ')} are view options — they belong to \`deckops convert\`.`
    );
  }
}

function fail(error: unknown, op: 'parse' | 'convert' | 'read', ctx: OutputContext): never {
  const translated = error instanceof DeckOpsError ? error : translate(error);
  printError(translated, op, ctx);
  process.exit(translated.exitCode);
}

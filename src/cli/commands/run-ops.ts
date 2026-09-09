import { translateError as translate } from '../../shared/errors.js';
import { runRead } from '../../core/read-op.js';
import { runConvert } from '../../core/convert-op.js';
import { resolveInput, type ResolvedInput } from '../../core/input.js';
import { runParse } from '../../core/parse-op.js';
import { validateConvertFlags, validateParseFlags } from '../../core/validation.js';
import { DeckOpsError } from '../../errors/index.js';
import { readProductConfig } from '../../config/product.js';
import type { CommonFlags, ConvertFlags, ParseFlags } from '../../types.js';
import { DEFAULT_PREFLIGHT_MODE, type PreflightMode } from '../../shared/preflight.js';
import { printEnvelope, printError, type OutputContext } from '../output.js';

/**
 * Shared command driver for the two verbs: resolve input, validate flags,
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
  preflight?: string;
  engine?: string;
  allowUpload?: boolean;
  failOnDegraded?: boolean;
  maxSourceBytes?: string;
  maxExpandedBytes?: string;
  maxPartBytes?: string;
  maxAssetBytes?: string;
  maxTotalAssetBytes?: string;
  maxZipEntries?: string;
  maxUrlBytes?: string;
  workerHeapMb?: string;
  apiKey?: string;
  token?: string;
  apiBase?: string;
  // parse-side
  profile?: string;
  password?: string;
  images?: boolean;
  pageFurniture?: string;
  overlaidText?: string;
  trackedChanges?: string;
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
  if (options.pageFurniture !== undefined) flags.pageFurniture = options.pageFurniture as NonNullable<ParseFlags['pageFurniture']>;
  if (options.overlaidText !== undefined) flags.overlaidText = options.overlaidText as NonNullable<ParseFlags['overlaidText']>;
  if (options.trackedChanges !== undefined) flags.trackedChanges = options.trackedChanges as NonNullable<ParseFlags['trackedChanges']>;
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
  const defaults = readProductConfig();
  const engine = options.engine ?? process.env.DECKOPS_ENGINE ?? defaults.engine ?? 'local';
  const allowUpload = options.allowUpload ?? envBoolean('DECKOPS_ALLOW_UPLOAD') ?? defaults.allowUpload;
  const failOnDegraded = options.failOnDegraded ?? envBoolean('DECKOPS_FAIL_ON_DEGRADED') ?? defaults.failOnDegraded;
  const timeout = options.timeout === undefined ? defaults.timeout : Number(options.timeout);
  if (!['local', 'cloud', 'auto'].includes(engine)) throw DeckOpsError.usage('--engine must be local, cloud, or auto.');
  if (options.engine === 'local' && options.allowUpload === true) throw DeckOpsError.usage('Explicit --engine local conflicts with --allow-upload.');
  if (engine === 'cloud' && allowUpload === false) throw DeckOpsError.usage('--engine cloud conflicts with upload denial.');
  if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout <= 0)) throw DeckOpsError.usage('--timeout must be a positive integer number of seconds.');
  const limitEntries = [
    ['sourceBytes', '--max-source-bytes', options.maxSourceBytes], ['zipExpandedBytes', '--max-expanded-bytes', options.maxExpandedBytes],
    ['zipEntryBytes', '--max-part-bytes', options.maxPartBytes], ['zipEntries', '--max-zip-entries', options.maxZipEntries],
    ['assetBytes', '--max-asset-bytes', options.maxAssetBytes], ['assetTotalBytes', '--max-total-asset-bytes', options.maxTotalAssetBytes],
    ['urlBytes', '--max-url-bytes', options.maxUrlBytes], ['workerHeapMb', '--worker-heap-mb', options.workerHeapMb],
  ] as const;
  const limits: Record<string, number> = {};
  for (const [name, flag, raw] of limitEntries) {
    if (raw === undefined) continue;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) throw DeckOpsError.usage(`${flag} must be a positive integer.`);
    limits[name] = value;
  }
  return {
    ...(options.space !== undefined ? { spaceId: options.space } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(options.force !== undefined ? { force: options.force } : {}),
    policySource: { engine: options.engine !== undefined ? 'cli' : process.env.DECKOPS_ENGINE !== undefined ? 'environment' : defaults.engine !== undefined ? 'config' : 'builtin', allowUpload: options.allowUpload !== undefined ? 'cli' : process.env.DECKOPS_ALLOW_UPLOAD !== undefined ? 'environment' : defaults.allowUpload !== undefined ? 'config' : 'builtin' },
    engine: engine as NonNullable<CommonFlags['engine']>,
    ...(allowUpload !== undefined ? { allowUpload } : {}),
    ...(failOnDegraded !== undefined ? { failOnDegraded } : {}),
    ...(Object.keys(limits).length ? { limits } : {}),
  };
}

function envBoolean(name: string): boolean | undefined {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === '') return undefined;
  if (['1', 'true', 'yes', 'allow'].includes(value)) return true;
  if (['0', 'false', 'no', 'deny'].includes(value)) return false;
  throw DeckOpsError.usage(`${name} must be true/false or 1/0.`);
}

export function preflightModeOf(options: RawCliOptions): PreflightMode {
  const value = options.preflight ?? readProductConfig().preflight ?? DEFAULT_PREFLIGHT_MODE;
  if (!['off', 'validate', 'strict'].includes(value)) {
    throw DeckOpsError.usage('--preflight must be off, validate, or strict.');
  }
  return value as PreflightMode;
}

/** Existing artifacts have no source bytes to inspect; only reject an explicitly requested mode there. */
export function preflightModeForConvert(input: ResolvedInput, options: RawCliOptions): PreflightMode | undefined {
  if (input.kind === 'artifact' && options.preflight === undefined) return undefined;
  return preflightModeOf(options);
}

async function clientFor(options: RawCliOptions) {
  const [{ resolveCredentials }, { createCloudClient }] = await Promise.all([
    import('../../config/index.js'), import('../../cloud/client.js'),
  ]);
  const credentials = await resolveCredentials({
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.token ? { token: options.token } : {}),
    ...(options.apiBase ? { apiBase: options.apiBase } : {}),
    ...(options.space ? { spaceId: options.space } : {}),
  });
  return createCloudClient(credentials);
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
      preflight: preflightModeOf(options),
      cloud: () => clientFor(options),
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
    const preflight = preflightModeForConvert(input, options);
    validateParseFlags(input, parseFlags);
    validateConvertFlags(input, convertFlags);

    const envelope = await runConvert({
      input,
      inputLabel: inputArg,
      ...(options.output ? { out: options.output } : {}),
      flags: convertFlags,
      parseFlags,
      common: commonFlagsOf(options),
      ...(preflight !== undefined ? { preflight } : {}),
      cloud: () => clientFor(options),
    });
    printEnvelope(envelope, ctx);
  } catch (error) {
    fail(error, 'convert', ctx);
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

export async function runReadCommand(inputArg: string, options: RawCliOptions): Promise<void> {
  try {
    const input = await resolveInput(inputArg, options.from ? { from: options.from } : {});
    const flags = parseFlagsOf(options); validateParseFlags(input, flags);
    const result = await runRead({ input, inputLabel: inputArg, flags, common: commonFlagsOf(options), preflight: preflightModeOf(options),
      cloud: () => clientFor(options), ...(options.output !== undefined ? { out: options.output } : {}),
      ...(options.format !== undefined ? { format: options.format as 'markdown' | 'ir' } : {}), ...(options.report ? { reportFile: options.report } : {}),
      ...(options.anchors !== undefined ? { anchors: options.anchors } : {}), ...(options.splitPages !== undefined ? { splitPages: options.splitPages } : {}) });
    if (options.json) process.stdout.write(JSON.stringify(result) + '\n');
    else if (result.content !== null) process.stdout.write(typeof result.content === 'string' ? result.content : JSON.stringify(result.content) + '\n');
    if (!options.json) {
      const issue = result.report.assessment.issues.find(i => i.severity !== 'info' && i.impact !== 'informational');
      if (issue) process.stderr.write(`quality: ${issue.message}\n`);
      const summary = result.report.assessment.summary;
      if (issue && summary) process.stderr.write(`coverage: ${summary.parsedPages}/${summary.sourcePages ?? '?'} pages/slides; missing=${summary.missingPageCount}; failed=${summary.failedPages.length}; searchableTextCharacters=${summary.searchableTextCharacters}\n`);
      const recommendation = result.report.assessment.recommendation;
      if (recommendation) process.stderr.write(`recommendation: ${recommendation.message}\n`);
      const delivery = result.report.warnings.find(w => w.startsWith('Replaced '));
      if (delivery) process.stderr.write(`delivery: ${delivery}\n`);
      const decision = result.report.decision;
      if (decision && (issue || decision.reason === 'upgrade_failed')) {
        process.stderr.write(`route: ${decision.action}; ${decision.reason}\n`);
        if (decision.next?.message) process.stderr.write(`hint: ${decision.next.message}\n`);
        if (decision.next) process.stderr.write(`next: ${decision.next.argv.map(arg => "'" + arg.replaceAll("'", "'\\''") + "'").join(' ')}\n`);
      }
      if (result.format === 'ir') process.stderr.write(`artifactBase: ${result.report.artifactBase}\n`);
      const preflight = result.report.warnings.find(w => w.includes('preflight') || w.includes('DeckProbe'));
      if (preflight) process.stderr.write(`${preflight}\n`);
    }
  } catch (error) { fail(error, 'read', { json: Boolean(options.json), quiet: Boolean(options.quiet) }); }
}

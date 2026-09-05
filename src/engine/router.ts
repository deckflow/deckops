import { DeckOpsError } from '../errors/index.js';
import type { ParseCandidate } from '../ir/schema.js';
import { CloudEngine } from './cloud.js';
import { LocalEngine } from './local.js';
import type { EngineParseInput, EngineParseOptions } from './types.js';
import type { CloudClient } from '../cloud/client.js';

export async function routeParse(options: {
  input: EngineParseInput;
  parse: EngineParseOptions;
  cloud?: () => Promise<CloudClient>;
  signal: AbortSignal;
}): Promise<ParseCandidate> {
  const mode = options.parse.common.engine ?? 'local';
  const local = new LocalEngine();
  if (mode === 'cloud') return (new CloudEngine(await requireCloud(options.cloud))).parse(options.input, options.parse, options.signal);
  const support = local.supports(options.input, options.parse);
  if (!support.supported) {
    if (mode === 'auto' && options.parse.common.allowUpload) return (new CloudEngine(await requireCloud(options.cloud))).parse(options.input, options.parse, options.signal);
    throw DeckOpsError.unsupported(support.reason ?? 'Input is unsupported locally.', support.hint ? { hint: support.hint } : {});
  }
  const candidate = await local.parse(options.input, options.parse, options.signal);
  if (candidate.quality.status === 'degraded') {
    if (options.parse.common.failOnDegraded) throw DeckOpsError.input('Local parsing completed with degraded quality.', candidate.quality.checks[0]?.message ? { hint: candidate.quality.checks[0].message } : {});
    if (mode === 'auto' && options.parse.common.allowUpload) return (new CloudEngine(await requireCloud(options.cloud))).parse(options.input, options.parse, options.signal);
  }
  return candidate;
}

async function requireCloud(factory?: () => Promise<CloudClient>): Promise<CloudClient> {
  if (!factory) throw DeckOpsError.usage('Cloud parsing was requested but no cloud client is configured.');
  return factory();
}

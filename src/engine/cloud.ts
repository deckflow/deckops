import type { ParseSource } from '@deckops/sdk';
import { cloudResultToCandidate } from '../ir/cloud-adapter.js';
import type { CloudClient } from '../cloud/client.js';
import type { EngineParseInput, EngineParseOptions, ParseEngine, SupportDecision } from './types.js';

export class CloudEngine implements ParseEngine {
  readonly id = 'cloud' as const;
  constructor(private readonly client: CloudClient) {}
  supports(): SupportDecision { return { supported: true }; }
  async parse(input: EngineParseInput, options: EngineParseOptions, _signal: AbortSignal) {
    const parsed = await this.client.parse(sourceFor(input.input), {
      ...cloudParams(options.flags, input.input.kind === 'link'),
      ...(options.common.spaceId ? { spaceId: options.common.spaceId } : {}),
      ...(options.common.timeout ? { wait: { timeout: options.common.timeout } } : {}),
    });
    if (!input.source) throw new Error('Cloud parsing needs a resolved source identity.');
    return cloudResultToCandidate(parsed, input.source);
  }
}
function sourceFor(input: EngineParseInput['input']): ParseSource {
  if (input.kind === 'document') return input.file;
  if (input.kind === 'stdin') return { file: { input: input.data, name: input.name }, name: input.name };
  return { url: input.url };
}

function cloudParams(flags: EngineParseOptions['flags'], isLink: boolean): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (flags.password !== undefined) params.password = flags.password;
  if (flags.profile !== undefined) params.parseProfile = flags.profile;
  if (flags.includeImages !== undefined) params.includeImages = flags.includeImages;
  if (flags.stayImageAreaRate !== undefined) params.stayImageAreaRate = flags.stayImageAreaRate;
  if (isLink && flags.mode !== undefined) params.mode = flags.mode;
  return params;
}

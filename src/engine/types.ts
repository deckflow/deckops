import type { ResolvedInput } from '../core/input.js';
import type { ParseCandidate } from '../ir/schema.js';
import type { CommonFlags, ParseFlags } from '../types.js';
import type { SourceIdentity } from '../local/common.js';

export interface SupportDecision {
  supported: boolean;
  reason?: string;
  hint?: string;
}
export interface EngineParseInput {
  input: Exclude<ResolvedInput, { kind: 'artifact' }>;
  inputLabel: string;
  source?: SourceIdentity;
}

export interface EngineParseOptions {
  /** 云端建任务的请求即将发出；在此之前失败不会留下云端任务。 */
  onSubmit?: () => void;
  onTask?: (task: { id: string }) => void;
  flags: ParseFlags;
  common: CommonFlags;
}

export interface ParseEngine {
  readonly id: 'local' | 'cloud';
  supports(input: EngineParseInput, options: EngineParseOptions): SupportDecision;
  parse(input: EngineParseInput, options: EngineParseOptions, signal: AbortSignal): Promise<ParseCandidate>;
}

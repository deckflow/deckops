import { DeckOpsError } from '../errors/index.js';
import type { ConvertFlags, ParseFlags } from '../types.js';
import type { ResolvedInput } from './input.js';
import { formatForTaskType, validateConvertFlagsForFormat, validateParseFlagsForFormat, type FormatKey } from '../shared/validation.js';

/**
 * Flag × format validation. A flag that cannot apply is a usage error before any task is
 * sent — the backend silently ignores unknown params, so the client is the only place this
 * can be caught.
 */

export function formatOf(input: ResolvedInput): FormatKey | undefined {
  if (input.kind === 'link') return 'link';
  if (input.kind === 'artifact') return formatForTaskType(input.manifest.parse.type);
  return formatForTaskType(input.taskType);
}

export function validateParseFlags(input: ResolvedInput, flags: ParseFlags): void {
  if (flags.profile && !['fast', 'balanced', 'quality'].includes(flags.profile)) throw DeckOpsError.usage('--profile must be fast, balanced, or quality.');
  if (flags.mode && !['source', 'runtime'].includes(flags.mode)) throw DeckOpsError.usage('--mode must be source or runtime.');
  if (flags.stayImageAreaRate !== undefined && (!Number.isFinite(flags.stayImageAreaRate) || flags.stayImageAreaRate < 0 || flags.stayImageAreaRate > 1)) {
    throw DeckOpsError.usage('--stay-image-area-rate must be a number between 0 and 1.');
  }
  if (input.kind === 'artifact') {
    const set = Object.entries(flags).filter(([, value]) => value !== undefined);
    if (set.length > 0) {
      throw DeckOpsError.usage(`Parse flags (${set.map(([name]) => `--${kebab(name)}`).join(', ')}) cannot apply to an artifact — it is already parsed.`);
    }
    return;
  }
  validateParseFlagsForFormat(formatOf(input), flags);
}

export function validateConvertFlags(input: ResolvedInput, flags: ConvertFlags): void {
  validateConvertFlagsForFormat(formatOf(input), flags);
}

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

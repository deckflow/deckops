import { DeckParseError } from '../errors/index.js';
import type { ConvertFlags, ParseFlags } from '../types.js';
import type { ResolvedInput } from './input.js';
import {
  formatForTaskType,
  validateConvertFlagsForFormat,
  validateParseFlagsForFormat,
  type FormatKey,
} from '../shared/validation.js';

/**
 * Flag × format validation (docs/rfc.md §5.2). A flag that cannot apply is a
 * usage error before any task is sent — the legacy backends silently ignored
 * unknown params, so the client is the only place this can be caught.
 */

function formatOf(input: ResolvedInput): FormatKey | undefined {
  if (input.kind === 'link') {
    return 'link';
  }
  if (input.kind === 'artifact') {
    return formatForTaskType(input.manifest.parse.type) ?? 'link';
  }
  return formatForTaskType(input.taskType);
}

export function validateParseFlags(input: ResolvedInput, flags: ParseFlags): void {
  const format = formatOf(input);
  if (input.kind === 'artifact') {
    const set = Object.entries(flags).filter(([, value]) => value !== undefined);
    if (set.length > 0) {
      throw DeckParseError.usage(
        `Parse flags (${set.map(([name]) => `--${kebab(name)}`).join(', ')}) cannot apply to an artifact — it is already parsed.`
      );
    }
    return;
  }
  validateParseFlagsForFormat(format, flags);
}

export function validateConvertFlags(input: ResolvedInput, flags: ConvertFlags): void {
  const format = formatOf(input);
  validateConvertFlagsForFormat(format, flags);
}

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

import { DeckOpsError } from '../errors/index.js';
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
    if (input.manifest.manifestVersion === 2) return input.manifest.parse.format === 'html' ? 'link' : input.manifest.parse.format === 'keynote' ? 'keynote' : input.manifest.parse.format;
    return formatForTaskType(input.manifest.parse.type) ?? 'link';
  }
  return formatForTaskType(input.taskType);
}

export function validateParseFlags(input: ResolvedInput, flags: ParseFlags): void {
  if (flags.profile && !['fast', 'balanced', 'quality'].includes(flags.profile)) throw DeckOpsError.usage('--profile must be fast, balanced, or quality.');
  if (flags.pageFurniture && !['off', 'drop', 'extract'].includes(flags.pageFurniture)) throw DeckOpsError.usage('--page-furniture must be off, drop, or extract.');
  if (flags.overlaidText && !['auto', 'keep', 'drop'].includes(flags.overlaidText)) throw DeckOpsError.usage('--overlaid-text must be auto, keep, or drop.');
  if (flags.trackedChanges && !['final', 'original', 'all'].includes(flags.trackedChanges)) throw DeckOpsError.usage('--tracked-changes must be final, original, or all.');
  if (flags.mode && !['source', 'runtime'].includes(flags.mode)) throw DeckOpsError.usage('--mode must be source or runtime.');
  const format = formatOf(input);
  if (input.kind === 'artifact') {
    const set = Object.entries(flags).filter(([, value]) => value !== undefined);
    if (set.length > 0) {
      throw DeckOpsError.usage(
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

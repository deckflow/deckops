import type { ConvertFlags, ParseFlags } from '../types.js';

/** Only backend params belong here; storage and task wait options stay with callers. */
export function parseParams(flags: ParseFlags, isLink: boolean): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (flags.password !== undefined) params.password = flags.password;
  if (flags.profile !== undefined) params.parseProfile = flags.profile;
  if (flags.includeImages !== undefined) params.includeImages = flags.includeImages;
  if (flags.stayImageAreaRate !== undefined) params.stayImageAreaRate = flags.stayImageAreaRate;
  if (isLink && flags.mode !== undefined) params.mode = flags.mode;
  return params;
}

export function convertParams(flags: ConvertFlags): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (flags.anchors !== undefined) params.markdownMeta = flags.anchors;
  if (flags.splitPages !== undefined) params.markdownPages = flags.splitPages;
  if (flags.strict !== undefined) params.markdownStrict = flags.strict;
  return params;
}

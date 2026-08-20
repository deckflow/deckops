import { z } from 'zod';

/**
 * Shared Deckflow credentials schema (`~/.deckflow/credentials`).
 * Keys match deckhtml / other Deckflow CLIs so tools can reuse one file.
 */
export const ConfigSchema = z.object({
  apiKey: z.string().optional(),
  token: z.string().optional(),
  spaceId: z.string().optional(),
  apiBase: z.string().url().optional(),
  webhook: z.string().optional(),
  retentionHours: z.number().optional(),
});

/**
 * Type inference from Zod schema
 */
export type ConfigData = z.infer<typeof ConfigSchema>;

/**
 * Partial config for updates
 */
export type PartialConfig = Partial<ConfigData>;

/** Keys written to the shared credentials file (must stay aligned with deckhtml). */
export const CONFIG_KEYS = [
  'apiKey',
  'token',
  'spaceId',
  'apiBase',
  'webhook',
  'retentionHours',
] as const satisfies ReadonlyArray<keyof ConfigData>;

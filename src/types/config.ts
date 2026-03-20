import { z } from 'zod';

/**
 * Configuration schema validation using Zod
 */
export const ConfigSchema = z.object({
  token: z.string().optional(),
  spaceId: z.string().default('UMYSELF'),
  apiBase: z.string().url().default('https://app.deckflow.com/v1'),
  signURI: z.string().url().optional(),
});

/**
 * Type inference from Zod schema
 */
export type ConfigData = z.infer<typeof ConfigSchema>;

/**
 * Partial config for updates
 */
export type PartialConfig = Partial<ConfigData>;

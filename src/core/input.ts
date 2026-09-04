import fs from 'node:fs';
import path from 'node:path';
import { DeckParseError } from '../errors/index.js';
import type { Manifest, ParseTaskType } from '../types.js';
import { readManifest } from '../artifact/manifest.js';
import { routeExtension } from '../shared/input.js';

export { EXTENSION_ROUTES, SUPPORTED_EXTENSIONS, extensionOf, routeExtension } from '../shared/input.js';

/**
 * Input classification (docs/rfc.md §3.1). Order matters: `-` → stdin,
 * http(s) → link, directory with a manifest → artifact, file → document.
 * A directory without a valid manifest is an error, not a guess.
 */

export type ResolvedInput =
  | { kind: 'document'; file: string; name: string; taskType: ParseTaskType }
  | { kind: 'link'; url: string }
  | { kind: 'stdin'; data: Buffer; name: string; taskType: ParseTaskType }
  | { kind: 'artifact'; dir: string; manifest: Manifest };

export interface ResolveInputOptions {
  /** Extension (e.g. "pdf") for stdin input, where there is no file name. */
  from?: string;
  /** Injected for tests. */
  readStdin?: () => Buffer;
}

export async function resolveInput(input: string, options: ResolveInputOptions = {}): Promise<ResolvedInput> {
  if (input === '-') {
    if (!options.from) {
      throw DeckParseError.usage('Reading from stdin needs --from <ext> to pick a parser (e.g. --from pdf).');
    }
    const ext = options.from.startsWith('.') ? options.from : `.${options.from}`;
    const name = `stdin${ext.toLowerCase()}`;
    const taskType = routeExtension(name);
    const data = options.readStdin ? options.readStdin() : fs.readFileSync(0);
    if (data.length === 0) {
      throw DeckParseError.input('stdin was empty.');
    }
    return { kind: 'stdin', data, name, taskType };
  }

  if (/^https?:\/\//i.test(input)) {
    return { kind: 'link', url: input };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(input);
  } catch {
    throw DeckParseError.input(`No such file or directory: ${input}`);
  }

  if (stat.isDirectory()) {
    const manifest = await readManifest(input);
    return { kind: 'artifact', dir: input, manifest };
  }

  const name = path.basename(input);
  return { kind: 'document', file: input, name, taskType: routeExtension(name) };
}

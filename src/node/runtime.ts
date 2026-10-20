import { resolveAuthUuid } from './auth-uuid.js';
import { fileIdStore } from './cache.js';
import type { DeckRuntime } from '../cloud/runtime.js';

export const nodeRuntime: DeckRuntime = {
  resolveAuthUuid,
  async readFile(filePath, signal) {
    const [fs, path] = await Promise.all([import('node:fs/promises'), import('node:path')]);
    const data = await fs.readFile(filePath, { signal });
    return { data, name: path.basename(filePath) };
  },
  fileIds: fileIdStore,
};

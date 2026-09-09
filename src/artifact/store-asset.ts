import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export async function storeAsset(target: string, data: Uint8Array, shareFrom: string[]): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const hash = createHash('sha256').update(data).digest('hex');
  const matches = async (file: string) => {
    const stat = await fs.lstat(file).catch(() => undefined);
    return stat?.isFile() && stat.size === data.byteLength && createHash('sha256').update(await fs.readFile(file)).digest('hex') === hash ? stat : undefined;
  };
  const existing = await matches(target);
  for (const source of shareFrom) {
    if (path.resolve(source) === path.resolve(target)) continue;
    const stat = await matches(source); if (!stat) continue;
    if (existing?.dev === stat.dev && existing?.ino === stat.ino) return;
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.link(source, temp);
      await fs.rename(temp, target);
      return;
    } catch { /* Cross-device or unavailable hard links: keep a normal artifact file. */ }
    finally { await fs.rm(temp, { force: true }); }
  }
  if (existing) return;
  const temp = `${target}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, data); await fs.rename(temp, target); }
  finally { await fs.rm(temp, { force: true }); }
}

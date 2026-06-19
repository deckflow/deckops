import fs from 'fs/promises';
import path from 'path';
import type { DeckTask } from '@deckops/sdk';

type OutputFile = {
  url: string;
  ext: string;
};

export type TaskOutputWriteResult =
  | { kind: 'file'; path: string }
  | { kind: 'directory'; path: string; files: string[] }
  | { kind: 'zip'; path: string }
  | { kind: 'json'; path: string };

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;

export async function writeTaskOutput(
  task: DeckTask,
  outPath: string,
  downloadResult: unknown
): Promise<TaskOutputWriteResult> {
  const files = collectOutputFiles(downloadResult);

  if (files.length === 0) {
    const target = await resolveSingleOutputPath(outPath, task.id, '.json');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(downloadResult ?? task.result ?? task, null, 2)}\n`);
    return { kind: 'json', path: target };
  }

  if (files.length === 1) {
    const file = files[0]!;
    const target = await resolveSingleOutputPath(outPath, task.id, file.ext);
    const bytes = await downloadFile(file.url);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
    return { kind: 'file', path: target };
  }

  const outExt = path.extname(outPath).toLowerCase();
  const outIsExistingDirectory = await isDirectory(outPath);
  const downloaded = await Promise.all(
    files.map(async (file) => ({
      file,
      bytes: await downloadFile(file.url),
    }))
  );

  if (!outIsExistingDirectory && outExt === '.zip') {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(
      outPath,
      createZip(
        downloaded.map((item, index) => ({
          name: orderedFileName(index, files.length, item.file.ext),
          bytes: item.bytes,
        }))
      )
    );
    return { kind: 'zip', path: outPath };
  }

  await fs.mkdir(outPath, { recursive: true });
  const written: string[] = [];
  for (let i = 0; i < downloaded.length; i += 1) {
    const item = downloaded[i];
    if (!item) continue;
    const target = path.join(outPath, orderedFileName(i, files.length, item.file.ext));
    await fs.writeFile(target, item.bytes);
    written.push(target);
  }
  return { kind: 'directory', path: outPath, files: written };
}

export function formatTaskOutputWriteResult(result: TaskOutputWriteResult): string {
  if (result.kind === 'directory') {
    return `Saved ${result.files.length} file(s) to ${result.path}`;
  }
  if (result.kind === 'json') {
    return `Saved JSON to ${result.path}`;
  }
  return `Saved result to ${result.path}`;
}

function collectOutputFiles(value: unknown): OutputFile[] {
  const files: OutputFile[] = [];
  visitOutputValue(value, files);
  return files;
}

function visitOutputValue(value: unknown, files: OutputFile[]): void {
  if (isFileTuple(value)) {
    addOutputFile(value[0], files);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      visitOutputValue(item, files);
    }
    return;
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.downloadUrl === 'string') {
      addOutputFile(record.downloadUrl, files);
    }
    for (const item of Object.values(record)) {
      visitOutputValue(item, files);
    }
  }
}

function addOutputFile(url: string, files: OutputFile[]): void {
  if (!isHttpUrl(url)) {
    return;
  }
  files.push({
    url,
    ext: extensionFromUrl(url),
  });
}

function isFileTuple(value: unknown): value is [string, ...unknown[]] {
  return Array.isArray(value) && typeof value[0] === 'string';
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function extensionFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return normalizeExt(path.extname(parsed.pathname));
  } catch {
    return normalizeExt(path.extname(url.split('?')[0] ?? ''));
  }
}

function normalizeExt(ext: string): string {
  return ext ? ext.toLowerCase() : '.bin';
}

async function resolveSingleOutputPath(outPath: string, taskId: string, expectedExt: string): Promise<string> {
  const normalizedExpectedExt = normalizeExt(expectedExt);
  const outExt = path.extname(outPath).toLowerCase();
  const outIsDirectory = (await isDirectory(outPath)) || !outExt || outExt !== normalizedExpectedExt;

  if (outIsDirectory) {
    return path.join(outPath, `${taskId}${normalizedExpectedExt}`);
  }
  return outPath;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function downloadFile(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function orderedFileName(index: number, total: number, ext: string): string {
  const width = Math.max(2, String(total).length);
  return `${String(index + 1).padStart(width, '0')}${normalizeExt(ext)}`;
}

function createZip(entries: { name: string; bytes: Buffer }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const crc = crc32(entry.bytes);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(ZIP_LOCAL_FILE_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.bytes.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    localParts.push(local, entry.bytes);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(ZIP_CENTRAL_DIRECTORY_SIGNATURE, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.bytes.length, 20);
    central.writeUInt32LE(entry.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);

    offset += local.length + entry.bytes.length;
  }

  const centralSize = centralParts.reduce((size, part) => size + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(ZIP_EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

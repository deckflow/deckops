import path from 'node:path';
import { inflateSync } from 'fflate';
import { DeckParseError } from '../../errors/index.js';
import type { LocalLimits } from '../limits.js';
import { parseXml, type XmlNode } from '../xml.js';

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  expandedSize: number;
  localOffset: number;
}

export interface Relationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

/** Minimal central-directory reader: validates first, inflates requested parts only. */
export class OpcPackage {
  private readonly entries = new Map<string, ZipEntry>();
  private expandedRead = 0;
  private readonly countedReads = new Set<string>();

  constructor(private readonly data: Uint8Array, private readonly limits: LocalLimits) {
    if (data.byteLength > limits.sourceBytes) throw DeckParseError.input('Source exceeds the local input size limit.');
    this.index();
  }

  has(name: string): boolean {
    return this.entries.has(normalizePart(name));
  }

  names(): string[] {
    return [...this.entries.keys()].sort();
  }

  read(name: string): Uint8Array {
    const normalized = normalizePart(name);
    const entry = this.entries.get(normalized);
    if (!entry) throw DeckParseError.input(`OOXML package is missing ${normalized}.`);
    if (!this.countedReads.has(normalized)) { this.countedReads.add(normalized); this.expandedRead += entry.expandedSize; }
    if (this.expandedRead > this.limits.zipExpandedBytes) throw DeckParseError.input('OOXML expanded data exceeds the local limit.');
    const view = new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength);
    if (entry.localOffset < 0 || entry.localOffset + 30 > this.data.byteLength) throw DeckParseError.input(`ZIP entry ${normalized} has a truncated local header.`);
    if (view.getUint32(entry.localOffset, true) !== 0x04034b50) throw DeckParseError.input(`ZIP entry ${normalized} has an invalid local header.`);
    if (view.getUint16(entry.localOffset + 8, true) !== entry.method || (view.getUint16(entry.localOffset + 6, true) & 1) !== 0) throw DeckParseError.input(`ZIP entry ${normalized} has conflicting local metadata.`);
    const nameLength = view.getUint16(entry.localOffset + 26, true);
    const extraLength = view.getUint16(entry.localOffset + 28, true);
    const localNameEnd = entry.localOffset + 30 + nameLength;
    if (localNameEnd > this.data.byteLength || normalizePart(new TextDecoder().decode(this.data.subarray(entry.localOffset + 30, localNameEnd))) !== normalized) throw DeckParseError.input(`ZIP entry ${normalized} has a conflicting local path.`);
    const start = entry.localOffset + 30 + nameLength + extraLength;
    const end = start + entry.compressedSize;
    if (end > this.data.byteLength) throw DeckParseError.input(`ZIP entry ${normalized} is truncated.`);
    const compressed = this.data.subarray(start, end);
    let output: Uint8Array;
    if (entry.method === 0) output = compressed.slice();
    else if (entry.method === 8) output = inflateSync(compressed);
    else throw DeckParseError.unsupported(`ZIP compression method ${entry.method} is not supported.`);
    if (output.byteLength !== entry.expandedSize) throw DeckParseError.input(`ZIP entry ${normalized} has an invalid expanded size.`);
    return output;
  }

  xml(name: string): XmlNode {
    return parseXml(this.read(name), this.limits, normalizePart(name));
  }

  relationships(ownerPart: string): Map<string, Relationship> {
    const relsPart = relationshipsPart(ownerPart);
    if (!this.has(relsPart)) return new Map();
    const root = this.xml(relsPart);
    const result = new Map<string, Relationship>();
    for (const rel of root.children.flatMap((node) => node.local === 'Relationships' ? node.children : [])) {
      if (rel.local !== 'Relationship') continue;
      const id = rel.attributes.Id;
      const target = rel.attributes.Target;
      const type = rel.attributes.Type;
      if (!id || !target || !type) continue;
      const external = rel.attributes.TargetMode === 'External';
      result.set(id, {
        id,
        type,
        target: external ? target : resolvePart(ownerPart, target),
        external,
      });
    }
    return result;
  }

  private index(): void {
    if (this.data.byteLength < 22) throw DeckParseError.input('File is not a valid ZIP package.');
    const view = new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength);
    let eocd = -1;
    const min = Math.max(0, this.data.byteLength - 65_557);
    for (let at = this.data.byteLength - 22; at >= min; at -= 1) {
      if (view.getUint32(at, true) === 0x06054b50) { eocd = at; break; }
    }
    if (eocd < 0) throw DeckParseError.input('ZIP end-of-central-directory record was not found.');
    const count = view.getUint16(eocd + 10, true);
    const centralSize = view.getUint32(eocd + 12, true);
    const centralOffset = view.getUint32(eocd + 16, true);
    if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw DeckParseError.unsupported('ZIP64 OOXML packages are not supported locally.');
    }
    if (count > this.limits.zipEntries) throw DeckParseError.input('ZIP package contains too many entries.');
    if (centralOffset + centralSize > this.data.byteLength) throw DeckParseError.input('ZIP central directory is truncated.');
    let at = centralOffset;
    let declaredExpanded = 0;
    for (let i = 0; i < count; i += 1) {
      if (at + 46 > centralOffset + centralSize) throw DeckParseError.input('ZIP central directory is truncated.');
      if (view.getUint32(at, true) !== 0x02014b50) throw DeckParseError.input('ZIP central directory is malformed.');
      const flags = view.getUint16(at + 8, true);
      const method = view.getUint16(at + 10, true);
      const compressedSize = view.getUint32(at + 20, true);
      const expandedSize = view.getUint32(at + 24, true);
      const nameLength = view.getUint16(at + 28, true);
      const extraLength = view.getUint16(at + 30, true);
      const commentLength = view.getUint16(at + 32, true);
      const localOffset = view.getUint32(at + 42, true);
      if ((flags & 1) !== 0) throw DeckParseError.unsupported('Encrypted ZIP entries are not supported locally.');
      if (expandedSize > this.limits.zipEntryBytes) throw DeckParseError.input('A ZIP entry exceeds the local expanded-size limit.');
      if (compressedSize === 0 && expandedSize > 0 || compressedSize > 0 && expandedSize / compressedSize > this.limits.zipCompressionRatio) {
        throw DeckParseError.input('ZIP entry exceeds the allowed compression ratio.');
      }
      declaredExpanded += expandedSize;
      if (declaredExpanded > this.limits.zipExpandedBytes) throw DeckParseError.input('ZIP package exceeds the local expanded-size limit.');
      const nameStart = at + 46;
      const nameEnd = nameStart + nameLength;
      if (nameEnd > this.data.byteLength) throw DeckParseError.input('ZIP entry name is truncated.');
      const name = normalizePart(new TextDecoder().decode(this.data.subarray(nameStart, nameEnd)));
      if (!name.endsWith('/')) {
        if (this.entries.has(name)) throw DeckParseError.input(`ZIP package contains duplicate path ${name}.`);
        this.entries.set(name, { name, flags, method, compressedSize, expandedSize, localOffset });
      }
      at = nameEnd + extraLength + commentLength;
    }
  }
}

export function normalizePart(value: string): string {
  const unix = value.replace(/\\/g, '/');
  if (unix.startsWith('/') || /^[A-Za-z]:\//.test(unix)) throw DeckParseError.input(`Unsafe ZIP path: ${value}`);
  const normalized = path.posix.normalize(unix);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw DeckParseError.input(`Unsafe ZIP path: ${value}`);
  }
  return normalized;
}

export function resolvePart(ownerPart: string, target: string): string {
  const base = path.posix.dirname(normalizePart(ownerPart));
  return normalizePart(path.posix.join(base, target));
}

function relationshipsPart(ownerPart: string): string {
  const normalized = normalizePart(ownerPart);
  return path.posix.join(path.posix.dirname(normalized), '_rels', `${path.posix.basename(normalized)}.rels`);
}

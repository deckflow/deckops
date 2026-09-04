import { DeckParseError } from '../errors/index.js';
import { DECK_IR_SCHEMA_VERSION, type DeckIR, type DeckIrNode } from './schema.js';

/**
 * Dependency-free runtime validation mirroring schemas/deckir.v1.schema.json.
 * Keeping this small avoids loading a general-purpose schema engine at startup.
 */
export function validateDeckIR(value: unknown): DeckIR {
  if (!isRecord(value) || value.schemaVersion !== DECK_IR_SCHEMA_VERSION) {
    throw DeckParseError.input('ir.json does not contain deckir.v1.');
  }
  if (!['pdf', 'pptx', 'docx', 'html', 'keynote'].includes(String(value.format))) {
    throw DeckParseError.input('DeckIR has an unsupported format.');
  }
  if (!isRecord(value.source) || !/^[a-f0-9]{64}$/.test(String(value.source.sha256)) || !isString(value.source.name) || !isNonNegativeInteger(value.source.bytes)) {
    throw DeckParseError.input('DeckIR source metadata is incomplete.');
  }
  if (!isRecord(value.producer) || !['local', 'cloud'].includes(String(value.producer.engine)) || !isString(value.producer.name) || typeof value.producer.version !== 'string') {
    throw DeckParseError.input('DeckIR producer metadata is incomplete.');
  }
  if (!isRecord(value.document) || !isRecord(value.document.metadata) || !Array.isArray(value.document.pages) || !Array.isArray(value.document.nodes) || !Array.isArray(value.document.assets)) {
    throw DeckParseError.input('DeckIR document collections are incomplete.');
  }
  if (!isRecord(value.quality) || !['pass', 'degraded', 'unsupported'].includes(String(value.quality.status)) || !Array.isArray(value.quality.checks) || !isRecord(value.quality.coverage)) {
    throw DeckParseError.input('DeckIR quality report is incomplete.');
  }

  const ids = new Set<string>(); const nodeById = new Map<string, DeckIrNode>();
  for (const raw of value.document.nodes) {
    if (!isNode(raw) || ids.has(raw.id)) {
      throw DeckParseError.input('DeckIR contains an invalid or duplicate node id.');
    }
    ids.add(raw.id);
    nodeById.set(raw.id, raw);
  }
  for (const raw of value.document.nodes as DeckIrNode[]) {
    if (raw.parentId !== null && !ids.has(raw.parentId)) {
      throw DeckParseError.input(`DeckIR node ${raw.id} refers to a missing parent.`);
    }
    if (raw.children.some((id) => !ids.has(id))) {
      throw DeckParseError.input(`DeckIR node ${raw.id} refers to a missing child.`);
    }
    if (raw.parentId !== null && !nodeById.get(raw.parentId)?.children.includes(raw.id)) {
      throw DeckParseError.input(`DeckIR node ${raw.id} is not registered by its parent.`);
    }
    if (raw.children.some((id) => nodeById.get(id)?.parentId !== raw.id)) {
      throw DeckParseError.input(`DeckIR node ${raw.id} has an inconsistent child relationship.`);
    }
  }
  const pageIds = new Set<string>();
  for (const page of value.document.pages) {
    if (!isRecord(page) || !isString(page.id) || pageIds.has(page.id) || !isNonNegativeInteger(page.index) ||
        !Array.isArray(page.nodeIds) || page.nodeIds.some((id) => !isString(id) || !ids.has(id)) || !isRecord(page.sourceRef)) {
      throw DeckParseError.input('DeckIR contains an invalid page index.');
    }
    pageIds.add(page.id);
  }
  const assetIds = new Set<string>(); const assetPaths = new Set<string>();
  for (const asset of value.document.assets) {
    if (!isRecord(asset) || !isString(asset.id) || assetIds.has(asset.id) || !isString(asset.path) || assetPaths.has(asset.path) ||
        !/^assets\/[a-f0-9]{64}(?:\.[a-z0-9]{1,8})?$/.test(asset.path) || !/^[a-f0-9]{64}$/.test(String(asset.hash)) ||
        !isNonNegativeInteger(asset.bytes)) {
      throw DeckParseError.input('DeckIR contains an invalid asset index.');
    }
    assetIds.add(asset.id); assetPaths.add(asset.path);
  }
  return value as unknown as DeckIR;
}
function isNode(value: unknown): value is DeckIrNode {
  return isRecord(value) && isString(value.id) && isString(value.type) &&
    (value.parentId === null || isString(value.parentId)) && Array.isArray(value.children) &&
    value.children.every(isString) && isNonNegativeInteger(value.order) && isRecord(value.sourceRef);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

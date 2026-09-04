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
  if (!isRecord(value.source) || !isString(value.source.sha256) || !isString(value.source.name) || !isNumber(value.source.bytes)) {
    throw DeckParseError.input('DeckIR source metadata is incomplete.');
  }
  if (!isRecord(value.producer) || !['local', 'cloud'].includes(String(value.producer.engine)) || !isString(value.producer.name)) {
    throw DeckParseError.input('DeckIR producer metadata is incomplete.');
  }
  if (!isRecord(value.document) || !Array.isArray(value.document.pages) || !Array.isArray(value.document.nodes) || !Array.isArray(value.document.assets)) {
    throw DeckParseError.input('DeckIR document collections are incomplete.');
  }
  if (!isRecord(value.quality) || !['pass', 'degraded', 'unsupported'].includes(String(value.quality.status)) || !Array.isArray(value.quality.checks)) {
    throw DeckParseError.input('DeckIR quality report is incomplete.');
  }

  const ids = new Set<string>();
  for (const raw of value.document.nodes) {
    if (!isNode(raw) || ids.has(raw.id)) {
      throw DeckParseError.input('DeckIR contains an invalid or duplicate node id.');
    }
    ids.add(raw.id);
  }
  for (const raw of value.document.nodes as DeckIrNode[]) {
    if (raw.parentId !== null && !ids.has(raw.parentId)) {
      throw DeckParseError.input(`DeckIR node ${raw.id} refers to a missing parent.`);
    }
    if (raw.children.some((id) => !ids.has(id))) {
      throw DeckParseError.input(`DeckIR node ${raw.id} refers to a missing child.`);
    }
  }
  return value as unknown as DeckIR;
}
function isNode(value: unknown): value is DeckIrNode {
  return isRecord(value) && isString(value.id) && isString(value.type) &&
    (value.parentId === null || isString(value.parentId)) && Array.isArray(value.children) &&
    value.children.every(isString) && isNumber(value.order) && isRecord(value.sourceRef);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

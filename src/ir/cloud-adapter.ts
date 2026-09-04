import type { ParseResult } from '@deckops/sdk';
import type { ResultArtifact } from 'pdf-lite-parse';
import { stableId } from './ids.js';
import { result3ToDeckIr } from './result3-adapter.js';
import type { CandidateAsset, DeckIrNode, DeckIrPage, DocumentFormat, ParseCandidate } from './schema.js';
import { makeIr, qualityOf, type SourceIdentity } from '../local/common.js';
import type { ParseTaskType } from '../types.js';

export async function cloudResultToCandidate(parsed: ParseResult, source: SourceIdentity): Promise<ParseCandidate> {
  const result3 = findResult3(parsed.ir);
  const assets = await cloudAssets(parsed.ir);
  if (result3) {
    const candidate = result3ToDeckIr({ document: result3, source, assets,
      producer: { engine: 'cloud', name: 'deckflow-cloud', version: '1' } });
    candidate.remote = { taskId: parsed.taskId, irKey: parsed.irKey };
    return candidate;
  }
  const format = formatForType(parsed.type as ParseTaskType);
  const nodes: DeckIrNode[] = [];
  const pages: DeckIrPage[] = [];
  const raw = parsed.ir as Record<string, unknown>;
  const pageItems = format === 'pptx' || format === 'keynote' ? array(raw.slides) : [];
  if (pageItems.length) {
    pageItems.forEach((item, index) => {
      const before = nodes.length;
      walkCloud(item, nodes, source.sha256, `pages/${index}`, index + 1, null);
      pages.push({ id: stableId(source.sha256, `cloud:page:${index}`, 'p'), index: index + 1,
        ...(number(raw.width ?? object(raw.slideSize)?.cx) ? { width: number(raw.width ?? object(raw.slideSize)?.cx) } : {}),
        ...(number(raw.height ?? object(raw.slideSize)?.cy) ? { height: number(raw.height ?? object(raw.slideSize)?.cy) } : {}),
        nodeIds: nodes.slice(before).map((node) => node.id), sourceRef: { page: index + 1, path: `slides/${index}` } });
    });
  } else if (Array.isArray(raw.content)) {
    raw.content.forEach((item, index) => walkCloud(item, nodes, source.sha256, `content/${index}`, undefined, null));
  } else {
    walkCloud(raw, nodes, source.sha256, 'root', undefined, null);
  }
  const quality = qualityOf([], { ...(pages.length ? { pages: { parsed: pages.length, total: pages.length } } : {}),
    objects: { parsed: nodes.length, opaque: 0 }, textCharacters: nodes.reduce((sum, node) => sum + (node.text?.length ?? 0), 0) });
  const ir = makeIr({ format, source, producer: { engine: 'cloud', name: 'deckflow-cloud', version: '1' },
    metadata: { cloudSchemaVersion: parsed.irSchemaVersion }, pages, nodes, assets, quality });
  return { ir, quality, assets, remote: { taskId: parsed.taskId, irKey: parsed.irKey }, warnings: [] };
}

function walkCloud(value: unknown, nodes: DeckIrNode[], hash: string, locator: string, page?: number, parentId: string | null = null): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach((item, index) => walkCloud(item, nodes, hash, `${locator}/${index}`, page, parentId)); return; }
  const record = value as Record<string, unknown>;
  const text = cloudText(record);
  const kind = String(record.type ?? (record.txBody ? 'shape' : record.table ? 'table' : text ? 'text' : 'object')).toLowerCase();
  let nextParent = parentId;
  if (text || ['shape', 'picture', 'image', 'table', 'group', 'chart'].some((token) => kind.includes(token))) {
    const id = stableId(hash, `cloud:${locator}`);
    const xfrm = object(record.xfrm);
    const node: DeckIrNode = { id, type: kind, parentId, children: [], order: nodes.length, ...(text ? { text } : {}),
      ...(page ? { page } : {}), sourceRef: { path: locator, ...(page ? { page } : {}) },
      ...(xfrm && [xfrm.x, xfrm.y, xfrm.cx, xfrm.cy].every((item) => typeof item === 'number') ? { bbox: [xfrm.x as number, xfrm.y as number, xfrm.cx as number, xfrm.cy as number] } : {}),
      extensions: { cloud: { id: record.id, name: record.name, style: record.style } } };
    nodes.push(node); if (parentId) nodes.find((item) => item.id === parentId)?.children.push(id); nextParent = id;
  }
  for (const [key, child] of Object.entries(record)) {
    if (['style', 'xfrm', 'txBody', 'text', 't', 'name', 'id', 'type'].includes(key)) continue;
    if (child && typeof child === 'object') walkCloud(child, nodes, hash, `${locator}/${key}`, page, nextParent);
  }
}

function cloudText(record: Record<string, unknown>): string {
  if (typeof record.text === 'string') return record.text;
  if (typeof record.t === 'string') return record.t;
  const txBody = object(record.txBody);
  if (txBody) return collectText(txBody).join('');
  return '';
}

function collectText(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(collectText);
  const record = value as Record<string, unknown>;
  return [...(typeof record.t === 'string' ? [record.t] : []), ...Object.entries(record).filter(([key]) => key !== 't').flatMap(([, child]) => collectText(child))];
}

async function cloudAssets(ir: unknown): Promise<CandidateAsset[]> {
  const images = object(ir)?.images;
  if (!Array.isArray(images)) return [];
  const result: CandidateAsset[] = [];
  for (const raw of images) {
    const image = object(raw); const url = image && (image.accessURL ?? image.url);
    const assetPath = image && (image.assetPath ?? image.path);
    if (typeof url !== 'string' || typeof assetPath !== 'string') continue;
    try { const response = await fetch(url); if (response.ok) result.push({ path: assetPath, data: new Uint8Array(await response.arrayBuffer()) }); } catch { /* remote reference remains in raw cloud metadata */ }
  }
  return result;
}

function findResult3(ir: unknown): ResultArtifact | undefined {
  const root = object(ir); if (!root) return undefined;
  if ((root.schemaVersion === 'result.v3' || root.version === 'result.v3') && Array.isArray(root.elements) && Array.isArray(root.pages)) return root as unknown as ResultArtifact;
  return findResult3(root.document);
}

function formatForType(type: ParseTaskType): DocumentFormat {
  if (type === 'pdf.pdfParse') return 'pdf'; if (type === 'pptx.parse') return 'pptx';
  if (type === 'docx.parseTextAndImage') return 'docx'; if (type === 'keynote.parseTextAndImage') return 'keynote'; return 'html';
}

function object(value: unknown): Record<string, unknown> | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function number(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }

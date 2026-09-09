import type { Element, Mark, ResultArtifact, Warning } from 'pdf-lite-parse';
import { stableId } from './ids.js';
import type { CandidateAsset, DeckIR, DeckIrNode, ParseCandidate, QualityCheck } from './schema.js';
import { makeIr, qualityOf, type SourceIdentity } from '../local/common.js';

export function result3ToDeckIr(options: {
  document: ResultArtifact;
  source: SourceIdentity;
  assets?: CandidateAsset[];
  producer: { engine: 'local' | 'cloud'; name: string; version: string };
}): ParseCandidate {
  const { document, source } = options;
  const allElements = [...document.elements, ...(document.furniture ?? [])];
  const elementIds = new Map(allElements.map((element) => [element.id, stableId(source.sha256, `pdf:element:${element.id}`)]));
  const nodes: DeckIrNode[] = allElements.map((element) => elementNode(source.sha256, element, elementIds));
  for (const node of nodes) {
    if (node.parentId) nodes.find((candidate) => candidate.id === node.parentId)?.children.push(node.id);
  }
  let nextOrder = Math.max(-1, ...nodes.map((node) => node.order)) + 1;
  for (const element of allElements) {
    if (element.type !== 'table') continue;
    const tableNode = nodes.find((node) => node.id === elementIds.get(element.id));
    if (!tableNode) continue;
    for (let rowIndex = 0; rowIndex < element.table.rows; rowIndex += 1) {
      const rowId = stableId(source.sha256, `pdf:element:${element.id}:row:${rowIndex}`);
      const rowNode: DeckIrNode = {
        id: rowId, type: 'table_row', parentId: tableNode.id, children: [], order: nextOrder++, page: element.page,
        sourceRef: { page: element.page, path: `elements/${element.id}/rows/${rowIndex}` },
      };
      nodes.push(rowNode); tableNode.children.push(rowId);
      for (const cell of element.table.cells.filter((candidate) => candidate.r === rowIndex).sort((a, b) => a.c - b.c)) {
        const cellId = stableId(source.sha256, `pdf:element:${element.id}:cell:${cell.r}:${cell.c}`);
        nodes.push({
          id: cellId, type: 'table_cell', parentId: rowId, children: [], order: nextOrder++, text: cell.text,
          page: cell.page, bbox: cell.bbox, confidence: cell.confidence,
          sourceRef: { page: cell.page, objectIds: cell.sourceObjectIds, path: `elements/${element.id}/cells/${cell.r}/${cell.c}` },
          extensions: { row: cell.r, column: cell.c, rowSpan: cell.rowSpan, gridSpan: cell.colSpan, isHeader: cell.isHeader, role: cell.role, ...(cell.sourceRasters ? { sourceRasters: cell.sourceRasters } : {}) },
        });
        rowNode.children.push(cellId);
      }
    }
  }
  for (const annotation of document.annotations ?? []) {
    nodes.push({
      id: stableId(source.sha256, `pdf:annotation:${annotation.id}`), type: 'annotation', parentId: null, children: [],
      order: nextOrder++, text: annotation.contents, page: annotation.page, bbox: annotation.bbox,
      sourceRef: { page: annotation.page, objectIds: annotation.sourceObjectIds },
      extensions: { subtype: annotation.subtype, target: annotation.target },
    });
  }
  const checks = warningsToChecks(document.warnings ?? [], source.sha256);
  const unknownElements = allElements.filter((element) => element.type === 'unknown');
  if (unknownElements.length) checks.push({
    code: 'unclassified_objects', severity: 'warning', message: `${unknownElements.length} PDF object(s) were preserved without a semantic classification.`,
    pages: [...new Set(unknownElements.map((element) => element.page))],
    nodeIds: unknownElements.map((element) => elementIds.get(element.id)!),
  });
  for (const page of document.pages) {
    if (page.status === 'failed') checks.push({ code: 'page_parse_failed', severity: 'error', pages: [page.index], message: `PDF page ${page.index} could not be parsed.` });
    else if (page.status === 'degraded') checks.push({ code: 'page_degraded', severity: 'warning', pages: [page.index], message: `PDF page ${page.index} was parsed with reduced fidelity.` });
  }
  const textCharacters = nodes.reduce((sum, node) => sum + (node.text?.length ?? 0), 0);
  const textByPage = new Map<number, number>();
  for (const node of nodes) if (node.page !== undefined) textByPage.set(node.page, (textByPage.get(node.page) ?? 0) + (node.text?.trim().length ?? 0));
  const scannedPages = document.pages.filter(page => {
    const characters = textByPage.get(page.index) ?? 0;
    return characters < 20 && page.probe?.imageAreaRatio > 0.9;
  });
  if (scannedPages.length) checks.push({ code: 'ocr_required', severity: 'warning', pages: scannedPages.map(page => page.index),
    message: 'Some pages have a large raster and little extracted text; they may need OCR (image covers can also match).', detail: { method: 'image-text-heuristic' } });
  const quality = qualityOf(dedupeChecks(checks), {
    pages: { parsed: document.pages.filter((page) => page.status !== 'failed').length, total: document.pages.length },
    objects: { parsed: allElements.length - unknownElements.length, opaque: unknownElements.length, total: allElements.length },
    textCharacters,
    sourceObjectCoverage: document.pages.length === 0 ? 0 : document.pages.reduce((sum, page) => sum + page.sourceObjectCoverage, 0) / document.pages.length,
  });
  const pages = document.pages.map((page) => ({
    id: stableId(source.sha256, `pdf:page:${page.index}`, 'p'), index: page.index,
    width: page.width, height: page.height,
    nodeIds: nodes.filter((node) => node.page === page.index).map((node) => node.id),
    sourceRef: { page: page.index },
  }));
  const ir = makeIr({
    format: 'pdf', source,
    producer: options.producer,
    metadata: { ...document.docInfo, outline: document.outline, encrypted: document.source.encrypted },
    pages, nodes, ...(options.assets ? { assets: options.assets } : {}), quality,
  });
  return { ir, quality, assets: options.assets ?? [], warnings: quality.checks.map((check) => check.message) };
}

function elementNode(hash: string, element: Element, ids: Map<string, string>): DeckIrNode {
  const sourceRef = { page: element.page, objectIds: element.sourceObjectIds ?? [], path: `elements/${element.id}`, provenance: element.provenance };
  const node: DeckIrNode = {
    id: ids.get(element.id)!, type: element.type, parentId: element.parentId ? (ids.get(element.parentId) ?? null) : null, children: [],
    order: element.order, text: element.text, page: element.page, bbox: element.bbox, sourceRef,
    confidence: element.confidence,
    ...(element.style ? { style: { ...element.style } } : {}),
  };
  if (element.marks?.length) {
    node.runs = markedRuns(element.text, element.marks);
    const links = element.marks.filter((mark): mark is Extract<Mark, { type: 'link' }> => mark.type === 'link').map((mark) => ({ href: linkHref(mark.target), text: element.text.slice(mark.start, mark.end) }));
    if (links.length) node.links = links;
  }
  node.extensions = {
    ...(element.marks?.length ? { marks: element.marks } : {}),
    ...(element.bboxes ? { bboxes: element.bboxes } : {}),
    ...(element.sourceRasters ? { sourceRasters: element.sourceRasters } : {}),
    ...(element.continuesFrom !== undefined ? { continuesFrom: element.continuesFrom } : {}),
    isBodyContent: element.isBodyContent,
  };
  if (element.type === 'heading') node.extensions = { ...(node.extensions ?? {}), level: element.level };
  if (element.type === 'list' || element.type === 'list_item') node.extensions = { ...(node.extensions ?? {}), list: 'list' in element ? element.list : { marker: element.marker, depth: element.depth } };
  if (element.type === 'table') node.extensions = { ...(node.extensions ?? {}), table: element.table };
  if (element.type === 'figure' || element.type === 'chart') node.extensions = { ...(node.extensions ?? {}), assetPath: element.figure.assetPath, kind: element.figure.kind };
  if (element.type === 'formula') node.extensions = { ...(node.extensions ?? {}), formula: element.formula };
  if (element.type === 'code') node.extensions = { ...(node.extensions ?? {}), language: element.code.language };
  if (element.type === 'caption') node.extensions = { ...(node.extensions ?? {}), captionOf: ids.get(element.captionOf) ?? element.captionOf };
  if ('furnitureKind' in element) node.extensions = { ...(node.extensions ?? {}), furnitureKind: element.furnitureKind };
  if (element.type === 'unknown') node.opaque = { type: 'pdf_unknown', reason: 'Upstream parser could not classify this source object.' };
  return node;
}

function markedRuns(text: string, marks: Mark[]): NonNullable<DeckIrNode['runs']> {
  const points = new Set([0, text.length]);
  for (const mark of marks) { points.add(Math.max(0, Math.min(text.length, mark.start))); points.add(Math.max(0, Math.min(text.length, mark.end))); }
  const ordered = [...points].sort((a, b) => a - b); const runs: NonNullable<DeckIrNode['runs']> = [];
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const start = ordered[index]!; const end = ordered[index + 1]!; if (end <= start) continue;
    const active = marks.filter((mark) => mark.start <= start && mark.end >= end);
    const link = active.find((mark): mark is Extract<Mark, { type: 'link' }> => mark.type === 'link');
    const vertical = active.find((mark) => mark.type === 'sup' || mark.type === 'sub');
    runs.push({ text: text.slice(start, end),
      ...(active.some((mark) => mark.type === 'bold') ? { bold: true } : {}),
      ...(active.some((mark) => mark.type === 'italic') ? { italic: true } : {}),
      ...(active.some((mark) => mark.type === 'underline') ? { underline: true } : {}),
      ...(active.some((mark) => mark.type === 'strike') ? { strike: true } : {}),
      ...(active.some((mark) => mark.type === 'code') ? { code: true } : {}),
      ...(link ? { href: linkHref(link.target) } : {}),
      ...(vertical ? { style: { verticalAlign: vertical.type } } : {}),
    });
  }
  return runs;
}

function linkHref(target: Extract<Mark, { type: 'link' }>['target']): string {
  if (target.kind === 'external') return target.href;
  return target.destination ? `#${target.destination}` : `#page-${target.page ?? 1}`;
}

function warningsToChecks(warnings: Warning[], hash: string): QualityCheck[] {
  return warnings.map((warning) => ({
    code: warningCode(warning.code), severity: warning.severity === 'warn' ? 'warning' : warning.severity,
    message: warning.message,
    ...(warning.scope === 'page' || warning.scope === 'element' ? { pages: [warning.page] } : {}),
    ...(warning.scope === 'element' ? { nodeIds: [stableId(hash, `pdf:element:${warning.elementId}`)] } : {}),
    ...(warning.detail ? { detail: warning.detail } : {}),
  }));
}

function warningCode(code: string): string {
  const mapped: Record<string, string> = {
    NO_TEXT_LAYER: 'ocr_required', BROKEN_TEXT_LAYER: 'ocr_required', TEXT_LAYER_SUSPECT: 'text_layer_suspect',
    FONT_NOT_MAPPABLE: 'font_not_mappable', LAYOUT_UNCERTAIN: 'reading_order_ambiguous',
    TABLE_GRID_UNCLOSED: 'table_ambiguous', RASTERIZER_UNAVAILABLE: 'composite_figure_unavailable',
    SOURCE_OBJECT_LOSS: 'source_object_loss', UNREPRESENTABLE_CONTENT: 'unrepresentable_content',
  };
  return mapped[code] ?? code.toLowerCase();
}

function dedupeChecks(checks: QualityCheck[]): QualityCheck[] {
  const seen = new Set<string>();
  return checks.filter((check) => {
    const key = `${check.code}:${check.message}:${check.pages?.join(',') ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

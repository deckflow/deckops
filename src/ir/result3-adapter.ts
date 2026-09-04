import type { Element, ResultArtifact, Warning } from 'pdf-lite-parse';
import { stableId } from './ids.js';
import type { CandidateAsset, DeckIR, DeckIrNode, ParseCandidate, QualityCheck } from './schema.js';
import { makeIr, qualityOf, type SourceIdentity } from '../local/common.js';

export function result3ToDeckIr(options: {
  document: ResultArtifact;
  source: SourceIdentity;
  assets?: CandidateAsset[];
  producer?: { engine: 'local' | 'cloud'; name: string; version: string };
}): ParseCandidate {
  const { document, source } = options;
  const nodes: DeckIrNode[] = document.elements.map((element) => elementNode(source.sha256, element));
  for (const annotation of document.annotations ?? []) {
    nodes.push({
      id: stableId(source.sha256, `pdf:annotation:${annotation.id}`), type: 'annotation', parentId: null, children: [],
      order: nodes.length, text: annotation.contents, page: annotation.page, bbox: annotation.bbox,
      sourceRef: { page: annotation.page, objectIds: annotation.sourceObjectIds },
      extensions: { subtype: annotation.subtype, target: annotation.target },
    });
  }
  const checks = warningsToChecks(document.warnings ?? [], source.sha256);
  for (const page of document.pages) {
    if (page.status === 'failed') checks.push({ code: 'page_parse_failed', severity: 'error', pages: [page.index], message: `PDF page ${page.index} could not be parsed.` });
    else if (page.status === 'degraded') checks.push({ code: 'page_degraded', severity: 'warning', pages: [page.index], message: `PDF page ${page.index} was parsed with reduced fidelity.` });
  }
  const textCharacters = nodes.reduce((sum, node) => sum + (node.text?.length ?? 0), 0);
  if (document.pages.length > 0 && textCharacters < document.pages.length * 20 && document.pages.some((page) => page.probe?.imageAreaRatio > 0.9)) {
    checks.push({ code: 'ocr_required', severity: 'error', pages: document.pages.filter((page) => page.probe?.imageAreaRatio > 0.9).map((page) => page.index), message: 'The PDF appears scanned and has too little usable text. Local OCR is not included.' });
  }
  const quality = qualityOf(dedupeChecks(checks), {
    pages: { parsed: document.pages.filter((page) => page.status !== 'failed').length, total: document.pages.length },
    objects: { parsed: document.elements.length, opaque: document.elements.filter((element) => element.type === 'unknown').length },
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
    producer: options.producer ?? { engine: 'local', name: 'pdf-lite-parse', version: '0.1.1' },
    metadata: { ...document.docInfo, outline: document.outline, encrypted: document.source.encrypted },
    pages, nodes, ...(options.assets ? { assets: options.assets } : {}), quality,
  });
  return { ir, quality, assets: options.assets ?? [], warnings: quality.checks.map((check) => check.message) };
}

function elementNode(hash: string, element: Element): DeckIrNode {
  const sourceRef = { page: element.page, objectIds: element.sourceObjectIds ?? [], path: `elements/${element.id}` };
  const node: DeckIrNode = {
    id: stableId(hash, `pdf:element:${element.id}`), type: element.type, parentId: null, children: [],
    order: element.order, text: element.text, page: element.page, bbox: element.bbox, sourceRef,
    confidence: element.confidence,
    ...(element.style ? { style: { fontFamily: element.style.fontFamily, fontSize: element.style.fontSize } } : {}),
  };
  if (element.marks?.length) node.extensions = { ...(node.extensions ?? {}), marks: element.marks };
  if (element.type === 'heading') node.extensions = { ...(node.extensions ?? {}), level: element.level };
  if (element.type === 'list' || element.type === 'list_item') node.extensions = { ...(node.extensions ?? {}), list: 'list' in element ? element.list : { marker: element.marker, depth: element.depth } };
  if (element.type === 'table') node.extensions = { ...(node.extensions ?? {}), table: element.table };
  if (element.type === 'figure' || element.type === 'chart') node.extensions = { ...(node.extensions ?? {}), assetPath: element.figure.assetPath, kind: element.figure.kind };
  if (element.type === 'formula') node.extensions = { ...(node.extensions ?? {}), formula: element.formula };
  if (element.type === 'unknown') node.opaque = { type: 'pdf_unknown', reason: 'Upstream parser could not classify this source object.' };
  return node;
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

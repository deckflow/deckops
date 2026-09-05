import { DeckOpsError } from '../../errors/index.js';
import { stableId } from '../../ir/ids.js';
import type { CandidateAsset, DeckIrNode, DeckIrRun, ParseCandidate, QualityCheck } from '../../ir/schema.js';
import { makeIr, mediaTypeForPath, qualityOf, type SourceIdentity } from '../common.js';
import type { LocalLimits } from '../limits.js';
import { OpcPackage, type Relationship } from '../opc/package.js';
import { children, descendants, first, textContent, type XmlNode } from '../xml.js';

interface Context {
  pkg: OpcPackage;
  source: SourceIdentity;
  nodes: DeckIrNode[];
  assets: CandidateAsset[];
  checks: QualityCheck[];
  order: number;
  page: number;
  part: string;
  rels: Map<string, Relationship>;
}

export function parsePptx(data: Uint8Array, source: SourceIdentity, limits: LocalLimits): ParseCandidate {
  const pkg = new OpcPackage(data, limits);
  if (!pkg.has('[Content_Types].xml') || !pkg.has('ppt/presentation.xml')) {
    throw DeckOpsError.input('PPTX package is missing required OOXML parts.');
  }
  const presentation = pkg.xml('ppt/presentation.xml');
  const presentationRels = pkg.relationships('ppt/presentation.xml');
  const sldSz = descendants(presentation, 'sldSz')[0];
  const width = emuToPt(Number(sldSz?.attributes.cx ?? 0));
  const height = emuToPt(Number(sldSz?.attributes.cy ?? 0));
  const slideIds = descendants(presentation, 'sldId');
  const nodes: DeckIrNode[] = [];
  const assets: CandidateAsset[] = [];
  const checks: QualityCheck[] = [];
  const pages = [];
  let order = 0;

  for (const [index, slideId] of slideIds.entries()) {
    // p:sldId carries both numeric id and namespaced r:id; relationship id wins.
    const relId = slideId.attributes['r:id'] ?? slideId.attributes.id;
    const rel = relId ? presentationRels.get(relId) : undefined;
    if (!rel || rel.external || !pkg.has(rel.target)) {
      checks.push({ code: 'missing_slide', severity: 'error', message: `Slide ${index + 1} is missing from the package.`, pages: [index + 1] });
      continue;
    }
    const page = index + 1;
    const before = nodes.length;
    const ctx: Context = { pkg, source, nodes, assets, checks, order, page, part: rel.target, rels: pkg.relationships(rel.target) };
    const slide = pkg.xml(rel.target);
    const tree = descendants(slide, 'spTree')[0];
    if (tree) parseShapeTree(tree, ctx, null);
    parseNotes(ctx);
    auditUnsupportedRelationships(ctx);
    order = ctx.order;
    pages.push({
      id: stableId(source.sha256, `pptx:slide:${rel.target}`, 'p'), index: page,
      ...(width > 0 ? { width } : {}), ...(height > 0 ? { height } : {}),
      nodeIds: nodes.slice(before).filter((node) => node.page === page).map((node) => node.id), sourceRef: { part: rel.target, page },
    });
  }
  for (const part of pkg.names().filter((name) => /(?:^|\/)vbaProject\.bin$/i.test(name))) {
    const id = stableId(source.sha256, `${part}:opaque:vba_project`);
    nodes.push({ id, type: 'opaque', parentId: null, children: [], order: order++, sourceRef: { part }, opaque: { type: 'vba_project', reason: 'VBA is never executed by the local parser.' } });
    checks.push({ code: 'macro_preserved', severity: 'warning', message: 'PPTX contains a VBA project. It was not executed and is preserved as an opaque part.', nodeIds: [id] });
  }
  const opaque = nodes.filter((node) => node.opaque).length;
  const quality = qualityOf(checks, {
    pages: { parsed: pages.length, total: slideIds.length },
    objects: { parsed: nodes.length - opaque, opaque, total: nodes.length },
    textCharacters: nodes.reduce((sum, node) => sum + (node.text?.length ?? 0), 0),
  });
  const ir = makeIr({ format: 'pptx', source, producer: { name: 'deckparse-pptx', version: '1' },
    metadata: { ...readCoreProperties(pkg), slideSize: { width, height }, theme: readTheme(pkg, presentationRels) },
    pages, nodes, assets, quality });
  return { ir, quality, assets, warnings: quality.checks.map((check) => check.message) };
}

function parseShapeTree(tree: XmlNode, ctx: Context, parentId: string | null): void {
  for (const child of tree.children) {
    if (child.local === 'sp' || child.local === 'cxnSp') parseShape(child, ctx, parentId);
    else if (child.local === 'pic') parsePicture(child, ctx, parentId);
    else if (child.local === 'graphicFrame') parseGraphicFrame(child, ctx, parentId);
    else if (child.local === 'grpSp') parseGroup(child, ctx, parentId);
  }
}

function parseShape(shape: XmlNode, ctx: Context, parentId: string | null): void {
  const native = descendants(shape, 'cNvPr')[0];
  const nativeId = native?.attributes.id ?? String(ctx.order);
  const id = stableId(ctx.source.sha256, `${ctx.part}:shape:${nativeId}`);
  const paragraphs = descendants(shape, 'p');
  const runs: DeckIrRun[] = [];
  for (const paragraph of paragraphs) {
    const paragraphRuns = textRuns(paragraph, ctx.rels);
    if (runs.length && paragraphRuns.length) runs.push({ text: '\n' });
    runs.push(...paragraphRuns);
  }
  const text = runs.map((run) => run.text).join('');
  const placeholder = descendants(shape, 'ph')[0];
  const xfrm = descendants(shape, 'xfrm')[0];
  const deckNode: DeckIrNode = {
    id, type: placeholder?.attributes.type === 'title' || placeholder?.attributes.type === 'ctrTitle' ? 'heading' : text ? 'text' : 'shape',
    parentId, children: [], order: ctx.order++, text, runs, page: ctx.page, zIndex: ctx.order,
    sourceRef: { part: ctx.part, page: ctx.page, path: `shape/${nativeId}` },
    ...(bboxOf(xfrm) ? { bbox: bboxOf(xfrm) } : {}),
    extensions: { nativeId, name: native?.attributes.name, placeholder: placeholder ? { ...placeholder.attributes } : undefined,
      rawTransform: rawTransform(xfrm), geometry: descendants(shape, 'prstGeom')[0]?.attributes.prst },
  };
  ctx.nodes.push(deckNode); attach(ctx, parentId, id);
}

function parsePicture(pic: XmlNode, ctx: Context, parentId: string | null): void {
  const native = descendants(pic, 'cNvPr')[0];
  const nativeId = native?.attributes.id ?? String(ctx.order);
  const id = stableId(ctx.source.sha256, `${ctx.part}:picture:${nativeId}`);
  const blip = descendants(pic, 'blip')[0];
  const relId = blip?.attributes.embed ?? blip?.attributes['r:embed'] ?? blip?.attributes.link ?? blip?.attributes['r:link'];
  const rel = relId ? ctx.rels.get(relId) : undefined;
  const node: DeckIrNode = { id, type: 'image', parentId, children: [], order: ctx.order++, text: native?.attributes.descr ?? '',
    page: ctx.page, zIndex: ctx.order, sourceRef: { part: ctx.part, page: ctx.page, ...(relId ? { relationship: relId } : {}), path: `picture/${nativeId}` },
    ...(bboxOf(descendants(pic, 'xfrm')[0]) ? { bbox: bboxOf(descendants(pic, 'xfrm')[0]) } : {}),
    extensions: { nativeId, name: native?.attributes.name, alt: native?.attributes.descr } };
  if (rel?.external) {
    node.extensions = { ...node.extensions, externalUrl: rel.target }; node.issues = ['external_asset'];
    ctx.checks.push({ code: 'external_asset', severity: 'warning', message: `Slide ${ctx.page} contains an externally linked image that was not downloaded.`, pages: [ctx.page], nodeIds: [id] });
  }
  else if (rel && ctx.pkg.has(rel.target)) {
    const bytes = ctx.pkg.readAsset(rel.target);
    ctx.assets.push({ path: rel.target, data: bytes, ...(mediaTypeForPath(rel.target) ? { mediaType: mediaTypeForPath(rel.target) } : {}), sourceRef: { part: ctx.part, relationship: rel.id } });
    node.extensions = { ...node.extensions, assetPath: rel.target };
  } else {
    node.issues = ['missing_media'];
    ctx.checks.push({ code: 'missing_media', severity: 'error', message: `Slide ${ctx.page} contains a picture with missing media.`, pages: [ctx.page], nodeIds: [id] });
  }
  ctx.nodes.push(node); attach(ctx, parentId, id);
}

function parseGraphicFrame(frame: XmlNode, ctx: Context, parentId: string | null): void {
  const native = descendants(frame, 'cNvPr')[0];
  const nativeId = native?.attributes.id ?? String(ctx.order);
  const table = descendants(frame, 'tbl')[0];
  if (table) { parseTable(table, frame, ctx, parentId, nativeId); return; }
  const graphicData = descendants(frame, 'graphicData')[0];
  const uri = graphicData?.attributes.uri ?? '';
  const relElement = descendants(frame, 'chart')[0] ?? descendants(frame, 'relIds')[0];
  const relId = relElement?.attributes.id ?? relElement?.attributes['r:id'] ?? relElement?.attributes.dm ?? relElement?.attributes['r:dm'];
  const rel = relId ? ctx.rels.get(relId) : undefined;
  const kind = /chart/i.test(uri) ? 'chart' : /diagram/i.test(uri) ? 'smartart' : 'graphic_frame';
  const id = stableId(ctx.source.sha256, `${ctx.part}:${kind}:${nativeId}`);
  const visibleText = descendants(frame, 't').map(textContent).join(' ');
  ctx.nodes.push({ id, type: kind, parentId, children: [], order: ctx.order++, text: visibleText, page: ctx.page,
    sourceRef: { part: ctx.part, page: ctx.page, ...(relId ? { relationship: relId } : {}), path: `${kind}/${nativeId}` },
    ...(bboxOf(descendants(frame, 'xfrm')[0]) ? { bbox: bboxOf(descendants(frame, 'xfrm')[0]) } : {}),
    opaque: { type: kind, reason: 'The object and visible text are preserved, but its full semantic model is not expanded.',
      data: { uri, target: rel?.target } }, extensions: { nativeId, name: native?.attributes.name } });
  attach(ctx, parentId, id);
  ctx.checks.push({ code: `${kind}_partial`, severity: 'warning', message: `Slide ${ctx.page} contains ${kind} whose full semantics are not expanded locally.`, pages: [ctx.page], nodeIds: [id] });
}

function parseTable(table: XmlNode, frame: XmlNode, ctx: Context, parentId: string | null, nativeId: string): void {
  const tableId = stableId(ctx.source.sha256, `${ctx.part}:table:${nativeId}`);
  const tableNode: DeckIrNode = { id: tableId, type: 'table', parentId, children: [], order: ctx.order++, page: ctx.page,
    sourceRef: { part: ctx.part, page: ctx.page, path: `table/${nativeId}` },
    ...(bboxOf(descendants(frame, 'xfrm')[0]) ? { bbox: bboxOf(descendants(frame, 'xfrm')[0]) } : {}),
    extensions: { rows: children(table, 'tr').length, columns: children(first(table, 'tblGrid') ?? emptyNode(), 'gridCol').length } };
  ctx.nodes.push(tableNode); attach(ctx, parentId, tableId);
  for (const [rowIndex, row] of children(table, 'tr').entries()) {
    const rowId = stableId(ctx.source.sha256, `${tableId}:row:${rowIndex}`);
    const rowNode: DeckIrNode = { id: rowId, type: 'table_row', parentId: tableId, children: [], order: ctx.order++, page: ctx.page, sourceRef: { part: ctx.part, page: ctx.page, path: `table/${nativeId}/row/${rowIndex}` } };
    ctx.nodes.push(rowNode); tableNode.children.push(rowId);
    for (const [column, cell] of children(row, 'tc').entries()) {
      const cellId = stableId(ctx.source.sha256, `${rowId}:cell:${column}`);
      const cellRuns = descendants(cell, 'p').flatMap((paragraph, index) => [...(index ? [{ text: '\n' }] : []), ...textRuns(paragraph, ctx.rels)]);
      const cellNode: DeckIrNode = { id: cellId, type: 'table_cell', parentId: rowId, children: [], order: ctx.order++, text: cellRuns.map((run) => run.text).join(''), runs: cellRuns, page: ctx.page,
        sourceRef: { part: ctx.part, page: ctx.page, path: `table/${nativeId}/row/${rowIndex}/cell/${column}` },
        extensions: { row: rowIndex, column, rowSpan: Number(cell.attributes.rowSpan ?? 1), gridSpan: Number(cell.attributes.gridSpan ?? 1), hMerge: cell.attributes.hMerge === '1', vMerge: cell.attributes.vMerge === '1' } };
      ctx.nodes.push(cellNode); rowNode.children.push(cellId);
    }
  }
}

function parseGroup(group: XmlNode, ctx: Context, parentId: string | null): void {
  const native = descendants(first(group, 'nvGrpSpPr') ?? emptyNode(), 'cNvPr')[0];
  const nativeId = native?.attributes.id ?? String(ctx.order);
  const id = stableId(ctx.source.sha256, `${ctx.part}:group:${nativeId}`);
  ctx.nodes.push({ id, type: 'group', parentId, children: [], order: ctx.order++, page: ctx.page,
    sourceRef: { part: ctx.part, page: ctx.page, path: `group/${nativeId}` }, extensions: { rawTransform: rawTransform(descendants(group, 'xfrm')[0]) } });
  attach(ctx, parentId, id);
  ctx.checks.push({ code: 'group_transform_partial', severity: 'warning', message: `Slide ${ctx.page} contains a group whose child transforms remain in group-local coordinates.`, pages: [ctx.page], nodeIds: [id] });
  parseShapeTree(group, ctx, id);
}

function parseNotes(ctx: Context): void {
  const rel = [...ctx.rels.values()].find((item) => item.type.endsWith('/notesSlide'));
  if (!rel || rel.external || !ctx.pkg.has(rel.target)) return;
  const root = ctx.pkg.xml(rel.target);
  const rels = ctx.pkg.relationships(rel.target);
  for (const [index, shape] of descendants(root, 'sp').entries()) {
    const placeholder = descendants(shape, 'ph')[0]?.attributes.type;
    if (placeholder === 'sldImg' || placeholder === 'hdr' || placeholder === 'ftr' || placeholder === 'dt' || placeholder === 'sldNum') continue;
    const runs = descendants(shape, 'p').flatMap((p, pIndex) => [...(pIndex ? [{ text: '\n' }] : []), ...textRuns(p, rels)]);
    const text = runs.map((run) => run.text).join('').trim();
    if (!text) continue;
    const id = stableId(ctx.source.sha256, `${rel.target}:note:${index}`);
    ctx.nodes.push({ id, type: 'speaker_note', parentId: null, children: [], order: ctx.order++, text, runs, page: ctx.page, sourceRef: { part: rel.target, page: ctx.page, path: `note/${index}` } });
  }
}

function auditUnsupportedRelationships(ctx: Context): void {
  for (const rel of ctx.rels.values()) {
    const kind = /oleObject|package/i.test(rel.type) ? 'embedded_object' : /audio|video|media/i.test(rel.type) ? 'media' : undefined;
    if (!kind) continue;
    const id = stableId(ctx.source.sha256, `${ctx.part}:opaque:${kind}:${rel.id}`);
    ctx.nodes.push({ id, type: 'opaque', parentId: null, children: [], order: ctx.order++, page: ctx.page,
      sourceRef: { part: ctx.part, page: ctx.page, relationship: rel.id },
      opaque: { type: kind, reason: 'The relationship is preserved but its binary payload is not interpreted.', data: { target: rel.target, external: rel.external } } });
    ctx.checks.push({ code: `${kind}_unsupported`, severity: 'warning', message: `Slide ${ctx.page} contains ${kind === 'media' ? 'audio/video media' : 'an embedded object'} that is not expanded locally.`, pages: [ctx.page], nodeIds: [id] });
  }
}

function textRuns(paragraph: XmlNode, rels: Map<string, Relationship>): DeckIrRun[] {
  const result: DeckIrRun[] = [];
  for (const run of paragraph.children) {
    if (run.local === 'br') { result.push({ text: '\n' }); continue; }
    if (run.local !== 'r' && run.local !== 'fld') continue;
    const text = descendants(run, 't').map(textContent).join('');
    if (!text) continue;
    const rPr = first(run, 'rPr');
    const link = descendants(rPr ?? emptyNode(), 'hlinkClick')[0];
    const relId = link?.attributes.id ?? link?.attributes['r:id'];
    const href = relId ? rels.get(relId)?.target : undefined;
    result.push({ text, ...(rPr?.attributes.b === '1' ? { bold: true } : {}), ...(rPr?.attributes.i === '1' ? { italic: true } : {}),
      ...(rPr?.attributes.u && rPr.attributes.u !== 'none' ? { underline: true } : {}), ...(href ? { href } : {}),
      style: { ...(rPr?.attributes.sz ? { fontSize: Number(rPr.attributes.sz) / 100 } : {}),
        ...(rPr?.attributes.lang ? { lang: rPr.attributes.lang } : {}), ...(first(rPr ?? emptyNode(), 'latin')?.attributes.typeface ? { fontFamily: first(rPr ?? emptyNode(), 'latin')!.attributes.typeface } : {}) } });
  }
  return result;
}

function bboxOf(xfrm?: XmlNode): [number, number, number, number] | undefined {
  if (!xfrm) return undefined;
  const off = first(xfrm, 'off'); const ext = first(xfrm, 'ext');
  if (!off || !ext) return undefined;
  const x = emuToPt(Number(off.attributes.x ?? 0)); const y = emuToPt(Number(off.attributes.y ?? 0));
  return [x, y, x + emuToPt(Number(ext.attributes.cx ?? 0)), y + emuToPt(Number(ext.attributes.cy ?? 0))];
}

function rawTransform(xfrm?: XmlNode): Record<string, unknown> | undefined {
  if (!xfrm) return undefined;
  return { ...xfrm.attributes, off: first(xfrm, 'off')?.attributes, ext: first(xfrm, 'ext')?.attributes,
    childOffset: first(xfrm, 'chOff')?.attributes, childExtent: first(xfrm, 'chExt')?.attributes };
}

function emuToPt(value: number): number { return Math.round(value / 12700 * 1000) / 1000; }

function attach(ctx: Context, parentId: string | null, id: string): void {
  if (parentId) ctx.nodes.find((node) => node.id === parentId)?.children.push(id);
}

function readTheme(pkg: OpcPackage, presentationRels: Map<string, Relationship>): Record<string, unknown> {
  const master = [...presentationRels.values()].find((rel) => rel.type.endsWith('/slideMaster'));
  if (!master || master.external || !pkg.has(master.target)) return {};
  const themeRel = [...pkg.relationships(master.target).values()].find((rel) => rel.type.endsWith('/theme'));
  if (!themeRel || themeRel.external || !pkg.has(themeRel.target)) return {};
  const root = pkg.xml(themeRel.target);
  const scheme = descendants(root, 'clrScheme')[0];
  const colors: Record<string, string> = {};
  for (const color of scheme?.children ?? []) {
    const value = color.children[0]?.attributes.val ?? color.children[0]?.attributes.lastClr;
    if (value) colors[color.local] = value;
  }
  return { name: descendants(root, 'theme')[0]?.attributes.name, colors, part: themeRel.target };
}

function readCoreProperties(pkg: OpcPackage): Record<string, unknown> {
  if (!pkg.has('docProps/core.xml')) return {};
  const root = pkg.xml('docProps/core.xml'); const out: Record<string, unknown> = {};
  for (const key of ['title', 'subject', 'creator', 'description', 'keywords', 'created', 'modified', 'lastModifiedBy']) {
    const value = descendants(root, key)[0]; if (value) out[key] = textContent(value);
  }
  return out;
}

function emptyNode(): XmlNode { return { local: '', uri: '', attributes: {}, children: [], text: '' }; }

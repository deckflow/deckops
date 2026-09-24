import { DeckOpsError } from '../../errors/index.js';
import { stableId } from '../../ir/ids.js';
import type { CandidateAsset, DeckIrNode, DeckIrRun, ParseCandidate, QualityCheck } from '../../ir/schema.js';
import { imageAltText } from '../../ir/alt-text.js';
import {
  bulletDeclaration, levelStyleKey, listParagraphs, resolveList, type BulletDeclaration, type TextParagraph,
} from '../../ir/pptx-lists.js';
import { inheritedPlaceholders, masterTextStyleKey, type PlaceholderEntry, type PlaceholderKey } from '../../ir/pptx-placeholders.js';
import { orderSlideNodes } from '../../ir/slide-order.js';
import { makeIr, packageImageAsset, qualityOf, type SourceIdentity } from '../common.js';
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
  /** 当前形状树坐标 → 幻灯片坐标（pt）。组合的子形状写在组合自己的子画布里，逐层复合。 */
  transform: Transform;
  /** 这一页的版式与母版：占位符没写的位置、项目符号从这里继承。 */
  inheritance: SlideInheritance;
}

/** 版式或母版上的一个占位符：幻灯片占位符可能继承的位置与列表样式。 */
interface InheritedPlaceholder { xfrm: XmlNode | undefined; lstStyle: XmlNode | undefined }

/** 版式、母版各自提供的继承来源；按部件缓存，几十页共用一个版式不必重复解析。 */
interface InheritanceSource {
  placeholders: Array<PlaceholderEntry<InheritedPlaceholder>>;
  textStyles: Partial<Record<'titleStyle' | 'bodyStyle' | 'otherStyle', XmlNode>>;
}

/** 一页幻灯片的继承链：版式占位符 → 母版占位符 → 母版文字样式 → 演示文稿默认样式。 */
interface SlideInheritance {
  layout: InheritanceSource | undefined;
  master: InheritanceSource | undefined;
  defaultTextStyle: XmlNode | undefined;
}

interface Transform { scaleX: number; scaleY: number; translateX: number; translateY: number }

const IDENTITY: Transform = { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 };

/**
 * 版式家具占位符 → 节点类型。页脚、日期、页码每页一份，是母版带下来的版式，不是这一页的内容：
 * 实测一份 99 页讲义，页脚「2: Application Layer」与页码在 Markdown 里各占 92 行。文字仍留在
 * IR 里，只是 Markdown 视图不渲染这几类节点。
 */
const FURNITURE_PLACEHOLDERS: Readonly<Record<string, string>> = { ftr: 'footer', dt: 'footer', hdr: 'header', sldNum: 'page_number' };

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
  const inheritanceSources = new Map<string, InheritanceSource>();
  const defaultTextStyle = descendants(presentation, 'defaultTextStyle')[0];

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
    const rels = pkg.relationships(rel.target);
    const ctx: Context = { pkg, source, nodes, assets, checks, order, page, part: rel.target, rels, transform: IDENTITY,
      inheritance: slideInheritance(pkg, rels, inheritanceSources, defaultTextStyle) };
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
  orderSlideNodes(nodes, pages);
  const opaque = nodes.filter((node) => node.opaque).length;
  const quality = qualityOf(checks, {
    pages: { parsed: pages.length, total: slideIds.length },
    objects: { parsed: nodes.length - opaque, opaque, total: nodes.length },
    textCharacters: nodes.reduce((sum, node) => sum + (node.text?.length ?? 0), 0),
  });
  const ir = makeIr({ format: 'pptx', source, producer: { name: 'deckparse-pptx', version: '4' },
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
  const runs: DeckIrRun[] = [];
  const spans: Array<{ start: number; end: number; pPr: XmlNode | undefined }> = [];
  let length = 0;
  for (const paragraph of descendants(shape, 'p')) {
    const paragraphRuns = textRuns(paragraph, ctx.rels);
    if (!paragraphRuns.length) continue;
    if (runs.length) { runs.push({ text: '\n' }); length += 1; }
    const start = length;
    for (const run of paragraphRuns) { runs.push(run); length += run.text.length; }
    spans.push({ start, end: length, pPr: first(paragraph, 'pPr') });
  }
  const text = runs.map((run) => run.text).join('');
  const placeholder = descendants(shape, 'ph')[0];
  const placeholderType = placeholder?.attributes.type;
  const placeholderKey = placeholder ? keyOf(placeholder) : undefined;
  const inherited = placeholderKey ? inheritedPlaceholders(placeholderKey, ctx.inheritance.layout?.placeholders ?? [], ctx.inheritance.master?.placeholders ?? []) : undefined;
  const xfrm = descendants(shape, 'xfrm')[0];
  // 占位符常常不写自己的位置，照版式或母版上的那一个摆。原先这样的正文没有框，排在整页最后：
  // 实测讲义 21 页的正文跑到了图示标签后面。继承来的框是幻灯片坐标，不经组合换算。
  const ownBbox = bboxOf(xfrm, ctx.transform);
  const layoutBbox = ownBbox ? undefined : bboxOf(inherited?.layout?.xfrm, IDENTITY);
  const masterBbox = ownBbox || layoutBbox ? undefined : bboxOf(inherited?.master?.xfrm, IDENTITY);
  const bbox = ownBbox ?? layoutBbox ?? masterBbox;
  const bboxInheritedFrom = layoutBbox ? 'layout' : masterBbox ? 'master' : undefined;
  // 空的标题占位符不是标题：它没有字，当成 heading 只会在 Markdown 里留下一行空的 `##`。
  const type = text && (placeholderType === 'title' || placeholderType === 'ctrTitle') ? 'heading'
    : (placeholderType && FURNITURE_PLACEHOLDERS[placeholderType]) || (text ? 'text' : 'shape');
  const paragraphs = type === 'text'
    ? listParagraphs(spans.map(({ start, end, pPr }): TextParagraph => {
      const level = Math.min(Math.max(Number(pPr?.attributes.lvl ?? 0) || 0, 0), 8);
      const list = resolveList(bulletChain(pPr, level, shape, placeholderKey, inherited, ctx.inheritance));
      return { start, end, level, ...(list ? { list } : {}) };
    }))
    : undefined;
  const deckNode: DeckIrNode = {
    id, type,
    parentId, children: [], order: ctx.order++, text, runs, page: ctx.page, zIndex: ctx.order,
    sourceRef: { part: ctx.part, page: ctx.page, path: `shape/${nativeId}` },
    ...(bbox ? { bbox } : {}),
    extensions: { nativeId, name: native?.attributes.name, placeholder: placeholder ? { ...placeholder.attributes } : undefined,
      rawTransform: rawTransform(xfrm), geometry: descendants(shape, 'prstGeom')[0]?.attributes.prst,
      ...(bboxInheritedFrom ? { bboxInheritedFrom } : {}), ...(paragraphs ? { paragraphs } : {}) },
  };
  ctx.nodes.push(deckNode); attach(ctx, parentId, id);
}

/**
 * 一个段落的项目符号，按 OOXML 的继承链逐层问：段落自己的 pPr → 形状的 lstStyle →
 * 版式占位符 → 母版占位符 → 母版文字样式 → 演示文稿默认样式。实测讲义的要点全都写在
 * 母版 bodyStyle 里，段落上只有 `lvl`；引导行则在段落上写 `<a:buNone/>` 把它关掉。
 */
function* bulletChain(pPr: XmlNode | undefined, level: number, shape: XmlNode, placeholder: PlaceholderKey | undefined,
  inherited: { layout: InheritedPlaceholder | undefined; master: InheritedPlaceholder | undefined } | undefined, slide: SlideInheritance): Generator<BulletDeclaration> {
  const key = levelStyleKey(level);
  yield declaredBullet(pPr);
  yield declaredBullet(levelOf(first(first(shape, 'txBody') ?? emptyNode(), 'lstStyle'), key));
  yield declaredBullet(levelOf(inherited?.layout?.lstStyle, key));
  yield declaredBullet(levelOf(inherited?.master?.lstStyle, key));
  yield declaredBullet(levelOf(slide.master?.textStyles[masterTextStyleKey(placeholder)], key));
  yield declaredBullet(levelOf(slide.defaultTextStyle, key));
}

function declaredBullet(pPr: XmlNode | undefined): BulletDeclaration {
  if (!pPr) return undefined;
  return bulletDeclaration({
    none: Boolean(first(pPr, 'buNone')),
    autoNumber: Boolean(first(pPr, 'buAutoNum')?.attributes.type),
    character: Boolean(first(pPr, 'buChar')?.attributes.char),
    picture: Boolean(first(pPr, 'buBlip')),
  });
}

function levelOf(list: XmlNode | undefined, key: string): XmlNode | undefined {
  return list ? first(list, key) : undefined;
}

function keyOf(placeholder: XmlNode): PlaceholderKey {
  return { type: placeholder.attributes.type, idx: placeholder.attributes.idx };
}

function slideInheritance(pkg: OpcPackage, slideRels: Map<string, Relationship>, cache: Map<string, InheritanceSource>, defaultTextStyle: XmlNode | undefined): SlideInheritance {
  const related = (rels: Map<string, Relationship>, suffix: string): string | undefined => {
    const rel = [...rels.values()].find((item) => item.type.endsWith(suffix) && !item.external && pkg.has(item.target));
    return rel?.target;
  };
  const source = (part: string | undefined): InheritanceSource | undefined => {
    if (!part) return undefined;
    let cached = cache.get(part);
    if (!cached) { cached = readInheritanceSource(pkg.xml(part)); cache.set(part, cached); }
    return cached;
  };
  const layoutPart = related(slideRels, '/slideLayout');
  const masterPart = layoutPart ? related(pkg.relationships(layoutPart), '/slideMaster') : undefined;
  return { layout: source(layoutPart), master: source(masterPart), defaultTextStyle };
}

function readInheritanceSource(root: XmlNode): InheritanceSource {
  const tree = descendants(root, 'spTree')[0];
  const placeholders = (tree ? descendants(tree, 'sp') : []).flatMap((sp): Array<PlaceholderEntry<InheritedPlaceholder>> => {
    const placeholder = descendants(sp, 'ph')[0];
    return placeholder ? [{ key: keyOf(placeholder), value: {
      xfrm: first(first(sp, 'spPr') ?? emptyNode(), 'xfrm'),
      lstStyle: first(first(sp, 'txBody') ?? emptyNode(), 'lstStyle'),
    } }] : [];
  });
  const txStyles = descendants(root, 'txStyles')[0];
  const textStyles: InheritanceSource['textStyles'] = {};
  for (const name of ['titleStyle', 'bodyStyle', 'otherStyle'] as const) {
    const style = txStyles ? first(txStyles, name) : undefined;
    if (style) textStyles[name] = style;
  }
  return { placeholders, textStyles };
}

function parsePicture(pic: XmlNode, ctx: Context, parentId: string | null): void {
  const native = descendants(pic, 'cNvPr')[0];
  const nativeId = native?.attributes.id ?? String(ctx.order);
  const id = stableId(ctx.source.sha256, `${ctx.part}:picture:${nativeId}`);
  const blip = descendants(pic, 'blip')[0];
  const relId = blip?.attributes.embed ?? blip?.attributes['r:embed'] ?? blip?.attributes.link ?? blip?.attributes['r:link'];
  const rel = relId ? ctx.rels.get(relId) : undefined;
  // 替代文字只收作者写的描述；网址、文件路径、剪贴画缓存名这类原文留在 descr 里。
  const descr = native?.attributes.descr;
  const alt = imageAltText(descr);
  const node: DeckIrNode = { id, type: 'image', parentId, children: [], order: ctx.order++, text: alt ?? '',
    page: ctx.page, zIndex: ctx.order, sourceRef: { part: ctx.part, page: ctx.page, ...(relId ? { relationship: relId } : {}), path: `picture/${nativeId}` },
    ...(bboxOf(descendants(pic, 'xfrm')[0], ctx.transform) ? { bbox: bboxOf(descendants(pic, 'xfrm')[0], ctx.transform) } : {}),
    extensions: { nativeId, name: native?.attributes.name, ...(alt ? { alt } : {}), ...(descr ? { descr } : {}) } };
  if (rel?.external) {
    node.extensions = { ...node.extensions, externalUrl: rel.target }; node.issues = ['external_asset'];
    ctx.checks.push({ code: 'external_asset', severity: 'warning', message: `Slide ${ctx.page} contains an externally linked image that was not downloaded.`, pages: [ctx.page], nodeIds: [id] });
  }
  else if (rel && ctx.pkg.has(rel.target)) {
    const bytes = ctx.pkg.readAsset(rel.target);
    const asset = packageImageAsset(rel.target, bytes);
    ctx.assets.push({ ...asset, data: bytes, sourceRef: { part: ctx.part, relationship: rel.id } });
    node.extensions = { ...node.extensions, assetPath: asset.path };
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
    ...(bboxOf(descendants(frame, 'xfrm')[0], ctx.transform) ? { bbox: bboxOf(descendants(frame, 'xfrm')[0], ctx.transform) } : {}),
    opaque: { type: kind, reason: 'The object and visible text are preserved, but its full semantic model is not expanded.',
      data: { uri, target: rel?.target } }, extensions: { nativeId, name: native?.attributes.name } });
  attach(ctx, parentId, id);
  ctx.checks.push({ code: `${kind}_partial`, severity: 'warning', message: `Slide ${ctx.page} contains ${kind} whose full semantics are not expanded locally.`, pages: [ctx.page], nodeIds: [id] });
}

function parseTable(table: XmlNode, frame: XmlNode, ctx: Context, parentId: string | null, nativeId: string): void {
  const tableId = stableId(ctx.source.sha256, `${ctx.part}:table:${nativeId}`);
  const tableNode: DeckIrNode = { id: tableId, type: 'table', parentId, children: [], order: ctx.order++, page: ctx.page,
    sourceRef: { part: ctx.part, page: ctx.page, path: `table/${nativeId}` },
    ...(bboxOf(descendants(frame, 'xfrm')[0], ctx.transform) ? { bbox: bboxOf(descendants(frame, 'xfrm')[0], ctx.transform) } : {}),
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
  const xfrm = first(first(group, 'grpSpPr') ?? emptyNode(), 'xfrm');
  const bbox = bboxOf(xfrm, ctx.transform);
  ctx.nodes.push({ id, type: 'group', parentId, children: [], order: ctx.order++, page: ctx.page, zIndex: ctx.order,
    sourceRef: { part: ctx.part, page: ctx.page, path: `group/${nativeId}` }, ...(bbox ? { bbox } : {}),
    extensions: { rawTransform: rawTransform(xfrm) } });
  attach(ctx, parentId, id);
  // 平移与缩放按子画布换算成幻灯片坐标；旋转与翻转没有换算，那样的组合里子形状的框只是近似。
  const rotated = Number(xfrm?.attributes.rot ?? 0) !== 0 || xfrm?.attributes.flipH === '1' || xfrm?.attributes.flipV === '1';
  if (rotated) {
    ctx.checks.push({ code: 'group_transform_partial', severity: 'warning', message: `Slide ${ctx.page} contains a rotated or flipped group; its children's positions are approximate.`, pages: [ctx.page], nodeIds: [id] });
  }
  const parentTransform = ctx.transform;
  ctx.transform = childTransform(xfrm, parentTransform);
  try { parseShapeTree(group, ctx, id); } finally { ctx.transform = parentTransform; }
}

/**
 * 组合的子画布：子形状的坐标写在 `chOff`/`chExt` 定义的空间里，按 `off`/`ext` 映射回组合外框。
 * 原先直接用子形状自己的 `xfrm`，框落在另一套坐标里，既不能按位置排序，也让每个组合都报
 * `group_transform_partial`（实测一份 99 页讲义 339 个组合，整份产物因此判成 degraded）。
 */
function childTransform(xfrm: XmlNode | undefined, parent: Transform): Transform {
  if (!xfrm) return parent;
  const off = first(xfrm, 'off'); const ext = first(xfrm, 'ext');
  const chOff = first(xfrm, 'chOff'); const chExt = first(xfrm, 'chExt');
  if (!off || !ext || !chOff || !chExt) return parent;
  const scale = (outer: string | undefined, inner: string | undefined): number => {
    const extent = Number(inner ?? 0);
    return extent > 0 ? Number(outer ?? 0) / extent : 1;
  };
  const scaleX = scale(ext.attributes.cx, chExt.attributes.cx);
  const scaleY = scale(ext.attributes.cy, chExt.attributes.cy);
  const offsetX = emuToPt(Number(off.attributes.x ?? 0)) - emuToPt(Number(chOff.attributes.x ?? 0)) * scaleX;
  const offsetY = emuToPt(Number(off.attributes.y ?? 0)) - emuToPt(Number(chOff.attributes.y ?? 0)) * scaleY;
  return {
    scaleX: parent.scaleX * scaleX,
    scaleY: parent.scaleY * scaleY,
    translateX: parent.translateX + parent.scaleX * offsetX,
    translateY: parent.translateY + parent.scaleY * offsetY,
  };
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

function bboxOf(xfrm: XmlNode | undefined, transform: Transform): [number, number, number, number] | undefined {
  if (!xfrm) return undefined;
  const off = first(xfrm, 'off'); const ext = first(xfrm, 'ext');
  if (!off || !ext) return undefined;
  const x = emuToPt(Number(off.attributes.x ?? 0)); const y = emuToPt(Number(off.attributes.y ?? 0));
  const round = (value: number): number => Math.round(value * 1000) / 1000;
  return [
    round(transform.translateX + transform.scaleX * x),
    round(transform.translateY + transform.scaleY * y),
    round(transform.translateX + transform.scaleX * (x + emuToPt(Number(ext.attributes.cx ?? 0)))),
    round(transform.translateY + transform.scaleY * (y + emuToPt(Number(ext.attributes.cy ?? 0)))),
  ];
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

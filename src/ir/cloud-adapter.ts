import pLimit from 'p-limit';
import type { ParseResult } from '../cloud/parse-facade.js';
import type { ResultArtifact } from '@deckflow/pdf-lite-parse';
import { imageAltText } from './alt-text.js';
import { stableId } from './ids.js';
import {
  bulletDeclaration, levelStyleKey, listParagraphs, resolveList, type BulletDeclaration, type TextParagraph,
} from './pptx-lists.js';
import { inheritedPlaceholders, masterTextStyleKey, type PlaceholderEntry, type PlaceholderKey } from './pptx-placeholders.js';
import { result3ToDeckIr } from './result3-adapter.js';
import type { CandidateAsset, DeckIrNode, DeckIrPage, DeckIrRun, DocumentFormat, ParseCandidate, QualityCheck } from './schema.js';
import { orderSlideNodes } from './slide-order.js';
import { makeIr, qualityOf, type SourceIdentity } from '../local/common.js';
import type { ParseTaskType } from '../types.js';

export async function cloudResultToCandidate(parsed: ParseResult, source: SourceIdentity, signal?: AbortSignal): Promise<ParseCandidate> {
  const result3 = findResult3(parsed.ir);
  const assets = await cloudAssets(parsed.ir, signal);
  if (result3) {
    const candidate = result3ToDeckIr({ document: result3, source, assets,
      producer: { engine: 'cloud', name: 'deckflow-cloud', version: cloudProducerVersion('pdf') } });
    candidate.remote = { taskId: parsed.taskId, irKey: parsed.irKey };
    return candidate;
  }
  const format = formatForType(parsed.type as ParseTaskType);
  const nodes: DeckIrNode[] = [];
  const sink: CloudNodeSink = { nodes, byId: new Map() };
  const pages: DeckIrPage[] = [];
  const raw = parsed.ir as Record<string, unknown>;
  const pageItems = format === 'pptx' || format === 'keynote' ? array(raw.slides) : [];
  // pptx 的坐标是 EMU，本地解析器给的是 pt；同一份文件换引擎，框的单位不能跟着变。
  const pageTransform = format === 'pptx' ? EMU_TO_PT : IDENTITY;
  const pageSize = (value: unknown): number | undefined => {
    const size = number(value);
    return size === undefined ? undefined : round(size * pageTransform.scaleX);
  };
  if (pageItems.length) {
    pageItems.forEach((item, index) => {
      const before = nodes.length;
      const styles = format === 'pptx' ? slideInheritance(raw, object(item)) : undefined;
      walkCloud(item, sink, source.sha256, `pages/${index}`, index + 1, null, pageTransform, styles);
      pages.push({ id: stableId(source.sha256, `cloud:page:${index}`, 'p'), index: index + 1,
        ...(pageSize(raw.width ?? object(raw.slideSize)?.cx) ? { width: pageSize(raw.width ?? object(raw.slideSize)?.cx) } : {}),
        ...(pageSize(raw.height ?? object(raw.slideSize)?.cy) ? { height: pageSize(raw.height ?? object(raw.slideSize)?.cy) } : {}),
        nodeIds: nodes.slice(before).map((node) => node.id), sourceRef: { page: index + 1, path: `slides/${index}` } });
    });
    if (format === 'pptx') {
      for (const node of nodes) node.zIndex = node.order;
      orderSlideNodes(nodes, pages);
    }
  } else if (Array.isArray(raw.content)) {
    raw.content.forEach((item, index) => walkCloud(item, sink, source.sha256, `content/${index}`, undefined, null));
  } else {
    walkCloud(raw, sink, source.sha256, 'root', undefined, null);
  }
  const checks: QualityCheck[] = [];
  if (nodes.length === 0) checks.push({ code: 'cloud_schema_unmapped', severity: 'error', message: `Cloud schema ${parsed.irSchemaVersion} did not contain mappable document nodes.` });
  let quality = qualityOf(checks, { ...(pages.length ? { pages: { parsed: pages.length, total: pages.length } } : {}),
    objects: { parsed: nodes.length, opaque: 0 }, textCharacters: nodes.reduce((sum, node) => sum + (node.text?.length ?? 0), 0) });
  const ir = makeIr({ format, source, producer: { engine: 'cloud', name: 'deckflow-cloud', version: cloudProducerVersion(format) },
    metadata: { cloudSchemaVersion: parsed.irSchemaVersion }, pages, nodes, assets, quality });
  const availableAssets = new Set(ir.document.assets.map((asset) => asset.path));
  for (const node of ir.document.nodes) {
    // 图片形状指着包里的媒体，云端结果却没有给出这张图：原先悄无声息地少一张图（实测两张存成
    // `.tmp` 的 PNG 被后端按扩展名筛掉）。
    const mediaRef = node.extensions?.mediaRef;
    if (typeof mediaRef === 'string') {
      node.issues = [...(node.issues ?? []), 'missing_media'];
      checks.push({ code: 'cloud_asset_missing', severity: 'warning', message: `The cloud result does not include the image ${mediaRef} that a picture refers to.`, ...(node.page ? { pages: [node.page] } : {}), nodeIds: [node.id] });
    }
    const assetPath = node.extensions?.assetPath;
    if (typeof assetPath !== 'string' || availableAssets.has(assetPath)) continue;
    delete node.extensions!.assetPath;
    node.issues = [...(node.issues ?? []), 'missing_media'];
    checks.push({ code: 'cloud_asset_unavailable', severity: 'warning', message: 'A cloud asset could not be materialized into the durable artifact.', nodeIds: [node.id] });
  }
  quality = qualityOf(checks, quality.coverage); ir.quality = quality;
  return { ir, quality, assets, remote: { taskId: parsed.taskId, irKey: parsed.irKey }, warnings: quality.checks.map((check) => check.message) };
}

/**
 * 云端适配器的产物版本，按格式分开：parse-op 按主版本判断缓存能不能复用，缓存失效就要重新提交
 * 云端任务（计费）。只有产物真变了的格式才升版本：pptx 3 加了列表结构，4 加了继承的占位符
 * 位置与图片替代文字；其余格式仍是 2。
 */
export function cloudProducerVersion(format: string | undefined): string {
  return format === 'pptx' ? '4' : '2';
}

/**
 * 收集遍历产出的节点。
 *
 * 除了数组还带一份 id → 节点的索引：建父子关系原本是 `nodes.find()`，每建一个节点线性
 * 扫一遍全表，在几千节点的文档上是平方级开销（实测一份 99 页文档 2838 个节点）。
 */
interface CloudNodeSink {
  nodes: DeckIrNode[];
  byId: Map<string, DeckIrNode>;
}

function push(sink: CloudNodeSink, node: DeckIrNode): void {
  sink.nodes.push(node);
  sink.byId.set(node.id, node);
}

/** 形状树坐标 → 页面坐标：先缩放再平移。组合的子形状写在组合自己的子画布里，逐层复合。 */
interface Transform { scaleX: number; scaleY: number; translateX: number; translateY: number }

const IDENTITY: Transform = { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 };
const EMU_PER_PT = 12700;
const EMU_TO_PT: Transform = { scaleX: 1 / EMU_PER_PT, scaleY: 1 / EMU_PER_PT, translateX: 0, translateY: 0 };

/**
 * 组合的子画布（`chX`/`chY`/`chCX`/`chCY`）映射回组合外框（`x`/`y`/`cx`/`cy`）。原先直接用
 * 子形状自己的 xfrm，组合里的框与页面上的框落在两套坐标里（实测同一页出现
 * `[3268, 2846, …]` 与 `[952500, 1138238, …]`），按位置排序无从谈起。
 */
function groupTransform(xfrm: Record<string, unknown> | undefined, parent: Transform): Transform {
  const x = number(xfrm?.x); const y = number(xfrm?.y); const cx = number(xfrm?.cx); const cy = number(xfrm?.cy);
  const chX = number(xfrm?.chX) ?? 0; const chY = number(xfrm?.chY) ?? 0;
  const chCX = number(xfrm?.chCX); const chCY = number(xfrm?.chCY);
  if (x === undefined || y === undefined || cx === undefined || cy === undefined || !chCX || !chCY) return parent;
  const scaleX = cx / chCX; const scaleY = cy / chCY;
  return {
    scaleX: parent.scaleX * scaleX,
    scaleY: parent.scaleY * scaleY,
    translateX: parent.translateX + parent.scaleX * (x - chX * scaleX),
    translateY: parent.translateY + parent.scaleY * (y - chY * scaleY),
  };
}

function transformedBbox(xfrm: Record<string, unknown> | undefined, transform: Transform): [number, number, number, number] | undefined {
  const x = number(xfrm?.x); const y = number(xfrm?.y); const cx = number(xfrm?.cx); const cy = number(xfrm?.cy);
  if (x === undefined || y === undefined || cx === undefined || cy === undefined) return undefined;
  return [
    round(transform.translateX + transform.scaleX * x),
    round(transform.translateY + transform.scaleY * y),
    round(transform.translateX + transform.scaleX * (x + cx)),
    round(transform.translateY + transform.scaleY * (y + cy)),
  ];
}

function round(value: number): number { return Math.round(value * 1000) / 1000; }

function walkCloud(value: unknown, sink: CloudNodeSink, hash: string, locator: string, page?: number, parentId: string | null = null, transform: Transform = IDENTITY, styles?: SlideInheritance): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach((item, index) => walkCloud(item, sink, hash, `${locator}/${index}`, page, parentId, transform, styles)); return; }
  const record = value as Record<string, unknown>;
  const text = cloudText(record);
  const kind = cloudKind(record, text);
  let nextParent = parentId;
  const skipKeys = new Set<string>(WALK_SKIP_KEYS);
  const xfrm = object(record.xfrm);
  if (text || ['shape', 'picture', 'image', 'table', 'group', 'chart'].some((token) => kind.includes(token)) || FURNITURE_KINDS.has(kind)) {
    const id = stableId(hash, `cloud:${locator}`);
    const placeholder = object(record.ph);
    const placeholderKey = placeholder ? cloudPlaceholderKey(placeholder) : undefined;
    const inherited = placeholderKey && styles ? inheritedPlaceholders(placeholderKey, styles.layoutPlaceholders, styles.masterPlaceholders) : undefined;
    // 占位符没写位置就照版式、再照母版上的那一个摆，与本地解析器一致；继承来的框是页面坐标。
    const ownBbox = transformedBbox(xfrm, transform);
    const layoutBbox = ownBbox ? undefined : transformedBbox(object(inherited?.layout?.xfrm), EMU_TO_PT);
    const masterBbox = ownBbox || layoutBbox ? undefined : transformedBbox(object(inherited?.master?.xfrm), EMU_TO_PT);
    const bbox = ownBbox ?? layoutBbox ?? masterBbox;
    const bboxInheritedFrom = layoutBbox ? 'layout' : masterBbox ? 'master' : undefined;
    const runs = text ? cloudRuns(record, text) : undefined;
    // 只认解析器明确给出的资产指针。`path` 曾经也在这条兜底链上，但在 pptx 里它是自选
    // 图形的几何路径（`"M 0 0 L 10 10 Z"`），任何 Freeform 都会因此被判成「指向不存在的
    // 资产」，凭空产出一条 cloud_asset_unavailable 并把 quality 顶成 degraded。
    const assetPath = string(record.assetPath ?? record.suggestedPath);
    const externalUrl = string(record.accessURL ?? record.url);
    // 段落范围按 runs 切，runs 与 text 对不上时一并不给。
    const paragraphs = kind === 'text' && runs && styles ? cloudListParagraphs(record, styles, placeholderKey, inherited) : undefined;
    // 图片的替代文字与本地解析器同一套清洗；原文留在 descr。
    const descr = kind === 'picture' ? string(record.descr) : undefined;
    const alt = imageAltText(descr);
    const mediaRef = kind === 'picture' && !assetPath && !externalUrl ? string(object(record.picture)?.blip) : undefined;
    const node: DeckIrNode = { id, type: kind, parentId, children: [], order: sink.nodes.length, ...(text ? { text } : alt ? { text: alt } : {}),
      ...(runs ? { runs } : {}), ...(page ? { page } : {}), sourceRef: { path: locator, ...(page ? { page } : {}) },
      ...(bbox ? { bbox } : {}),
      extensions: { cloud: { id: record.id, name: record.name, style: record.style }, ...(placeholder ? { placeholder } : {}),
        ...(bboxInheritedFrom ? { bboxInheritedFrom } : {}), ...(assetPath ? { assetPath } : {}), ...(externalUrl ? { externalUrl } : {}),
        ...(alt ? { alt } : {}), ...(descr ? { descr } : {}), ...(mediaRef ? { mediaRef } : {}), ...(paragraphs ? { paragraphs } : {}) } };
    push(sink, node); if (parentId) sink.byId.get(parentId)?.children.push(id); nextParent = id;
    // 表格必须按 table → table_row → table_cell 发，和 local/pptx、local/docx、result3 三个
    // 适配器一致：Markdown 渲染器只认这三种类型，让通用遍历把单元格摊成一串 shape 子节点，
    // 整张表会在渲染时被静默丢掉——IR 里看得见，产物里一个字都没有。
    if (kind.includes('table') && emitCloudTable(record, node, sink, hash, locator, page)) {
      skipKeys.add('table');
    }
  }
  const childTransform = kind === 'group' ? groupTransform(xfrm, transform) : transform;
  for (const [key, child] of Object.entries(record)) {
    if (skipKeys.has(key)) continue;
    if (child && typeof child === 'object') walkCloud(child, sink, hash, `${locator}/${key}`, page, nextParent, key === 'children' ? childTransform : transform, styles);
  }
}

/**
 * 遍历时不再下钻的键：要么已在节点上表达，要么由更专门的分支接管。
 *
 * `prstGeom` 是预设几何描述符，和 `style` / `xfrm` 一样描述的是形状怎么画，不是内容。
 * 下钻进去会凭空造出节点：它自带 `type`（如 `flowChartMagneticDisk`），而建节点的判据是
 * 子串命中 —— "flowchart…" 里就含着 "chart"。实测一份文档因此多出 18 个空节点，还把
 * 「产物是否表示了图表」的判断带偏。
 */
const WALK_SKIP_KEYS = ['style', 'xfrm', 'txBody', 'text', 't', 'name', 'id', 'type', 'prstGeom'] as const;

/**
 * 把云端表格结构展开成行列节点；认不出行列就返回 false，交回通用遍历。
 *
 * 行与单元格的键名各格式不同（pptx 是 `table.trs[].cells[]`），所以按候选键取第一个命中的，
 * 而不是写死某一种格式。
 */
function emitCloudTable(
  record: Record<string, unknown>,
  table: DeckIrNode,
  sink: CloudNodeSink,
  hash: string,
  locator: string,
  page?: number,
): boolean {
  const container = object(record.table) ?? record;
  const rows = array(container.trs ?? container.rows).map((row) =>
    array(object(row)?.cells ?? object(row)?.tcs).flatMap((cell) => {
      const parsed = object(cell);
      return parsed ? [parsed] : [];
    }));
  if (!rows.some((cells) => cells.length > 0)) return false;
  table.extensions = { ...table.extensions, rows: rows.length,
    columns: Math.max(...rows.map((cells) => cells.length)) };
  rows.forEach((cells, rowIndex) => {
    const rowLocator = `${locator}/row/${rowIndex}`;
    const rowId = stableId(hash, `cloud:${rowLocator}`);
    const row: DeckIrNode = { id: rowId, type: 'table_row', parentId: table.id, children: [], order: sink.nodes.length,
      ...(page ? { page } : {}), sourceRef: { path: rowLocator, ...(page ? { page } : {}) } };
    push(sink, row); table.children.push(rowId);
    cells.forEach((cell, column) => {
      const cellLocator = `${rowLocator}/cell/${column}`;
      const cellId = stableId(hash, `cloud:${cellLocator}`);
      const text = cloudText(cell);
      const runs = text ? cloudRuns(cell, text) : undefined;
      push(sink, { id: cellId, type: 'table_cell', parentId: rowId, children: [], order: sink.nodes.length,
        ...(text ? { text } : {}), ...(runs ? { runs } : {}), ...(page ? { page } : {}),
        sourceRef: { path: cellLocator, ...(page ? { page } : {}) },
        extensions: { row: rowIndex, column,
          gridSpan: number(cell.colSpan ?? cell.gridSpan) ?? 1, rowSpan: number(cell.rowSpan) ?? 1,
          ...(cell.hMerge === true ? { hMerge: true } : {}), ...(cell.vMerge === true ? { vMerge: true } : {}) } });
      row.children.push(cellId);
    });
  });
  return true;
}

/**
 * 节点类型。
 *
 * 解析器自报的 `type` 是它的形状分类（pptx 一律是 "Shape"），不是文档语义：整篇因此落成
 * 清一色的 shape，Markdown 一个标题都没有（实测 99 页文档本地 96 个 heading、云端 0 个）。
 * 占位符类型才是 OOXML 里「这是标题」的确定性证据，与 local/pptx/parser.ts 用的是同一条
 * 判据 —— 两个引擎的产物必须在这件事上对得上，否则同一份文件换引擎结构就变了。
 *
 * 只在有文字时改判，空的标题占位符仍按原类型走：那些节点靠类型词命中才得以建出来，
 * 改成 heading 会让它们从 IR 里整个消失。
 */
function cloudKind(record: Record<string, unknown>, text: string): string {
  const placeholder = string(object(record.ph)?.type);
  const declared = string(record.type)?.toLowerCase();
  if (text && (placeholder === 'title' || placeholder === 'ctrTitle')) return 'heading';
  if (placeholder && FURNITURE_PLACEHOLDERS[placeholder]) return FURNITURE_PLACEHOLDERS[placeholder]!;
  if (text && declared === 'shape') return 'text';
  return declared ?? (record.txBody ? 'shape' : record.table ? 'table' : text ? 'text' : 'object');
}

/**
 * 版式家具占位符 → 节点类型，与 local/pptx/parser.ts 同一张表。页脚、日期、页码每页一份，
 * 实测一份 99 页讲义的页脚在 Markdown 里占了 92 行；文字留在 IR，Markdown 视图不渲染。
 */
const FURNITURE_PLACEHOLDERS: Readonly<Record<string, string>> = { ftr: 'footer', dt: 'footer', hdr: 'header', sldNum: 'page_number' };
const FURNITURE_KINDS: ReadonlySet<string> = new Set(Object.values(FURNITURE_PLACEHOLDERS));

/**
 * 文字的格式（粗体、斜体、下划线、删除线）。云端 IR 的 `txBody` 里每个文本运行带着样式，
 * 原先只取纯文本，本地产物有的强调云端一处都没有（实测同一份讲义本地 234 个带格式的运行）。
 *
 * 段落之间与 `text` 一样用换行连接、跳过空段落；拼出来与 `text` 不一字不差就不给 runs——
 * runs 是 text 的另一种切分，两者不一致时读方无从判断该信哪个。
 */
function cloudRuns(record: Record<string, unknown>, text: string): DeckIrRun[] | undefined {
  const paragraphs = cloudParagraphs(record);
  if (paragraphs.length === 0) return undefined;
  const runs: DeckIrRun[] = [];
  paragraphs.forEach((paragraph, index) => {
    if (index > 0) runs.push({ text: '\n' });
    for (const run of paragraph.runs) {
      const style = object(run.style);
      const underline = string(style?.u);
      const strike = string(style?.strike);
      runs.push({ text: run.t as string,
        ...(style?.b === true ? { bold: true } : {}), ...(style?.i === true ? { italic: true } : {}),
        ...(underline && underline !== 'none' ? { underline: true } : {}),
        ...(strike && strike !== 'noStrike' ? { strike: true } : {}) });
    }
  });
  return runs.map((run) => run.text).join('') === text ? runs : undefined;
}

/** 有文本运行的段落，与 `text`、`cloudRuns` 同一种切法：跳过空段落。 */
function cloudParagraphs(record: Record<string, unknown>): Array<{ style: Record<string, unknown> | undefined; runs: Array<Record<string, unknown>> }> {
  return array(object(record.txBody)?.children).flatMap((raw) => {
    const paragraph = object(raw);
    const runs = array(paragraph?.children).flatMap((run) => {
      const parsed = object(run);
      return parsed && typeof parsed.t === 'string' ? [parsed] : [];
    });
    return runs.length > 0 ? [{ style: object(paragraph?.style), runs }] : [];
  });
}

/** 一页幻灯片的版式与母版：占位符没写的位置、项目符号从这里继承，与 local/pptx/parser.ts 同一条链。 */
interface SlideInheritance {
  layoutPlaceholders: Array<PlaceholderEntry<Record<string, unknown>>>;
  masterPlaceholders: Array<PlaceholderEntry<Record<string, unknown>>>;
  master: Record<string, unknown> | undefined;
  defaultTextStyle: Record<string, unknown> | undefined;
}

type InheritedShapes = { layout: Record<string, unknown> | undefined; master: Record<string, unknown> | undefined };

function slideInheritance(raw: Record<string, unknown>, slide: Record<string, unknown> | undefined): SlideInheritance {
  const masters = array(raw.slideMasters).flatMap((item) => object(item) ? [object(item)!] : []);
  const master = masters.find((item) => item._ref === slide?._masterRef);
  const layout = masters.flatMap((item) => array(item.slideLayouts)).map(object).find((item) => item?._ref === slide?._layoutRef);
  return {
    layoutPlaceholders: placeholdersOf(layout?.spTree),
    masterPlaceholders: placeholdersOf(master?.spTree),
    master,
    defaultTextStyle: object(raw.defaultTextStyle),
  };
}

function placeholdersOf(tree: unknown): Array<PlaceholderEntry<Record<string, unknown>>> {
  return array(tree).flatMap((item) => {
    const shape = object(item);
    if (!shape) return [];
    const placeholder = object(shape.ph);
    return [...(placeholder ? [{ key: cloudPlaceholderKey(placeholder), value: shape }] : []), ...placeholdersOf(shape.children)];
  });
}

function cloudPlaceholderKey(placeholder: Record<string, unknown>): PlaceholderKey {
  const idx = placeholder.idx;
  return { type: string(placeholder.type), idx: typeof idx === 'number' || typeof idx === 'string' ? String(idx) : undefined };
}

function cloudListParagraphs(record: Record<string, unknown>, slide: SlideInheritance, key: PlaceholderKey | undefined, inherited: InheritedShapes | undefined): TextParagraph[] | undefined {
  let length = 0;
  return listParagraphs(cloudParagraphs(record).map((paragraph, index): TextParagraph => {
    if (index > 0) length += 1;
    const start = length;
    length += paragraph.runs.reduce((sum, run) => sum + (run.t as string).length, 0);
    const level = Math.min(Math.max(number(paragraph.style?.lvl) ?? 0, 0), 8);
    const list = resolveList(cloudBulletChain(paragraph.style, level, record, key, inherited, slide));
    return { start, end: length, level, ...(list ? { list } : {}) };
  }));
}

/** 段落 → 形状 lstStyle → 版式占位符 → 母版占位符 → 母版文字样式 → 默认文字样式。 */
function* cloudBulletChain(style: Record<string, unknown> | undefined, level: number, record: Record<string, unknown>, placeholder: PlaceholderKey | undefined,
  inherited: InheritedShapes | undefined, slide: SlideInheritance): Generator<BulletDeclaration> {
  const levelKey = levelStyleKey(level);
  const levelOf = (list: unknown): Record<string, unknown> | undefined => object(object(list)?.[levelKey]);
  yield cloudDeclaredBullet(style);
  yield cloudDeclaredBullet(levelOf(object(record.txBody)?.lstStyle));
  yield cloudDeclaredBullet(levelOf(object(inherited?.layout?.txBody)?.lstStyle));
  yield cloudDeclaredBullet(levelOf(object(inherited?.master?.txBody)?.lstStyle));
  yield cloudDeclaredBullet(levelOf(slide.master?.[masterTextStyleKey(placeholder)]));
  yield cloudDeclaredBullet(levelOf(slide.defaultTextStyle));
}

/** 云端 IR 不带图片项目符号（`buBlip`）：presentation 没有读出这个元素，那一层按「没说」处理。 */
function cloudDeclaredBullet(style: Record<string, unknown> | undefined): BulletDeclaration {
  if (!style) return undefined;
  return bulletDeclaration({ none: style.buNone === true, autoNumber: Boolean(string(style.buAutoNum)), character: Boolean(string(style.buChar)) });
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

/**
 * 同时在途的资产下载数。与 assets/localize.ts 的 convert 路径取同一个值：同一个后端、
 * 同一批签名地址，没有理由两条路径压出不同的并发。
 */
const ASSET_FETCH_CONCURRENCY = 4;
/** 单个资产的尝试次数（含首次）。 */
const ASSET_FETCH_ATTEMPTS = 3;
/** 值得重试的响应：另一端过载或限流，重来一次可能就成了。4xx 重试只是白等。 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

async function cloudAssets(ir: unknown, signal?: AbortSignal): Promise<CandidateAsset[]> {
  const images = object(ir)?.images;
  if (!Array.isArray(images)) return [];
  const requests = images.flatMap((raw) => {
    const image = object(raw);
    const url = image && (image.accessURL ?? image.url);
    const path = image && (image.assetPath ?? image.path);
    return typeof url === 'string' && typeof path === 'string' ? [{ url, path }] : [];
  });
  if (requests.length === 0) return [];
  // 串行下载在真实文档上是几十到上百次往返（实测 PDF 96 张、PPTX 135 张）；并发上限沿用
  // convert 路径的值，避免把后端的签名地址服务打爆。
  const limit = pLimit(ASSET_FETCH_CONCURRENCY);
  const fetched = await Promise.all(requests.map((request) => limit(() => fetchCloudAsset(request, signal))));
  return fetched.filter((asset): asset is CandidateAsset => asset !== undefined);
}

/**
 * 取一个资产；取不到返回 undefined。
 *
 * 解析阶段缺图不该让整份解析失败 —— 它由 candidate 评估报成 `cloud_asset_unavailable`，
 * 调用方看得见。但「不失败」不等于「不重试」：原先一次网络抖动就永久丢一张图，而这条
 * 路径拿的是有效期很短的签名地址，重来一次通常就成了。中断信号仍然逐层抛出。
 */
async function fetchCloudAsset(request: { url: string; path: string }, signal?: AbortSignal): Promise<CandidateAsset | undefined> {
  for (let attempt = 0; attempt < ASSET_FETCH_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted();
    try {
      const response = await fetch(request.url, signal ? { signal } : {});
      if (response.ok) return { path: request.path, data: new Uint8Array(await response.arrayBuffer()) };
      if (!RETRYABLE_STATUS.has(response.status)) return undefined;
    } catch {
      signal?.throwIfAborted();
    }
    if (attempt < ASSET_FETCH_ATTEMPTS - 1) await backoff(200 * 2 ** attempt, signal);
  }
  return undefined;
}

function backoff(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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
function string(value: unknown): string | undefined { return typeof value === 'string' && value ? value : undefined; }

import pLimit from 'p-limit';
import type { ParseResult } from '../cloud/parse-facade.js';
import type { ResultArtifact } from 'pdf-lite-parse';
import { stableId } from './ids.js';
import { result3ToDeckIr } from './result3-adapter.js';
import type { CandidateAsset, DeckIrNode, DeckIrPage, DocumentFormat, ParseCandidate, QualityCheck } from './schema.js';
import { makeIr, qualityOf, type SourceIdentity } from '../local/common.js';
import type { ParseTaskType } from '../types.js';

export async function cloudResultToCandidate(parsed: ParseResult, source: SourceIdentity, signal?: AbortSignal): Promise<ParseCandidate> {
  const result3 = findResult3(parsed.ir);
  const assets = await cloudAssets(parsed.ir, signal);
  if (result3) {
    const candidate = result3ToDeckIr({ document: result3, source, assets,
      producer: { engine: 'cloud', name: 'deckflow-cloud', version: '1' } });
    candidate.remote = { taskId: parsed.taskId, irKey: parsed.irKey };
    return candidate;
  }
  const format = formatForType(parsed.type as ParseTaskType);
  const nodes: DeckIrNode[] = [];
  const sink: CloudNodeSink = { nodes, byId: new Map() };
  const pages: DeckIrPage[] = [];
  const raw = parsed.ir as Record<string, unknown>;
  const pageItems = format === 'pptx' || format === 'keynote' ? array(raw.slides) : [];
  if (pageItems.length) {
    pageItems.forEach((item, index) => {
      const before = nodes.length;
      walkCloud(item, sink, source.sha256, `pages/${index}`, index + 1, null);
      pages.push({ id: stableId(source.sha256, `cloud:page:${index}`, 'p'), index: index + 1,
        ...(number(raw.width ?? object(raw.slideSize)?.cx) ? { width: number(raw.width ?? object(raw.slideSize)?.cx) } : {}),
        ...(number(raw.height ?? object(raw.slideSize)?.cy) ? { height: number(raw.height ?? object(raw.slideSize)?.cy) } : {}),
        nodeIds: nodes.slice(before).map((node) => node.id), sourceRef: { page: index + 1, path: `slides/${index}` } });
    });
  } else if (Array.isArray(raw.content)) {
    raw.content.forEach((item, index) => walkCloud(item, sink, source.sha256, `content/${index}`, undefined, null));
  } else {
    walkCloud(raw, sink, source.sha256, 'root', undefined, null);
  }
  const checks: QualityCheck[] = [];
  if (nodes.length === 0) checks.push({ code: 'cloud_schema_unmapped', severity: 'error', message: `Cloud schema ${parsed.irSchemaVersion} did not contain mappable document nodes.` });
  let quality = qualityOf(checks, { ...(pages.length ? { pages: { parsed: pages.length, total: pages.length } } : {}),
    objects: { parsed: nodes.length, opaque: 0 }, textCharacters: nodes.reduce((sum, node) => sum + (node.text?.length ?? 0), 0) });
  const ir = makeIr({ format, source, producer: { engine: 'cloud', name: 'deckflow-cloud', version: '1' },
    metadata: { cloudSchemaVersion: parsed.irSchemaVersion }, pages, nodes, assets, quality });
  const availableAssets = new Set(ir.document.assets.map((asset) => asset.path));
  for (const node of ir.document.nodes) {
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

function walkCloud(value: unknown, sink: CloudNodeSink, hash: string, locator: string, page?: number, parentId: string | null = null): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach((item, index) => walkCloud(item, sink, hash, `${locator}/${index}`, page, parentId)); return; }
  const record = value as Record<string, unknown>;
  const text = cloudText(record);
  const kind = cloudKind(record, text);
  let nextParent = parentId;
  const skipKeys = new Set<string>(WALK_SKIP_KEYS);
  if (text || ['shape', 'picture', 'image', 'table', 'group', 'chart'].some((token) => kind.includes(token))) {
    const id = stableId(hash, `cloud:${locator}`);
    const xfrm = object(record.xfrm);
    // 只认解析器明确给出的资产指针。`path` 曾经也在这条兜底链上，但在 pptx 里它是自选
    // 图形的几何路径（`"M 0 0 L 10 10 Z"`），任何 Freeform 都会因此被判成「指向不存在的
    // 资产」，凭空产出一条 cloud_asset_unavailable 并把 quality 顶成 degraded。
    const assetPath = string(record.assetPath ?? record.suggestedPath);
    const externalUrl = string(record.accessURL ?? record.url);
    const node: DeckIrNode = { id, type: kind, parentId, children: [], order: sink.nodes.length, ...(text ? { text } : {}),
      ...(page ? { page } : {}), sourceRef: { path: locator, ...(page ? { page } : {}) },
      ...(xfrm && [xfrm.x, xfrm.y, xfrm.cx, xfrm.cy].every((item) => typeof item === 'number') ?
        { bbox: [xfrm.x as number, xfrm.y as number, (xfrm.x as number) + (xfrm.cx as number), (xfrm.y as number) + (xfrm.cy as number)] } : {}),
      extensions: { cloud: { id: record.id, name: record.name, style: record.style }, ...(assetPath ? { assetPath } : {}), ...(externalUrl ? { externalUrl } : {}) } };
    push(sink, node); if (parentId) sink.byId.get(parentId)?.children.push(id); nextParent = id;
    // 表格必须按 table → table_row → table_cell 发，和 local/pptx、local/docx、result3 三个
    // 适配器一致：Markdown 渲染器只认这三种类型，让通用遍历把单元格摊成一串 shape 子节点，
    // 整张表会在渲染时被静默丢掉——IR 里看得见，产物里一个字都没有。
    if (kind.includes('table') && emitCloudTable(record, node, sink, hash, locator, page)) {
      skipKeys.add('table');
    }
  }
  for (const [key, child] of Object.entries(record)) {
    if (skipKeys.has(key)) continue;
    if (child && typeof child === 'object') walkCloud(child, sink, hash, `${locator}/${key}`, page, nextParent);
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
      push(sink, { id: cellId, type: 'table_cell', parentId: rowId, children: [], order: sink.nodes.length,
        ...(text ? { text } : {}), ...(page ? { page } : {}),
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
  if (text && declared === 'shape') return 'text';
  return declared ?? (record.txBody ? 'shape' : record.table ? 'table' : text ? 'text' : 'object');
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

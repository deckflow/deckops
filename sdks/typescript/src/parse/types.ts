/**
 * 解析类任务的参数与结果类型。
 *
 * 这些结构由服务端的 slave 解析器产出，此处**照抄而非引用** `@deckflow/platform-slave` ——
 * 公开 SDK 不能依赖私有 registry 上的服务端包。字段随服务端演进时需同步更新。
 *
 * **parse 只出 IR，markdown 由 `parse.convert` 从已存储的 IR 派生。** 解析结果里不再有
 * 任何 markdown 字段：View 是按需派生的，不是解析的副产品。
 *
 * 注意：任务结果经服务端 `key2url` 处理后，OSS key 字段已被展开为可访问 URL —— 唯独
 * `irKey` 例外，它是引用不是产物，原样保留（展开成签名地址会让引用几小时后失效，而 IR
 * 承诺活 7 天）。
 */

import type { FileResult } from '../types.js';

// ------------------------------------------------------------------------ IR

/** 支持解析的格式，与 IR 信封的 `format` 一一对应。 */
export type IrFormat = 'pdf' | 'pptx' | 'docx' | 'keynote' | 'html';

/**
 * 每个 parse 任务结果都带的两个字段，指向这次解析存下来的 IR。
 *
 * 拿着 `irKey` 就能在保留期内反复调 `deck.convert()` 派生不同 View，源文件不必再传一次。
 */
export interface IrResult {
  /** 已存储 IR 的 key */
  irKey: string;
  /** 该 IR 的版本标签，convert 的门禁按它判断认不认 */
  irSchemaVersion: string;
}

/** IR 保留期：7 天。过期后引用会得到 `irExpired`，重新 parse 即可。 */
export const IR_RETENTION_DAYS = 7;

/** IR 中被引用的二进制资源。**只存持久 key，不存带效期的地址。** */
export interface IrResource {
  /** body 里引用这份资源用的标识：pdf 用工件内相对路径，pptx 用 zip 内路径，其余即 key */
  ref: string;
  key: string;
  bytes: number;
  hash: string;
  /** 建议的落盘相对路径，形如 `assets/p1_i0000.png` */
  suggestedPath: string;
}

/**
 * IR 信封：自描述信头 + 解析器原样输出。
 *
 * 这是 IR 的**存储形态**。parse 任务的响应仍是扁平的（`slides` / `content` / `document`
 * 直接在顶层），信封只在存储里出现，`deck.convert()` 按 `irKey` 读它。
 */
export interface IrEnvelope<B = unknown> {
  format: IrFormat;
  schemaVersion: string;
  producer: { name: string; version: string };
  source: { sha256?: string; name?: string; bytes?: number };
  /** ISO 8601 */
  createdAt: string;
  body: B;
  resources?: IrResource[];
}

// ------------------------------------------------------------------- convert

/** convert 支持的 View 目标。v1 只有 markdown，枚举位是给后续 html / text 预留的。 */
export type ConvertTarget = 'markdown';

/** 分页 markdown 的页分隔符，`markdown.split(PAGE_SEPARATOR)` 可还原分页。 */
export const PAGE_SEPARATOR = '\n\n---\n\n';

/**
 * convert 交付的图片清单，四种格式同一形状。
 *
 * 下游据此把 markdown 里的图片下载到本地并改写为相对路径 —— 因为正文里的地址带有效期，
 * 直接存盘几小时后就是死链。
 */
export interface ConvertImage {
  /** 该图片在 markdown 正文里出现的引用，即现签的访问地址 */
  ref: string;
  /** OSS 持久 key */
  key: string;
  /** 建议落盘相对路径 */
  suggestedPath: string;
  bytes?: number;
  hash?: string;
}

export interface ConvertTaskParams {
  /** 已存储 IR 的 key，与 `taskId` 二选一 */
  irKey?: string;
  /** 产出该 IR 的 parse 任务 id，与 `irKey` 二选一 */
  taskId?: string;
  /** 目标 View，默认 markdown */
  to?: ConvertTarget;
  /** pdf：markdown 是否写入逐元素溯源注释，默认 false（注释体积通常是正文的数倍） */
  markdownMeta?: boolean;
  /** 分页格式（pptx / keynote）：是否额外返回逐页数组 */
  markdownPages?: boolean;
  /** 渲染失败时抛错；默认 false，容错返回 `markdownError` */
  markdownStrict?: boolean;
}

export interface ConvertTaskResult {
  /** IR 的格式，由信封给出而不是调用方声明 */
  format: IrFormat;
  schemaVersion: string;
  to: ConvertTarget;
  /** 完整 markdown；分页格式按页用 `PAGE_SEPARATOR` 连接 */
  markdown: string;
  /** 逐页 markdown，仅 `markdownPages: true` 且格式分页时返回 */
  markdownPages?: string[];
  /** 容错模式下渲染失败的原因；有它就说明 markdown 不可信 */
  markdownError?: string;
  images: ConvertImage[];
}

/** 图片在文档中的位置 */
export interface ParseLocator {
  /** 所在页，从 0 开始 */
  pageIndex: number;
}

// -------------------------------------------------------------- pdf.pdfParse

/** 精度/成本档位 */
export type PdfParseProfile = 'fast' | 'balanced' | 'quality';

/** `[x0, y0, x1, y1]`，单位 pt，左上原点 */
export type PdfBbox = [number, number, number, number];

/**
 * 图片落盘后的持久标识。
 *
 * **只有 key，没有访问地址**：这份标识写在 IR 里，而 IR 要活 7 天，签名地址活不了那么久。
 */
export interface StoredPdfAsset {
  /** 持久化 key，长期标识用它 */
  key: string;
  bytes: number;
  hash: string;
}

/** 落盘后的图片；`assetPath` 与 IR 中 `figure.assetPath` 关联 */
export interface ParsedPdfAsset extends StoredPdfAsset {
  /** 工件内相对路径，形如 `assets/p1_i0000.png` */
  assetPath: string;
  /** 现签的访问地址；只在响应里出现，不进 IR */
  accessURL: string;
}

/**
 * IR 元素的公共形状。
 *
 * 这是上游 `@deckflow/pdf-parse` `Element` 的**宽松镜像**：只把常用字段写成强类型，
 * 其余由索引签名兜住。需要完整判别联合（`heading.level`、`table.table` 等）的调用方
 * 自行按 `type` 收窄即可，运行时字段就在那里。
 */
export interface PdfElement {
  id: string;
  page: number;
  order: number;
  bbox: PdfBbox;
  parentId: string | null;
  /** unknown / heading / paragraph / list_item / table / figure / chart / caption / … */
  type: string;
  text?: string;
  /** figure 与 chart 共用；落盘后就地带上 key/bytes/hash */
  figure?: {
    assetPath: string | null;
    kind: 'raster' | 'vector';
  } & Partial<StoredPdfAsset>;
  [field: string]: unknown;
}

/** 文档元信息 */
export interface PdfDocInfo {
  status: 'read' | 'unavailable';
  title: string | null;
  author: string | null;
  subject: string | null;
  keywords: string | null;
  creator: string | null;
  producer: string | null;
  createdAt: string | null;
  modifiedAt: string | null;
  lang: string | null;
}

/** IR 顶层形状 */
export interface PdfDocument {
  version: string;
  schemaVersion: string;
  source: { sha256: string; pages: number; encrypted: boolean; path?: string };
  profile: PdfParseProfile;
  docInfo: PdfDocInfo;
  outline: unknown[] | null;
  pages: unknown[];
  elements: PdfElement[];
  furniture?: PdfElement[];
  annotations: unknown[];
  warnings: unknown[];
  stats: Record<string, unknown>;
  [field: string]: unknown;
}

export interface PdfParseTaskParams {
  /** 加密文档的打开口令 */
  password?: string;
  /** 精度/成本档位，默认 balanced */
  parseProfile?: PdfParseProfile;
  /** 是否抽取图片并落盘，默认 true */
  includeImages?: boolean;
}

/** `pdf.pdfParse` 的结果 */
export interface PdfParseResult extends IrResult {
  /** 结构化文档模型，figure/chart 已带落盘后的持久 key */
  document: PdfDocument;
  /** 落盘图片的平铺索引，省去遍历元素树 */
  images: ParsedPdfAsset[];
}

// ------------------------------------------------- keynote.parseTextAndImage

export interface KeynoteTextItem {
  id: string;
  text?: string;
}

export interface KeynoteTableItem {
  id: string;
  data: string[];
}

export interface KeynoteChartItem {
  id: string;
  data: { rowName: string[]; columnName: string[] };
}

export interface KeynoteImageItem {
  id: string;
  fileName: string;
  /** 图片所在页，对应 slides 数组索引 */
  pageIndex?: number;
  key: string;
}

export interface KeynoteParseTaskParams {
  /** 图片区域保留率 0-1，默认 0.05 */
  stayImageAreaRate?: number;
}

export interface KeynoteParseResult extends IrResult {
  pageNum: number;
  width: number;
  height: number;
  slides: {
    text: KeynoteTextItem[];
    table: KeynoteTableItem[];
    chart: KeynoteChartItem[];
  }[];
  images?: KeynoteImageItem[];
}

// --------------------------------------------------- docx.parseTextAndImage

/** 段落样式，由 `@deckflow/docx` >= 1.4.0 提供 */
export interface DocxTextStyle {
  /** 段落样式 id，如 "Heading1"、"1"、"Title" */
  styleId?: string;
  /** 段落样式名，已小写，如 "heading 1"、"title" */
  styleName?: string;
  /** 大纲级别 0-8，0 为最高级（对应 heading 1） */
  outlineLvl?: number;
  /** 首个文本 run 的字号（磅） */
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
}

export interface DocxText {
  idx: number;
  type: 'text';
  text: string;
  style?: DocxTextStyle;
}

export interface DocxImage {
  idx: number;
  type: 'image';
  /** slave 已把图片二进制转存为 OSS key（经 key2url 后是 URL） */
  image: string;
  name: string;
  hash?: string;
  bytes?: number;
}

export interface DocxTableCell {
  idx: number;
  type: 'table-cell';
  children: DocxText[];
}

export interface DocxTableRow {
  idx: number;
  type: 'table-row';
  children: DocxTableCell[];
}

export interface DocxTable {
  idx: number;
  type: 'table';
  table: DocxTableRow[];
}

export interface DocxChart {
  idx: number;
  type: 'chart';
  series: string[];
  categories: string[];
}

export interface DocxDiagram {
  idx: number;
  type: 'diagram';
  texts: { idx: number; aps: { idx: number; text: string }[] }[];
}

export interface DocxWsp {
  idx: number;
  type: 'wsp';
  children: DocxText[];
}

export interface DocxGroup {
  idx: number;
  type: 'group';
  children: (DocxWsp | DocxGroup)[];
}

export interface DocxSdtWpText {
  idx: number;
  type: 'sdt-wp';
  children: DocxText[];
}

export interface DocxSdt {
  idx: number;
  type: 'sdt';
  children: DocxSdtWpText[];
}

export type DocxElement =
  | DocxText
  | DocxImage
  | DocxTable
  | DocxChart
  | DocxDiagram
  | DocxGroup
  | DocxWsp
  | DocxSdt;

export type DocxParseTaskParams = Record<string, never>;

export interface DocxParseResult extends IrResult {
  width: number;
  height: number;
  /** 页数，上游标注为非可靠信息 */
  pageNum: number;
  content: DocxElement[];
}

// ------------------------------------------------------------------ pptx.parse

/**
 * `pptx.parse` 的结果：PPTX 对象模型。
 *
 * 完整形状见 `@deckflow/presentation` 的 `PresentationAttrs`；这里是**宽松镜像**，
 * 只固定下游最常用的三个顶层字段，其余由索引签名兜住 —— 公开 SDK 不能依赖
 * 私有 registry 上的 `@deckflow/presentation`。需要完整类型的调用方自行引它。
 */
export interface PptxParseResult extends IrResult {
  slides: Record<string, unknown>[];
  slideMasters: Record<string, unknown>[];
  slideSize?: { cx: number; cy: number };
  /** zip 内路径 → 落盘后的文件 */
  files?: Record<string, FileResult>;
  [field: string]: unknown;
}

export type PptxParseTaskParams = Record<string, never>;

// ------------------------------------------------------------- html.getByURL

export interface HtmlGetByUrlTaskParams {
  /** 目标 http(s) 链接 */
  url: string;
  /** 取源码还是运行后的代码，默认 runtime */
  mode?: 'source' | 'runtime';
}

export interface HtmlGetByUrlResult extends IrResult {
  html: string;
}

/**
 * 解析类任务的参数与结果类型。
 *
 * 这些结构由服务端的 slave 解析器产出，此处**照抄而非引用** `@deckflow/platform-slave` ——
 * 公开 SDK 不能依赖私有 registry 上的服务端包。字段随服务端演进时需同步更新。
 *
 * markdown 由服务端生成（slave >= 0.21.0），SDK 不再做任何格式转换，只负责传参与取值。
 *
 * 注意：任务结果经服务端 `key2url` 处理后，所有 OSS key 字段已被展开为可访问 URL；
 * markdown 正文里的图片地址由 slave 直接签好，是带有效期的访问地址而非持久 key。
 */

import type { FileResult } from '../types.js';

// ------------------------------------------------------------------ markdown

/** 解析类任务共用的 markdown 开关，与 slave 的 `MarkdownParams` 一一对应 */
export interface MarkdownParams {
  /** 是否额外返回 markdown，默认 false */
  markdown?: boolean;
  /** 只返回 markdown 与必要元数据，丢弃结构化结果，默认 false */
  markdownOnly?: boolean;
  /** markdown 生成失败时抛错；默认 false，容错返回 `markdownError` */
  markdownStrict?: boolean;
}

/** 分页格式（pptx / keynote）额外支持逐页 markdown */
export interface MarkdownPagesParams {
  /** 是否额外返回逐页 markdown 数组，默认 false */
  markdownPages?: boolean;
}

/** 解析类任务共用的 markdown 响应字段 */
export interface MarkdownResult {
  /** 完整 markdown；分页格式按页用 `PAGE_SEPARATOR` 连接 */
  markdown?: string;
  /** 逐页 markdown，仅 `markdownPages: true` 且格式分页时返回 */
  markdownPages?: string[];
  /** `markdownOnly: true` 时返回：markdown 中的图片访问地址 → 持久 key */
  markdownImages?: Record<string, FileResult>;
  /** 容错模式下 markdown 生成失败的原因 */
  markdownError?: string;
}

/** 分页 markdown 的页分隔符，`markdown.split(PAGE_SEPARATOR)` 可还原分页 */
export const PAGE_SEPARATOR = '\n\n---\n\n';

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

/** 图片落盘后的标识 */
export interface StoredPdfAsset {
  /** 持久化 key，长期标识用它 */
  key: string;
  bytes: number;
  hash: string;
  /** 访问地址；带签名有有效期 */
  accessURL: string;
}

/** 落盘后的图片；`assetPath` 与 IR 中 `figure.assetPath` 关联 */
export interface ParsedPdfAsset extends StoredPdfAsset {
  /** 工件内相对路径，形如 `assets/p1_i0000.png` */
  assetPath: string;
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
  /** figure 与 chart 共用；落盘后就地带上 key/bytes/hash/accessURL */
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

/** IR 顶层形状，figure/chart 已带落盘后的 accessURL */
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

export interface PdfParseTaskParams extends MarkdownParams {
  /** 加密文档的打开口令 */
  password?: string;
  /** 精度/成本档位，默认 balanced */
  parseProfile?: PdfParseProfile;
  /** 是否抽取图片并落盘，默认 true；关掉时 markdown 里的图片是工件内相对路径 */
  includeImages?: boolean;
  /** markdown 是否写入逐元素溯源注释，默认 false（注释体积通常是正文的数倍） */
  markdownMeta?: boolean;
}

/** `pdf.pdfParse` 的结构化结果 */
export interface PdfParseStructuredResult extends MarkdownResult {
  /** 结构化文档模型，figure/chart 已带 accessURL */
  document: PdfDocument;
  /** 落盘图片的平铺索引，省去遍历元素树 */
  images: ParsedPdfAsset[];
}

/** `pdf.pdfParse` 在 `markdownOnly: true` 下的精简结果 */
export interface PdfParseMarkdownOnlyResult extends MarkdownResult {
  pageNum: number;
  parseProfile: PdfParseProfile;
  docInfo: PdfDocInfo;
}

export type PdfParseResult = PdfParseStructuredResult | PdfParseMarkdownOnlyResult;

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

export interface KeynoteParseTaskParams extends MarkdownParams, MarkdownPagesParams {
  /** 图片区域保留率 0-1，默认 0.05 */
  stayImageAreaRate?: number;
}

export interface KeynoteParseStructuredResult extends MarkdownResult {
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

export interface KeynoteParseMarkdownOnlyResult extends MarkdownResult {
  pageNum: number;
  width: number;
  height: number;
}

export type KeynoteParseResult = KeynoteParseStructuredResult | KeynoteParseMarkdownOnlyResult;

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

export type DocxParseTaskParams = MarkdownParams;

export interface DocxParseStructuredResult extends MarkdownResult {
  width: number;
  height: number;
  /** 页数，上游标注为非可靠信息 */
  pageNum: number;
  content: DocxElement[];
}

export interface DocxParseMarkdownOnlyResult extends MarkdownResult {
  width: number;
  height: number;
  pageNum: number;
}

export type DocxParseResult = DocxParseStructuredResult | DocxParseMarkdownOnlyResult;

// ------------------------------------------------------------------ pptx.parse

/**
 * `pptx.parse` 的结构化结果：PPTX 对象模型。
 *
 * 完整形状见 `@deckflow/presentation` 的 `PresentationAttrs`；这里是**宽松镜像**，
 * 只固定下游最常用的三个顶层字段，其余由索引签名兜住 —— 公开 SDK 不能依赖
 * 私有 registry 上的 `@deckflow/presentation`。需要完整类型的调用方自行引它。
 */
export interface PptxParseStructuredResult extends MarkdownResult {
  slides: Record<string, unknown>[];
  slideMasters: Record<string, unknown>[];
  slideSize?: { cx: number; cy: number };
  /** zip 内路径 → 落盘后的文件 */
  files?: Record<string, FileResult>;
  [field: string]: unknown;
}

export interface PptxParseMarkdownOnlyResult extends MarkdownResult {
  slideSize?: { cx: number; cy: number };
  files?: Record<string, FileResult>;
}

export type PptxParseTaskParams = MarkdownParams & MarkdownPagesParams;

export type PptxParseResult = PptxParseStructuredResult | PptxParseMarkdownOnlyResult;

// ------------------------------------------------------------- html.getByURL

export interface HtmlGetByUrlTaskParams extends MarkdownParams {
  /** 目标 http(s) 链接 */
  url: string;
  /** 取源码还是运行后的代码，默认 runtime */
  mode?: 'source' | 'runtime';
}

export interface HtmlGetByUrlStructuredResult extends MarkdownResult {
  html: string;
}

/** `markdownOnly: true` 时不返回 html —— 源码常有数 MB */
export type HtmlGetByUrlMarkdownOnlyResult = MarkdownResult;

export type HtmlGetByUrlResult = HtmlGetByUrlStructuredResult | HtmlGetByUrlMarkdownOnlyResult;

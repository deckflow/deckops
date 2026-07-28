/**
 * 解析类任务的结果类型。
 *
 * 这些结构由服务端的 slave 解析器产出，此处**照抄而非引用** `@deckflow/platform-slave` ——
 * 公开 SDK 不能依赖服务端内部包。字段随服务端演进时需同步更新，测试夹具是防漂移的第一道闸。
 *
 * 注意：任务结果经服务端 `key2url` 处理后，所有 OSS key 字段已被展开为可访问 URL，
 * 因此转换器里的 `toImageUrl` 默认是恒等函数。
 */

/** 图片在文档中的位置 */
export interface ParseLocator {
  /** 所在页，从 0 开始 */
  pageIndex: number;
}

// ---------------------------------------------------------------- pdf.parse

export interface PdfTextBlockStyle {
  bold?: boolean;
  italic?: boolean;
}

/** 已知的语义角色；上游可能返回其它值，故保留任意字符串 */
export type PdfTextRole =
  | 'heading'
  | 'list-item'
  | 'caption'
  | 'paragraph'
  | (string & NonNullable<unknown>);

export interface PdfTextBlock {
  text: string;
  /** 语义角色，决定渲染成标题/列表项/图注 */
  role?: PdfTextRole;
  style?: PdfTextBlockStyle;
  locator: ParseLocator;
}

export interface PdfImage {
  key?: string;
  fileName?: string;
  locator?: ParseLocator;
  bytes?: number;
  hash?: string;
}

export interface PdfParseResult {
  textBlocks: PdfTextBlock[];
  images?: PdfImage[];
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
  /**
   * 图片所在页，对应 slides 数组索引。
   * 上游可能不提供或给出越界值，转换器不会因此丢弃图片，见 `keynoteResult2Markdown`。
   */
  pageIndex?: number;
  key: string;
}

export interface KeynoteParseResult {
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

// --------------------------------------------- docx.parseTextAndImage

/**
 * 段落样式。由 `@deckflow/docx` >= 1.4.0 提供；
 * 服务端 slave 尚未升级到该版本时字段为 undefined，转换器会退化为扁平段落。
 */
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

export interface DocxParseResult {
  width: number;
  height: number;
  /** 页数，上游标注为非可靠信息 */
  pageNum: number;
  content: DocxElement[];
}

// ------------------------------------------------------------- html.getByURL

export interface HtmlGetByUrlResult {
  html: string;
}

// ------------------------------------------------------------------ 通用选项

export interface MarkdownConvertOptions {
  /**
   * 把图片 key 转为可访问 URL。
   * 服务端 `key2url` 通常已展开，默认恒等即可。
   */
  toImageUrl?: (key: string) => string;
}

/** 默认的图片地址解析：原样返回 */
export const identityImageUrl = (key: string): string => key;

/**
 * 解析结果 → markdown 的转换层。
 *
 * 服务端把 slave 的解析原语原样暴露为 ttask 类型（`pdf.parse` / `pptx.parse` /
 * `docx.parseTextAndImage` / `keynote.parseTextAndImage` / `html.getByURL`），
 * 返回**结构化结果**；需要 markdown 的调用方在这里做最后一步转换。
 *
 * 想要结构化数据（形状坐标、表格结构、页宽高）的调用方直接用底层结果即可，不必经过这里。
 */

export * from './types.js';
export { pdfResult2Markdown } from './pdf.js';
export { keynoteResult2Markdown, PAGE_SEPARATOR } from './keynote.js';
export { docxResult2Markdown } from './docx.js';
export { pptxResult2Markdown, type PptxParseResult, type PptxConvertOptions } from './pptx.js';
export { html2markdown, type Html2MarkdownOptions } from './html.js';

/** 走解析链路的文档任务类型 */
export type ParseTaskType =
  | 'pdf.parse'
  | 'pptx.parse'
  | 'docx.parseTextAndImage'
  | 'keynote.parseTextAndImage';

/**
 * 扩展名 → 任务类型。
 *
 * 这是本方案**唯一**外移到客户端的服务端知识，TS 与 Go SDK 必须保持一致。
 */
export const PARSE_TASK_TYPE_BY_EXTENSION: Record<string, ParseTaskType> = {
  '.pdf': 'pdf.parse',
  '.pptx': 'pptx.parse',
  '.docx': 'docx.parseTextAndImage',
  '.key': 'keynote.parseTextAndImage',
};

/** 支持解析的文件扩展名 */
export const PARSE_SUPPORTED_EXTENSIONS = Object.keys(PARSE_TASK_TYPE_BY_EXTENSION);

/** 从文件名/路径/URL 取小写扩展名（含点），取不到返回空串 */
export const extensionOf = (nameOrPath: string): string => {
  const clean = nameOrPath.split(/[?#]/)[0] ?? '';
  const base = clean.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
};

/** 按文件名决定该走哪个解析任务类型；不支持的扩展名返回 undefined */
export const parseTaskTypeFor = (nameOrPath: string): ParseTaskType | undefined =>
  PARSE_TASK_TYPE_BY_EXTENSION[extensionOf(nameOrPath)];

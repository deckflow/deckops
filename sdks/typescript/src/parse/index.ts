/**
 * 解析类任务的类型与扩展名路由。
 *
 * 服务端把 slave 的解析原语原样暴露为 ttask 类型（`pdf.pdfParse` / `pptx.parse` /
 * `docx.parseTextAndImage` / `keynote.parseTextAndImage` / `html.getByURL`），
 * 每个都能按参数返回**结构化结果**、**markdown**、或两者兼有。
 *
 * markdown 由服务端生成，SDK 侧不再有任何转换逻辑。
 */

export * from './types.js';

/** 走解析链路的文档任务类型 */
export type ParseTaskType =
  | 'pdf.pdfParse'
  | 'pptx.parse'
  | 'docx.parseTextAndImage'
  | 'keynote.parseTextAndImage';

/**
 * 扩展名 → 任务类型。
 *
 * 这是本方案**唯一**外移到客户端的服务端知识，TS / Python / Go SDK 必须保持一致。
 */
export const PARSE_TASK_TYPE_BY_EXTENSION: Record<string, ParseTaskType> = {
  '.pdf': 'pdf.pdfParse',
  '.pptx': 'pptx.parse',
  '.docx': 'docx.parseTextAndImage',
  '.key': 'keynote.parseTextAndImage',
};

/** 支持解析的文件扩展名 */
export const PARSE_SUPPORTED_EXTENSIONS = Object.keys(PARSE_TASK_TYPE_BY_EXTENSION);

/** 支持逐页 markdown（`markdownPages`）的任务类型 —— 只有分页格式有 */
export const PARSE_PAGED_TASK_TYPES: ReadonlySet<ParseTaskType> = new Set<ParseTaskType>([
  'pptx.parse',
  'keynote.parseTextAndImage',
]);

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

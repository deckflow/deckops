/**
 * `deck.parse()` 门面：按扩展名/链接路由到对应解析任务 → 等待完成 → 取结果。
 *
 * markdown 由服务端生成（slave >= 0.21.0），这里只做三件事：路由、翻译 `output` 档位
 * 为 slave 的 markdown 开关、把结果分拣成 `{ markdown, result }`。没有任何格式转换。
 *
 * 想完全自己控参数的调用方走底层即可，不必经过这里：
 * ```ts
 * const task = await deck.pptxParse({ files: ['./a.pptx'], params: { markdown: true } });
 * const raw  = await deck.tasks.down<'pptx.parse'>((await deck.tasks.wait(task.id)).id);
 * ```
 */

import { parseTaskTypeFor, PARSE_SUPPORTED_EXTENSIONS, type ParseTaskType } from './parse/index.js';
import type { MarkdownResult, PdfParseProfile } from './parse/types.js';
import type { DeckTask, TaskUploadInput, WaitForTaskOptions } from './types.js';

/** 要什么：只要 markdown、只要原始结构（IR）、还是两者都要 */
export type ParseOutput = 'markdown' | 'ir' | 'all';

/** 要解析的文件 */
export interface ParseFileSource {
  /** 文件：路径（Node）、Blob、或二进制数据 */
  file: TaskUploadInput;
  /** 文件名，用于判定扩展名。`file` 是字符串路径时可省略 */
  name?: string;
}

/** 已上传的文件 */
export interface ParseFileIdSource {
  /** 已上传文件的 id */
  fileId: string;
  /** 文件名，用于判定扩展名 */
  name: string;
}

/** 要解析的链接 */
export interface ParseLinkSource {
  /** http(s) 链接 */
  url: string;
  /** 取源码还是运行后的代码，默认 runtime */
  mode?: 'source' | 'runtime';
}

/** 字符串等价于 `{ file }`，用于 Node 下的本地路径 */
export type ParseSource = string | ParseFileSource | ParseFileIdSource | ParseLinkSource;

export interface ParseOptions {
  /** 要什么，默认 `'markdown'` */
  output?: ParseOutput;
  /** 空间 id */
  spaceId?: string;
  /** 等待任务完成的选项 */
  wait?: WaitForTaskOptions;

  /** 是否额外返回逐页 markdown，仅分页格式（pptx / keynote）有 */
  markdownPages?: boolean;
  /** markdown 生成失败时抛错；默认 false，容错返回 `markdownError` */
  markdownStrict?: boolean;

  /** pdf：加密文档的打开口令 */
  password?: string;
  /** pdf：精度/成本档位，默认 balanced */
  parseProfile?: PdfParseProfile;
  /** pdf：是否抽取图片并落盘，默认 true */
  includeImages?: boolean;
  /** pdf：markdown 是否写入逐元素溯源注释，默认 false */
  markdownMeta?: boolean;

  /** keynote：图片区域保留率 0-1，默认 0.05 */
  stayImageAreaRate?: number;
}

export interface ParseResult<R = unknown> extends MarkdownResult {
  /** 产出该结果的任务 id，便于回查 */
  taskId: string;
  /** 实际使用的任务类型 */
  type: ParseTaskType | 'html.getByURL';
  /**
   * 原始结构化结果，`output` 为 `'ir'` / `'all'` 时返回。
   *
   * 是服务端返回体的原样透传 —— `'all'` 下 markdown 字段同时也在这里面。
   */
  result?: R;
}

interface ParseDeps {
  createTask(params: {
    type: string;
    spaceId?: string;
    files?: TaskUploadInput[];
    fileIds?: string[];
    params?: Record<string, unknown>;
  }): Promise<DeckTask>;
  waitTask(taskId: string, options?: WaitForTaskOptions): Promise<DeckTask>;
  downTask(taskId: string): Promise<unknown>;
}

const isLinkSource = (source: ParseSource): source is ParseLinkSource =>
  typeof source === 'object' && source !== null && 'url' in source;

const isFileIdSource = (source: ParseSource): source is ParseFileIdSource =>
  typeof source === 'object' && source !== null && 'fileId' in source;

const nameForRouting = (source: ParseFileSource): string => {
  if (source.name) return source.name;
  if (typeof source.file === 'string') return source.file;
  if (typeof source.file === 'object' && source.file !== null && 'input' in source.file) {
    const nested = source.file as { input: unknown; name?: string };
    if (nested.name) return nested.name;
    if (typeof nested.input === 'string') return nested.input;
  }
  const maybeNamed = source.file as { name?: string };
  return maybeNamed?.name ?? '';
};

const unsupported = (name: string): Error =>
  new Error(
    `Cannot determine parser for ${name ? `"${name}"` : 'input'}. ` +
      `Supported extensions: ${PARSE_SUPPORTED_EXTENSIONS.join(', ')}. ` +
      `Pass { name } to specify the file name.`
  );

/**
 * `output` 档位 → slave 的 markdown 开关。
 *
 * - `markdown`：只要 markdown，丢结构化结果压缩响应体
 * - `ir`：不生成 markdown，省掉服务端一次渲染
 * - `all`：两者都要
 */
const markdownSwitches = (output: ParseOutput): { markdown?: boolean; markdownOnly?: boolean } => {
  switch (output) {
    case 'markdown':
      return { markdown: true, markdownOnly: true };
    case 'all':
      return { markdown: true };
    case 'ir':
      return {};
  }
};

/** 组装任务参数：markdown 档位 + 该任务类型认得的直通参数 */
const taskParams = (
  type: ParseTaskType | 'html.getByURL',
  options: ParseOptions
): Record<string, unknown> => {
  const params: Record<string, unknown> = markdownSwitches(options.output ?? 'markdown');
  if (options.markdownStrict !== undefined) params.markdownStrict = options.markdownStrict;

  switch (type) {
    case 'pdf.pdfParse':
      if (options.password !== undefined) params.password = options.password;
      if (options.parseProfile !== undefined) params.parseProfile = options.parseProfile;
      if (options.includeImages !== undefined) params.includeImages = options.includeImages;
      if (options.markdownMeta !== undefined) params.markdownMeta = options.markdownMeta;
      break;
    case 'pptx.parse':
      if (options.markdownPages !== undefined) params.markdownPages = options.markdownPages;
      break;
    case 'keynote.parseTextAndImage':
      if (options.markdownPages !== undefined) params.markdownPages = options.markdownPages;
      if (options.stayImageAreaRate !== undefined)
        params.stayImageAreaRate = options.stayImageAreaRate;
      break;
    case 'docx.parseTextAndImage':
    case 'html.getByURL':
      break;
  }
  return params;
};

/** 把服务端返回体分拣成 `{ markdown 字段…, result? }` */
const toParseResult = (
  raw: unknown,
  taskId: string,
  type: ParseTaskType | 'html.getByURL',
  output: ParseOutput
): ParseResult => {
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as MarkdownResult;
  const result: ParseResult = { taskId, type };

  if (output !== 'ir') {
    result.markdown = body.markdown ?? '';
    if (body.markdownPages !== undefined) result.markdownPages = body.markdownPages;
    if (body.markdownImages !== undefined) result.markdownImages = body.markdownImages;
    if (body.markdownError !== undefined) result.markdownError = body.markdownError;
  }
  if (output !== 'markdown') result.result = raw;

  return result;
};

export const createParse = (deps: ParseDeps) => {
  /**
   * 解析一个文件或链接。
   *
   * ```ts
   * (await deck.parse('./a.pptx')).markdown                      // 只要 markdown
   * (await deck.parse('./a.pdf', { output: 'ir' })).result       // 只要结构化 IR
   * await deck.parse({ url: 'https://…' }, { output: 'all' })    // 两者都要
   * ```
   */
  const parse = async <R = unknown>(
    source: ParseSource,
    options: ParseOptions = {}
  ): Promise<ParseResult<R>> => {
    const output = options.output ?? 'markdown';

    if (isLinkSource(source)) {
      const task = await deps.createTask({
        type: 'html.getByURL',
        spaceId: options.spaceId,
        params: {
          url: source.url,
          mode: source.mode ?? 'runtime',
          ...taskParams('html.getByURL', options),
        },
      });
      const done = await deps.waitTask(task.id, options.wait);
      const raw = await deps.downTask(done.id);
      return toParseResult(raw, done.id, 'html.getByURL', output) as ParseResult<R>;
    }

    const normalized: ParseFileSource | ParseFileIdSource =
      typeof source === 'string' ? { file: source } : source;

    const name = isFileIdSource(normalized) ? normalized.name : nameForRouting(normalized);
    const type = parseTaskTypeFor(name);
    if (!type) throw unsupported(name);

    const task = await deps.createTask({
      type,
      spaceId: options.spaceId,
      params: taskParams(type, options),
      ...(isFileIdSource(normalized)
        ? { fileIds: [normalized.fileId] }
        : { files: [normalized.file] }),
    });
    const done = await deps.waitTask(task.id, options.wait);
    const raw = await deps.downTask(done.id);

    return toParseResult(raw, done.id, type, output) as ParseResult<R>;
  };

  return { parse };
};

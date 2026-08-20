/**
 * `deck.parse()` 与 `deck.convert()`：两个正交的原语。
 *
 * - **parse**：文档 → IR。按扩展名/链接路由到对应解析任务，等完成，取结果。产物是一份
 *   可以长期持有的 IR，以及指向它的 `irKey`。
 * - **convert**：IR → View。按 `irKey`（或产出它的 `taskId`）把已存储的 IR 转成指定格式，
 *   **不重新解析源文件**。
 *
 * 这就是 "Parse once, operate repeatedly"：解析一次，在保留期（7 天）内反复转换。
 *
 * 想完全自己控参数的调用方走底层即可，不必经过这里：
 * ```ts
 * const task = await deck.pptxParse({ files: ['./a.pptx'] });
 * const ir   = await deck.tasks.down<'pptx.parse'>((await deck.tasks.wait(task.id)).id);
 * ```
 */

import { parseTaskTypeFor, PARSE_SUPPORTED_EXTENSIONS, type ParseTaskType } from './parse/index.js';
import type { ConvertTarget, ConvertTaskResult, IrResult } from './parse/types.js';
import type { DeckTask, TaskUploadInput, WaitForTaskOptions } from './types.js';

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
  /** 空间 id */
  spaceId?: string;
  /** 等待任务完成的选项 */
  wait?: WaitForTaskOptions;

  /** pdf：加密文档的打开口令 */
  password?: string;
  /** pdf：精度/成本档位，默认 balanced */
  parseProfile?: 'fast' | 'balanced' | 'quality';
  /** pdf：是否抽取图片并落盘，默认 true */
  includeImages?: boolean;

  /** keynote：图片区域保留率 0-1，默认 0.05 */
  stayImageAreaRate?: number;
}

export interface ParseResult<R = unknown> extends IrResult {
  /** 产出该 IR 的任务 id，可交给 `convert()` 或用于回查 */
  taskId: string;
  /** 实际使用的任务类型 */
  type: ParseTaskType | 'html.getByURL';
  /** IR：服务端结构化结果的原样透传 */
  ir: R;
}

/** convert 的入口引用：给 irKey 或产出它的 taskId，二选一 */
export type ConvertRef = { irKey: string; taskId?: never } | { taskId: string; irKey?: never };

export interface ConvertOptions {
  /** 目标 View，默认 markdown */
  to?: ConvertTarget;
  /** 空间 id */
  spaceId?: string;
  /** 等待任务完成的选项 */
  wait?: WaitForTaskOptions;
  /** pdf：markdown 是否写入逐元素溯源注释，默认 false */
  markdownMeta?: boolean;
  /** 分页格式（pptx / keynote）：是否额外返回逐页数组 */
  markdownPages?: boolean;
  /** 渲染失败时抛错；默认 false，容错返回 `markdownError` */
  markdownStrict?: boolean;
}

export interface ConvertResult extends ConvertTaskResult {
  /** 产出该 View 的任务 id，便于回查 */
  taskId: string;
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

/** 组装解析参数：只有该任务类型认得的直通参数，没有任何 View 相关开关。 */
const parseParams = (
  type: ParseTaskType | 'html.getByURL',
  options: ParseOptions
): Record<string, unknown> => {
  const params: Record<string, unknown> = {};
  switch (type) {
    case 'pdf.pdfParse':
      if (options.password !== undefined) params.password = options.password;
      if (options.parseProfile !== undefined) params.parseProfile = options.parseProfile;
      if (options.includeImages !== undefined) params.includeImages = options.includeImages;
      break;
    case 'keynote.parseTextAndImage':
      if (options.stayImageAreaRate !== undefined) params.stayImageAreaRate = options.stayImageAreaRate;
      break;
    case 'pptx.parse':
    case 'docx.parseTextAndImage':
    case 'html.getByURL':
      break;
  }
  return params;
};

/**
 * 把服务端返回体整理成 `{ ir, irKey, … }`。
 *
 * **没有 `irKey` 必须报错而不是放过**：那说明服务端还没升到 parse 出 IR 的版本，此时
 * 结果虽然看着是完整的解析结果，却没有任何东西能交给 `convert()`。让它在这里失败，
 * 比让调用方拿着 undefined 去调 convert、再收到一个语焉不详的参数错误强得多。
 */
const toParseResult = <R>(
  raw: unknown,
  taskId: string,
  type: ParseTaskType | 'html.getByURL'
): ParseResult<R> => {
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<IrResult>;
  if (typeof body.irKey !== 'string' || !body.irKey) {
    throw new Error(
      `${type} returned no irKey. The backend is likely older than the parse/convert split ` +
        `(@deckflow/platform-slave 0.22.0); its result cannot be converted without re-parsing.`
    );
  }
  return {
    taskId,
    type,
    irKey: body.irKey,
    irSchemaVersion: body.irSchemaVersion ?? '',
    ir: raw as R,
  };
};

export const createParse = (deps: ParseDeps) => {
  /**
   * 解析一个文件或链接，产出 IR。
   *
   * ```ts
   * const parsed = await deck.parse('./a.pdf');
   * parsed.ir;      // 结构化 IR
   * parsed.irKey;   // 拿它去 convert，源文件不必再传
   * ```
   */
  const parse = async <R = unknown>(
    source: ParseSource,
    options: ParseOptions = {}
  ): Promise<ParseResult<R>> => {
    if (isLinkSource(source)) {
      const task = await deps.createTask({
        type: 'html.getByURL',
        spaceId: options.spaceId,
        params: {
          url: source.url,
          mode: source.mode ?? 'runtime',
          ...parseParams('html.getByURL', options),
        },
      });
      const done = await deps.waitTask(task.id, options.wait);
      const raw = await deps.downTask(done.id);
      return toParseResult<R>(raw, done.id, 'html.getByURL');
    }

    const normalized: ParseFileSource | ParseFileIdSource =
      typeof source === 'string' ? { file: source } : source;

    const name = isFileIdSource(normalized) ? normalized.name : nameForRouting(normalized);
    const type = parseTaskTypeFor(name);
    if (!type) throw unsupported(name);

    const task = await deps.createTask({
      type,
      spaceId: options.spaceId,
      params: parseParams(type, options),
      ...(isFileIdSource(normalized)
        ? { fileIds: [normalized.fileId] }
        : { files: [normalized.file] }),
    });
    const done = await deps.waitTask(task.id, options.wait);
    const raw = await deps.downTask(done.id);

    return toParseResult<R>(raw, done.id, type);
  };

  /**
   * 把已存储的 IR 转换成指定 View，不重新解析源文件。
   *
   * ```ts
   * const parsed = await deck.parse('./a.pdf');
   * const md = await deck.convert({ irKey: parsed.irKey }, { to: 'markdown' });
   * // 隔天再要一份别的 View，仍然不必重传源文件（7 天保留期内）
   * ```
   */
  const convert = async (ref: ConvertRef, options: ConvertOptions = {}): Promise<ConvertResult> => {
    const task = await deps.createTask({
      type: 'parse.convert',
      spaceId: options.spaceId,
      params: {
        ...(ref.irKey ? { irKey: ref.irKey } : { taskId: ref.taskId }),
        to: options.to ?? 'markdown',
        ...(options.markdownMeta === undefined ? {} : { markdownMeta: options.markdownMeta }),
        ...(options.markdownPages === undefined ? {} : { markdownPages: options.markdownPages }),
        ...(options.markdownStrict === undefined ? {} : { markdownStrict: options.markdownStrict }),
      },
    });
    const done = await deps.waitTask(task.id, options.wait);
    const raw = (await deps.downTask(done.id)) as ConvertTaskResult;
    return { ...raw, taskId: done.id };
  };

  return { parse, convert };
};

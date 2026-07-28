/**
 * `deck.parse()` 门面：按扩展名路由到对应解析任务 → 等待完成 → 取结果 → 转 markdown。
 *
 * 想要结构化结果的调用方走底层即可，不必经过这里：
 * ```ts
 * const task = await deck.pptxParse({ files: ['./a.pptx'] });
 * const raw  = await deck.tasks.down<'pptx.parse'>(await deck.tasks.wait(task.id).then(t => t.id));
 * ```
 */

import {
  docxResult2Markdown,
  html2markdown,
  keynoteResult2Markdown,
  parseTaskTypeFor,
  PARSE_SUPPORTED_EXTENSIONS,
  pdfResult2Markdown,
  pptxResult2Markdown,
  type ParseTaskType,
} from './parse/index.js';
import type {
  DocxParseResult,
  HtmlGetByUrlResult,
  KeynoteParseResult,
  PdfParseResult,
} from './parse/types.js';
import type {
  DeckTask,
  PptxTaskParseResult,
  TaskUploadInput,
  WaitForTaskOptions,
} from './types.js';

export interface ParseFileInput {
  /** 要解析的文件：路径（Node）、Blob、或二进制数据 */
  file: TaskUploadInput;
  /** 文件名，用于判定扩展名。`file` 是字符串路径时可省略 */
  name?: string;
  /** 空间 id */
  spaceId?: string;
  /** 等待任务完成的选项 */
  wait?: WaitForTaskOptions;
}

export interface ParseFileIdInput {
  /** 已上传文件的 id */
  fileId: string;
  /** 文件名，用于判定扩展名 */
  name: string;
  spaceId?: string;
  wait?: WaitForTaskOptions;
}

export interface ParseLinkInput {
  /** 要解析的 http(s) 链接 */
  url: string;
  /** 取源码还是运行后的代码，默认 runtime */
  mode?: 'source' | 'runtime';
  spaceId?: string;
  wait?: WaitForTaskOptions;
}

export type ParseInput = string | ParseFileInput | ParseFileIdInput | ParseLinkInput;

export interface ParseResult {
  /** 转换后的 markdown */
  markdown: string;
  /** 产出该结果的任务 id，便于回查结构化结果 */
  taskId: string;
  /** 实际使用的任务类型 */
  type: ParseTaskType | 'html.getByURL';
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

const isLinkInput = (input: ParseInput): input is ParseLinkInput =>
  typeof input === 'object' && input !== null && 'url' in input;

const isFileIdInput = (input: ParseInput): input is ParseFileIdInput =>
  typeof input === 'object' && input !== null && 'fileId' in input;

const nameForRouting = (input: ParseFileInput): string => {
  if (input.name) return input.name;
  if (typeof input.file === 'string') return input.file;
  if (typeof input.file === 'object' && input.file !== null && 'input' in input.file) {
    const nested = input.file as { input: unknown; name?: string };
    if (nested.name) return nested.name;
    if (typeof nested.input === 'string') return nested.input;
  }
  const maybeNamed = input.file as { name?: string };
  return maybeNamed?.name ?? '';
};

const unsupported = (name: string): Error =>
  new Error(
    `Cannot determine parser for ${name ? `"${name}"` : 'input'}. ` +
      `Supported extensions: ${PARSE_SUPPORTED_EXTENSIONS.join(', ')}. ` +
      `Pass { name } to specify the file name.`
  );

/** 把结构化结果转成 markdown。pptx 是异步的（惰性加载样式解析器），故整体 async */
const toMarkdown = async (
  type: ParseTaskType | 'html.getByURL',
  result: unknown,
  url?: string
): Promise<string> => {
  switch (type) {
    case 'pdf.parse':
      return pdfResult2Markdown(result as PdfParseResult);
    case 'docx.parseTextAndImage':
      return docxResult2Markdown(result as DocxParseResult);
    case 'keynote.parseTextAndImage':
      return keynoteResult2Markdown(result as KeynoteParseResult);
    case 'pptx.parse':
      return await pptxResult2Markdown(result as PptxTaskParseResult);
    case 'html.getByURL':
      return await html2markdown((result as HtmlGetByUrlResult)?.html ?? '', { url });
  }
};

export const createParse = (deps: ParseDeps) => {
  /** 解析一个文件或链接，返回 markdown */
  const parse = async (input: ParseInput): Promise<string> => (await parseDetailed(input)).markdown;

  /** 同 parse，但同时返回任务 id 与所用类型 */
  const parseDetailed = async (input: ParseInput): Promise<ParseResult> => {
    if (isLinkInput(input)) {
      const task = await deps.createTask({
        type: 'html.getByURL',
        spaceId: input.spaceId,
        params: { url: input.url, mode: input.mode ?? 'runtime' },
      });
      const done = await deps.waitTask(task.id, input.wait);
      const result = await deps.downTask(done.id);
      return {
        markdown: await toMarkdown('html.getByURL', result, input.url),
        taskId: done.id,
        type: 'html.getByURL',
      };
    }

    const normalized: ParseFileInput | ParseFileIdInput =
      typeof input === 'string' ? { file: input } : input;

    const name = isFileIdInput(normalized) ? normalized.name : nameForRouting(normalized);
    const type = parseTaskTypeFor(name);
    if (!type) throw unsupported(name);

    const task = await deps.createTask({
      type,
      spaceId: normalized.spaceId,
      ...(isFileIdInput(normalized)
        ? { fileIds: [normalized.fileId] }
        : { files: [normalized.file] }),
    });
    const done = await deps.waitTask(task.id, normalized.wait);
    const result = await deps.downTask(done.id);

    return { markdown: await toMarkdown(type, result), taskId: done.id, type };
  };

  return { parse, parseDetailed };
};

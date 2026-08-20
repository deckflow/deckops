import { describe, it, expect, vi } from 'vitest';
import {
  extensionOf,
  parseTaskTypeFor,
  PARSE_PAGED_TASK_TYPES,
  PARSE_SUPPORTED_EXTENSIONS,
} from '../../src/parse/index.js';
import {
  createParse,
  type ConvertOptions,
  type ConvertRef,
  type ParseOptions,
  type ParseSource,
} from '../../src/parse-facade.js';

/** 建一对 parse / convert 门面，记录它们实际提交了什么任务、拿到了什么返回 */
const harness = (downResult: unknown) => {
  const created: { type: string; params?: Record<string, unknown>; [k: string]: unknown }[] = [];
  const createTask = vi.fn(async (params: never) => {
    created.push(params as never);
    return { id: 'task-1' } as never;
  });
  const { parse, convert } = createParse({
    createTask: createTask as never,
    waitTask: async (taskId) => ({ id: taskId, status: 'completed' }) as never,
    downTask: async () => downResult,
  });
  const run = (source: ParseSource, options?: ParseOptions) => parse(source, options);
  const runConvert = (ref: ConvertRef, options?: ConvertOptions) => convert(ref, options);
  return { run, runConvert, created };
};

/** parse 任务的最小合法返回：有 IR 引用才算数 */
const ir = (extra: Record<string, unknown> = {}) => ({
  irKey: '2026-08/ab/ir.json',
  irSchemaVersion: 'pptx.v1',
  ...extra,
});

describe('扩展名路由', () => {
  it('按扩展名映射到任务类型，大小写与查询串不影响判定', () => {
    expect(parseTaskTypeFor('a.pdf')).toBe('pdf.pdfParse');
    expect(parseTaskTypeFor('/tmp/deck.PPTX')).toBe('pptx.parse');
    expect(parseTaskTypeFor('report.docx')).toBe('docx.parseTextAndImage');
    expect(parseTaskTypeFor('https://x.com/a/b.key?v=1#f')).toBe('keynote.parseTextAndImage');
    expect(parseTaskTypeFor('a.txt')).toBeUndefined();
    expect(parseTaskTypeFor('noext')).toBeUndefined();
  });

  it('extensionOf 处理隐藏文件与无扩展名', () => {
    expect(extensionOf('.gitignore')).toBe('');
    expect(extensionOf('a/b/c.tar.gz')).toBe('.gz');
    expect(extensionOf('')).toBe('');
  });

  it('只有分页格式支持逐页 markdown', () => {
    expect([...PARSE_PAGED_TASK_TYPES].sort()).toEqual(['keynote.parseTextAndImage', 'pptx.parse']);
    expect(PARSE_SUPPORTED_EXTENSIONS).toEqual(['.pdf', '.pptx', '.docx', '.key']);
  });
});

describe('parse：只出 IR', () => {
  it('产出 IR 与它的引用，返回体原样透传', async () => {
    const raw = ir({ slides: [{}], slideMasters: [] });
    const { run, created } = harness(raw);
    const res = await run('./a.pptx');

    expect(created[0]).toMatchObject({ type: 'pptx.parse' });
    // 解析任务不再有任何 View 相关开关
    expect(created[0].params).toEqual({});
    expect(res).toEqual({
      taskId: 'task-1',
      type: 'pptx.parse',
      irKey: '2026-08/ab/ir.json',
      irSchemaVersion: 'pptx.v1',
      ir: raw,
    });
  });

  /**
   * 没有 irKey 说明服务端还没升到 parse/convert 拆分之后的版本：结果看着完整，却没有
   * 任何东西能交给 convert。在这里失败，比让调用方拿着 undefined 去调 convert 强。
   */
  it('返回体没有 irKey 时报错，指向服务端版本', async () => {
    const { run } = harness({ slides: [{}], slideMasters: [] });
    await expect(run('./a.pptx')).rejects.toThrow(/returned no irKey/);
    await expect(run('./a.pptx')).rejects.toThrow(/platform-slave 0\.22\.0/);
  });

  it('pdf 直通 password / parseProfile / includeImages', async () => {
    const { run, created } = harness(ir());
    await run('./a.pdf', { password: 'pw', parseProfile: 'quality', includeImages: false });

    expect(created[0].type).toBe('pdf.pdfParse');
    expect(created[0].params).toEqual({ password: 'pw', parseProfile: 'quality', includeImages: false });
  });

  it('keynote 直通 stayImageAreaRate', async () => {
    const { run, created } = harness(ir());
    await run('./a.key', { stayImageAreaRate: 0.08 });

    expect(created[0].type).toBe('keynote.parseTextAndImage');
    expect(created[0].params).toEqual({ stayImageAreaRate: 0.08 });
  });

  it('链接下发 url / mode，默认 runtime', async () => {
    const { run, created } = harness(ir());
    const res = await run({ url: 'https://example.com/a', mode: 'source' });

    expect(created[0]).toMatchObject({ type: 'html.getByURL' });
    expect(created[0].params).toEqual({ url: 'https://example.com/a', mode: 'source' });
    expect(res.type).toBe('html.getByURL');

    const second = harness(ir());
    await second.run({ url: 'https://example.com/a' });
    expect(second.created[0].params).toMatchObject({ mode: 'runtime' });
  });
});

describe('convert：IR → View', () => {
  const view = {
    format: 'pptx',
    schemaVersion: 'pptx.v1',
    to: 'markdown',
    markdown: '# hi',
    images: [],
  };

  it('按 irKey 转换，不重新上传源文件', async () => {
    const { runConvert, created } = harness(view);
    const res = await runConvert({ irKey: '2026-08/ab/ir.json' });

    expect(created[0]).toMatchObject({ type: 'parse.convert' });
    expect(created[0].params).toEqual({ irKey: '2026-08/ab/ir.json', to: 'markdown' });
    // 转换任务不带任何文件
    expect(created[0]).not.toHaveProperty('files');
    expect(created[0]).not.toHaveProperty('fileIds');
    expect(res).toEqual({ ...view, taskId: 'task-1' });
  });

  it('也可以直接引用产出该 IR 的 parse 任务', async () => {
    const { runConvert, created } = harness(view);
    await runConvert({ taskId: 'task-parse-1' });

    expect(created[0].params).toEqual({ taskId: 'task-parse-1', to: 'markdown' });
  });

  it('只下发显式传入的 View 开关，不塞默认值', async () => {
    const { runConvert, created } = harness(view);
    await runConvert({ irKey: 'k' }, { markdownPages: true, markdownMeta: false });

    expect(created[0].params).toEqual({ irKey: 'k', to: 'markdown', markdownPages: true, markdownMeta: false });
    expect(created[0].params).not.toHaveProperty('markdownStrict');
  });

  it('容错模式下透出 markdownError，不抛错', async () => {
    const { runConvert } = harness({ ...view, markdown: '', markdownError: 'boom' });
    await expect(runConvert({ irKey: 'k' })).resolves.toMatchObject({ markdown: '', markdownError: 'boom' });
  });

  /** 解析一次、反复转换：后续转换不应该再产生任何解析任务。 */
  it('同一份 IR 可以反复转换，源文件只解析一次', async () => {
    const parseHarness = harness(ir());
    const parsed = await parseHarness.run('./a.pptx');

    const convertHarness = harness(view);
    await convertHarness.runConvert({ irKey: parsed.irKey });
    await convertHarness.runConvert({ irKey: parsed.irKey, to: 'markdown' } as never);

    expect(parseHarness.created).toHaveLength(1);
    expect(convertHarness.created).toHaveLength(2);
    expect(convertHarness.created.every((task) => task.type === 'parse.convert')).toBe(true);
  });
});

describe('parse：输入形态', () => {
  it('fileId 输入靠 name 判定扩展名', async () => {
    const { run, created } = harness(ir());
    await run({ fileId: 'f-1', name: 'report.docx' });

    expect(created[0]).toMatchObject({ type: 'docx.parseTextAndImage', fileIds: ['f-1'] });
    expect(created[0]).not.toHaveProperty('files');
  });

  it('非字符串文件必须给 name，否则报错并列出支持的扩展名', async () => {
    const { run } = harness(ir());
    await expect(run({ file: new Uint8Array([1]) as never })).rejects.toThrow(
      /Supported extensions: \.pdf, \.pptx, \.docx, \.key/
    );
  });

  it('不支持的扩展名直接报错，不发任务', async () => {
    const { run, created } = harness(ir());
    await expect(run('./a.txt')).rejects.toThrow(/Cannot determine parser for "\.\/a\.txt"/);
    expect(created).toHaveLength(0);
  });
});

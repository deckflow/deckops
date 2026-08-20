import { describe, it, expect, vi } from 'vitest';
import {
  extensionOf,
  parseTaskTypeFor,
  PARSE_PAGED_TASK_TYPES,
  PARSE_SUPPORTED_EXTENSIONS,
} from '../../src/parse/index.js';
import { createParse, type ParseOptions, type ParseSource } from '../../src/parse-facade.js';

/** 建一个 parse 门面，记录它实际提交了什么任务、拿到了什么返回 */
const harness = (downResult: unknown) => {
  const created: { type: string; params?: Record<string, unknown>; [k: string]: unknown }[] = [];
  const createTask = vi.fn(async (params: never) => {
    created.push(params as never);
    return { id: 'task-1' } as never;
  });
  const { parse } = createParse({
    createTask: createTask as never,
    waitTask: async (taskId) => ({ id: taskId, status: 'completed' }) as never,
    downTask: async () => downResult,
  });
  const run = (source: ParseSource, options?: ParseOptions) => parse(source, options);
  return { run, created };
};

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

describe('parse 门面：output 档位 → slave markdown 开关', () => {
  it('默认只要 markdown，丢结构化结果', async () => {
    const { run, created } = harness({ markdown: '# hi', markdownImages: { u: ['k', 1, 'h'] } });
    const res = await run('./a.pptx');

    expect(created[0]).toMatchObject({ type: 'pptx.parse' });
    expect(created[0].params).toEqual({ markdown: true, markdownOnly: true });
    expect(res).toEqual({
      taskId: 'task-1',
      type: 'pptx.parse',
      markdown: '# hi',
      markdownImages: { u: ['k', 1, 'h'] },
    });
    // markdown 档位不回传原始结构
    expect(res.result).toBeUndefined();
  });

  it("output: 'ir' 不请求 markdown，只回传原始结构", async () => {
    const raw = { slides: [{}], slideMasters: [] };
    const { run, created } = harness(raw);
    const res = await run('./a.pptx', { output: 'ir' });

    expect(created[0].params).toEqual({});
    expect(res.result).toBe(raw);
    expect(res.markdown).toBeUndefined();
  });

  it("output: 'all' 两者都要，result 是返回体原样透传", async () => {
    const raw = { slides: [{}], markdown: '# hi', markdownPages: ['# hi'] };
    const { run, created } = harness(raw);
    const res = await run('./a.pptx', { output: 'all', markdownPages: true });

    expect(created[0].params).toEqual({ markdown: true, markdownPages: true });
    expect(res.markdown).toBe('# hi');
    expect(res.markdownPages).toEqual(['# hi']);
    expect(res.result).toBe(raw);
  });

  it('服务端容错降级时透出 markdownError，不抛错', async () => {
    const { run } = harness({ markdown: '', markdownError: 'boom' });
    const res = await run('./a.docx');
    expect(res.markdown).toBe('');
    expect(res.markdownError).toBe('boom');
  });
});

describe('parse 门面：按任务类型直通参数', () => {
  it('pdf 直通 password / parseProfile / includeImages / markdownMeta', async () => {
    const { run, created } = harness({ markdown: '# pdf' });
    await run('./a.pdf', {
      output: 'all',
      password: 'pw',
      parseProfile: 'quality',
      includeImages: false,
      markdownMeta: true,
      markdownStrict: true,
    });

    expect(created[0].type).toBe('pdf.pdfParse');
    expect(created[0].params).toEqual({
      markdown: true,
      markdownStrict: true,
      password: 'pw',
      parseProfile: 'quality',
      includeImages: false,
      markdownMeta: true,
    });
  });

  it('pdf / docx / html 不支持 markdownPages，传了也不下发', async () => {
    for (const source of ['./a.pdf', './a.docx'] as const) {
      const { run, created } = harness({ markdown: '' });
      await run(source, { markdownPages: true });
      expect(created[0].params).not.toHaveProperty('markdownPages');
    }

    const { run, created } = harness({ markdown: '' });
    await run({ url: 'https://example.com' }, { markdownPages: true });
    expect(created[0].params).not.toHaveProperty('markdownPages');
  });

  it('keynote 直通 stayImageAreaRate 与 markdownPages', async () => {
    const { run, created } = harness({ markdown: '' });
    await run('./a.key', { markdownPages: true, stayImageAreaRate: 0.08 });

    expect(created[0].type).toBe('keynote.parseTextAndImage');
    expect(created[0].params).toEqual({
      markdown: true,
      markdownOnly: true,
      markdownPages: true,
      stayImageAreaRate: 0.08,
    });
  });

  it('链接把 url / mode 与 markdown 开关一起下发', async () => {
    const { run, created } = harness({ markdown: '# page' });
    const res = await run({ url: 'https://example.com/a', mode: 'source' });

    expect(created[0]).toMatchObject({ type: 'html.getByURL' });
    expect(created[0].params).toEqual({
      url: 'https://example.com/a',
      mode: 'source',
      markdown: true,
      markdownOnly: true,
    });
    expect(res.type).toBe('html.getByURL');
  });

  it('链接默认走 runtime 模式', async () => {
    const { run, created } = harness({ markdown: '' });
    await run({ url: 'https://example.com/a' });
    expect(created[0].params).toMatchObject({ mode: 'runtime' });
  });
});

describe('parse 门面：输入形态', () => {
  it('fileId 输入靠 name 判定扩展名', async () => {
    const { run, created } = harness({ markdown: '' });
    await run({ fileId: 'f-1', name: 'report.docx' });

    expect(created[0]).toMatchObject({ type: 'docx.parseTextAndImage', fileIds: ['f-1'] });
    expect(created[0]).not.toHaveProperty('files');
  });

  it('非字符串文件必须给 name，否则报错并列出支持的扩展名', async () => {
    const { run } = harness({ markdown: '' });
    await expect(run({ file: new Uint8Array([1]) as never })).rejects.toThrow(
      /Supported extensions: \.pdf, \.pptx, \.docx, \.key/
    );
  });

  it('不支持的扩展名直接报错，不发任务', async () => {
    const { run, created } = harness({ markdown: '' });
    await expect(run('./a.txt')).rejects.toThrow(/Cannot determine parser for "\.\/a\.txt"/);
    expect(created).toHaveLength(0);
  });
});

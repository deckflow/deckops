import { afterEach, describe, expect, it, vi } from 'vitest';
import { cloudResultToCandidate } from '../../src/ir/cloud-adapter.js';
import { renderMarkdown } from '../../src/views/markdown.js';
import type { ParseResult } from '../../src/cloud/parse-facade.js';

const source = { sha256: 'a'.repeat(64), name: 'fixture.pptx', bytes: 1 };

const parse = (spTree: unknown[]): Promise<ReturnType<typeof cloudResultToCandidate>> =>
  cloudResultToCandidate(
    {
      taskId: 'task', type: 'pptx.parse', irKey: 'ir/fixture', irSchemaVersion: 'pptx.v1',
      ir: { slides: [{ _ref: 'slide1', spTree }], files: {}, images: [] },
    } as ParseResult,
    source,
  ) as never;

const cell = (text: string, extra: Record<string, unknown> = {}) => ({
  text, txBody: { children: [{ children: [{ t: text }] }] }, ...extra,
});

describe('cloud IR adapter', () => {
  it('expands tables into table_row and table_cell so Markdown can render them', async () => {
    const candidate = await parse([
      {
        id: 1, name: 'Table 1', type: 'Table', xfrm: { x: 0, y: 0, cx: 400, cy: 100 },
        table: {
          grid: { cols: [] },
          trs: [
            { cells: [cell('Name'), cell('Qty')] },
            { cells: [cell('Widget'), cell('12')] },
          ],
        },
      },
    ]);

    const types = candidate.ir.document.nodes.map((node) => node.type);
    expect(types).toEqual(['table', 'table_row', 'table_cell', 'table_cell', 'table_row', 'table_cell', 'table_cell']);

    const table = candidate.ir.document.nodes[0]!;
    expect(table.extensions).toMatchObject({ rows: 2, columns: 2 });
    // 单元格摊成 table 的直接子节点时渲染器一个字都取不到，这里锁住层级。
    const rows = candidate.ir.document.nodes.filter((node) => node.type === 'table_row');
    expect(rows.map((row) => row.parentId)).toEqual([table.id, table.id]);
    expect(rows.every((row) => row.children.length === 2)).toBe(true);

    expect(renderMarkdown(candidate.ir).markdown).toContain('| Name | Qty |\n| --- | --- |\n| Widget | 12 |');
  });

  it('carries merge spans through to the cells', async () => {
    const candidate = await parse([
      {
        id: 1, name: 'Table 1', type: 'Table',
        table: { grid: { cols: [] }, trs: [{ cells: [cell('Wide', { colSpan: 2 }), cell('', { hMerge: true })] }] },
      },
    ]);

    const cells = candidate.ir.document.nodes.filter((node) => node.type === 'table_cell');
    expect(cells[0]!.extensions).toMatchObject({ row: 0, column: 0, gridSpan: 2, rowSpan: 1 });
    expect(cells[1]!.extensions).toMatchObject({ column: 1, hMerge: true });
  });

  it('leaves records without a recognizable grid to the generic walk', async () => {
    const candidate = await parse([
      { id: 1, name: 'Empty', type: 'Table', table: { grid: { cols: [] }, trs: [] } },
    ]);

    expect(candidate.ir.document.nodes.map((node) => node.type)).toEqual(['table']);
  });

  it('types title placeholders as headings and text shapes as text', async () => {
    const candidate = await parse([
      { id: 1, name: 'Title 1', type: 'Shape', ph: { type: 'title' },
        txBody: { children: [{ children: [{ t: 'Application architectures' }] }] }, text: 'Application architectures' },
      { id: 2, name: 'Body 1', type: 'Shape', ph: { type: 'body' },
        txBody: { children: [{ children: [{ t: 'Client-server' }] }] }, text: 'Client-server' },
      // 空的标题占位符靠类型词才建得出节点，改判 heading 会让它整个消失。
      { id: 3, name: 'Empty title', type: 'Shape', ph: { type: 'ctrTitle' }, xfrm: { x: 0, y: 0, cx: 10, cy: 10 } },
    ]);

    expect(candidate.ir.document.nodes.map((node) => node.type)).toEqual(['heading', 'text', 'shape']);
    expect(renderMarkdown(candidate.ir).markdown).toContain('## Application architectures');
  });

  it('does not mistake a freeform geometry path for an asset pointer', async () => {
    const candidate = await parse([
      { id: 1, name: 'Freeform 9', type: 'Shape', path: 'M 0 0 L 10 10 Z', xfrm: { x: 0, y: 0, cx: 10, cy: 10 } },
    ]);

    const [shape] = candidate.ir.document.nodes;
    expect(shape!.extensions?.assetPath).toBeUndefined();
    expect(shape!.issues ?? []).toEqual([]);
    // 几何路径被当成资产时会凭空产出这条告警，并把整份产物顶成 degraded。
    expect(candidate.ir.quality.checks.map((check) => check.code)).not.toContain('cloud_asset_unavailable');
    expect(candidate.ir.quality.status).toBe('pass');
  });

  it('still reports a real asset that the cloud could not materialize', async () => {
    const candidate = await parse([
      { id: 1, name: 'Picture 1', type: 'Picture', assetPath: 'assets/missing.png' },
    ]);

    expect(candidate.ir.document.nodes[0]!.issues).toEqual(['missing_media']);
    expect(candidate.ir.quality.checks.map((check) => check.code)).toContain('cloud_asset_unavailable');
  });
});

describe('cloud IR adapter: pptx slide layout', () => {
  const EMU = 12700;
  const box = (x: number, y: number, cx: number, cy: number) => ({ x: x * EMU, y: y * EMU, cx: cx * EMU, cy: cy * EMU });
  const textShape = (id: number, name: string, xfrm: Record<string, number>, paragraphs: Array<Array<Record<string, unknown>>>, extra: Record<string, unknown> = {}) => ({
    id, name, type: 'Shape', xfrm,
    txBody: { children: paragraphs.map((runs) => ({ children: runs })) },
    text: paragraphs.map((runs) => runs.map((run) => run.t).join('')).filter(Boolean).join('\n'),
    ...extra,
  });

  it('keeps bold and italic from the cloud text runs', async () => {
    const candidate = await parse([
      textShape(1, 'Body', box(50, 100, 300, 100), [[{ t: 'server: ' }, { t: 'always-on', style: { b: true } }, { t: ' host' }], [{ t: 'note', style: { i: true } }]]),
    ]);
    const [node] = candidate.ir.document.nodes;
    expect(node!.runs?.map((run) => run.text).join('')).toBe(node!.text);
    // 两个段落各成一段：原先只隔一个换行，Markdown 把它们并成了一段。
    expect(renderMarkdown(candidate.ir).markdown).toContain('server: **always-on** host\n\n*note*');
  });

  it('drops runs that would not reproduce the node text', async () => {
    const candidate = await parse([
      { ...textShape(1, 'Body', box(0, 0, 10, 10), [[{ t: 'abc', style: { b: true } }]]), text: 'something else' },
    ]);
    expect(candidate.ir.document.nodes[0]!.runs).toBeUndefined();
  });

  it('maps footer and slide-number placeholders to furniture that Markdown does not render', async () => {
    const candidate = await parse([
      textShape(1, 'Footer Placeholder 2', box(20, 500, 300, 20), [[{ t: '2: Application Layer' }]], { ph: { type: 'ftr', idx: 11 } }),
      textShape(2, 'Slide Number Placeholder 3', box(600, 500, 100, 20), [[{ t: '7', field: 'slidenum' }]], { ph: { type: 'sldNum', idx: 12 } }),
      textShape(3, 'Body', box(50, 100, 300, 100), [[{ t: 'content' }]]),
    ]);
    expect(candidate.ir.document.nodes.map((node) => node.type)).toEqual(['footer', 'page_number', 'text']);
    expect(renderMarkdown(candidate.ir).markdown).toBe('content\n');
  });

  it('places group children on the slide in points and reads top-to-bottom, left-to-right', async () => {
    const candidate = await parse([
      textShape(4, 'Right', box(400, 100, 250, 150), [[{ t: 'right column' }]]),
      textShape(5, 'Left', box(50, 100, 250, 150), [[{ t: 'left column' }]]),
      { id: 6, name: 'Group 6', type: 'Group',
        xfrm: { ...box(100, 300, 200, 100), chX: 0, chY: 0, chCX: 400 * EMU, chCY: 200 * EMU },
        children: [textShape(7, 'Label', box(200, 100, 100, 50), [[{ t: 'group label' }]])] },
      textShape(8, 'Title 1', box(50, 20, 600, 60), [[{ t: 'Slide title' }]], { ph: { type: 'title' } }),
    ]);
    const label = candidate.ir.document.nodes.find((node) => node.text === 'group label')!;
    // 组合外框 (100, 300, 200×100)，子画布 400×200：缩放 0.5。与本地解析器给出同一个框。
    expect(label.bbox).toEqual([200, 350, 250, 375]);
    expect(renderMarkdown(candidate.ir).markdown).toBe('## Slide title\n\nleft column\n\nright column\n\ngroup label\n');
  });
});

describe('cloud asset retrieval', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  const withImages = (count: number) => ({
    taskId: 'task', type: 'pptx.parse', irKey: 'ir/fixture', irSchemaVersion: 'pptx.v1',
    ir: {
      slides: [{ _ref: 'slide1', spTree: Array.from({ length: count }, (_, index) => ({
        id: index + 1, name: `Picture ${index}`, type: 'Picture', assetPath: `assets/i${index}.png`,
      })) }],
      files: {},
      images: Array.from({ length: count }, (_, index) => ({
        assetPath: `assets/i${index}.png`, accessURL: `https://assets.test/i${index}.png`,
      })),
    },
  } as ParseResult);

  const png = () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });

  it('retries a transient failure instead of permanently losing the image', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1 ? { ok: false, status: 503 } : png();
    }) as never;

    const candidate = await cloudResultToCandidate(withImages(1), source);
    expect(calls).toBe(2);
    expect(candidate.ir.document.assets).toHaveLength(1);
    expect(candidate.ir.quality.checks).toEqual([]);
  });

  it('gives up at once on a permanent status and reports the gap', async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return { ok: false, status: 404 }; }) as never;

    const candidate = await cloudResultToCandidate(withImages(1), source);
    // 4xx 重试只是白等；缺图本身仍要如实报给调用方，而不是让整份解析失败。
    expect(calls).toBe(1);
    expect(candidate.ir.document.assets).toEqual([]);
    expect(candidate.ir.quality.checks.map((check) => check.code)).toEqual(['cloud_asset_unavailable']);
  });

  it('fetches in parallel under a bounded concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    globalThis.fetch = (async () => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return png();
    }) as never;

    const candidate = await cloudResultToCandidate(withImages(12), source);
    expect(candidate.ir.document.assets).toHaveLength(1); // 同内容去重后只剩一份
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('propagates an abort instead of silently returning fewer assets', async () => {
    const controller = new AbortController();
    globalThis.fetch = (async () => { controller.abort(); throw new Error('aborted'); }) as never;

    await expect(cloudResultToCandidate(withImages(2), source, controller.signal)).rejects.toThrow();
  });
});

describe('cloud IR adapter: pptx lists', () => {
  const EMU = 12700;
  const box = (x: number, y: number, cx: number, cy: number) => ({ x: x * EMU, y: y * EMU, cx: cx * EMU, cy: cy * EMU });
  const shape = (name: string, xfrm: Record<string, number>, paragraphs: Array<[string, Record<string, unknown>?]>, extra: Record<string, unknown> = {}) => ({
    name, type: 'Shape', xfrm,
    txBody: { children: paragraphs.map(([t, style]) => ({ ...(style ? { style } : {}), children: [{ t }] })) },
    text: paragraphs.map(([t]) => t).join('\n'),
    ...extra,
  });
  const placeholder = (type: string, idx?: number, xfrm?: Record<string, number>) =>
    ({ type: 'Shape', ph: { type, ...(idx === undefined ? {} : { idx }) }, ...(xfrm ? { xfrm } : {}), txBody: { children: [] } });
  // 与 tests/unit/pptx-parser.test.ts 的 pptxWithMaster 同一份演示文稿：项目符号来自母版 bodyStyle。
  const deck = (spTree: unknown[]) => cloudResultToCandidate({
    taskId: 'task', type: 'pptx.parse', irKey: 'ir/fixture', irSchemaVersion: 'pptx.v1',
    ir: {
      slides: [{ _ref: 'slide1', _layoutRef: 'layout1', _masterRef: 'master1', spTree }],
      slideMasters: [{
        _ref: 'master1', spTree: [placeholder('title', undefined, box(40, 20, 600, 60)), placeholder('body', 1, box(40, 110, 600, 290))],
        slideLayouts: [{ _ref: 'layout1', _masterRef: 'master1', spTree: [placeholder('title'), placeholder('body', 1, box(50, 120, 570, 260))] }],
        titleStyle: { lvl1pPr: { buNone: true } },
        bodyStyle: { lvl1pPr: { buChar: '•' }, lvl2pPr: { buChar: '–' }, lvl3pPr: { buChar: '»' } },
        otherStyle: { lvl1pPr: {} },
      }],
      defaultTextStyle: { lvl1pPr: { buFont: { typeface: 'Arial' } } },
      files: {}, images: [],
    },
  } as ParseResult, source);

  it('nests bullets inherited from the master exactly as the local parser does', async () => {
    const candidate = await deck([
      shape('Title 1', box(50, 20, 600, 60), [['Client-server architecture']], { ph: { type: 'title' } }),
      shape('Content Placeholder 2', box(50, 100, 600, 300), [
        ['server:', { buFont: { typeface: 'ZapfDingbats' }, buNone: true }],
        ['always-on host', { lvl: 1 }],
        ['permanent IP address', { lvl: 1 }],
        ['clients:', { buNone: true }],
        ['communicate with server', { lvl: 1 }],
      ], { ph: { type: 'body', idx: 2 } }),
    ]);
    expect(renderMarkdown(candidate.ir).markdown).toBe([
      '## Client-server architecture', '',
      'server:', '',
      '- always-on host', '- permanent IP address', '',
      'clients:', '',
      '- communicate with server', '',
    ].join('\n'));
    expect(candidate.ir.producer.version).toBe('5');
  });

  it('places placeholders without a frame like the layout and master do, as the local parser does', async () => {
    const candidate = await deck([
      shape('Label 1', box(400, 110, 100, 20), [['HTTP request']]),
      { ...shape('Title 1', box(0, 0, 0, 0), [['HTTP overview']], { ph: { type: 'title' } }), xfrm: undefined },
      { ...shape('Content Placeholder 2', box(0, 0, 0, 0), [['HTTP: hypertext transfer protocol', { buNone: true }], ['client/server model']],
        { ph: { type: 'body', idx: 1 } }), xfrm: undefined },
    ]);
    const named = (name: string) => candidate.ir.document.nodes.find((node) => (node.extensions?.cloud as { name?: string }).name === name)!;
    expect(named('Content Placeholder 2').bbox).toEqual([50, 120, 620, 380]);
    expect(named('Content Placeholder 2').extensions?.bboxInheritedFrom).toBe('layout');
    expect(named('Title 1').bbox).toEqual([40, 20, 640, 80]);
    expect(renderMarkdown(candidate.ir).markdown).toBe('## HTTP overview\n\nHTTP: hypertext transfer protocol\n\n- client/server model\n\nHTTP request\n');
  });

  it('numbers auto-numbered paragraphs and keeps plain paragraphs apart', async () => {
    const candidate = await deck([
      shape('TextBox 1', box(50, 100, 600, 200), [
        ['first', { buAutoNum: 'arabicPeriod' }], ['second', { buAutoNum: 'arabicPeriod' }],
        ['detail', { lvl: 1, buChar: '•' }], ['third', { buAutoNum: 'arabicPeriod' }],
      ]),
      shape('TextBox 2', box(50, 400, 600, 100), [['caption line one'], ['caption line two']]),
    ]);
    expect(renderMarkdown(candidate.ir).markdown).toBe('1. first\n2. second\n   - detail\n3. third\n\ncaption line one\n\ncaption line two\n');
    expect(candidate.ir.document.nodes.find((node) => node.text?.startsWith('caption'))!.extensions?.paragraphs)
      .toEqual([{ start: 0, end: 16, level: 0 }, { start: 17, end: 33, level: 0 }]);
  });
});

describe('Markdown emphasis from text runs', () => {
  const EMU = 12700;
  const render = async (runs: Array<Record<string, unknown>>) => {
    const text = runs.map((run) => run.t).join('');
    const candidate = await parse([{ type: 'Shape', xfrm: { x: 0, y: 0, cx: EMU, cy: EMU }, txBody: { children: [{ children: runs }] }, text }]);
    return renderMarkdown(candidate.ir).markdown.trimEnd();
  };

  it('merges a phrase PowerPoint split into several bold runs', async () => {
    // 实测：「50% 的」被切成四个粗体运行，原先输出 **50****% ****的**** **。
    expect(await render([{ t: '50', style: { b: true } }, { t: '% ', style: { b: true } }, { t: '的', style: { b: true } }, { t: ' ', style: { b: true } }, { t: '市场' }]))
      .toBe('**50% 的** 市场');
  });

  it('keeps whitespace and edge punctuation outside the markers so they still parse', async () => {
    expect(await render([{ t: '中文' }, { t: '粗体：', style: { b: true } }, { t: '正文' }])).toBe('中文**粗体**：正文');
    expect(await render([{ t: 'a' }, { t: '   ', style: { b: true } }, { t: 'b' }])).toBe('a   b');
    expect(await render([{ t: 'see ' }, { t: ' this ', style: { i: true } }, { t: 'now' }])).toBe('see  *this* now');
  });

  it('nests italic inside bold instead of butting the markers together', async () => {
    expect(await render([{ t: 'abc', style: { b: true } }, { t: 'def', style: { b: true, i: true } }])).toBe('**abc*def***');
  });
});

describe('cloud IR adapter: pictures', () => {
  const EMU = 12700;
  const picture = (extra: Record<string, unknown>) => ({ type: 'Picture', name: 'Picture 1', xfrm: { x: 0, y: 0, cx: 10 * EMU, cy: 10 * EMU }, picture: { blip: 'ppt/media/image92.tmp' }, ...extra });

  it('reads alt text from descr with the same cleanup as the local parser', async () => {
    const candidate = await parse([
      picture({ descr: `Image result for ${String.fromCharCode(...new TextEncoder().encode('中信集团'))} logo`, assetPath: 'assets/a.png' }),
      picture({ descr: 'https://timgsa.baidu.com/timg?image&quality=80', assetPath: 'assets/b.png' }),
    ]);
    const [kept, dropped] = candidate.ir.document.nodes;
    expect(kept!.extensions?.alt).toBe('中信集团 logo');
    expect(dropped!.extensions?.alt).toBeUndefined();
    expect(dropped!.extensions?.descr).toMatch(/^https:/);
  });

  it('reports a picture whose image the cloud result left out instead of dropping it silently', async () => {
    // 实测：后端按扩展名筛图片，两张存成 .tmp 的 PNG 没有 assetPath，Markdown 里就少了两张图。
    const candidate = await parse([picture({})]);
    const [node] = candidate.ir.document.nodes;
    expect(node!.issues).toEqual(['missing_media']);
    expect(candidate.ir.quality.checks.map((check) => check.code)).toEqual(['cloud_asset_missing']);
    expect(candidate.ir.quality.checks[0]!.message).toContain('ppt/media/image92.tmp');
  });
});

describe('cloud IR adapter: notes, embedded objects and charts', () => {
  const EMU = 12700;
  const box = (x: number, y: number, cx: number, cy: number) => ({ x: x * EMU, y: y * EMU, cx: Math.round(cx * EMU), cy: Math.round(cy * EMU) });
  const textShape = (name: string, paragraphs: string[], extra: Record<string, unknown> = {}) => ({
    name, type: 'Shape', txBody: { children: paragraphs.map((t) => ({ children: [{ t }] })) }, text: paragraphs.join('\n'), ...extra,
  });
  const deck = (slide: Record<string, unknown>) => cloudResultToCandidate({
    taskId: 'task', type: 'pptx.parse', irKey: 'ir/fixture', irSchemaVersion: 'pptx.v1',
    ir: { slides: [{ _ref: 'slide1', ...slide }], files: {}, images: [] },
  } as ParseResult, source);

  it('reads speaker notes from the slide and renders them like the local parser', async () => {
    const candidate = await deck({ spTree: [textShape('TextBox 1', ['slide body'], { xfrm: box(50, 100, 600, 100) })],
      notes: [textShape('Notes', ['见ppt。解释三多云', '智慧城市云'], { ph: { type: 'body', idx: 1 } })] });
    expect(renderMarkdown(candidate.ir).markdown).toBe('slide body\n\n> **Speaker notes:** 见ppt。解释三多云\n>\n> 智慧城市云\n');
    expect(candidate.ir.document.nodes.filter((node) => node.type === 'speaker_note')).toHaveLength(1);
  });

  it('shows embedded objects as previews, leaves out the ones that draw nothing, and reports SmartArt', async () => {
    const candidate = await deck({ spTree: [
      { type: 'Graphic', name: 'Object 2', graphicType: 'ole', xfrm: box(50, 100, 200, 150), ole: { progId: 'Excel.Sheet.12', name: 'Worksheet', preview: 'ppt/media/image1.png' }, assetPath: 'assets/a.png' },
      { type: 'Graphic', name: 'Object 3', graphicType: 'ole', xfrm: box(300, 230, 0.125, 0.125), ole: { name: 'think-cell Slide', preview: 'ppt/media/image18.emf' }, assetPath: 'assets/b.emf' },
      { type: 'Graphic', name: 'Object 4', graphicType: 'ole', xfrm: box(120, 110, 480, 320), ole: { name: 'Clip', imgW: 0, imgH: 0 } },
      { type: 'Graphic', name: 'Diagram 5', graphicType: 'diagram', xfrm: box(50, 300, 400, 200) },
    ] });
    expect(candidate.ir.document.nodes.map((node) => node.type)).toEqual(['picture', 'embedded_object', 'embedded_object', 'smartart']);
    expect(candidate.ir.document.nodes[0]!.extensions?.embeddedObject).toEqual({ progId: 'Excel.Sheet.12', name: 'Worksheet' });
    const codes = candidate.ir.quality.checks.map((check) => [check.code, check.severity]);
    expect(codes).toContainEqual(['smartart_partial', 'warning']);
    expect(codes).toContainEqual(['embedded_object_preview', 'info']);
    expect(codes).toContainEqual(['embedded_object_hidden', 'info']);
  });

  it('renders cached chart data as a table, and reports a chart that came without data', async () => {
    const chart = { title: 'Share by quarter', kind: 'bar', categories: ['Q1', 'Q2'], series: [{ name: 'Share', values: [0.25, 0.305], formatCode: '0%' }] };
    const withData = await deck({ spTree: [{ type: 'Chart', name: 'Chart 3', xfrm: box(50, 100, 400, 300), chart }] });
    expect(renderMarkdown(withData.ir).markdown).toBe('*Share by quarter*\n\n|  | Share |\n| --- | --- |\n| Q1 | 25% |\n| Q2 | 31% |\n');
    const withoutData = await deck({ spTree: [{ type: 'Chart', name: 'Chart 3', xfrm: box(50, 100, 400, 300) }] });
    expect(withoutData.ir.quality.checks.map((check) => check.code)).toEqual(['chart_partial']);
  });
});

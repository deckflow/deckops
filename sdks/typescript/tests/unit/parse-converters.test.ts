import { describe, expect, it } from 'vitest';
import {
  docxResult2Markdown,
  extensionOf,
  html2markdown,
  keynoteResult2Markdown,
  parseTaskTypeFor,
  pdfResult2Markdown,
  pptxResult2Markdown,
} from '../../src/parse/index.js';
import type {
  DocxParseResult,
  KeynoteParseResult,
  PdfParseResult,
  PptxParseResult,
} from '../../src/parse/index.js';

// 夹具刻意写成可被 Go SDK 复用的纯数据，防止两个 SDK 的转换实现漂移
const keynote = (
  slides: KeynoteParseResult['slides'],
  images?: KeynoteParseResult['images']
): KeynoteParseResult => ({ pageNum: slides.length, width: 1280, height: 720, slides, images });

const slide = (text: string) => ({
  text: text ? [{ id: 'x', text }] : [],
  table: [],
  chart: [],
});

describe('pdfResult2Markdown', () => {
  it('按 role 渲染标题/列表/图注，按页序拼接，图片置于页末', () => {
    const res: PdfParseResult = {
      textBlocks: [
        { text: '第二页正文', locator: { pageIndex: 1 } },
        { text: '大标题', role: 'heading', locator: { pageIndex: 0 } },
        { text: '要点一', role: 'list-item', locator: { pageIndex: 0 } },
        { text: '图注', role: 'caption', locator: { pageIndex: 0 } },
        { text: '加粗', style: { bold: true }, locator: { pageIndex: 0 } },
      ],
      images: [{ key: 'k/a.png', fileName: 'a.png', locator: { pageIndex: 0 } }],
    };

    expect(pdfResult2Markdown(res)).toBe(
      ['## 大标题', '- 要点一', '*图注*', '**加粗**', '![a.png](k/a.png)', '第二页正文'].join(
        '\n\n'
      )
    );
  });

  it('缺 locator 的块归入第 0 页，无 key 的图片跳过，空输入返回空串', () => {
    const res = {
      textBlocks: [{ text: '无定位' }],
      images: [{ fileName: 'no-key.png' }],
    } as unknown as PdfParseResult;
    expect(pdfResult2Markdown(res)).toBe('无定位');
    expect(pdfResult2Markdown({ textBlocks: [] })).toBe('');
  });

  it('toImageUrl 用于把 key 转成可访问地址', () => {
    const res: PdfParseResult = {
      textBlocks: [],
      images: [{ key: 'k/a.png', locator: { pageIndex: 0 } }],
    };
    expect(pdfResult2Markdown(res, { toImageUrl: (k) => `https://cdn/${k}` })).toBe(
      '![img](https://cdn/k/a.png)'
    );
  });
});

describe('keynoteResult2Markdown', () => {
  it('每页一段，页间以 --- 分隔，文本平铺不加标题', () => {
    const md = keynoteResult2Markdown(keynote([slide('封面'), slide('第二页')]));
    expect(md.split('\n\n---\n\n')).toEqual(['封面', '第二页']);
    expect(md).not.toContain('#');
  });

  it('table/chart 追加为正文行，完全为空的页被跳过', () => {
    const md = keynoteResult2Markdown(
      keynote([
        {
          text: [{ id: '1', text: '数据页' }],
          table: [{ id: 't', data: ['A', 'B', ''] }],
          chart: [{ id: 'c', data: { rowName: ['r1', 'r2'], columnName: ['c1', 'c2'] } }],
        },
        slide(''),
      ])
    );
    expect(md.split('\n\n---\n\n')).toHaveLength(1);
    expect(md).toContain('A | B');
    expect(md).toContain('c1 | c2');
    expect(md).toContain('r1 | r2');
  });

  it('pageIndex 正常时图片归到对应页末尾', () => {
    const md = keynoteResult2Markdown(
      keynote(
        [slide('页一'), slide('页二')],
        [
          { id: 'i1', fileName: 'a.png', pageIndex: 0, key: 'k/a.png' },
          { id: 'i2', fileName: 'b.png', pageIndex: 1, key: 'k/b.png' },
        ]
      ),
      { toImageUrl: (k) => `https://cdn/${k}` }
    );
    const pages = md.split('\n\n---\n\n');
    expect(pages[0]).toBe('页一\n![img](https://cdn/k/a.png)');
    expect(pages[1]).toBe('页二\n![img](https://cdn/k/b.png)');
  });

  // ↓ 三条回归：历史实现用 `img.pageIndex === slideIndex` 严格比对，这些图片会被静默丢弃
  it('回归：pageIndex 整体缺失时不丢图，收敛到文末兜底段', () => {
    const md = keynoteResult2Markdown(
      keynote(
        [slide('页一'), slide('页二')],
        [
          { id: 'i1', fileName: 'a.png', key: 'k/a.png' },
          { id: 'i2', fileName: 'b.png', key: 'k/b.png' },
        ]
      )
    );
    expect(md.match(/!\[img\]/g)).toHaveLength(2);
    expect(md.split('\n\n---\n\n').at(-1)).toBe('![img](k/a.png)\n![img](k/b.png)');
  });

  it('回归：pageIndex 越界不丢图', () => {
    const md = keynoteResult2Markdown(
      keynote(
        [slide('页一'), slide('页二')],
        [{ id: 'i', fileName: 'a.png', pageIndex: 5, key: 'k/a.png' }]
      )
    );
    expect(md.match(/!\[img\]/g)).toHaveLength(1);
  });

  it('回归：pageIndex 为负数或非整数不丢图', () => {
    const md = keynoteResult2Markdown(
      keynote(
        [slide('页一')],
        [
          { id: 'i1', fileName: 'a.png', pageIndex: -1, key: 'k/a.png' },
          { id: 'i2', fileName: 'b.png', pageIndex: 1.5, key: 'k/b.png' },
        ]
      )
    );
    expect(md.match(/!\[img\]/g)).toHaveLength(2);
  });

  it('无 key 的图片跳过，空 slides 返回空串', () => {
    expect(keynoteResult2Markdown(keynote([]))).toBe('');
    const md = keynoteResult2Markdown(
      keynote([slide('页')], [{ id: 'i', fileName: 'a.png', pageIndex: 0, key: '' }])
    );
    expect(md).toBe('页');
  });
});

describe('docxResult2Markdown', () => {
  const doc = (content: DocxParseResult['content']): DocxParseResult => ({
    width: 12240,
    height: 15840,
    pageNum: 1,
    content,
  });

  it('段落、图片、表格按 idx 顺序渲染，表格输出 GFM', () => {
    const md = docxResult2Markdown(
      doc([
        { idx: 1, type: 'image', image: 'k/pic.png', name: 'pic.png' },
        { idx: 0, type: 'text', text: '  首段  ' },
        {
          idx: 2,
          type: 'table',
          table: [
            {
              idx: 0,
              type: 'table-row',
              children: [
                { idx: 0, type: 'table-cell', children: [{ idx: 0, type: 'text', text: '姓名' }] },
                { idx: 1, type: 'table-cell', children: [{ idx: 0, type: 'text', text: '年龄' }] },
              ],
            },
            {
              idx: 1,
              type: 'table-row',
              children: [
                { idx: 0, type: 'table-cell', children: [{ idx: 0, type: 'text', text: '张三' }] },
                { idx: 1, type: 'table-cell', children: [{ idx: 0, type: 'text', text: '30' }] },
              ],
            },
          ],
        },
      ])
    );

    expect(md).toBe(
      ['首段', '![pic](k/pic.png)', '| 姓名 | 年龄 |\n| --- | --- |\n| 张三 | 30 |'].join('\n\n')
    );
  });

  it('单元格里的竖线被转义、换行被压平，行列不齐时补空单元格', () => {
    const md = docxResult2Markdown(
      doc([
        {
          idx: 0,
          type: 'table',
          table: [
            {
              idx: 0,
              type: 'table-row',
              children: [
                { idx: 0, type: 'table-cell', children: [{ idx: 0, type: 'text', text: 'a|b' }] },
                {
                  idx: 1,
                  type: 'table-cell',
                  children: [{ idx: 0, type: 'text', text: '换\n行' }],
                },
              ],
            },
            {
              idx: 1,
              type: 'table-row',
              children: [
                {
                  idx: 0,
                  type: 'table-cell',
                  children: [{ idx: 0, type: 'text', text: '只有一列' }],
                },
              ],
            },
          ],
        },
      ])
    );
    expect(md).toContain('| a\\|b | 换 行 |');
    expect(md).toContain('| 只有一列 |  |');
  });

  it('递归展开 group/wsp/sdt，渲染 chart 与 diagram，跳过空块', () => {
    const md = docxResult2Markdown(
      doc([
        {
          idx: 0,
          type: 'group',
          children: [
            { idx: 0, type: 'wsp', children: [{ idx: 0, type: 'text', text: '文本框一' }] },
            {
              idx: 1,
              type: 'group',
              children: [
                { idx: 0, type: 'wsp', children: [{ idx: 0, type: 'text', text: '嵌套文本框' }] },
              ],
            },
          ],
        },
        { idx: 1, type: 'chart', series: ['销量'], categories: ['一月', '二月'] },
        {
          idx: 2,
          type: 'diagram',
          texts: [
            {
              idx: 0,
              aps: [
                { idx: 0, text: '流程节点' },
                { idx: 1, text: '' },
              ],
            },
          ],
        },
        {
          idx: 3,
          type: 'sdt',
          children: [
            { idx: 0, type: 'sdt-wp', children: [{ idx: 0, type: 'text', text: '控件文本' }] },
          ],
        },
        { idx: 4, type: 'text', text: '   ' },
      ])
    );

    expect(md.split('\n\n')).toEqual([
      '文本框一\n嵌套文本框',
      '一月 | 二月\n销量',
      '流程节点',
      '控件文本',
    ]);
  });

  it('按 style.outlineLvl 还原标题层级，Title 视为一级，超深层级截到 ######', () => {
    const md = docxResult2Markdown(
      doc([
        { idx: 0, type: 'text', text: '文档标题', style: { styleId: 'Title', styleName: 'title' } },
        { idx: 1, type: 'text', text: '一级', style: { outlineLvl: 0, styleName: 'heading 1' } },
        { idx: 2, type: 'text', text: '二级', style: { outlineLvl: 1, styleName: 'heading 2' } },
        { idx: 3, type: 'text', text: '第九级', style: { outlineLvl: 8 } },
        { idx: 4, type: 'text', text: '正文', style: { styleName: 'body text' } },
      ])
    );

    expect(md.split('\n\n')).toEqual(['# 文档标题', '# 一级', '## 二级', '###### 第九级', '正文']);
  });

  it('上游未升级（段落不带 style）时退化为扁平段落而非报错', () => {
    const md = docxResult2Markdown(
      doc([
        { idx: 0, type: 'text', text: '标题' },
        { idx: 1, type: 'text', text: '正文' },
      ])
    );
    expect(md).toBe('标题\n\n正文');
  });

  it('outlineLvl 为负数或非整数时不加抬头', () => {
    const md = docxResult2Markdown(
      doc([
        { idx: 0, type: 'text', text: 'a', style: { outlineLvl: -1 } },
        { idx: 1, type: 'text', text: 'b', style: { outlineLvl: 1.5 } },
      ])
    );
    expect(md).toBe('a\n\nb');
  });

  it('空文档与全空表格返回空串', () => {
    expect(docxResult2Markdown(doc([]))).toBe('');
    expect(
      docxResult2Markdown(
        doc([
          {
            idx: 0,
            type: 'table',
            table: [
              {
                idx: 0,
                type: 'table-row',
                children: [
                  { idx: 0, type: 'table-cell', children: [{ idx: 0, type: 'text', text: '  ' }] },
                ],
              },
            ],
          },
        ])
      )
    ).toBe('');
  });
});

describe('pptxResult2Markdown', () => {
  type PptxShape = PptxParseResult['slides'][number]['spTree'][number];

  const shape = (
    text: string,
    {
      left,
      top,
      width = 100,
      height = 20,
      order = 0,
      type = 'Shape',
    }: {
      left: number;
      top: number;
      width?: number;
      height?: number;
      order?: number;
      type?: PptxShape['type'];
    }
  ): PptxShape => ({
    id: order + 1,
    name: `${type} ${order + 1}`,
    type,
    xfrm: { x: left, y: top, cx: width, cy: height },
    ...(text
      ? {
          txBody: {
            children: [{ children: [{ t: text }] }],
          },
        }
      : {}),
  });

  const group = (
    children: PptxShape[],
    {
      left,
      top,
      width = 100,
      height = 20,
      order = 0,
    }: {
      left: number;
      top: number;
      width?: number;
      height?: number;
      order?: number;
    }
  ): PptxShape => ({
    id: order + 1,
    name: `Group ${order + 1}`,
    type: 'Group',
    xfrm: { x: left, y: top, cx: width, cy: height },
    children,
  });

  const presentation = (
    shapes: PptxShape[],
    files: PptxParseResult['files'] = {}
  ): PptxParseResult => ({
    slides: [
      {
        _ref: 'slide1.xml',
        _layoutRef: 'layout1.xml',
        _masterRef: 'master1.xml',
        spTree: shapes,
      },
    ],
    slideMasters: [],
    slideSize: { cx: 12_000_000, cy: 7_000_000 },
    notesSize: { cx: 7_000_000, cy: 9_000_000 },
    files,
  });

  it('递归解析实体组，并在同行出现块级内容时使用 --- 分隔', async () => {
    const EMU = 100_000;
    const result = presentation([
      shape('公司年度报告', {
        left: 50 * EMU,
        top: 20 * EMU,
        width: 500 * EMU,
        height: 50 * EMU,
        order: 0,
      }),
      shape('报告副标题', {
        left: 400 * EMU,
        top: 100 * EMU,
        width: 300 * EMU,
        height: 30 * EMU,
        order: 1,
      }),
      shape('这是左侧第一段。', {
        left: 50 * EMU,
        top: 150 * EMU,
        width: 300 * EMU,
        height: 100 * EMU,
        order: 2,
      }),
      group(
        [
          shape('要点一的内容。', {
            left: 410 * EMU,
            top: 160 * EMU,
            width: 280 * EMU,
            height: 40 * EMU,
            order: 0,
          }),
          shape('要点二的内容。', {
            left: 410 * EMU,
            top: 230 * EMU,
            width: 280 * EMU,
            height: 40 * EMU,
            order: 1,
          }),
        ],
        {
          left: 400 * EMU,
          top: 150 * EMU,
          width: 300 * EMU,
          height: 120 * EMU,
          order: 3,
        }
      ),
      shape('这是左侧第二段。', {
        left: 50 * EMU,
        top: 400 * EMU,
        width: 300 * EMU,
        height: 100 * EMU,
        order: 4,
      }),
    ]);

    await expect(pptxResult2Markdown(result)).resolves.toBe(
      '公司年度报告\n' +
        '报告副标题\n' +
        '这是左侧第一段。\n' +
        '---\n' +
        '要点一的内容。\n' +
        '要点二的内容。\n' +
        '这是左侧第二段。'
    );
  });

  it('每行从有内容的左上对象起步，再按二维最近邻链排序', async () => {
    const result = presentation([
      shape('', { left: 0, top: 0, width: 20, height: 20, order: 0 }),
      shape('A', { left: 100, top: 0, width: 20, height: 100, order: 1 }),
      shape('B', { left: 200, top: 0, width: 20, height: 100, order: 2 }),
      shape('C', { left: 0, top: 150, width: 20, height: 100, order: 3 }),
      shape('D', { left: 0, top: 100_000, width: 20, height: 100, order: 4 }),
      shape('E', { left: 900, top: 100_000, width: 20, height: 100, order: 5 }),
    ]);

    await expect(pptxResult2Markdown(result)).resolves.toBe('A C B\nD E');
  });

  it('空几何对象参与行吸收和最近邻导航，但不产生 Markdown', async () => {
    const result = presentation([
      shape('A', { left: 0, top: 0, height: 100, order: 0 }),
      shape('', { left: 40, top: 225, height: 25, order: 1 }),
      shape('B', { left: 100, top: 350, height: 100, order: 2 }),
    ]);

    await expect(
      pptxResult2Markdown(result, {
        verticalToleranceFactor: 0,
        absoluteVerticalTolerance: 100,
      })
    ).resolves.toBe('A B');
  });

  it('重叠的小对象归入最小的较大虚拟容器，容器子项优先连续输出', async () => {
    const result = presentation([
      shape('Large', { left: 0, top: 0, width: 1000, height: 1000, order: 0 }),
      shape('Medium', { left: 800, top: 800, width: 150, height: 150, order: 1 }),
      shape('Child', { left: 940, top: 940, width: 10, height: 10, order: 2 }),
      shape('After', { left: 960, top: 760, width: 20, height: 20, order: 3 }),
    ]);

    await expect(pptxResult2Markdown(result)).resolves.toBe('Large Medium Child After');
  });

  it('实体组不会被重叠的虚拟容器吸收', async () => {
    const result = presentation([
      shape('Panel', { left: 0, top: 0, width: 1000, height: 1000, order: 0 }),
      group([shape('Entity', { left: 0, top: 0, width: 50, height: 50 })], {
        left: 900,
        top: 900,
        width: 50,
        height: 50,
        order: 1,
      }),
      shape('Next', { left: 1100, top: 0, width: 50, height: 50, order: 2 }),
    ]);

    await expect(pptxResult2Markdown(result)).resolves.toBe('Panel\n---\nNext\n---\nEntity');
  });

  it('绝对垂直容差决定相邻但不重叠的对象是否进入同一行', async () => {
    const result = presentation([
      shape('A', { left: 0, top: 0, height: 10, order: 0 }),
      shape('B', { left: 100, top: 25, height: 10, order: 1 }),
    ]);

    await expect(
      pptxResult2Markdown(result, {
        verticalToleranceFactor: 0,
        absoluteVerticalTolerance: 10,
      })
    ).resolves.toBe('A\nB');
    await expect(
      pptxResult2Markdown(result, {
        verticalToleranceFactor: 0,
        absoluteVerticalTolerance: 15,
      })
    ).resolves.toBe('A B');
  });

  it('表格输出 GFM，图片保持几何顺序并正确转义 Markdown', async () => {
    const table = {
      ...shape('', { left: 0, top: 0, width: 100, height: 80, order: 0, type: 'Table' }),
      table: {
        grid: { cols: [{}, {}] },
        trs: [
          {
            cells: [
              { txBody: { children: [{ children: [{ t: 'Name' }] }] } },
              { txBody: { children: [{ children: [{ t: 'Value' }] }] } },
            ],
          },
          {
            cells: [
              { txBody: { children: [{ children: [{ t: 'A|B' }] }] } },
              { txBody: { children: [{ children: [{ t: '10' }] }] } },
            ],
          },
        ],
      },
    } as PptxShape;
    const image = {
      ...shape('', { left: 120, top: 0, width: 60, height: 60, order: 1, type: 'Picture' }),
      picture: { blip: 'rIdImage' },
      alt: '示例]图',
    } as unknown as PptxShape;
    const result = presentation([table, image], {
      rIdImage: ['image 1.png', 6000, 'hash'],
    });

    await expect(pptxResult2Markdown(result)).resolves.toBe(
      '| Name | Value |\n' +
        '| --- | --- |\n' +
        '| A\\|B | 10 |\n' +
        '---\n' +
        '![示例\\]图](<image 1.png>)'
    );
  });

  it('坐标完全一致时回退到 spTree（OOXML）顺序，并跳过隐藏对象', async () => {
    const hidden = {
      ...shape('Hidden', { left: 0, top: 0, order: 0 }),
      hidden: true,
    };
    const result = presentation([
      hidden,
      shape('First', { left: 0, top: 0, order: 1 }),
      shape('Second', { left: 0, top: 0, order: 2 }),
    ]);

    await expect(pptxResult2Markdown(result)).resolves.toBe('First Second');
  });
});

describe('html2markdown', () => {
  const page = `<!doctype html><html><head><title>探针标题</title></head><body>
    <nav><a href="/a">导航一</a><a href="/b">导航二</a><a href="/c">导航三</a></nav>
    <article><h1>正文大标题</h1>
    <p>第一段正文，需要足够长才能通过 Readability 的字数阈值，所以这里多写一些内容用于填充测试样本，避免被判定为无正文。第一段正文，需要足够长才能通过阈值。</p>
    <p>第二段正文同样需要一定长度，Readability 会根据链接密度与文本长度打分，短文本会被丢弃，因此再补充一些描述性文字保证得分。</p>
    <img data-src="https://cdn.example.com/lazy.png" src="">
    <table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>
    <noscript><img src="https://cdn.example.com/fallback.png"></noscript>
    </article><footer>页脚版权信息</footer></body></html>`;

  it('提取正文、剔除导航页脚、还原懒加载图片、输出 GFM 表格', async () => {
    const md = await html2markdown(page);
    expect(md.startsWith('# 探针标题')).toBe(true);
    expect(md).not.toContain('导航一');
    expect(md).not.toContain('页脚版权信息');
    expect(md).toContain('![img](https://cdn.example.com/lazy.png)');
    expect(md).toContain('| A | B |');
    // noscript 兜底图不应重复出现
    expect(md).not.toContain('fallback.png');
  });

  it('传入 url 时把相对图片地址补全为绝对地址', async () => {
    const html = `<html><head><title>T</title></head><body><article>
      <p>需要足够长的正文才能让 Readability 认定为文章主体，这里补充足够多的中文字符以通过其打分阈值，继续补充更多内容。</p>
      <img src="/static/a.png"></article></body></html>`;
    const md = await html2markdown(html, { url: 'https://example.com/posts/1' });
    expect(md).toContain('![img](https://example.com/static/a.png)');
  });

  it('提取不到正文时抛错，交由调用方降级', async () => {
    await expect(html2markdown('<html><body></body></html>')).rejects.toThrow(/empty content/);
  });
});

describe('扩展名路由', () => {
  it('按扩展名映射到任务类型，大小写与查询串不影响判定', () => {
    expect(parseTaskTypeFor('a.pdf')).toBe('pdf.parse');
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
});

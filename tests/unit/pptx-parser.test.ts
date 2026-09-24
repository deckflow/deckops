import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCAL_LIMITS } from '../../src/local/limits.js';
import { parsePptx } from '../../src/local/pptx/parser.js';
import { renderMarkdown } from '../../src/views/markdown.js';

const source = { sha256: 'b'.repeat(64), name: 'fixture.pptx', bytes: 1 };
const EMU = 12700;
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const xfrm = (x: number, y: number, cx: number, cy: number, child?: [number, number, number, number], attrs = '') =>
  `<a:xfrm${attrs}><a:off x="${x * EMU}" y="${y * EMU}"/><a:ext cx="${cx * EMU}" cy="${cy * EMU}"/>${
    child ? `<a:chOff x="${child[0] * EMU}" y="${child[1] * EMU}"/><a:chExt cx="${child[2] * EMU}" cy="${child[3] * EMU}"/>` : ''}</a:xfrm>`;

const textShape = (id: number, name: string, box: [number, number, number, number], paragraphs: string, placeholder = '') =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr>${placeholder}</p:nvPr></p:nvSpPr>`
  + `<p:spPr>${xfrm(...box)}</p:spPr><p:txBody><a:bodyPr/>${paragraphs}</p:txBody></p:sp>`;

const run = (text: string) => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`;

function pptx(shapes: string): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    'ppt/presentation.xml': strToU8(`<p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="${720 * EMU}" cy="${540 * EMU}"/></p:presentation>`),
    'ppt/_rels/presentation.xml.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>'),
    'ppt/slides/slide1.xml': strToU8(`<p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree></p:cSld></p:sld>`),
  });
}

describe('local pptx parser: slide layout', () => {
  // 形状树的先后是 z-order：页脚、右栏、左栏、组合、标题，故意与阅读顺序相反。
  const candidate = parsePptx(pptx([
    textShape(2, 'Footer Placeholder 2', [20, 500, 300, 20], run('2: Application Layer'), '<p:ph type="ftr" sz="quarter" idx="11"/>'),
    textShape(3, 'Slide Number Placeholder 3', [600, 500, 100, 20],
      '<a:p><a:fld id="{1}" type="slidenum"><a:t>7</a:t></a:fld></a:p>', '<p:ph type="sldNum" sz="quarter" idx="12"/>'),
    textShape(4, 'Right', [400, 100, 250, 150], run('right column')),
    textShape(5, 'Left', [50, 100, 250, 150], run('left column')),
    `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="6" name="Group 6"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>`
      + `<p:grpSpPr>${xfrm(100, 300, 200, 100, [0, 0, 400, 200])}</p:grpSpPr>`
      + textShape(7, 'Label', [200, 100, 100, 50], run('group label'))
      + `</p:grpSp>`,
    textShape(8, 'Title 1', [50, 20, 600, 60], run('Slide title'), '<p:ph type="title"/>'),
  ].join('')), source, DEFAULT_LOCAL_LIMITS);
  const nodes = candidate.ir.document.nodes;
  const named = (name: string) => nodes.find((node) => node.extensions?.name === name)!;

  it('types footer and slide-number placeholders as furniture and keeps them out of Markdown', () => {
    expect(named('Footer Placeholder 2').type).toBe('footer');
    expect(named('Slide Number Placeholder 3').type).toBe('page_number');
    // 文字仍在 IR 里，只是不进阅读视图。
    expect(named('Footer Placeholder 2').text).toBe('2: Application Layer');
    const markdown = renderMarkdown(candidate.ir).markdown;
    expect(markdown).not.toContain('Application Layer');
    expect(markdown).not.toMatch(/^7$/m);
  });

  it('maps group children from the group canvas into slide coordinates', () => {
    // 组合外框 (100, 300, 200×100)，子画布 400×200：缩放 0.5。子形状 (200, 100, 100×50) → (200, 350)–(250, 375)。
    expect(named('Label').bbox).toEqual([200, 350, 250, 375]);
    expect(nodes.find((node) => node.type === 'group')!.bbox).toEqual([100, 300, 300, 400]);
    expect(candidate.ir.quality.checks.map((check) => check.code)).not.toContain('group_transform_partial');
  });

  it('reads the slide top-to-bottom, left-to-right instead of in z-order', () => {
    expect(renderMarkdown(candidate.ir).markdown).toBe('## Slide title\n\nleft column\n\nright column\n\ngroup label\n');
    const page = candidate.ir.document.pages[0]!;
    const texts = page.nodeIds.map((id) => nodes.find((node) => node.id === id)!.text).filter(Boolean);
    expect(texts).toEqual(['Slide title', 'left column', 'right column', 'group label', '2: Application Layer', '7']);
    // z-order 仍然可查。
    expect(named('Right').zIndex!).toBeLessThan(named('Left').zIndex!);
  });

  it('still reports a rotated group, whose children cannot be placed exactly', () => {
    const rotated = parsePptx(pptx(
      `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="2" name="Group 2"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>`
      + `<p:grpSpPr>${xfrm(0, 0, 100, 100, [0, 0, 100, 100], ' rot="5400000"')}</p:grpSpPr>`
      + textShape(3, 'Inside', [10, 10, 20, 20], run('inside'))
      + `</p:grpSp>`), source, DEFAULT_LOCAL_LIMITS);
    expect(rotated.ir.quality.checks.map((check) => check.code)).toContain('group_transform_partial');
  });
});

/**
 * 带版式与母版的演示文稿：母版 bodyStyle 给出两级项目符号，正文占位符的段落只写 lvl。
 * 位置：母版标题 (40, 20)–(640, 80)，版式正文 (50, 120)–(620, 380)；版式标题不写位置。
 */
function pptxWithMaster(shapes: string): Uint8Array {
  const rels = (target: string, type: string) =>
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/></Relationships>`;
  const placeholder = (type: string, idx?: number, box?: [number, number, number, number]) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${(idx ?? 0) + 2}" name="${type}"/><p:cNvSpPr/><p:nvPr><p:ph type="${type}"${idx === undefined ? '' : ` idx="${idx}"`}/></p:nvPr></p:nvSpPr>`
    + `<p:spPr>${box ? xfrm(...box) : ''}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>`;
  const tree = (content: string) => `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${content}</p:spTree></p:cSld>`;
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    'ppt/presentation.xml': strToU8(`<p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="${720 * EMU}" cy="${540 * EMU}"/>`
      + `<p:defaultTextStyle><a:lvl1pPr><a:buFont typeface="Arial"/></a:lvl1pPr></p:defaultTextStyle></p:presentation>`),
    'ppt/_rels/presentation.xml.rels': strToU8(rels('slides/slide1.xml', 'slide')),
    'ppt/slides/slide1.xml': strToU8(`<p:sld ${NS}>${tree(shapes)}</p:sld>`),
    'ppt/slides/_rels/slide1.xml.rels': strToU8(rels('../slideLayouts/slideLayout1.xml', 'slideLayout')),
    'ppt/slideLayouts/slideLayout1.xml': strToU8(`<p:sldLayout ${NS}>${tree(placeholder('title') + placeholder('body', 1, [50, 120, 570, 260]))}</p:sldLayout>`),
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': strToU8(rels('../slideMasters/slideMaster1.xml', 'slideMaster')),
    'ppt/slideMasters/slideMaster1.xml': strToU8(`<p:sldMaster ${NS}>${tree(placeholder('title', undefined, [40, 20, 600, 60]) + placeholder('body', 1, [40, 110, 600, 290]))}<p:txStyles>`
      + `<p:titleStyle><a:lvl1pPr><a:buNone/></a:lvl1pPr></p:titleStyle>`
      + `<p:bodyStyle><a:lvl1pPr><a:buChar char="•"/></a:lvl1pPr><a:lvl2pPr><a:buChar char="–"/></a:lvl2pPr><a:lvl3pPr><a:buChar char="»"/></a:lvl3pPr></p:bodyStyle>`
      + `<p:otherStyle><a:lvl1pPr/></p:otherStyle></p:txStyles></p:sldMaster>`),
  });
}

const paragraph = (text: string, pPr = '') => `<a:p>${pPr}<a:r><a:t>${text}</a:t></a:r></a:p>`;

describe('local pptx parser: lists', () => {
  it('nests bullets inherited from the master under lead lines that switch them off', () => {
    // 实测讲义「Client-server architecture」：引导行写 <a:buNone/>，要点只写 lvl="1"，项目符号来自母版。
    const candidate = parsePptx(pptxWithMaster([
      textShape(2, 'Title 1', [50, 20, 600, 60], run('Client-server architecture'), '<p:ph type="title"/>'),
      textShape(3, 'Content Placeholder 2', [50, 100, 600, 300], [
        paragraph('server:', '<a:pPr><a:buFont typeface="ZapfDingbats"/><a:buNone/></a:pPr>'),
        paragraph('always-on host', '<a:pPr lvl="1"/>'),
        paragraph('permanent IP address', '<a:pPr lvl="1"/>'),
        paragraph('clients:', '<a:pPr><a:buNone/></a:pPr>'),
        paragraph('communicate with server', '<a:pPr lvl="1"/>'),
      ].join(''), '<p:ph type="body" idx="1"/>'),
    ].join('')), source, DEFAULT_LOCAL_LIMITS);
    expect(renderMarkdown(candidate.ir).markdown).toBe([
      '## Client-server architecture', '',
      'server:', '',
      '- always-on host', '- permanent IP address', '',
      'clients:', '',
      '- communicate with server', '',
    ].join('\n'));
    const body = candidate.ir.document.nodes.find((node) => node.extensions?.name === 'Content Placeholder 2')!;
    expect(body.extensions?.paragraphs).toEqual([
      { start: 0, end: 7, level: 0 },
      { start: 8, end: 22, level: 1, list: 'bullet' },
      { start: 23, end: 43, level: 1, list: 'bullet' },
      { start: 44, end: 52, level: 0 },
      { start: 53, end: 76, level: 1, list: 'bullet' },
    ]);
  });

  it('numbers auto-numbered paragraphs and indents a sub-list under the item it follows', () => {
    const candidate = parsePptx(pptxWithMaster(textShape(2, 'TextBox 1', [50, 100, 600, 300], [
      paragraph('first', '<a:pPr><a:buAutoNum type="arabicPeriod"/></a:pPr>'),
      paragraph('second', '<a:pPr><a:buAutoNum type="arabicPeriod"/></a:pPr>'),
      paragraph('detail', '<a:pPr lvl="1"><a:buChar char="•"/></a:pPr>'),
      paragraph('third', '<a:pPr><a:buAutoNum type="arabicPeriod"/></a:pPr>'),
    ].join(''))), source, DEFAULT_LOCAL_LIMITS);
    expect(renderMarkdown(candidate.ir).markdown).toBe('1. first\n2. second\n   - detail\n3. third\n');
  });

  it('indents a skipped outline level only one step, and leaves plain text boxes alone', () => {
    const candidate = parsePptx(pptxWithMaster([
      textShape(2, 'Content Placeholder 1', [50, 100, 600, 200], [
        paragraph('top'), paragraph('deep', '<a:pPr lvl="2"/>'),
      ].join(''), '<p:ph idx="1"/>'),
      // 不是占位符的文本框走 otherStyle，母版的正文项目符号与它无关。
      textShape(3, 'TextBox 2', [50, 400, 600, 100], paragraph('caption line one') + paragraph('caption line two')),
    ].join('')), source, DEFAULT_LOCAL_LIMITS);
    expect(renderMarkdown(candidate.ir).markdown).toBe('- top\n  - deep\n\ncaption line one\ncaption line two\n');
    const box = candidate.ir.document.nodes.find((node) => node.extensions?.name === 'TextBox 2')!;
    expect(box.extensions?.paragraphs).toBeUndefined();
  });

  it('does not turn an empty title placeholder into an empty heading', () => {
    const candidate = parsePptx(pptxWithMaster([
      textShape(2, 'Title 1', [50, 20, 600, 60], '<a:p><a:endParaRPr lang="en-US"/></a:p>', '<p:ph type="title"/>'),
      textShape(3, 'TextBox 2', [50, 100, 600, 100], run('body')),
    ].join('')), source, DEFAULT_LOCAL_LIMITS);
    expect(candidate.ir.document.nodes.map((node) => node.type)).toEqual(['shape', 'text']);
    expect(renderMarkdown(candidate.ir).markdown).toBe('body\n');
  });
});

/** 不写自己位置的占位符：位置照版式、母版。 */
const bareShape = (id: number, name: string, paragraphs: string, placeholder: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr>${placeholder}</p:nvPr></p:nvSpPr>`
  + `<p:spPr/><p:txBody><a:bodyPr/>${paragraphs}</p:txBody></p:sp>`;

describe('local pptx parser: inherited placeholder positions', () => {
  // 实测讲义「HTTP overview」：正文占位符不写位置，右侧图示的标签原先都排在它前面。
  const candidate = parsePptx(pptxWithMaster([
    textShape(4, 'Label 1', [400, 110, 100, 20], run('HTTP request')),
    bareShape(2, 'Title 1', run('HTTP overview'), '<p:ph type="title"/>'),
    bareShape(3, 'Content Placeholder 2', paragraph('HTTP: hypertext transfer protocol', '<a:pPr><a:buNone/></a:pPr>')
      + paragraph('client/server model'), '<p:ph type="body" sz="half" idx="1"/>'),
  ].join('')), source, DEFAULT_LOCAL_LIMITS);
  const named = (name: string) => candidate.ir.document.nodes.find((node) => node.extensions?.name === name)!;

  it('takes the box from the layout placeholder, then from the master', () => {
    expect(named('Content Placeholder 2').bbox).toEqual([50, 120, 620, 380]);
    expect(named('Content Placeholder 2').extensions?.bboxInheritedFrom).toBe('layout');
    // 版式标题也没写位置，退到母版。
    expect(named('Title 1').bbox).toEqual([40, 20, 640, 80]);
    expect(named('Title 1').extensions?.bboxInheritedFrom).toBe('master');
  });

  it('reads the body placeholder before loose shapes on the slide', () => {
    expect(renderMarkdown(candidate.ir).markdown).toBe('## HTTP overview\n\nHTTP: hypertext transfer protocol\n\n- client/server model\n\nHTTP request\n');
  });
});

/** 一页只有一张图片的演示文稿，图片放在给定的包内路径。 */
function pptxWithPicture(target: string, bytes: Uint8Array, descr: string): Uint8Array {
  const picture = `<p:pic><p:nvPicPr><p:cNvPr id="2" name="Picture 1" descr="${descr}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>`
    + `<p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr>${xfrm(10, 10, 100, 100)}</p:spPr></p:pic>`;
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    'ppt/presentation.xml': strToU8(`<p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="${720 * EMU}" cy="${540 * EMU}"/></p:presentation>`),
    'ppt/_rels/presentation.xml.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>'),
    'ppt/slides/slide1.xml': strToU8(`<p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${picture}</p:spTree></p:cSld></p:sld>`),
    'ppt/slides/_rels/slide1.xml.rels': strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${target}"/></Relationships>`),
    [`ppt/media/${target}`]: bytes,
  });
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

describe('local pptx parser: pictures', () => {
  it('names a PNG stored as .tmp by its real type', () => {
    // 实测讲义：两张 PNG 存成 ppt/media/image92.tmp，原先落成 .tmp 资产，Markdown 里的链接打不开。
    const candidate = parsePptx(pptxWithPicture('image92.tmp', PNG, 'Alice'), source, DEFAULT_LOCAL_LIMITS);
    expect(candidate.ir.document.assets.map((asset) => [asset.path.split('.').pop(), asset.mediaType])).toEqual([['png', 'image/png']]);
    expect(renderMarkdown(candidate.ir).markdown).toMatch(/^!\[Alice\]\([0-9a-f]{64}\.png\)\n$/);
  });

  it('keeps the author description as alt text but not a file path', () => {
    const junk = parsePptx(pptxWithPicture('image1.png', PNG, 'C:\\Users\\WADE\\QQ\\WinTemp\\RichOle\\SWUP_5R.png'), source, DEFAULT_LOCAL_LIMITS);
    const image = junk.ir.document.nodes.find((node) => node.type === 'image')!;
    expect(image.extensions?.alt).toBeUndefined();
    expect(image.extensions?.descr).toContain('RichOle');
    expect(renderMarkdown(junk.ir).markdown).toMatch(/^!\[\]\(/);
  });
});

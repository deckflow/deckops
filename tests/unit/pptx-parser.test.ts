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

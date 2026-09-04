import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { parseHtmlSource } from '../../src/local/html/parser.js';
import { DEFAULT_LOCAL_LIMITS } from '../../src/local/limits.js';
import { OpcPackage, resolvePart } from '../../src/local/opc/package.js';
import { parseXml } from '../../src/local/xml.js';
import { renderMarkdown } from '../../src/views/markdown.js';
import { result3ToDeckIr } from '../../src/ir/result3-adapter.js';
import { finalizeAssets } from '../../src/ir/assets.js';

const source = { sha256: 'a'.repeat(64), name: 'page.html', bytes: 1 };

describe('local parser safety and rendering', () => {
  it('extracts static HTML and flags hydration shells', () => {
    const article = parseHtmlSource('<html><head><title>T</title></head><body><main><h1>Hello</h1><p>World</p></main></body></html>', source, 'https://example.com');
    expect(article.ir.document.nodes.map((node) => node.text)).toEqual(['Hello', 'World']);
    expect(article.quality.status).toBe('pass');
    const inline = parseHtmlSource('<main><div>Hello <a href="/world">world</a>!</div></main>', source, 'https://example.com');
    expect(inline.ir.document.nodes).toHaveLength(1);
    expect(inline.ir.document.nodes[0]).toMatchObject({ text: 'Hello world!', links: [{ href: 'https://example.com/world', text: 'world' }] });
    expect(renderMarkdown(inline.ir).markdown).toContain('[world](https://example.com/world)');
    const image = parseHtmlSource('<main><img src="/a.png" alt="A"></main>', source, 'https://example.com/page');
    expect(renderMarkdown(image.ir).markdown).toContain('![A](https://example.com/a.png)');
    expect(image.quality.checks.map((check) => check.code)).toContain('remote_assets_not_localized');
    const shell = parseHtmlSource('<body><div id="root"></div><script>__NEXT_DATA__={}</script></body>', source);
    expect(shell.quality.checks.map((check) => check.code)).toContain('runtime_required');
  });

  it('rejects traversal paths and XML entity declarations', () => {
    const unsafe = zipSync({ '../escape.xml': strToU8('<x/>') });
    expect(() => new OpcPackage(unsafe, DEFAULT_LOCAL_LIMITS)).toThrow('Unsafe ZIP path');
    expect(() => parseXml('<!DOCTYPE x [<!ENTITY y "z">]><x>&y;</x>', DEFAULT_LOCAL_LIMITS, 'bad.xml')).toThrow('forbidden DTD');
    const withAsset = new OpcPackage(zipSync({ 'word/media/a.png': new Uint8Array([1, 2, 3]) }), { ...DEFAULT_LOCAL_LIMITS, assetBytes: 2 });
    expect(() => withAsset.readAsset('word/media/a.png')).toThrow('asset-size limit');
    expect(resolvePart('ppt/slides/slide1.xml', '/ppt/media/image%201.png')).toBe('ppt/media/image%201.png');
    expect(() => resolvePart('word/document.xml', '%2e%2e/%2e%2e/escape.bin')).toThrow('Unsafe ZIP path');
  });

  it('escapes raw HTML when deriving Markdown', () => {
    const parsed = parseHtmlSource('<main><p>&lt;script&gt;alert(1)&lt;/script&gt;</p></main>', source);
    const markdown = renderMarkdown(parsed.ir).markdown;
    expect(markdown).toContain('&lt;script&gt;');
    expect(markdown).not.toContain('<script>');
  });

  it('preserves result.v3 hierarchy and renders explicit PDF table cells', () => {
    const candidate = result3ToDeckIr({ source: { ...source, name: 'table.pdf' }, document: {
      version: 'result.v3', source: { sha256: source.sha256, pages: 1, encrypted: false }, profile: 'balanced',
      docInfo: {}, outline: null, annotations: [], warnings: [], stats: {},
      pages: [{ index: 1, width: 100, height: 100, status: 'ok', sourceObjectCoverage: 1, probe: { imageAreaRatio: 0 } }],
      elements: [
        { id: 'list', type: 'list', page: 1, order: 0, text: '', bbox: [0, 0, 1, 1], parentId: null, provenance: {}, confidence: 1, isBodyContent: true, list: { ordered: false, depth: 0 } },
        { id: 'item', type: 'list_item', page: 1, order: 1, text: 'Item', marks: [{ type: 'link', start: 0, end: 4, target: { kind: 'external', href: 'https://example.com' } }], bbox: [0, 0, 1, 1], parentId: 'list', provenance: {}, confidence: 1, isBodyContent: true, marker: '•', depth: 0 },
        { id: 'table', type: 'table', page: 1, order: 2, text: 'Name Value', bbox: [0, 0, 10, 10], parentId: null, provenance: {}, confidence: 1, isBodyContent: true,
          table: { rows: 2, cols: 2, headerRows: 1, headerCols: 0, kind: 'ruled', crossPage: false, cells: [
            { r: 0, c: 0, rowSpan: 1, colSpan: 1, text: 'Name', bbox: [0, 0, 1, 1], isHeader: true, role: 'column_header', page: 1, confidence: 1, sourceObjectIds: [] },
            { r: 0, c: 1, rowSpan: 1, colSpan: 1, text: 'Value', bbox: [1, 0, 2, 1], isHeader: true, role: 'column_header', page: 1, confidence: 1, sourceObjectIds: [] },
            { r: 1, c: 0, rowSpan: 1, colSpan: 1, text: 'A', bbox: [0, 1, 1, 2], isHeader: false, role: 'data', page: 1, confidence: 1, sourceObjectIds: [] },
            { r: 1, c: 1, rowSpan: 1, colSpan: 1, text: '1', bbox: [1, 1, 2, 2], isHeader: false, role: 'data', page: 1, confidence: 1, sourceObjectIds: [] },
          ] } },
      ],
    } as never });
    const list = candidate.ir.document.nodes.find((node) => node.type === 'list')!;
    const item = candidate.ir.document.nodes.find((node) => node.type === 'list_item')!;
    expect(item.parentId).toBe(list.id); expect(list.children).toContain(item.id);
    const markdown = renderMarkdown(candidate.ir).markdown;
    expect(markdown).toContain('[Item](https://example.com)');
    expect(markdown).toContain('| A | 1 |');
  });

  it('keeps same-content assets with distinct safe extensions addressable', () => {
    const data = new Uint8Array([1, 2, 3]);
    const nodes = [
      { id: 'a', type: 'image', parentId: null, children: [], order: 0, sourceRef: {}, extensions: { assetPath: 'a.jpg' } },
      { id: 'b', type: 'image', parentId: null, children: [], order: 1, sourceRef: {}, extensions: { assetPath: 'b.jpeg' } },
    ];
    const assets = finalizeAssets([{ path: 'a.jpg', data }, { path: 'b.jpeg', data }], nodes);
    expect(assets).toHaveLength(2);
    expect(new Set(assets.map((asset) => asset.id)).size).toBe(2);
    expect(nodes[0]!.extensions!.assetPath).not.toBe(nodes[1]!.extensions!.assetPath);
  });
});

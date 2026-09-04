import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { parseHtmlSource } from '../../src/local/html/parser.js';
import { DEFAULT_LOCAL_LIMITS } from '../../src/local/limits.js';
import { OpcPackage } from '../../src/local/opc/package.js';
import { parseXml } from '../../src/local/xml.js';
import { renderMarkdown } from '../../src/views/markdown.js';

const source = { sha256: 'a'.repeat(64), name: 'page.html', bytes: 1 };

describe('local parser safety and rendering', () => {
  it('extracts static HTML and flags hydration shells', () => {
    const article = parseHtmlSource('<html><head><title>T</title></head><body><main><h1>Hello</h1><p>World</p></main></body></html>', source, 'https://example.com');
    expect(article.ir.document.nodes.map((node) => node.text)).toEqual(['Hello', 'World']);
    expect(article.quality.status).toBe('pass');
    const shell = parseHtmlSource('<body><div id="root"></div><script>__NEXT_DATA__={}</script></body>', source);
    expect(shell.quality.checks.map((check) => check.code)).toContain('runtime_required');
  });

  it('rejects traversal paths and XML entity declarations', () => {
    const unsafe = zipSync({ '../escape.xml': strToU8('<x/>') });
    expect(() => new OpcPackage(unsafe, DEFAULT_LOCAL_LIMITS)).toThrow('Unsafe ZIP path');
    expect(() => parseXml('<!DOCTYPE x [<!ENTITY y "z">]><x>&y;</x>', DEFAULT_LOCAL_LIMITS, 'bad.xml')).toThrow('forbidden DTD');
  });

  it('escapes raw HTML when deriving Markdown', () => {
    const parsed = parseHtmlSource('<main><p>&lt;script&gt;alert(1)&lt;/script&gt;</p></main>', source);
    const markdown = renderMarkdown(parsed.ir).markdown;
    expect(markdown).toContain('&lt;script&gt;');
    expect(markdown).not.toContain('<script>');
  });
});

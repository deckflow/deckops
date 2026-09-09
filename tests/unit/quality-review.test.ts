import { describe, it, expect } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { makeIr, qualityOf } from '../../src/local/common.js';
import { assessCandidate, improvesCandidate } from '../../src/quality/assessment.js';
import { evaluatePolicy } from '../../src/engine/policy.js';
import { renderMarkdown } from '../../src/views/markdown.js';
import { parseDocx } from '../../src/local/docx/parser.js';
import { DEFAULT_LOCAL_LIMITS } from '../../src/local/limits.js';
import type { DeckIrNode, ParseCandidate, QualityCheck } from '../../src/ir/schema.js';
const source = { sha256: 'a'.repeat(64), name: 'test.pptx', bytes: 100 };
const input = { input: { kind: 'document' as const, file: 'test.pptx', name: 'test.pptx', taskType: 'pptx.parse' as const }, inputLabel: 'test.pptx', source };
const node = (id: string, text: string, extra: Partial<DeckIrNode> = {}): DeckIrNode => ({ id, text, type: 'paragraph', parentId: null, children: [], order: 0, page: 1, sourceRef: {}, ...extra });
function candidate(nodes: DeckIrNode[], checks: QualityCheck[] = [], total = 1): ParseCandidate {
  const quality = qualityOf(checks, { pages: { total, parsed: 1 } });
  const ir = makeIr({ format: 'pptx', source, producer: { name: 'fixture', version: '1' }, nodes,
    pages: [{ id: 'p1', index: 1, nodeIds: nodes.map(n => n.id), sourceRef: { page: 1 } }], quality });
  return { ir, quality, assets: [] };
}
describe('review: lightweight quality and recommendations', () => {
  it('distinguishes missing pages and failed pages from page objects', () => {
    const a = assessCandidate(candidate([node('n', '')], [{ code: 'page_parse_failed', severity: 'error', message: 'failed', pages: [1] }], 3));
    expect(a.summary).toMatchObject({ sourcePages: 3, parsedPages: 0, missingPages: [2, 3], missingPageCount: 2, failedPages: [1], searchableTextCharacters: 0 });
    expect(a.recommendation?.paid).toBe(true);
    expect(a.issues.map(i => i.code)).toContain('no_body_text');
  });
  it('counts table cell content once and excludes annotations, image alt and document metadata', () => {
    const c = candidate([node('cell', 'cell body', { type: 'table_cell', children: ['p'] }), node('p', 'cell body', { parentId: 'cell' }), node('image', 'alt', { type: 'image' }), node('comment', 'comment', { type: 'annotation' })]);
    c.ir.document.metadata.outline = 'lots of outline text';
    expect(assessCandidate(c).summary?.searchableTextCharacters).toBe(9);
    expect(assessCandidate(candidate([node('image', 'alt', { type: 'image' })])).issues.map(i => i.code)).toContain('no_body_text');
  });
  it('keeps distinct nested list text while avoiding synthetic separator characters in the count', () => {
    const c = candidate([node('list', 'Intro', { type: 'list_item', children: ['step'] }), node('step', 'Step1', { type: 'list_item', parentId: 'list' })]);
    expect(assessCandidate(c).summary?.searchableTextCharacters).toBe(10);
  });
  it('does not infer OCR from a blank page and bounds missing page lists', () => {
    const a = assessCandidate(candidate([], [], 100_000_000));
    expect(a.summary?.ocrSuspectedPages).toEqual([]);
    expect(a.summary?.missingPages).toHaveLength(1000);
    expect(a.summary?.missingPagesTruncated).toBe(true);
    expect(a.summary?.missingPageCount).toBe(99_999_999);
  });
  it('recommends cloud in local mode, and upgrades missing slides only with policy authorization', () => {
    const a = assessCandidate(candidate([node('n', 'some body')], [{ code: 'missing_slide', severity: 'error', message: 'missing', pages: [2] }], 2));
    const local = evaluatePolicy(input, {}, { engine: 'local' }, a);
    expect(local.reason).toBe('local_only'); expect(local.next?.argv).toEqual(['deckops', '--engine', 'cloud', '--', 'test.pptx']);
    expect(evaluatePolicy(input, {}, { engine: 'auto' }, a).reason).toBe('upload_denied');
    expect(evaluatePolicy(input, {}, { engine: 'auto', allowUpload: true }, a).action).toBe('upgrade');
  });
  it('visual and OCR warnings recommend cloud without claiming verified automatic remedies', () => {
    for (const code of ['group_transform_partial', 'ocr_required']) {
      const a = assessCandidate(candidate([node('n', 'body')], [{ code, severity: 'warning', message: code, pages: [1] }]));
      expect(a.recommendation?.reasonCodes).toContain(code);
      const route = evaluatePolicy(input, {}, { engine: 'auto', allowUpload: true }, a);
      expect(route.reason).toBe('capability_unverified'); expect(route.next?.argv).toContain('cloud');
    }
  });
  it('never hides unmapped defects or suggests dropping incompatible parameters, secrets or budgets', () => {
    const a = assessCandidate(candidate([node('n', 'body')], [{ code: 'unknown_local_issue', severity: 'warning', message: 'unknown' }]));
    expect(evaluatePolicy(input, {}, {}, a).reason).toBe('no_verified_remedy');
    for (const flags of [{ trackedChanges: 'final' as const }, { password: 'secret' }]) {
      const route = evaluatePolicy(input, flags, {}, a); expect(route.next?.argv).toEqual(['deckops', 'capabilities', '--json']);
      expect(JSON.stringify(route)).not.toContain('secret');
    }
    expect(evaluatePolicy(input, {}, { cloudLimits: { maxSourceBytes: 100 } }, a).next?.argv).toEqual(['deckops', 'capabilities', '--json']);
  });
  it('does not recommend paid parsing for metadata-only warnings or good results', () => {
    expect(assessCandidate(candidate([node('n', 'body')])).recommendation).toBeUndefined();
    expect(assessCandidate(candidate([node('n', 'body')], [{ code: 'macro_preserved', severity: 'warning', message: 'preserved' }])).recommendation).toBeUndefined();
  });
  it('does not treat cloud result page count as source evidence or erase known missing pages', () => {
    const local = candidate([node('n', 'body')], [{ code: 'missing_slide', severity: 'error', message: 'missing', pages: [2] }], 2);
    const cloud = candidate([node('n', 'cloud body')]); cloud.ir.producer.engine = 'cloud';
    expect(assessCandidate(cloud).summary?.sourcePages).toBeUndefined();
    const before = assessCandidate(local), after = assessCandidate(cloud, undefined, before.summary?.sourcePages);
    expect(after.summary?.missingPages).toEqual([2]);
    expect(improvesCandidate(local, cloud, before, after)).toBe(false);
  });
  it('rejects empty cloud output even if parser says pass', () => {
    const local = candidate([node('n', 'readable')], [{ code: 'local_parse_failed', severity: 'warning', message: 'partial' }]);
    const cloud = candidate([]); cloud.ir.producer.engine = 'cloud';
    expect(improvesCandidate(local, cloud, assessCandidate(local), assessCandidate(cloud))).toBe(false);
  });
});
describe('review: Markdown and DOCX fidelity', () => {
  it('preserves commands while protecting literal entities and HTML', () => {
    const md = renderMarkdown(candidate([node('n', 'echo a && echo b <script> &amp;')]).ir).markdown;
    expect(md).toBe('echo a && echo b &lt;script&gt; &amp;amp;\n');
  });
  it('uses unescaped code contents with safe fences, retaining blank lines', () => {
    const c = candidate([node('n', '', { runs: [{ text: 'echo `a` && <b>', code: true }] })]);
    expect(renderMarkdown(c.ir).markdown).toBe('``echo `a` && <b>``\n');
    c.ir.document.nodes[0] = node('n', 'echo a && b\n\n\n```\nend', { type: 'code_block', extensions: { language: 'sh' } });
    expect(renderMarkdown(c.ir).markdown).toBe('````sh\necho a && b\n\n\n```\nend\n````\n');
  });
  it('replaces unsupported controls visibly, keeps tab/newline/Unicode and original IR', () => {
    const text = '\u000ba\u0001b\t中\u200d文\nend\u000c';
    const c = candidate([node('n', text)]); const output = renderMarkdown(c.ir);
    expect(output.markdown).toBe('\uFFFDa\uFFFDb\t中\u200d文\nend\uFFFD\n');
    expect(output.warnings.join()).toContain('3 unsupported');
    expect(c.ir.document.nodes[0]?.text).toBe(text);
    expect(assessCandidate(c).summary?.controlCharacters).toBe(3);
  });
  it('preserves ordinary strike, respects explicit off, and filters basic revisions', () => {
    const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:strike/></w:rPr><w:t>strike</w:t></w:r><w:r><w:rPr><w:strike w:val="0"/></w:rPr><w:t>plain</w:t></w:r><w:del><w:r><w:delText>deleted</w:delText></w:r></w:del><w:ins><w:r><w:t>added</w:t></w:r></w:ins></w:p></w:body></w:document>';
    const data = zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8(xml) });
    const parse = (trackedChanges: 'final' | 'original') => renderMarkdown(parseDocx(data, source, DEFAULT_LOCAL_LIMITS, { trackedChanges }).ir).markdown;
    expect(parse('final')).toBe('~~strike~~plainadded\n'); expect(parse('original')).toBe('~~strike~~plaindeleted\n');
  });
});

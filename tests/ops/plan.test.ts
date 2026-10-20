import { describe, expect, it } from 'vitest';
import { familyOf, findRoute, matrix, planRoute } from '../../src/ops/plan.js';
import * as P from '../../src/ops/params.js';
import { ROUTES } from '../../src/ops/routes.js';
import type { InputFamily, OpsOptions, Target, Verb } from '../../src/ops/types.js';

const opts = (options: Partial<OpsOptions> & Pick<OpsOptions, 'to'>): OpsOptions => options as OpsOptions;

const ROWS: [Verb, InputFamily, Target, string[]][] = [
  ['render', 'pptx', 'image', ['convertor.ppt2image']],
  ['render', 'ppt', 'image', ['convertor.ppt2image']],
  ['render', 'pdf', 'image', ['convertor.pdf2image']],
  ['render', 'key', 'image', ['convertor.keynote2image']],
  ['render', 'docx', 'image', ['convertor.doc2pdf', 'convertor.pdf2image']],
  ['render', 'html', 'image', ['convertor.html2png']],
  ['render', 'url', 'image', ['convertor.html2png']],
  ['render', 'md', 'image', ['convertor.markdown2png']],
  ['render', 'pptx', 'video', ['convertor.ppt2video']],
  ['render', 'ppt', 'video', ['convertor.ppt2video']],
  ...(['pdf', 'pptx', 'docx', 'key', 'url'] as const).flatMap((family) => [
    ['convert', family, 'markdown', ['document.convert']],
    ['extract', family, 'json', ['document.extract']],
    ['extract', family, 'assets', ['document.extract']],
  ] as [Verb, InputFamily, Target, string[]][]),
];

describe('route table', () => {
  it.each(ROWS)('%s %s → %s runs %j', (verb, family, to, types) => {
    expect(findRoute(verb, family, to)?.steps.map((step) => step.type)).toEqual(types);
  });

  it('holds exactly the 4.0 rows: no xlsx, no document-to-document conversion yet', () => {
    expect(ROUTES.flatMap((route) => route.from.map((from) => `${route.verb}:${from}:${route.to}`))).toHaveLength(25);
    expect(familyOf('sheet.xlsx')).toBeUndefined();
    expect(findRoute('convert', 'pptx', 'json')).toBeUndefined();
  });

  it('gates the document routes and the URL render on the server capabilities', () => {
    expect(findRoute('convert', 'pdf', 'markdown')?.requires).toEqual({ task: 'document.convert', to: 'markdown' });
    expect(findRoute('extract', 'pdf', 'assets')?.requires).toEqual({ task: 'document.extract', to: 'assets' });
    expect(findRoute('render', 'url', 'image')?.requires).toEqual({ task: 'convertor.html2png' });
    expect(findRoute('render', 'html', 'image')?.requires).toBeUndefined();
  });

  it('appends one webp conversion per frame and keeps the caveat', () => {
    const plan = planRoute('render', 'docx', 'deck.docx', opts({ to: 'image', imageFormat: 'webp' }));
    expect(plan.steps.map((step) => [step.type, step.each ?? false])).toEqual([
      ['convertor.doc2pdf', false], ['convertor.pdf2image', false], ['image.convertWebp', true],
    ]);
    expect(plan.warnings).toEqual([expect.stringContaining('PDF pagination')]);
  });

  it('summarizes the table for `deckops formats`', () => {
    expect(matrix()).toContainEqual({ verb: 'render', to: 'image', from: ['pptx', 'ppt', 'pdf', 'key', 'docx', 'html', 'url', 'md'] });
    expect(matrix()).toContainEqual({ verb: 'extract', to: 'json', from: ['pdf', 'pptx', 'docx', 'key', 'url'] });
  });
});

describe('planning errors name the way out', () => {
  it('reports an unsupported combination with the nearest ones that exist', () => {
    expect(() => planRoute('render', 'md', 'a.md', opts({ to: 'video' }))).toThrow(expect.objectContaining({
      code: 'unsupported', message: 'render cannot turn .md into video.', hint: '.md can render to image; video comes from .pptx, .ppt.',
    }));
    expect(() => planRoute('convert', 'html', 'a.html', opts({ to: 'markdown' }))).toThrow(expect.objectContaining({
      code: 'unsupported', hint: expect.stringContaining('.html supports render --to image'),
    }));
  });

  it('rejects an unknown input format before anything is read', () => {
    expect(() => planRoute('convert', familyOf('book.xlsx'), 'book.xlsx', opts({ to: 'markdown' }))).toThrow(expect.objectContaining({
      code: 'unsupported', message: '.xlsx files are not supported.', hint: 'convert accepts .pdf, .pptx, .docx, .key, URLs.',
    }));
  });

  it('rejects options the route or the input format cannot honour', () => {
    expect(() => planRoute('render', 'pptx', 'a.pptx', opts({ to: 'video', pages: [1] }))).toThrow(expect.objectContaining({
      code: 'usage_error', message: 'pages does not apply to render .pptx → video.',
    }));
    expect(() => planRoute('convert', 'pptx', 'a.pptx', opts({ to: 'markdown', anchors: true }))).toThrow(expect.objectContaining({
      code: 'usage_error', message: 'anchors only applies to .pdf input, not .pptx.',
    }));
    expect(() => planRoute('render', 'key', 'a.key', opts({ to: 'image', imageFormat: 'jpg' }))).toThrow(expect.objectContaining({
      code: 'usage_error', hint: 'Choose png, webp.',
    }));
  });
});

describe('parameter mapping', () => {
  it('maps quality, width and scale to the long edge each task accepts', () => {
    const warnings: string[] = [];
    expect(P.ppt2image(opts({ to: 'image' }), {}, warnings)).toEqual({ format: 'png' });
    expect(P.ppt2image(opts({ to: 'image', quality: 'low' }), {}, warnings)).toEqual({ resolution: 1080, format: 'jpg' });
    expect(P.ppt2image(opts({ to: 'image', width: 1500 }), {}, warnings)).toEqual({ resolution: 1920, format: 'png' });
    expect(warnings).toEqual(['Resolution 1500 was snapped to 1920: PPTX renders at 1080/1920/2560 only.']);
    expect(P.pdf2image(opts({ to: 'image', scale: 2, imageFormat: 'webp' }))).toEqual({ resolution: 2160, format: 'png' });
    expect(P.pdf2image(opts({ to: 'image', quality: 'medium' }))).toEqual({ resolution: 1600, format: 'png' });
    expect(P.html2png(opts({ to: 'image', width: 800 }), { url: 'https://example.com/' })).toEqual({ key: 'https://example.com/', fullPage: true, width: 800 });
    expect(P.markdown2png(opts({ to: 'image', width: 800, scale: 2 }))).toEqual({ scale: 2, pageWidth: 800 });
  });

  it('maps document options to the document task contract', () => {
    expect(P.documentConvert(opts({ to: 'markdown', anchors: true, strict: true, profile: 'quality', password: 'p' }), {})).toEqual({
      to: 'markdown', anchors: true, strict: true, parse: { profile: 'quality', password: 'p' },
    });
    expect(P.documentExtract(opts({ to: 'json' }), { url: 'https://example.com/' })).toEqual({ to: 'json', url: 'https://example.com/' });
  });
});

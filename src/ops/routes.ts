import * as P from './params.js';
import type { InputFamily, OptionName, Route, Step } from './types.js';

/**
 * The route table: (verb, input family, target) → cloud task chain. Data, not code — adding a
 * conversion is adding a row. Parameter mapping lives in `params.ts`, execution in `chain.ts`.
 */

/** Source extension → input family. URLs are recognised by scheme, not here. */
export const EXTENSIONS: Readonly<Record<string, Exclude<InputFamily, 'url'>>> = {
  '.pdf': 'pdf',
  '.pptx': 'pptx',
  '.ppt': 'ppt',
  '.docx': 'docx',
  '.key': 'key',
  '.html': 'html',
  '.htm': 'html',
  '.md': 'md',
  '.markdown': 'md',
};

/** Options that only some input families accept, whatever the route. */
export const OPTION_FAMILIES: Readonly<Partial<Record<OptionName, readonly InputFamily[]>>> = {
  profile: ['pdf'],
  password: ['pdf'],
  includeImages: ['pdf'],
  stayImageAreaRate: ['key'],
  anchors: ['pdf'],
  splitPages: ['pptx', 'key'],
};

const DOCUMENTS: readonly InputFamily[] = ['pdf', 'pptx', 'docx', 'key', 'url'];
const PARSE_OPTIONS: readonly OptionName[] = ['profile', 'password', 'includeImages', 'stayImageAreaRate'];
const PAGED_IMAGE_OPTIONS: readonly OptionName[] = ['pages', 'quality', 'imageFormat', 'width', 'scale'];
const PAGE_IMAGE_OPTIONS: readonly OptionName[] = ['imageFormat', 'width', 'scale'];

export const ROUTES: readonly Route[] = [
  {
    verb: 'render', from: ['pptx', 'ppt'], to: 'image', options: PAGED_IMAGE_OPTIONS, imageFormats: ['png', 'jpg', 'webp'],
    steps: [{ type: 'convertor.ppt2image', params: P.ppt2image, result: 'files' }],
  },
  {
    verb: 'render', from: ['pdf'], to: 'image', options: PAGED_IMAGE_OPTIONS, imageFormats: ['png', 'jpg', 'webp'],
    steps: [{ type: 'convertor.pdf2image', params: P.pdf2image, result: 'files' }],
  },
  {
    verb: 'render', from: ['key'], to: 'image', options: ['pages', 'imageFormat'], imageFormats: ['png', 'webp'],
    steps: [{ type: 'convertor.keynote2image', params: P.none, result: 'files' }],
  },
  {
    verb: 'render', from: ['docx'], to: 'image', options: PAGED_IMAGE_OPTIONS, imageFormats: ['png', 'jpg', 'webp'],
    steps: [
      { type: 'convertor.doc2pdf', params: P.none, result: 'files' },
      { type: 'convertor.pdf2image', params: P.pdf2image, result: 'files' },
    ],
    caveat: 'DOCX is laid out as PDF first, so pages follow the PDF pagination.',
  },
  {
    verb: 'render', from: ['html'], to: 'image', options: PAGE_IMAGE_OPTIONS, imageFormats: ['png', 'webp'],
    steps: [{ type: 'convertor.html2png', params: P.html2png, result: 'files' }],
  },
  {
    verb: 'render', from: ['url'], to: 'image', options: PAGE_IMAGE_OPTIONS, imageFormats: ['png', 'webp'],
    steps: [{ type: 'convertor.html2png', params: P.html2png, result: 'files' }],
    requires: { task: 'convertor.html2png' },
  },
  {
    verb: 'render', from: ['md'], to: 'image', options: PAGE_IMAGE_OPTIONS, imageFormats: ['png', 'webp'],
    steps: [{ type: 'convertor.markdown2png', params: P.markdown2png, result: 'files' }],
  },
  {
    verb: 'render', from: ['pptx', 'ppt'], to: 'video', options: [],
    steps: [{ type: 'convertor.ppt2video', params: P.none, result: 'files' }],
  },
  {
    verb: 'convert', from: DOCUMENTS, to: 'markdown', options: ['anchors', 'splitPages', 'strict', ...PARSE_OPTIONS],
    steps: [{ type: 'document.convert', params: P.documentConvert, result: 'markdown' }],
    requires: { task: 'document.convert', to: 'markdown' },
  },
  {
    verb: 'extract', from: DOCUMENTS, to: 'json', options: PARSE_OPTIONS,
    steps: [{ type: 'document.extract', params: P.documentExtract, result: 'json' }],
    requires: { task: 'document.extract', to: 'json' },
  },
  {
    verb: 'extract', from: DOCUMENTS, to: 'assets', options: PARSE_OPTIONS,
    steps: [{ type: 'document.extract', params: P.documentExtract, result: 'assets' }],
    requires: { task: 'document.extract', to: 'assets' },
  },
];

/** Appended to an image route for webp output: one conversion per rendered frame. */
export const WEBP_STEP: Step = { type: 'image.convertWebp', params: P.none, result: 'files', each: true };

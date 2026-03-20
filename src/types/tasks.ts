/**
 * File type to task type mappings for compress command
 */
export const COMPRESS_TYPES: Record<string, string> = {
  '.zip': 'file.compress',
  '.pptx': 'file.compress',
  '.key': 'file.compress',
  '.docx': 'file.compress',
  '.xlsx': 'file.compress',
  '.mp4': 'video.compress',
  '.avi': 'video.compress',
  '.mov': 'video.compress',
  '.mkv': 'video.compress',
};

/**
 * File type to task type mappings for extract command
 */
export const EXTRACT_TYPES: Record<string, string> = {
  '.jpg': 'image.ocr',
  '.jpeg': 'image.ocr',
  '.png': 'image.ocr',
  '.pptx': 'pptx.getFontInfo',
};

/**
 * Extract type to task type mappings
 */
export const EXTRACT_TYPE_MAP: Record<string, string> = {
  ocr: 'image.ocr',
  fonts: 'pptx.getFontInfo',
  'text-shapes': 'pptx.getTextShapes',
};

/**
 * Output format to file extension and task type mappings for render command
 */
export const RENDER_FORMATS: Record<string, Record<string, string>> = {
  image: {
    '.ppt': 'convertor.ppt2image',
    '.pptx': 'convertor.ppt2image',
    '.pdf': 'convertor.pdf2image',
    '.key': 'convertor.keynote2image',
  },
  pdf: {
    '.ppt': 'convertor.ppt2pdf',
    '.pptx': 'convertor.ppt2pdf',
    '.doc': 'convertor.doc2pdf',
    '.docx': 'convertor.doc2pdf',
    '.key': 'convertor.keynote2pdf',
  },
  video: {
    '.ppt': 'convertor.ppt2video',
    '.pptx': 'convertor.ppt2video',
  },
  html: {
    '.key': 'convertor.keynote2html',
  },
  png: {
    '.html': 'convertor.html2png',
    '.md': 'convertor.markdown2png',
  },
  pptx: {
    '.ppt': 'convertor.ppt2pptx',
    '.html': 'convertor.html2pptx',
  },
  webp: {
    '.jpg': 'image.convertWebp',
    '.jpeg': 'image.convertWebp',
    '.png': 'image.convertWebp',
  },
};

/**
 * Supported OCR languages
 */
export const OCR_LANGUAGES = [
  'zh-hans',
  'zh-hant',
  'en',
  'ja',
  'ko',
  'ar',
  'de',
  'es',
  'fr',
  'it',
  'pt',
  'ru',
] as const;

export type OcrLanguage = (typeof OCR_LANGUAGES)[number];

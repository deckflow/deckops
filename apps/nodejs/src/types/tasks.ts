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
  '.pptx': 'pptx.getFontInfo',
};

/**
 * Extract type to task type mappings
 */
export const EXTRACT_TYPE_MAP: Record<string, string> = {
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

/**
 * Supported language sets for translation
 */
export const SUPPORTED_SOURCE_LANGUAGES = [
  'auto',
  'zh',
  'zh-hans',
  'zh-hant',
  'en',
  'ja',
  'ko',
  'de',
  'fr',
  'es',
  'it',
  'pt',
  'ru',
] as const;

export const SUPPORTED_TARGET_LANGUAGES = [
  'zh',
  'zh-hans',
  'zh-hant',
  'en',
  'ja',
  'ko',
  'de',
  'fr',
  'es',
  'it',
  'pt',
  'ru',
] as const;

/**
 * Generation command supported extensions
 */
export const GENERATION_FILE_EXTENSIONS = [
  '.html',
  '.pdf',
  '.docx',
  '.pptx',
  '.txt',
  '.md',
  '.mm',
  '.xmind',
  '.ipynb',
] as const;

/**
 * Translation command supported extensions
 */
export const TRANSLATION_FILE_EXTENSIONS = ['.docx', '.pptx', '.pdf', '.xlsx', '.key'] as const;

/**
 * Translation models by engine
 */
export const TRANSLATE_MODELS = {
  deepl: {
    models: ['deepl'],
  },
  gemini: {
    models: ['gemini-pro', 'gemini-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
  },
  openai: {
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-5.2', 'gpt-5-mini'],
  },
} as const;

export const PDF_TRANSLATE_MODELS = {
  gemini: {
    models: ['gemini-pro', 'gemini-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
  },
  openai: {
    models: ['gpt-4', 'gpt-4o-mini', 'gpt-5.1', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o'],
  },
} as const;

export type TranslateEngine = keyof typeof TRANSLATE_MODELS;

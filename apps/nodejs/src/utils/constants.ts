/**
 * Constants and mappings
 */

export {
  COMPRESS_TYPES,
  EXTRACT_TYPES,
  EXTRACT_TYPE_MAP,
  RENDER_FORMATS,
  OCR_LANGUAGES,
  SUPPORTED_SOURCE_LANGUAGES,
  SUPPORTED_TARGET_LANGUAGES,
  GENERATION_FILE_EXTENSIONS,
  TRANSLATION_FILE_EXTENSIONS,
  TRANSLATE_MODELS,
  PDF_TRANSLATE_MODELS,
} from '../types/tasks.js';

/**
 * Default values
 */
export const DEFAULT_TIMEOUT = 300; // seconds
export const DEFAULT_POLL_INTERVAL = 2000; // milliseconds
export const DEFAULT_OCR_LANGUAGE = 'zh-hans';
export const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB

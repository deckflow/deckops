import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const VERSION: string = (require('../package.json') as { version: string }).version;
/** Exact dependency pin, read without loading PDF.js. */
export const PDF_PARSER_VERSION: string = (require('../package.json') as { dependencies: Record<string, string> }).dependencies['pdf-lite-parse']!;

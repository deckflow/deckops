import { DeckOpsError } from '../errors/index.js';
import type { ParseTaskType } from '../types.js';

/** Extension → task type, shared by the Node and browser inputs. */
export const EXTENSION_ROUTES: Record<string, ParseTaskType> = {
  '.pdf': 'pdf.pdfParse',
  '.pptx': 'pptx.parse',
  '.docx': 'docx.parseTextAndImage',
  '.key': 'keynote.parseTextAndImage',
};

export const SUPPORTED_EXTENSIONS = Object.keys(EXTENSION_ROUTES);

/** Clear failures over approximate results: each rejection names its way out. */
const UNSUPPORTED_HINTS: Record<string, string> = {
  '.doc': 'Save it as .docx (File → Save As in Word) and parse that.',
  '.ppt': 'Save it as .pptx and parse that.',
  '.xls': 'Spreadsheets are not supported yet.',
  '.xlsx': 'Spreadsheets are not supported yet.',
  '.pages': 'Export it as .docx or .pdf and parse that.',
  '.numbers': 'Spreadsheets are not supported yet.',
  '.md': 'Markdown is a parse output, not an input.',
};

export function extensionOf(name: string): string {
  const clean = name.split(/[?#]/)[0] ?? '';
  const base = clean.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

export function routeExtension(name: string): ParseTaskType {
  const ext = extensionOf(name);
  const route = EXTENSION_ROUTES[ext];
  if (route) {
    return route;
  }
  const hint = UNSUPPORTED_HINTS[ext];
  throw DeckOpsError.unsupported(
    ext
      ? `${ext} files are not supported. Supported: ${SUPPORTED_EXTENSIONS.join(', ')}.`
      : `Cannot tell the format of "${name}". Supported: ${SUPPORTED_EXTENSIONS.join(', ')}.`,
    hint ? { hint } : {}
  );
}

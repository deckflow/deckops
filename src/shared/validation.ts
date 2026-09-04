import { DeckParseError } from '../errors/index.js';
import type { ConvertFlags, ParseFlags } from '../types.js';

export type FormatKey = 'pdf' | 'pptx' | 'docx' | 'keynote' | 'link';

export function formatForTaskType(type: string): FormatKey | undefined {
  switch (type) {
    case 'pdf.pdfParse':
      return 'pdf';
    case 'pptx.parse':
      return 'pptx';
    case 'docx.parseTextAndImage':
      return 'docx';
    case 'keynote.parseTextAndImage':
      return 'keynote';
    case 'html.getByURL':
      return 'link';
    default:
      return undefined;
  }
}

const PARSE_FLAG_FORMATS: Record<keyof ParseFlags, FormatKey[]> = {
  profile: ['pdf'],
  password: ['pdf'],
  includeImages: ['pdf'],
  pageFurniture: ['pdf'],
  overlaidText: ['pdf'],
  trackedChanges: ['docx'],
  stayImageAreaRate: ['keynote'],
  mode: ['link'],
};

const CONVERT_FLAG_FORMATS: Partial<Record<keyof ConvertFlags, FormatKey[]>> = {
  anchors: ['pdf'],
  splitPages: ['pptx', 'keynote'],
};

export function validateParseFlagsForFormat(format: FormatKey | undefined, flags: ParseFlags): void {
  for (const [name, value] of Object.entries(flags)) {
    if (value === undefined) {
      continue;
    }
    const allowed = PARSE_FLAG_FORMATS[name as keyof ParseFlags];
    if (allowed && format && !allowed.includes(format)) {
      throw DeckParseError.usage(`--${kebab(name)} only applies to ${allowed.join('/')} input, not ${format}.`);
    }
  }
}

export function validateConvertFlagsForFormat(format: FormatKey | undefined, flags: ConvertFlags): void {
  for (const [name, value] of Object.entries(flags)) {
    if (value === undefined || value === false) {
      continue;
    }
    const allowed = CONVERT_FLAG_FORMATS[name as keyof ConvertFlags];
    if (allowed && format && !allowed.includes(format)) {
      throw DeckParseError.usage(`--${kebab(name)} only applies to ${allowed.join('/')} input, not ${format}.`);
    }
  }
}

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

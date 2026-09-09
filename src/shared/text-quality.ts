import type { DeckIR, DeckIrNode } from '../ir/schema.js';

/** C0 controls other than tab/CR/LF, plus DEL. Do not strip Unicode formatting. */
export function countControlCharacters(text: string): number { return text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g)?.length ?? 0; }
export function cleanControlCharacters(text: string): string { return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '\uFFFD'); }
const NON_BODY = new Set(['image', 'figure', 'picture', 'chart', 'annotation', 'comment', 'header', 'footer', 'footnote', 'endnote', 'notes', 'table', 'table_row']);
export function bodyTextStats(ir: DeckIR): { text: string; pages: Map<number, number>; controlCharacters: number; characters: number } {
  const byId = new Map(ir.document.nodes.map(n => [n.id, n]));
  const textOf = (n: DeckIrNode): string => n.runs?.length ? n.runs.map(r => r.text).join('') : n.text ?? '';
  const accepted = (n: DeckIrNode): boolean => !NON_BODY.has(n.type) && !/\/(?:header|footer|comments|footnotes|endnotes|notesSlides)[^/]*[/.]/i.test(n.sourceRef.part ?? '');
  const hidden = new Map<string, boolean>();
  // Iterative memoization keeps deeply nested tables linear and avoids double-counting cell text.
  const suppressed = (n: DeckIrNode): boolean => {
    const chain: string[] = []; const seen = new Set<string>(); let parent = n.parentId; let result = false;
    while (parent) {
      if (hidden.has(parent)) { result = hidden.get(parent)!; break; }
      if (seen.has(parent)) break;
      seen.add(parent); chain.push(parent);
      const ancestor = byId.get(parent); if (!ancestor) break;
      if (!accepted(ancestor) && !['table', 'table_row'].includes(ancestor.type) || ancestor.type === 'table_cell' && !!textOf(ancestor).trim()) { result = true; break; }
      parent = ancestor.parentId;
    }
    for (const id of chain) hidden.set(id, result);
    return result;
  };
  const parts: string[] = []; const pages = new Map<number, number>(); let controlCharacters = 0; let characters = 0;
  for (const node of ir.document.nodes) {
    if (!accepted(node) || suppressed(node)) continue;
    const raw = textOf(node); controlCharacters += countControlCharacters(raw);
    const text = cleanControlCharacters(raw).replace(/\uFFFD/g, '').trim();
    parts.push(raw); characters += text.length;
    if (node.page !== undefined) pages.set(node.page, (pages.get(node.page) ?? 0) + text.length);
  }
  return { text: parts.join('\n'), pages, controlCharacters, characters };
}

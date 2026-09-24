import type { ListKind, TextParagraph } from '../ir/pptx-lists.js';
import type { DeckIR, DeckIrNode, DeckIrRun } from '../ir/schema.js';
import { cleanControlCharacters, countControlCharacters } from '../shared/text-quality.js';

export const MARKDOWN_RENDERER_VERSION = '1.4.0';

export interface RenderedMarkdown {
  markdown: string;
  pages?: string[];
  warnings: string[];
}

export function renderMarkdown(ir: DeckIR, options: { anchors?: boolean | undefined; splitPages?: boolean | undefined; assetPrefix?: string | undefined } = {}): RenderedMarkdown {
  const byId = new Map(ir.document.nodes.map((node) => [node.id, node]));
  const roots = ir.document.nodes.filter((node) => node.parentId === null).sort((a, b) => a.order - b.order);
  const renderSet = (nodes: DeckIrNode[]): string => normalize(nodes.map((node) => renderNode(node, byId, options)).filter(Boolean).join('\n\n'));
  const markdown = renderSet(roots);
  const pages = options.splitPages && ir.document.pages.length > 0
    ? ir.document.pages.map((page) => renderSet(page.nodeIds.map((id) => byId.get(id)).filter((node): node is DeckIrNode => Boolean(node) && node!.parentId === null)))
    : undefined;
  const controlCharacters = countControlCharacters(markdown);
  return { markdown: cleanControlCharacters(markdown), ...(pages ? { pages: pages.map(cleanControlCharacters) } : {}), warnings: controlCharacters ? [`Replaced ${controlCharacters} unsupported control characters with U+FFFD in Markdown; original IR text is preserved.`] : [] };
}

function renderNode(node: DeckIrNode, byId: Map<string, DeckIrNode>, options: { anchors?: boolean | undefined; assetPrefix?: string | undefined }): string {
  const anchor = options.anchors ? `<!-- deckir:${escapeComment(node.id)} -->\n` : '';
  const children = node.children.map((id) => byId.get(id)).filter((item): item is DeckIrNode => Boolean(item)).sort((a, b) => a.order - b.order);
  const text = node.runs?.length ? renderRuns(node.runs) : escapeMarkdown(node.text ?? '');
  let own = '';
  if (node.type === 'heading') own = renderHeading(node, text);
  else if (node.type === 'list_item') own = `${listMarker(node)} ${indentLines(text, 2)}`;
  else if (node.type === 'blockquote') own = text.split('\n').map((line) => `> ${line}`).join('\n');
  else if (node.type === 'code' || node.type === 'code_block') own = fencedCode(node.text ?? '', String(node.extensions?.language ?? ''));
  else if (node.type === 'image' || node.type === 'figure' || node.type === 'picture' || node.type === 'chart') own = renderImage(node, options.assetPrefix ?? '');
  else if (node.type === 'formula') own = node.extensions?.formula && typeof node.extensions.formula === 'object' && 'latex' in node.extensions.formula
    ? `$$\n${String((node.extensions.formula as { latex?: unknown }).latex ?? node.text ?? '')}\n$$` : text;
  else if (node.type === 'table') own = renderTable(node, byId);
  else if (node.type === 'speaker_note') own = renderSpeakerNote(node, text);
  // 页眉、页脚、页码是版式家具，文字留在 IR 里，不进阅读视图（pdf-parse 的 Markdown 同样只以注释保留）。
  else if (!['table_row', 'table_cell', 'group', 'section', 'article', 'main', 'header', 'footer', 'page_number', 'nav', 'aside', 'list'].includes(node.type)) {
    const paragraphs = paragraphsOf(node);
    own = paragraphs ? renderParagraphs(node, paragraphs) : text;
  }
  const childBody = node.type === 'table' ? '' : children.map((child) => renderNode(child, byId, options)).filter(Boolean).join('\n\n');
  return `${anchor}${[own, childBody].filter(Boolean).join('\n\n')}`.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
}

function renderTable(table: DeckIrNode, byId: Map<string, DeckIrNode>): string {
  const rows = table.children.map((id) => byId.get(id)).filter((node): node is DeckIrNode => node?.type === 'table_row');
  const declaredColumns = Number((table.extensions?.table as { cols?: unknown } | undefined)?.cols ?? table.extensions?.columns ?? 0);
  const matrix = rows.map((row) => {
    const cells = row.children.map((id) => byId.get(id)).filter((cell): cell is DeckIrNode => Boolean(cell));
    const width = Math.max(declaredColumns, ...cells.map((cell, index) => Number(cell.extensions?.column ?? index) + Number(cell.extensions?.gridSpan ?? 1)), 0);
    const values = Array<string>(width).fill('');
    for (const [index, cell] of cells.entries()) {
      const content = cell.runs?.length ? renderRuns(cell.runs).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>') : escapeTable(cell.text ?? childText(cell, byId));
      values[Number(cell.extensions?.column ?? index)] = content;
    }
    return values;
  });
  if (!matrix.length) return '';
  const columns = Math.max(...matrix.map((row) => row.length));
  const padded = matrix.map((row) => [...row, ...Array(Math.max(0, columns - row.length)).fill('')]);
  const header = padded[0] ?? [];
  const separator = Array(columns).fill('---');
  const body = [header, separator, ...padded.slice(1)].map((row) => `| ${row.join(' | ')} |`).join('\n');
  const caption = (table.extensions?.table as { caption?: unknown } | undefined)?.caption;
  return typeof caption === 'string' && caption.trim() ? `${escapeMarkdown(caption.trim())}\n\n${body}` : body;
}

function childText(node: DeckIrNode, byId: Map<string, DeckIrNode>): string {
  return node.children.map((id) => byId.get(id)).filter((item): item is DeckIrNode => Boolean(item)).map((item) => item.text ?? childText(item, byId)).filter(Boolean).join(' ');
}

function renderImage(node: DeckIrNode, prefix: string): string {
  const alt = escapeMarkdown(String(node.extensions?.alt ?? node.text ?? ''));
  const assetPath = typeof node.extensions?.assetPath === 'string' ? node.extensions.assetPath.replace(/^assets\//, '') : undefined;
  const external = typeof node.extensions?.externalUrl === 'string' ? node.extensions.externalUrl : undefined;
  const target = assetPath ? `${prefix}${assetPath}` : external;
  return target ? `![${alt}](${escapeLink(target)})` : alt ? `*${alt}*` : '';
}

/** 标题只占一行：多段标题的第二段原先会跑出 `#` 行，成了一段正文。没有字的标题不输出。 */
function renderHeading(node: DeckIrNode, text: string): string {
  const line = text.split('\n').map((part) => part.trim()).filter(Boolean).join(' ');
  return line ? `${'#'.repeat(clamp(Number(node.extensions?.level ?? 2), 1, 6))} ${line}` : '';
}

/**
 * 带段落结构的文本框（pptx 解析器写在 `extensions.paragraphs`）：每个普通段落自成一段，列表项
 * 按大纲级别嵌套，段落与列表之间都空一行；段内换行（`<a:br>`）仍是换行。级别跳级（0 直接到 2）
 * 只缩进一层——Markdown 的嵌套按父项内容列对齐，多缩进一层就成了代码块。
 */
function renderParagraphs(node: DeckIrNode, paragraphs: readonly TextParagraph[]): string {
  const blocks: string[] = [];
  let items: string[] = [];
  const open: Array<{ level: number; kind: ListKind; indent: number; width: number; count: number }> = [];
  const flushItems = (): void => { if (items.length) blocks.push(items.join('\n')); items = []; open.length = 0; };
  for (const paragraph of paragraphs) {
    const body = node.runs?.length
      ? renderRuns(sliceRuns(node.runs, paragraph.start, paragraph.end))
      : escapeMarkdown((node.text ?? '').slice(paragraph.start, paragraph.end));
    // 行首空白要去掉：列表标记后跟五个以上空格，CommonMark 就把这一项读成代码块。
    const lines = body.split('\n').map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    if (!paragraph.list) { flushItems(); blocks.push(lines.join('\n')); continue; }
    while (open.length && open.at(-1)!.level > paragraph.level) open.pop();
    if (open.at(-1)?.level === paragraph.level && open.at(-1)!.kind !== paragraph.list) open.pop();
    let list = open.at(-1);
    if (!list || list.level < paragraph.level) {
      list = { level: paragraph.level, kind: paragraph.list, indent: list ? list.indent + list.width : 0, width: 0, count: 0 };
      open.push(list);
    }
    list.count += 1;
    const marker = list.kind === 'number' ? `${list.count}.` : '-';
    list.width = marker.length + 1;
    const pad = ' '.repeat(list.indent);
    items.push(`${pad}${marker} ${lines.join(`\n${pad}${' '.repeat(list.width)}`)}`);
  }
  flushItems();
  return blocks.join('\n\n');
}

/**
 * 讲者备注：引用块，并标明是备注。原先备注作为普通段落跟在幻灯片内容后面，读的人分不清哪句
 * 在幻灯片上、哪句是讲者要说的。
 */
function renderSpeakerNote(node: DeckIrNode, text: string): string {
  const paragraphs = paragraphsOf(node);
  const body = (paragraphs ? renderParagraphs(node, paragraphs) : text).trim();
  if (!body) return '';
  // 以列表开头的备注，标签单独成行，免得「- 」接在标签后面不再是列表。
  const labelled = /^(?:[-*+]|\d+\.)\s/.test(body) ? `**Speaker notes:**\n\n${body}` : `**Speaker notes:** ${body}`;
  return labelled.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n');
}

/** 读 IR 里的段落结构；缺字段或对不上就当没有，按纯文本渲染。 */
function paragraphsOf(node: DeckIrNode): TextParagraph[] | undefined {
  const raw = node.extensions?.paragraphs;
  if (!Array.isArray(raw)) return undefined;
  const paragraphs = raw.flatMap((item): TextParagraph[] => {
    if (!item || typeof item !== 'object') return [];
    const { start, end, level, list } = item as Record<string, unknown>;
    if (typeof start !== 'number' || typeof end !== 'number' || typeof level !== 'number') return [];
    return [{ start, end, level, ...(list === 'bullet' || list === 'number' ? { list } : {}) }];
  });
  return paragraphs.length > 0 && paragraphs.length === raw.length ? paragraphs : undefined;
}

function sliceRuns(runs: readonly DeckIrRun[], start: number, end: number): DeckIrRun[] {
  const sliced: DeckIrRun[] = [];
  let offset = 0;
  for (const run of runs) {
    const from = Math.max(start, offset);
    const to = Math.min(end, offset + run.text.length);
    if (from < to) sliced.push({ ...run, text: run.text.slice(from - offset, to - offset) });
    offset += run.text.length;
  }
  return sliced;
}

interface InlinePiece { text: string; bold: boolean; italic: boolean; strike: boolean; code: boolean; href: string | undefined }

/** 由外到内的行内格式层：链接包着粗体，粗体包着斜体，斜体包着删除线。 */
const INLINE_LAYERS = ['href', 'bold', 'italic', 'strike'] as const;
const EMPHASIS_MARKERS = { bold: '**', italic: '*', strike: '~~' } as const;

/**
 * 文本运行 → 行内 Markdown。
 *
 * 原先逐个运行各包一层标记：同一个粗体短语被 PowerPoint 切成几个运行（实测「50」「% 」「的」
 * 「 」四个），输出 `**50****% ****的**** **`，四个星号挨在一起，渲染出来满屏星号。现在
 * 同样式的相邻运行先并起来，按格式层嵌套；每段强调两头的空白挪到标记外，只有空白的不加
 * 标记；标记按行闭合，不跨换行。
 */
function renderRuns(runs: DeckIrRun[]): string {
  const pieces: InlinePiece[] = [];
  for (const run of runs) {
    const piece: InlinePiece = { text: run.text, bold: Boolean(run.bold), italic: Boolean(run.italic), strike: Boolean(run.strike),
      code: Boolean(run.code), href: run.href || undefined };
    const last = pieces.at(-1);
    if (last && sameInlineStyle(last, piece)) last.text += piece.text;
    else pieces.push(piece);
  }
  const lines: InlinePiece[][] = [[]];
  for (const piece of pieces) {
    piece.text.split('\n').forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines.at(-1)!.push({ ...piece, text: part });
    });
  }
  return lines.map((line) => renderInline(line, 0, '', '')).join('\n');
}

function sameInlineStyle(left: InlinePiece, right: InlinePiece): boolean {
  return left.bold === right.bold && left.italic === right.italic && left.strike === right.strike && left.code === right.code && left.href === right.href;
}

function renderInline(pieces: readonly InlinePiece[], depth: number, before: string, after: string): string {
  const layer = INLINE_LAYERS[depth];
  if (!layer) return pieces.map((piece) => piece.code ? inlineCode(piece.text) : escapeMarkdown(piece.text)).join('');
  const groups: InlinePiece[][] = [];
  for (const piece of pieces) {
    const group = groups.at(-1);
    if (group && group[0]![layer] === piece[layer]) group.push(piece);
    else groups.push([piece]);
  }
  let out = '';
  groups.forEach((group, index) => {
    const previous = out ? [...out.slice(-2)].at(-1)! : before;
    const next = index + 1 < groups.length ? firstCharacter(groups[index + 1]!) : after;
    const value = group[0]![layer];
    if (!value) { out += renderInline(group, depth + 1, previous, next); return; }
    if (layer === 'href') { out += `[${renderInline(group, depth + 1, '[', ']')}](${escapeLink(String(value))})`; return; }
    const marker = EMPHASIS_MARKERS[layer];
    const { lead, core, trail } = peelForEmphasis(group, previous, next);
    if (!core.length) { out += renderInline(group, depth + 1, previous, next); return; }
    out += renderInline(lead, depth + 1, previous, marker[0]!)
      + marker + renderInline(core, depth + 1, marker[0]!, marker[0]!) + marker
      + renderInline(trail, depth + 1, marker[0]!, next);
  });
  return out;
}

/**
 * 把强调两头放不进标记的字符挪到外面。CommonMark 要求开标记后、闭标记前不是空白；紧挨着
 * 文字的标记内侧若是标点也不成立——中文讲义里「**粗体：**正文」就这样整段露出星号。空白
 * 一律挪出；标点只在外侧紧挨文字时挪出，那个标点因此不再加粗，字一个不少。代码片段不拆。
 */
function peelForEmphasis(pieces: readonly InlinePiece[], before: string, after: string): { lead: InlinePiece[]; core: InlinePiece[]; trail: InlinePiece[] } {
  const characters = pieces.flatMap((piece) => [...piece.text].map((character) => ({ character, piece })));
  let start = 0;
  let previous = before;
  while (start < characters.length && movable(characters[start]!, previous)) previous = characters[start++]!.character;
  let end = characters.length;
  let next = after;
  while (end > start && movable(characters[end - 1]!, next)) next = characters[--end]!.character;
  const regroup = (slice: typeof characters): InlinePiece[] => {
    const grouped: InlinePiece[] = [];
    let owner: InlinePiece | undefined;
    for (const { character, piece } of slice) {
      if (piece === owner) grouped.at(-1)!.text += character;
      else { grouped.push({ ...piece, text: character }); owner = piece; }
    }
    return grouped;
  };
  return { lead: regroup(characters.slice(0, start)), core: regroup(characters.slice(start, end)), trail: regroup(characters.slice(end)) };
}

function movable(item: { character: string; piece: InlinePiece }, outside: string): boolean {
  if (item.piece.code) return false;
  return isWhitespace(item.character) || (isPunctuation(item.character) && isWordCharacter(outside));
}

function firstCharacter(pieces: readonly InlinePiece[]): string { return [...(pieces[0]?.text ?? '')][0] ?? ''; }
function isWhitespace(character: string): boolean { return /\s/u.test(character); }
function isPunctuation(character: string): boolean { return /[\p{P}\p{S}]/u.test(character); }
/** 行首行尾（空字符串）按空白算，与 CommonMark 一致。 */
function isWordCharacter(character: string): boolean { return character !== '' && !isWhitespace(character) && !isPunctuation(character); }

function listMarker(node: DeckIrNode): string {
  const numbering = node.extensions?.numbering as { format?: string } | undefined;
  return numbering?.format && numbering.format !== 'bullet' ? '1.' : '-';
}

function escapeMarkdown(value: string): string {
  return value.replace(/&(?=(?:#\d+|#x[\da-f]+|[a-z][\da-z]*);)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_[\]{}])/g, '\\$1');
}

function escapeTable(value: string): string { return escapeMarkdown(value).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>'); }
function escapeLink(value: string): string { return value.replace(/[()\s]/g, (character) => encodeURIComponent(character)); }
function escapeComment(value: string): string { return value.replace(/--/g, '—'); }
function indentLines(value: string, spaces: number): string { return value.replace(/\n/g, `\n${' '.repeat(spaces)}`); }
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min)); }
function normalize(value: string): string { return `${value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '')}\n`; }

function inlineCode(text: string): string {
  const delimiter = '`'.repeat((text.match(/`+/g) ?? []).reduce((max, s) => Math.max(max, s.length), 0) + 1);
  const padding = /^`|`$/.test(text) || /^ .* $/s.test(text) && /[^ ]/.test(text) ? ' ' : '';
  return `${delimiter}${padding}${text}${padding}${delimiter}`;
}
function fencedCode(text: string, language: string): string {
  const delimiter = '`'.repeat((text.match(/`+/g) ?? []).reduce((max, s) => Math.max(max, s.length), 2) + 1);
  return `${delimiter}${language.replace(/[`\r\n]/g, '')}\n${text}\n${delimiter}`;
}

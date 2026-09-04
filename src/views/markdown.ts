import type { DeckIR, DeckIrNode, DeckIrRun } from '../ir/schema.js';

export const MARKDOWN_RENDERER_VERSION = '1.0.0';

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
  return { markdown, ...(pages ? { pages } : {}), warnings: [] };
}

function renderNode(node: DeckIrNode, byId: Map<string, DeckIrNode>, options: { anchors?: boolean | undefined; assetPrefix?: string | undefined }): string {
  const anchor = options.anchors ? `<!-- deckir:${escapeComment(node.id)} -->\n` : '';
  const children = node.children.map((id) => byId.get(id)).filter((item): item is DeckIrNode => Boolean(item)).sort((a, b) => a.order - b.order);
  const text = node.runs?.length ? renderRuns(node.runs) : escapeMarkdown(node.text ?? '');
  let own = '';
  if (node.type === 'heading') own = `${'#'.repeat(clamp(Number(node.extensions?.level ?? 2), 1, 6))} ${text}`;
  else if (node.type === 'list_item') own = `${listMarker(node)} ${indentLines(text, 2)}`;
  else if (node.type === 'blockquote') own = text.split('\n').map((line) => `> ${line}`).join('\n');
  else if (node.type === 'code' || node.type === 'code_block') own = `\`\`\`${String(node.extensions?.language ?? '')}\n${node.text ?? ''}\n\`\`\``;
  else if (node.type === 'image' || node.type === 'figure') own = renderImage(node, options.assetPrefix ?? '');
  else if (node.type === 'formula') own = node.extensions?.formula && typeof node.extensions.formula === 'object' && 'latex' in node.extensions.formula
    ? `$$\n${String((node.extensions.formula as { latex?: unknown }).latex ?? node.text ?? '')}\n$$` : text;
  else if (node.type === 'table') own = renderTable(node, byId);
  else if (!['table_row', 'table_cell', 'group', 'section', 'article', 'main', 'header', 'footer', 'nav', 'aside', 'list'].includes(node.type)) own = text;
  const childBody = node.type === 'table' ? '' : children.map((child) => renderNode(child, byId, options)).filter(Boolean).join('\n\n');
  return `${anchor}${[own, childBody].filter(Boolean).join('\n\n')}`.trim();
}

function renderTable(table: DeckIrNode, byId: Map<string, DeckIrNode>): string {
  const rows = table.children.map((id) => byId.get(id)).filter((node): node is DeckIrNode => node?.type === 'table_row');
  const matrix = rows.map((row) => row.children.map((id) => byId.get(id)).filter((cell): cell is DeckIrNode => Boolean(cell)).map((cell) => escapeTable(cell.text ?? childText(cell, byId))));
  if (!matrix.length) return '';
  const columns = Math.max(...matrix.map((row) => row.length));
  const padded = matrix.map((row) => [...row, ...Array(Math.max(0, columns - row.length)).fill('')]);
  const header = padded[0] ?? [];
  const separator = Array(columns).fill('---');
  return [header, separator, ...padded.slice(1)].map((row) => `| ${row.join(' | ')} |`).join('\n');
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

function renderRuns(runs: DeckIrRun[]): string {
  return runs.map((run) => {
    let value = escapeMarkdown(run.text);
    if (run.code) value = `\`${value.replace(/`/g, '\\`')}\``;
    if (run.bold) value = `**${value}**`;
    if (run.italic) value = `*${value}*`;
    if (run.strike) value = `~~${value}~~`;
    if (run.href) value = `[${value}](${escapeLink(run.href)})`;
    return value;
  }).join('');
}

function listMarker(node: DeckIrNode): string {
  const numbering = node.extensions?.numbering as { format?: string } | undefined;
  return numbering?.format && numbering.format !== 'bullet' ? '1.' : '-';
}

function escapeMarkdown(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_[\]{}])/g, '\\$1');
}

function escapeTable(value: string): string { return escapeMarkdown(value).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>'); }
function escapeLink(value: string): string { return value.replace(/[()\s]/g, (character) => encodeURIComponent(character)); }
function escapeComment(value: string): string { return value.replace(/--/g, '—'); }
function indentLines(value: string, spaces: number): string { return value.replace(/\n/g, `\n${' '.repeat(spaces)}`); }
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min)); }
function normalize(value: string): string { return `${value.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()}\n`; }

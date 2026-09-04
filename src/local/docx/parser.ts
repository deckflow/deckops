import type { DeckIrNode, DeckIrRun, ParseCandidate, QualityCheck, CandidateAsset } from '../../ir/schema.js';
import { stableId } from '../../ir/ids.js';
import { makeIr, mediaTypeForPath, qualityOf, type SourceIdentity } from '../common.js';
import type { LocalLimits } from '../limits.js';
import { OpcPackage, type Relationship } from '../opc/package.js';
import { children, descendants, first, textContent, type XmlNode } from '../xml.js';

export interface DocxOptions {
  trackedChanges?: 'final' | 'original' | 'all';
}

interface Context {
  pkg: OpcPackage;
  source: SourceIdentity;
  rels: Map<string, Relationship>;
  styles: Map<string, { name: string; basedOn?: string }>;
  numbering: Map<string, Map<number, { format: string; text: string }>>;
  strategy: NonNullable<DocxOptions['trackedChanges']>;
  nodes: DeckIrNode[];
  assets: CandidateAsset[];
  checks: QualityCheck[];
  order: number;
}

export function parseDocx(data: Uint8Array, source: SourceIdentity, limits: LocalLimits, options: DocxOptions = {}): ParseCandidate {
  const pkg = new OpcPackage(data, limits);
  if (!pkg.has('[Content_Types].xml') || !pkg.has('word/document.xml')) {
    throw new Error('DOCX package is missing required OOXML parts.');
  }
  const ctx: Context = {
    pkg, source, rels: pkg.relationships('word/document.xml'), styles: readStyles(pkg), numbering: readNumbering(pkg),
    strategy: options.trackedChanges ?? 'final', nodes: [], assets: [], checks: [], order: 0,
  };
  const document = pkg.xml('word/document.xml');
  const body = descendants(document, 'body')[0];
  if (!body) throw new Error('word/document.xml has no document body.');
  parseBlocks(body, ctx, null, 'word/document.xml');

  for (const [part, type] of [
    ['word/footnotes.xml', 'footnote'], ['word/endnotes.xml', 'endnote'], ['word/comments.xml', 'comment'],
  ] as const) {
    if (!pkg.has(part)) continue;
    const partRoot = pkg.xml(part);
    const partCtx = { ...ctx, rels: pkg.relationships(part) };
    parseBlocks(partRoot, partCtx, null, part, type);
    ctx.order = partCtx.order;
  }
  for (const rel of ctx.rels.values()) {
    if (rel.external) continue;
    const basename = rel.target.split('/').pop() ?? '';
    if (!/^header\d+\.xml$/.test(basename) && !/^footer\d+\.xml$/.test(basename)) continue;
    if (!pkg.has(rel.target)) continue;
    const partCtx = { ...ctx, rels: pkg.relationships(rel.target) };
    parseBlocks(pkg.xml(rel.target), partCtx, null, rel.target, basename.startsWith('header') ? 'header' : 'footer');
    ctx.order = partCtx.order;
  }

  for (const alt of descendants(body, 'altChunk')) {
    ctx.checks.push({ code: 'alt_chunk_unsupported', severity: 'error', message: 'DOCX contains altChunk content that cannot be expanded locally.' });
    addOpaque(ctx, null, 'altChunk', 'word/document.xml', alt.attributes.id ?? alt.attributes['r:id']);
  }
  const opaque = ctx.nodes.filter((node) => node.opaque).length;
  const quality = qualityOf(ctx.checks, {
    objects: { parsed: ctx.nodes.length - opaque, opaque, total: ctx.nodes.length },
    textCharacters: ctx.nodes.reduce((sum, node) => sum + (node.text?.length ?? 0), 0),
  });
  const metadata = readCoreProperties(pkg);
  const ir = makeIr({ format: 'docx', source, producer: { name: 'deckparse-docx', version: '1' }, metadata,
    nodes: ctx.nodes, assets: ctx.assets, quality });
  return { ir, quality, assets: ctx.assets, warnings: quality.checks.map((check) => check.message) };
}

function parseBlocks(root: XmlNode, ctx: Context, parentId: string | null, part: string, forcedType?: string): void {
  for (const child of root.children) {
    if (child.local === 'p') parseParagraph(child, ctx, parentId, part, forcedType);
    else if (child.local === 'tbl') parseTable(child, ctx, parentId, part);
    else if (['body', 'hdr', 'ftr', 'footnotes', 'endnotes', 'comments', 'footnote', 'endnote', 'comment', 'sdt', 'sdtContent'].includes(child.local)) {
      parseBlocks(child, ctx, parentId, part, forcedType);
    }
  }
}

function parseParagraph(node: XmlNode, ctx: Context, parentId: string | null, part: string, forcedType?: string): string | undefined {
  const locator = `${part}:p:${ctx.order}`;
  const pPr = first(node, 'pPr');
  const styleId = first(pPr ?? emptyNode(), 'pStyle')?.attributes.val;
  const numPr = first(pPr ?? emptyNode(), 'numPr');
  const numId = first(numPr ?? emptyNode(), 'numId')?.attributes.val;
  const level = Number(first(numPr ?? emptyNode(), 'ilvl')?.attributes.val ?? 0);
  const runs = collectRuns(node, ctx, part);
  const text = runs.map((run) => run.text).join('');
  const images = imageRefs(node, ctx.rels);
  if (!text && images.length === 0 && descendants(node, 'oMath').length === 0) return undefined;
  const resolvedStyle = resolveStyle(styleId, ctx.styles);
  const type = forcedType ?? (numId ? 'list_item' : headingType(resolvedStyle?.name));
  const id = stableId(ctx.source.sha256, locator);
  const deckNode: DeckIrNode = {
    id, type, parentId, children: [], order: ctx.order++, text, runs, sourceRef: { part, path: locator },
    ...(resolvedStyle ? { style: { styleId, name: resolvedStyle.name } } : {}),
  };
  if (numId) {
    const definition = ctx.numbering.get(numId)?.get(level);
    deckNode.extensions = { numbering: { numId, level, format: definition?.format, text: definition?.text } };
  }
  if (descendants(node, 'br').some((item) => item.attributes.type === 'page')) {
    deckNode.extensions = { ...(deckNode.extensions ?? {}), pageBreakAfter: true };
  }
  ctx.nodes.push(deckNode);
  attach(ctx, parentId, id);
  for (const image of images) addImageNode(image, ctx, id, part);
  for (const math of descendants(node, 'oMath')) {
    const mathText = textContent(math).trim();
    const mathId = stableId(ctx.source.sha256, `${locator}:math:${deckNode.children.length}`);
    ctx.nodes.push({ id: mathId, type: 'formula', parentId: id, children: [], order: ctx.order++, text: mathText,
      sourceRef: { part, path: `${locator}/oMath` }, extensions: { ommlText: mathText, omml: xmlSnapshot(math) },
      opaque: { type: 'omml', reason: 'OMML is preserved but not converted to a layout-equivalent formula.' } });
    deckNode.children.push(mathId);
    ctx.checks.push({ code: 'formula_partial', severity: 'warning', message: 'An OMML formula was preserved as text and opaque source structure.', nodeIds: [mathId] });
  }
  return id;
}

function parseTable(table: XmlNode, ctx: Context, parentId: string | null, part: string): void {
  const tableId = stableId(ctx.source.sha256, `${part}:table:${ctx.order}`);
  const tableNode: DeckIrNode = { id: tableId, type: 'table', parentId, children: [], order: ctx.order++, sourceRef: { part, path: `table/${tableId}` }, extensions: { rows: children(table, 'tr').length } };
  ctx.nodes.push(tableNode);
  attach(ctx, parentId, tableId);
  for (const [rowIndex, row] of children(table, 'tr').entries()) {
    const rowId = stableId(ctx.source.sha256, `${tableId}:row:${rowIndex}`);
    const rowNode: DeckIrNode = { id: rowId, type: 'table_row', parentId: tableId, children: [], order: ctx.order++, sourceRef: { part, path: `table/${tableId}/row/${rowIndex}` } };
    ctx.nodes.push(rowNode); tableNode.children.push(rowId);
    for (const [cellIndex, cell] of children(row, 'tc').entries()) {
      const cellId = stableId(ctx.source.sha256, `${rowId}:cell:${cellIndex}`);
      const tcPr = first(cell, 'tcPr');
      const cellNode: DeckIrNode = { id: cellId, type: 'table_cell', parentId: rowId, children: [], order: ctx.order++, text: paragraphsText(cell),
        sourceRef: { part, path: `table/${tableId}/row/${rowIndex}/cell/${cellIndex}` },
        extensions: { row: rowIndex, column: cellIndex, gridSpan: Number(first(tcPr ?? emptyNode(), 'gridSpan')?.attributes.val ?? 1),
          verticalMerge: first(tcPr ?? emptyNode(), 'vMerge')?.attributes.val ?? (first(tcPr ?? emptyNode(), 'vMerge') ? 'continue' : undefined) } };
      ctx.nodes.push(cellNode); rowNode.children.push(cellId);
      parseBlocks(cell, ctx, cellId, part);
    }
  }
}

function collectRuns(node: XmlNode, ctx: Context, part: string, inheritedHref?: string): DeckIrRun[] {
  const runs: DeckIrRun[] = [];
  const walk = (current: XmlNode, href?: string, deleted = false, inserted = false): void => {
    const nextDeleted = deleted || current.local === 'del';
    const nextInserted = inserted || current.local === 'ins';
    if (nextDeleted && ctx.strategy === 'final' || nextInserted && ctx.strategy === 'original') return;
    let nextHref = href;
    if (current.local === 'hyperlink') {
      const relId = current.attributes.id ?? current.attributes['r:id'];
      nextHref = relId ? ctx.rels.get(relId)?.target : current.attributes.anchor ? `#${current.attributes.anchor}` : undefined;
    }
    if (current.local === 'r') {
      const value = current.children.map((child) => child.local === 't' || child.local === 'delText' ? textContent(child) : child.local === 'tab' ? '\t' : child.local === 'br' ? '\n' : '').join('');
      if (value) {
        const rPr = first(current, 'rPr');
        runs.push({ text: value,
          ...(first(rPr ?? emptyNode(), 'b') ? { bold: true } : {}), ...(first(rPr ?? emptyNode(), 'i') ? { italic: true } : {}),
          ...(first(rPr ?? emptyNode(), 'u') ? { underline: true } : {}), ...(first(rPr ?? emptyNode(), 'strike') ? { strike: true } : {}),
          ...(nextHref ? { href: nextHref } : {}),
          ...(ctx.strategy === 'all' && (nextDeleted || nextInserted) ? { style: { revision: nextDeleted ? 'deleted' : 'inserted' } } : {}),
        });
      }
      return;
    }
    for (const child of current.children) walk(child, nextHref, nextDeleted, nextInserted);
  };
  walk(node, inheritedHref);
  return runs;
}

function imageRefs(node: XmlNode, rels: Map<string, Relationship>): Relationship[] {
  const result: Relationship[] = [];
  for (const blip of descendants(node, 'blip')) {
    const id = blip.attributes.embed ?? blip.attributes['r:embed'] ?? blip.attributes.link ?? blip.attributes['r:link'];
    const rel = id ? rels.get(id) : undefined;
    if (rel && !result.some((item) => item.id === rel.id)) result.push(rel);
  }
  return result;
}

function addImageNode(rel: Relationship, ctx: Context, parentId: string, part: string): void {
  const id = stableId(ctx.source.sha256, `${part}:image:${rel.id}`);
  if (rel.external) {
    ctx.nodes.push({ id, type: 'image', parentId, children: [], order: ctx.order++, sourceRef: { part, relationship: rel.id }, extensions: { externalUrl: rel.target }, issues: ['external_asset'] });
    ctx.nodes.find((node) => node.id === parentId)?.children.push(id);
    return;
  }
  if (!ctx.pkg.has(rel.target)) {
    ctx.checks.push({ code: 'missing_media', severity: 'error', message: `DOCX image relationship ${rel.id} points to a missing part.` });
    return;
  }
  const data = ctx.pkg.read(rel.target);
  ctx.assets.push({ path: rel.target, data, ...(mediaTypeForPath(rel.target) ? { mediaType: mediaTypeForPath(rel.target) } : {}), sourceRef: { part, relationship: rel.id } });
  ctx.nodes.push({ id, type: 'image', parentId, children: [], order: ctx.order++, sourceRef: { part, relationship: rel.id }, extensions: { assetPath: rel.target } });
  ctx.nodes.find((node) => node.id === parentId)?.children.push(id);
}

function addOpaque(ctx: Context, parentId: string | null, type: string, part: string, relationship?: string): void {
  const id = stableId(ctx.source.sha256, `${part}:opaque:${type}:${ctx.order}`);
  ctx.nodes.push({ id, type: 'opaque', parentId, children: [], order: ctx.order++, sourceRef: { part, ...(relationship ? { relationship } : {}) }, opaque: { type } });
  attach(ctx, parentId, id);
}

function attach(ctx: Context, parentId: string | null, childId: string): void {
  if (parentId) ctx.nodes.find((node) => node.id === parentId)?.children.push(childId);
}

function readStyles(pkg: OpcPackage): Context['styles'] {
  const result = new Map<string, { name: string; basedOn?: string }>();
  if (!pkg.has('word/styles.xml')) return result;
  for (const style of descendants(pkg.xml('word/styles.xml'), 'style')) {
    const id = style.attributes.styleId;
    const name = first(style, 'name')?.attributes.val;
    if (id && name) result.set(id, { name, ...(first(style, 'basedOn')?.attributes.val ? { basedOn: first(style, 'basedOn')!.attributes.val } : {}) });
  }
  return result;
}

function resolveStyle(id: string | undefined, styles: Context['styles']): { name: string; basedOn?: string } | undefined {
  let current = id;
  let resolved: { name: string; basedOn?: string } | undefined;
  const seen = new Set<string>();
  while (current && !seen.has(current)) { seen.add(current); resolved ??= styles.get(current); current = styles.get(current)?.basedOn; }
  return resolved;
}

function readNumbering(pkg: OpcPackage): Context['numbering'] {
  const result: Context['numbering'] = new Map();
  if (!pkg.has('word/numbering.xml')) return result;
  const root = pkg.xml('word/numbering.xml');
  const abstracts = new Map<string, Map<number, { format: string; text: string }>>();
  for (const abstract of descendants(root, 'abstractNum')) {
    const id = abstract.attributes.abstractNumId;
    const levels = new Map<number, { format: string; text: string }>();
    for (const level of children(abstract, 'lvl')) levels.set(Number(level.attributes.ilvl ?? 0), { format: first(level, 'numFmt')?.attributes.val ?? 'bullet', text: first(level, 'lvlText')?.attributes.val ?? '•' });
    if (id) abstracts.set(id, levels);
  }
  for (const num of descendants(root, 'num')) {
    const id = num.attributes.numId; const abstractId = first(num, 'abstractNumId')?.attributes.val;
    if (id && abstractId && abstracts.has(abstractId)) result.set(id, abstracts.get(abstractId)!);
  }
  return result;
}

function readCoreProperties(pkg: OpcPackage): Record<string, unknown> {
  if (!pkg.has('docProps/core.xml')) return {};
  const root = pkg.xml('docProps/core.xml');
  const metadata: Record<string, unknown> = {};
  for (const key of ['title', 'subject', 'creator', 'description', 'keywords', 'created', 'modified', 'lastModifiedBy']) {
    const value = descendants(root, key)[0]; if (value) metadata[key] = textContent(value);
  }
  return metadata;
}

function headingType(name?: string): string {
  return name && /^heading\s*[1-9]/i.test(name) ? 'heading' : 'paragraph';
}

function paragraphsText(node: XmlNode): string {
  return descendants(node, 'p').map((p) => descendants(p, 't').map(textContent).join('')).join('\n');
}

function xmlSnapshot(node: XmlNode): Record<string, unknown> {
  return { name: node.local, ...(Object.keys(node.attributes).length ? { attributes: node.attributes } : {}),
    ...(node.text ? { text: node.text } : {}), ...(node.children.length ? { children: node.children.map(xmlSnapshot) } : {}) };
}

function emptyNode(): XmlNode { return { local: '', uri: '', attributes: {}, children: [], text: '' }; }

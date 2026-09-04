import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { stableId } from '../../ir/ids.js';
import type { DeckIrNode, ParseCandidate, QualityCheck } from '../../ir/schema.js';
import { makeIr, qualityOf, type SourceIdentity } from '../common.js';
import type { LocalLimits } from '../limits.js';

type HtmlNode = DefaultTreeAdapterMap['node'];
type HtmlElement = DefaultTreeAdapterMap['element'];

const CONTENT_TAGS = new Set(['article', 'section', 'main', 'nav', 'aside', 'header', 'footer', 'div', 'address', 'dl', 'dt', 'dd', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'figure', 'figcaption', 'img', 'a']);
const SKIP_TAGS = new Set(['script', 'style', 'template', 'noscript', 'svg', 'canvas']);
const TEXT_CONTAINER_TAGS = new Set(['address', 'dt', 'dd', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote', 'pre', 'code', 'li', 'th', 'td', 'figcaption', 'a']);
const BLOCK_CHILD_TAGS = new Set(['article', 'section', 'main', 'nav', 'aside', 'header', 'footer', 'div', 'address', 'dl', 'dt', 'dd', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote', 'pre', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'figure', 'figcaption']);

export function parseHtmlSource(html: string, source: SourceIdentity, baseUrl?: string): ParseCandidate {
  const document = parse(html);
  const body = findElement(document, 'body') ?? document;
  const main = findElement(body, 'main') ?? findElement(body, 'article');
  const checks: QualityCheck[] = [];
  if (!main) checks.push({ code: 'main_content_ambiguous', severity: 'warning', message: 'No main/article landmark was found; the semantic body was retained.' });
  if (findElement(document, 'script')) checks.push({ code: 'scripts_ignored', severity: 'info', message: 'HTML scripts were retained only as a safety signal and were not executed.' });
  const nodes: DeckIrNode[] = [];
  let order = 0;
  const walk = (raw: HtmlNode, parentId: string | null, path: string): void => {
    if (!isElement(raw)) return;
    const tag = raw.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    const childPath = `${path}/${tag}[${order}]`;
    let nextParent = parentId;
    let capturesText = false;
    if (CONTENT_TAGS.has(tag)) {
      const id = stableId(source.sha256, `html:${childPath}`);
      const href = attr(raw, 'href');
      const src = attr(raw, 'src');
      const text = directSemanticText(raw).trim();
      capturesText = Boolean(text) && !hasBlockContentChild(raw);
      const nestedLinks = descendantsOf(raw, 'a').map((link) => ({ href: resolveUrl(attr(link, 'href') ?? '', baseUrl), text: textOf(link).trim() })).filter((link) => link.href);
      const type = htmlType(tag);
      const node: DeckIrNode = { id, type, parentId, children: [], order: order++, ...(text ? { text } : {}),
        sourceRef: { path: childPath },
        ...(href ? { links: [{ href: resolveUrl(href, baseUrl), ...(text ? { text } : {}) }] } : nestedLinks.length ? { links: nestedLinks } : {}),
        extensions: { tag, ...(attr(raw, 'id') ? { htmlId: attr(raw, 'id') } : {}),
          ...(src ? { sourceUrl: resolveUrl(src, baseUrl), externalUrl: resolveUrl(src, baseUrl), alt: attr(raw, 'alt'), width: numberAttr(raw, 'width'), height: numberAttr(raw, 'height') } : {}) } };
      if (href || nestedLinks.length) node.runs = inlineRuns(raw, baseUrl);
      if (/^h[1-6]$/.test(tag)) node.extensions = { ...node.extensions, level: Number(tag[1]) };
      nodes.push(node);
      if (parentId) nodes.find((item) => item.id === parentId)?.children.push(id);
      nextParent = id;
    }
    if (TEXT_CONTAINER_TAGS.has(tag) || capturesText) {
      for (const image of descendantsOf(raw, 'img')) walk(image, nextParent, childPath);
      return;
    }
    for (const child of childNodes(raw)) walk(child, nextParent, childPath);
  };
  for (const child of childNodes((main ?? body) as HtmlNode)) walk(child, null, main ? '/main' : '/body');

  const textCharacters = nodes.reduce((sum, node) => sum + (node.text?.length ?? 0), 0);
  const remoteImages = nodes.filter((node) => node.type === 'image' && typeof node.extensions?.sourceUrl === 'string');
  if (remoteImages.length) checks.push({ code: 'remote_assets_not_localized', severity: 'warning', message: `${remoteImages.length} HTML image(s) remain remote references and were not downloaded.`, nodeIds: remoteImages.map((node) => node.id) });
  const hydration = /(?:__NEXT_DATA__|__NUXT__|data-reactroot|ng-version|id=["'](?:root|app)["'])/i.test(html);
  if (textCharacters < 120 && hydration) checks.push({ code: 'runtime_required', severity: 'error', message: 'The initial HTML contains little readable content and appears to require JavaScript hydration.' });
  const quality = qualityOf(checks, { objects: { parsed: nodes.length, opaque: 0 }, textCharacters });
  const title = findElement(document, 'title');
  const ir = makeIr({ format: 'html', source, producer: { name: 'deckparse-html-source', version: '1' },
    metadata: { title: title ? textOf(title).trim() : undefined, baseUrl }, nodes, quality });
  return { ir, quality, assets: [], warnings: quality.checks.map((check) => check.message) };
}

export async function fetchHtml(url: string, limits: LocalLimits, signal?: AbortSignal): Promise<{ html: string; url: string; bytes: Uint8Array }> {
  let current = new URL(url);
  if (!['http:', 'https:'].includes(current.protocol)) throw new TypeError('Only http(s) URLs are supported.');
  for (let redirect = 0; redirect <= limits.redirects; redirect += 1) {
    const timeout = AbortSignal.timeout(limits.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(current, { redirect: 'manual', signal: combined, headers: { accept: 'text/html,application/xhtml+xml' } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location || redirect === limits.redirects) throw new Error('HTML redirect limit exceeded.');
      current = new URL(location, current);
      if (!['http:', 'https:'].includes(current.protocol)) throw new Error('HTML redirected to a non-http(s) URL.');
      continue;
    }
    if (!response.ok) throw new Error(`HTML request failed with HTTP ${response.status}.`);
    const type = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (type && !type.includes('text/html') && !type.includes('application/xhtml+xml')) throw new Error(`URL returned unsupported content type ${type}.`);
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > limits.urlBytes) throw new Error('HTML response exceeds the local size limit.');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('HTML response has no body.');
    const chunks: Uint8Array[] = []; let total = 0;
    while (true) {
      const next = await reader.read(); if (next.done) break;
      total += next.value.byteLength; if (total > limits.urlBytes) { await reader.cancel(); throw new Error('HTML response exceeds the local size limit.'); }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { html: new TextDecoder().decode(bytes), url: current.href, bytes };
  }
  throw new Error('HTML redirect limit exceeded.');
}

function htmlType(tag: string): string {
  if (/^h[1-6]$/.test(tag)) return 'heading';
  return ({ p: 'paragraph', a: 'link', img: 'image', ul: 'list', ol: 'list', li: 'list_item',
    table: 'table', tr: 'table_row', th: 'table_cell', td: 'table_cell', pre: 'code_block', code: 'code',
    blockquote: 'blockquote', figcaption: 'caption' } as Record<string, string>)[tag] ?? tag;
}

function directSemanticText(node: HtmlElement): string {
  if (TEXT_CONTAINER_TAGS.has(node.tagName)) return textOf(node);
  return hasBlockContentChild(node) ? '' : textOf(node);
}

function hasBlockContentChild(node: HtmlElement): boolean {
  return childNodes(node).some((child) => isElement(child) && BLOCK_CHILD_TAGS.has(child.tagName));
}

function textOf(node: HtmlNode): string {
  if ('nodeName' in node && node.nodeName === '#text') return (node as DefaultTreeAdapterMap['textNode']).value;
  if (isElement(node) && SKIP_TAGS.has(node.tagName)) return '';
  return childNodes(node).map(textOf).join('');
}

function inlineRuns(root: HtmlNode, base?: string): import('../../ir/schema.js').DeckIrRun[] {
  const runs: import('../../ir/schema.js').DeckIrRun[] = [];
  const visit = (node: HtmlNode, href?: string): void => {
    if ('nodeName' in node && node.nodeName === '#text') {
      const text = (node as DefaultTreeAdapterMap['textNode']).value;
      if (text) runs.push({ text, ...(href ? { href } : {}) });
      return;
    }
    if (!isElement(node) || SKIP_TAGS.has(node.tagName)) return;
    const ownHref = node.tagName === 'a' ? resolveUrl(attr(node, 'href') ?? '', base) || href : href;
    for (const child of childNodes(node)) visit(child, ownHref);
  };
  visit(root);
  if (runs.length) { runs[0]!.text = runs[0]!.text.replace(/^\s+/, ''); runs.at(-1)!.text = runs.at(-1)!.text.replace(/\s+$/, ''); }
  return runs.filter((run) => run.text);
}

function findElement(root: HtmlNode, tag: string): HtmlElement | undefined {
  if (isElement(root) && root.tagName === tag) return root;
  for (const child of childNodes(root)) { const found = findElement(child, tag); if (found) return found; }
  return undefined;
}

function descendantsOf(root: HtmlNode, tag: string): HtmlElement[] {
  const result: HtmlElement[] = [];
  for (const child of childNodes(root)) {
    if (isElement(child) && child.tagName === tag) result.push(child);
    result.push(...descendantsOf(child, tag));
  }
  return result;
}

function isElement(node: HtmlNode): node is HtmlElement {
  return typeof (node as Partial<HtmlElement>).tagName === 'string';
}

function childNodes(node: HtmlNode): HtmlNode[] {
  return 'childNodes' in node ? [...(node.childNodes as HtmlNode[])] : [];
}

function attr(node: HtmlElement, name: string): string | undefined { return node.attrs.find((item) => item.name === name)?.value; }
function numberAttr(node: HtmlElement, name: string): number | undefined { const value = Number(attr(node, name)); return Number.isFinite(value) && value > 0 ? value : undefined; }
function resolveUrl(value: string, base?: string): string { try { return base ? new URL(value, base).href : value; } catch { return value; } }

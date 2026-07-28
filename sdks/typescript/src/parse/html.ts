/**
 * 把 `html.getByURL` 抓到的 html 提取正文并转为 markdown，首行为 `# 标题`。
 *
 * DOM 来源：浏览器用原生 `DOMParser`（零额外体积）；Node 没有全局 `DOMParser`，
 * 惰性加载 `linkedom`（2.5MB、零传递依赖）。**不能用 turndown 自带的 domino** ——
 * 它的 `querySelectorAll()` 返回不可迭代的 NodeList，`Readability.parse()` 会抛
 * `TypeError: nodeList is not iterable`。
 */

import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
// turndown-plugin-gfm 无官方类型定义
// @ts-expect-error -- 无 .d.ts，运行时导出 gfm 插件
import { gfm as gfmPlugin } from 'turndown-plugin-gfm';

const gfm = gfmPlugin as TurndownService.Plugin;

export interface Html2MarkdownOptions {
  /** 页面来源地址，用于把相对图片地址补全为绝对地址 */
  url?: string;
  /** 自定义 DOM 解析器，用于测试或非标准运行时 */
  domParser?: { parseFromString: (this: void, html: string, type: string) => Document };
}

const getDocument = async (html: string, options: Html2MarkdownOptions): Promise<Document> => {
  if (options.domParser) return options.domParser.parseFromString(html, 'text/html');
  if (typeof DOMParser !== 'undefined') return new DOMParser().parseFromString(html, 'text/html');

  const { parseHTML } = (await import('linkedom')) as unknown as {
    parseHTML: (this: void, html: string) => { document: Document };
  };
  return parseHTML(html).document;
};

/** 修正懒加载图片、去掉 noscript，使 Readability/Turndown 能正确提取内容 */
const preprocess = (document: Document): void => {
  // 微信等站点图片懒加载，真实地址在 data-src，不还原则图片地址为空
  document.querySelectorAll('img').forEach((img) => {
    const dataSrc = img.getAttribute('data-src');
    if (dataSrc && !img.getAttribute('src')?.startsWith('http')) {
      img.setAttribute('src', dataSrc);
    }
  });
  // noscript 中常有兜底图片，会导致内容重复
  document.querySelectorAll('noscript').forEach((el) => el.remove());
};

const absolutize = (src: string, base?: string): string => {
  if (!base) return src;
  try {
    return new URL(src, base).toString();
  } catch {
    return src;
  }
};

const buildTurndown = (base?: string): TurndownService => {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  turndown.use(gfm);
  turndown.remove(['script', 'style']);
  // alt 统一为 img，无 src 的图片丢弃
  turndown.addRule('image', {
    filter: 'img',
    replacement: (_content, node) => {
      const src = node.getAttribute('src');
      return src ? `![img](${absolutize(src, base)})` : '';
    },
  });
  turndown.addRule('dropIframe', {
    filter: ['iframe'],
    replacement: () => '',
  });
  return turndown;
};

/**
 * 提取正文并转 markdown。提取结果为空时抛错，由调用方决定是否降级。
 */
export const html2markdown = async (
  html: string,
  options: Html2MarkdownOptions = {}
): Promise<string> => {
  const document = await getDocument(html, options);
  preprocess(document);

  // Readability 会改写传入的 document，先取标题
  const documentTitle = document.title || '';
  let article: { title?: string | null; content?: string | null } | null = null;
  try {
    article = new Readability(document as never).parse();
  } catch {
    // 提取失败时降级为整个 body
    article = null;
  }

  const title = (article?.title || documentTitle || '').trim().replace(/\n+/g, ' ');
  const contentHtml = article?.content || document.body?.innerHTML || '';

  const body = buildTurndown(options.url).turndown(contentHtml).trim();
  if (!body) {
    throw new Error(
      `html2markdown: empty content extracted${options.url ? ` from ${options.url}` : ''}`
    );
  }

  return title ? `# ${title}\n\n${body}` : body;
};

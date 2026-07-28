import {
  identityImageUrl,
  type DocxElement,
  type DocxGroup,
  type DocxParseResult,
  type DocxTable,
  type DocxText,
  type DocxWsp,
  type MarkdownConvertOptions,
} from './types.js';

/**
 * 把 `docx.parseTextAndImage` 的结构化结果渲染为 markdown。
 *
 * 标题层级来自段落的 `style.outlineLvl`（`@deckflow/docx` >= 1.4.0 提供）。
 * 服务端 slave 尚未升级到该版本时段落不带 style，输出**退化为扁平段落**而非报错。
 */

/** 大纲级别 → markdown 抬头；outlineLvl 0 对应 `#`，最深截到 `######` */
const headingPrefix = (text: DocxText): string => {
  const style = text.style;
  if (!style) return '';

  const lvl = style.outlineLvl;
  if (typeof lvl === 'number' && Number.isInteger(lvl) && lvl >= 0) {
    return '#'.repeat(Math.min(lvl + 1, 6)) + ' ';
  }

  // 文档标题（Word 的 Title 样式）没有大纲级别，但语义上就是一级标题
  if (style.styleName === 'title') return '# ';

  return '';
};

const cellText = (children: DocxText[] | undefined): string =>
  (children || [])
    .map((c) => (c?.text ?? '').trim())
    .filter(Boolean)
    .join(' ')
    // markdown 表格单元格内不能有裸竖线与换行
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ')
    .trim();

/** 表格 → GFM 表格；首行作表头。行列不齐时按最宽行补空单元格 */
const tableToMarkdown = (table: DocxTable): string => {
  const rows = (table.table || [])
    .map((row) => (row.children || []).map((cell) => cellText(cell.children)))
    .filter((cells) => cells.length > 0);
  if (!rows.length) return '';

  const width = Math.max(...rows.map((r) => r.length), 0);
  const pad = (cells: string[]): string[] => {
    const out = cells.slice(0, width);
    while (out.length < width) out.push('');
    return out;
  };

  // 整表无任何文字时不输出空骨架
  if (!rows.some((r) => r.some((c) => c))) return '';

  const [head = [], ...body] = rows;
  const lines = [
    `| ${pad(head).join(' | ')} |`,
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
    ...body.map((r) => `| ${pad(r).join(' | ')} |`),
  ];
  return lines.join('\n');
};

/** 文本框 / 组：递归展开，内部文本按段落平铺 */
const groupToLines = (node: DocxGroup | DocxWsp): string[] => {
  const lines: string[] = [];
  for (const child of node.children || []) {
    if (!child) continue;
    if (child.type === 'group' || child.type === 'wsp') {
      lines.push(...groupToLines(child));
    } else {
      const text = (child.text ?? '').trim();
      if (text) lines.push(text);
    }
  }
  return lines;
};

const elementToBlock = (el: DocxElement, toImageUrl: (key: string) => string): string => {
  switch (el.type) {
    case 'text': {
      const text = (el.text ?? '').trim();
      return text ? `${headingPrefix(el)}${text}` : '';
    }

    case 'image': {
      if (!el.image) return '';
      const alt = el.name ? el.name.replace(/\.[^.]+$/, '') : 'img';
      return `![${alt}](${toImageUrl(el.image)})`;
    }

    case 'table':
      return tableToMarkdown(el);

    case 'chart': {
      // 无坐标数据，只能给出系列/分类名，标注来源以免被误读为正文
      const series = (el.series || []).filter(Boolean);
      const categories = (el.categories || []).filter(Boolean);
      if (!series.length && !categories.length) return '';
      const parts: string[] = [];
      if (categories.length) parts.push(categories.join(' | '));
      if (series.length) parts.push(series.join(' | '));
      return parts.join('\n');
    }

    case 'diagram': {
      const lines: string[] = [];
      for (const t of el.texts || []) {
        for (const ap of t.aps || []) {
          const text = (ap?.text ?? '').trim();
          if (text) lines.push(text);
        }
      }
      return lines.join('\n');
    }

    case 'group':
    case 'wsp':
      return groupToLines(el).join('\n');

    case 'sdt': {
      const lines: string[] = [];
      for (const wp of el.children || []) {
        for (const child of wp?.children || []) {
          const text = (child?.text ?? '').trim();
          if (text) lines.push(text);
        }
      }
      return lines.join('\n');
    }

    default:
      return '';
  }
};

export const docxResult2Markdown = (
  res: DocxParseResult,
  options: MarkdownConvertOptions = {}
): string => {
  const toImageUrl = options.toImageUrl ?? identityImageUrl;
  // idx 是 w:body 下的顺序值，按它排序还原阅读顺序（上游通常已有序，排序是防御性的）
  const content = [...(res?.content ?? [])].sort((a, b) => (a?.idx ?? 0) - (b?.idx ?? 0));

  const blocks: string[] = [];
  for (const el of content) {
    if (!el) continue;
    const block = elementToBlock(el, toImageUrl);
    if (block.trim()) blocks.push(block.trim());
  }

  return blocks.join('\n\n');
};

import {
  identityImageUrl,
  type KeynoteChartItem,
  type KeynoteImageItem,
  type KeynoteParseResult,
  type MarkdownConvertOptions,
} from './types.js';

/**
 * 把 `keynote.parseTextAndImage` 的解析结果转换为按 `---` 分页的 markdown。
 *
 * - 每个 slide 一页，页间用 `\n\n---\n\n` 分隔；
 * - 每页所有文本/表格/图表平铺为正文（不加 `###` 标题），标题与结构交由下游重新生成；
 * - images 按 `pageIndex` 归到对应页末尾。
 *
 * **不丢图保证**：`pageIndex` 缺失或越界的图片不会被丢弃，而是收敛到文末的兜底段落。
 * 上游 keynote 解析器把 `pageIndex` 标注为可选，历史实现用 `img.pageIndex === slideIndex`
 * 严格比对，导致这两类图片被静默丢弃（`pageIndex` 整体缺失时会丢掉全部图片）。
 */
export const PAGE_SEPARATOR = '\n\n---\n\n';

const chartToLines = (chart: KeynoteChartItem): string[] => {
  const rows = (chart.data?.rowName || []).filter((s) => s && s.trim());
  const cols = (chart.data?.columnName || []).filter((s) => s && s.trim());
  const lines: string[] = [];
  if (cols.length) lines.push(cols.join(' | '));
  if (rows.length) lines.push(rows.join(' | '));
  return lines;
};

const imageLine = (img: KeynoteImageItem, toImageUrl: (key: string) => string): string =>
  `![img](${toImageUrl(img.key)})`;

export const keynoteResult2Markdown = (
  result: KeynoteParseResult,
  options: MarkdownConvertOptions = {}
): string => {
  const toImageUrl = options.toImageUrl ?? identityImageUrl;
  const slides = result?.slides || [];
  const images = (result?.images || []).filter((img) => img && img.key);

  // 先把图片按页归位；页号缺失或越界的进兜底桶，绝不丢弃
  const byPage = new Map<number, KeynoteImageItem[]>();
  const unassigned: KeynoteImageItem[] = [];
  for (const img of images) {
    const idx = img.pageIndex;
    const inRange =
      typeof idx === 'number' && Number.isInteger(idx) && idx >= 0 && idx < slides.length;
    if (!inRange) {
      unassigned.push(img);
      continue;
    }
    const bucket = byPage.get(idx);
    if (bucket) bucket.push(img);
    else byPage.set(idx, [img]);
  }

  const pages: string[] = [];

  for (const [slideIndex, slide] of slides.entries()) {
    const lines: string[] = [];

    const texts = (slide.text || []).map((t) => (t.text || '').trim()).filter(Boolean);
    lines.push(...texts);

    for (const table of slide.table || []) {
      const row = (table.data || [])
        .map((c) => (c ?? '').trim())
        .filter(Boolean)
        .join(' | ');
      if (row) lines.push(row);
    }

    for (const chart of slide.chart || []) {
      lines.push(...chartToLines(chart));
    }

    for (const img of byPage.get(slideIndex) || []) {
      lines.push(imageLine(img, toImageUrl));
    }

    if (lines.length) pages.push(lines.join('\n'));
  }

  // 兜底：页号无法归位的图片挂在文末，宁可位置不准也不丢内容
  if (unassigned.length) {
    pages.push(unassigned.map((img) => imageLine(img, toImageUrl)).join('\n'));
  }

  return pages.join(PAGE_SEPARATOR);
};

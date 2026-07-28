import {
  identityImageUrl,
  type MarkdownConvertOptions,
  type PdfParseResult,
  type PdfTextBlock,
} from './types.js';

/** 将单个文本块按其 role/style 渲染为一行 markdown */
const renderTextBlock = (b: PdfTextBlock): string => {
  const text = (b.text ?? '').trim();
  if (!text) return '';
  switch (b.role) {
    case 'heading':
      return `## ${text}`;
    case 'list-item':
      return `- ${text}`;
    case 'caption':
      return `*${text}*`;
    default: {
      if (b.style?.bold) return `**${text}**`;
      if (b.style?.italic) return `*${text}*`;
      return text;
    }
  }
};

/**
 * 把 `pdf.parse` 的结构化结果渲染为 markdown。
 * 按页序拼接，页内保留原始顺序，图片置于各页末尾；无分页标识。
 */
export const pdfResult2Markdown = (
  res: PdfParseResult,
  options: MarkdownConvertOptions = {}
): string => {
  const toImageUrl = options.toImageUrl ?? identityImageUrl;
  const textBlocks = res?.textBlocks ?? [];
  const images = res?.images ?? [];

  const pageIndices = new Set<number>();
  for (const b of textBlocks) pageIndices.add(b.locator?.pageIndex ?? 0);
  for (const img of images) pageIndices.add(img.locator?.pageIndex ?? 0);

  const parts: string[] = [];
  for (const p of [...pageIndices].sort((a, b) => a - b)) {
    for (const b of textBlocks) {
      if ((b.locator?.pageIndex ?? 0) !== p) continue;
      const line = renderTextBlock(b);
      if (line) parts.push(line);
    }
    for (const img of images) {
      if ((img.locator?.pageIndex ?? 0) !== p) continue;
      if (!img.key) continue;
      parts.push(`![${img.fileName || 'img'}](${toImageUrl(img.key)})`);
    }
  }
  return parts.join('\n\n');
};

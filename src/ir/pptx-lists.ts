/**
 * PPTX 段落的列表结构：大纲级别与项目符号，本地解析器与云端适配器共用这一套判据。
 *
 * 两个引擎原先都把一个文本框的段落摊平成几行字：讲义里「server:」底下缩进的要点、编号步骤，
 * 在 Markdown 里和普通正文没有分别。OOXML 的项目符号大多不写在段落上，而是从版式、母版继承，
 * 所以这里给出继承链的顺序与每一层的读法；各引擎只负责从自己的数据里把这条链取出来。
 */

export type ListKind = 'bullet' | 'number';

/** 一个段落在节点 `text` 里的范围（UTF-16 下标，左闭右开）、大纲级别（0 起）与项目符号。 */
export interface TextParagraph {
  start: number;
  end: number;
  level: number;
  list?: ListKind | undefined;
}

/** 某一层样式对项目符号的表态：要（哪一种）、明确不要（`buNone`），或没说（交给下一层）。 */
export type BulletDeclaration = ListKind | 'none' | undefined;

/** 一层段落属性里写了哪些项目符号元素。 */
export interface BulletElements {
  none?: boolean;
  autoNumber?: boolean;
  character?: boolean;
  picture?: boolean;
}

export function bulletDeclaration(elements: BulletElements): BulletDeclaration {
  if (elements.none) return 'none';
  if (elements.autoNumber) return 'number';
  if (elements.character || elements.picture) return 'bullet';
  return undefined;
}

/**
 * 沿继承链取第一个表态的层：段落自己 → 形状的 lstStyle → 版式占位符 → 母版占位符 →
 * 母版文字样式 → 演示文稿默认样式。传生成器即可按需求值。
 */
export function resolveList(declarations: Iterable<BulletDeclaration>): ListKind | undefined {
  for (const declaration of declarations) {
    if (declaration) return declaration === 'none' ? undefined : declaration;
  }
  return undefined;
}

/** 大纲级别 → lstStyle / txStyles 里的键：级别 0 是 `lvl1pPr`。 */
export function levelStyleKey(level: number): string {
  return `lvl${Math.min(Math.max(Math.trunc(level), 0), 8) + 1}pPr`;
}

/** 只有真有列表项时才值得写进 IR；全是普通段落的文本框照旧只有 text 与 runs。 */
export function listParagraphs(paragraphs: readonly TextParagraph[]): TextParagraph[] | undefined {
  return paragraphs.some((paragraph) => paragraph.list) ? [...paragraphs] : undefined;
}

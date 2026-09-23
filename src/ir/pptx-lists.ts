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

export interface PlaceholderKey {
  type?: string | undefined;
  idx?: string | undefined;
}

const FURNITURE_PLACEHOLDER_TYPES: ReadonlySet<string> = new Set(['dt', 'ftr', 'sldNum', 'hdr']);

/**
 * 占位符归类：标题、四类家具各成一类，其余（正文、内容、副标题、图片、表格……）都按正文。
 * 母版上每类只有一个占位符，版式占位符按这个归类找到它的母版占位符。
 */
export function placeholderKind(type: string | undefined): string {
  if (type === 'title' || type === 'ctrTitle') return 'title';
  if (type && FURNITURE_PLACEHOLDER_TYPES.has(type)) return type;
  return 'body';
}

/** 母版文字样式：标题占位符用 titleStyle，家具与不是占位符的形状用 otherStyle，其余用 bodyStyle。 */
export function masterTextStyleKey(placeholder: PlaceholderKey | undefined): 'titleStyle' | 'bodyStyle' | 'otherStyle' {
  if (!placeholder) return 'otherStyle';
  const kind = placeholderKind(placeholder.type);
  return kind === 'title' ? 'titleStyle' : kind === 'body' ? 'bodyStyle' : 'otherStyle';
}

/**
 * 幻灯片占位符 → 版式占位符：有 idx 先按 idx 找（PowerPoint 的做法），找不到再按类型，
 * 类型也对不上就按归类。
 */
export function matchLayoutPlaceholder<T>(target: PlaceholderKey, candidates: ReadonlyArray<{ key: PlaceholderKey; value: T }>): T | undefined {
  if (target.idx !== undefined) {
    const byIdx = candidates.find((candidate) => candidate.key.idx === target.idx);
    if (byIdx) return byIdx.value;
  }
  const sameType = (type: string | undefined): string => type === 'ctrTitle' ? 'title' : type ?? 'obj';
  const byType = candidates.find((candidate) => sameType(candidate.key.type) === sameType(target.type));
  if (byType) return byType.value;
  return candidates.find((candidate) => placeholderKind(candidate.key.type) === placeholderKind(target.type))?.value;
}

/** 只有真有列表项时才值得写进 IR；全是普通段落的文本框照旧只有 text 与 runs。 */
export function listParagraphs(paragraphs: readonly TextParagraph[]): TextParagraph[] | undefined {
  return paragraphs.some((paragraph) => paragraph.list) ? [...paragraphs] : undefined;
}

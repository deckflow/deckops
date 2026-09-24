/**
 * PPTX 占位符的继承：幻灯片上的占位符没写的属性（位置、项目符号……）从版式、再从母版上的
 * 对应占位符取。本地解析器与云端适配器共用这套匹配规则，两边从各自的数据里取出候选即可。
 */

export interface PlaceholderKey {
  type?: string | undefined;
  idx?: string | undefined;
}

/** 版式或母版上的一个占位符：匹配用的键，与各引擎自己的数据。 */
export interface PlaceholderEntry<T> {
  key: PlaceholderKey;
  value: T;
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
export function matchLayoutPlaceholder<T>(target: PlaceholderKey, candidates: ReadonlyArray<PlaceholderEntry<T>>): PlaceholderEntry<T> | undefined {
  if (target.idx !== undefined) {
    const byIdx = candidates.find((candidate) => candidate.key.idx === target.idx);
    if (byIdx) return byIdx;
  }
  const sameType = (type: string | undefined): string => type === 'ctrTitle' ? 'title' : type ?? 'obj';
  const byType = candidates.find((candidate) => sameType(candidate.key.type) === sameType(target.type));
  if (byType) return byType;
  return candidates.find((candidate) => placeholderKind(candidate.key.type) === placeholderKind(target.type));
}

/**
 * 幻灯片占位符在版式与母版上的对应项。母版按归类找，归类以版式占位符的类型为准——版式上的
 * 内容占位符常常只写 idx 不写类型，那时退回幻灯片占位符自己的类型。
 */
export function inheritedPlaceholders<T>(
  target: PlaceholderKey,
  layout: ReadonlyArray<PlaceholderEntry<T>>,
  master: ReadonlyArray<PlaceholderEntry<T>>,
): { layout: T | undefined; master: T | undefined } {
  const fromLayout = matchLayoutPlaceholder(target, layout);
  const kind = placeholderKind(fromLayout?.key.type ?? target.type);
  return { layout: fromLayout?.value, master: master.find((candidate) => placeholderKind(candidate.key.type) === kind)?.value };
}

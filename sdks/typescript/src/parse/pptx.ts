/**
 * 把 `pptx.parse` 的结构化结果渲染为按 `---` 分页的 Markdown。
 *
 * 阅读顺序算法与 PPTX-Parser 保持一致：
 * 1. 先按纵向重叠/容差把元素链式吸收到行；
 * 2. 每行从自己的左上区域选择有内容的起点；
 * 3. 行内按二维最近邻链排序，空几何对象也参与导航但不输出；
 * 4. 重叠且面积更小的元素归入“虚拟容器”，实体 Group 则在父级保持原子并递归解析；
 * 5. 表格、图片、组和多行文本按块级内容输出。
 *
 * 位置信息（xfrm）可能来自占位符/layout/master 的继承链，因此仍由
 * `@deckflow/presentation` 解析。它以惰性 import 引入，只使用其它格式转换器时不会加载。
 */

import type {
  InitSDK,
  PresentationAttrs,
  ShapeAttrs,
  SlideAttrs,
  TblAttrs,
  TxBodyAttrs,
} from '@deckflow/presentation';
import { identityImageUrl, type MarkdownConvertOptions } from './types.js';

type PresentationSdk = ReturnType<typeof InitSDK>;

export interface PptxParseResult extends PresentationAttrs {
  files?: Record<string, [relativePath: string, bytes: number, hash: string]>;
}

export interface PptxConvertOptions extends MarkdownConvertOptions {
  /** 小于该字节数的图片视为装饰性内容丢弃；默认 5120，传 0 关闭 */
  minImageBytes?: number;
  /** 行吸收的相对垂直容差系数；默认 0 */
  verticalToleranceFactor?: number;
  /** 行吸收的绝对垂直容差（EMU）；默认 9000 */
  absoluteVerticalTolerance?: number;
  /** 同行内的普通原子分隔符；默认空格 */
  inlineSeparator?: string;
  /** 同行内出现组、表格或多行内容时的块分隔符；默认 `\n---\n` */
  blockSeparator?: string;
  /** 行之间的分隔符；默认换行 */
  rowSeparator?: string;
  /** 是否丢弃没有 Markdown 输出的行；默认 true */
  dropEmptyText?: boolean;
  /**
   * @deprecated 新算法改用 absoluteVerticalTolerance，不再使用最小行高。
   * 保留字段仅用于兼容旧调用方。
   */
  minRowHeight?: number;
  /**
   * @deprecated 新算法使用二维最近邻链，不再使用固定横向阈值。
   * 保留字段仅用于兼容旧调用方。
   */
  horizontalGroupingThreshold?: number;
}

interface XForm {
  x: number;
  y: number;
  cx: number;
  cy: number;
}

interface BoundingBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

type AtomKind = 'group' | 'table' | 'image' | 'object';

interface LayoutAtom {
  box: BoundingBox;
  kind: AtomKind;
  order: number;
  ooxmlOrder: number;
  output: string;
  isEntityGroup: boolean;
  hasChildren: boolean;
}

type ChainItem =
  | { kind: 'element'; element: LayoutAtom }
  | { kind: 'virtual-group'; mother: LayoutAtom; children: ChainItem[] };

interface NormalizedOptions {
  minImageBytes: number;
  verticalToleranceFactor: number;
  absoluteVerticalTolerance: number;
  inlineSeparator: string;
  blockSeparator: string;
  rowSeparator: string;
  dropEmptyText: boolean;
}

const DEFAULTS: NormalizedOptions = {
  minImageBytes: 5120,
  verticalToleranceFactor: 0,
  absoluteVerticalTolerance: 9000,
  inlineSeparator: ' ',
  blockSeparator: '\n---\n',
  rowSeparator: '\n',
  dropEmptyText: true,
};

const BACKGROUND_MIN_WIDTH = 8_000_000;
const BACKGROUND_MIN_HEIGHT = 5_000_000;

/** 样式链由近及远，取第一个定义了该属性的值 */
const pickStyle = <T, K extends keyof T>(
  styles: readonly T[] | undefined,
  key: K
): T[K] | undefined => {
  for (const style of styles ?? []) {
    const value = style?.[key];
    if (value !== undefined) return value;
  }
  return undefined;
};

const numberOrZero = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

const boundingBox = (xfrm?: XForm): BoundingBox => {
  const left = numberOrZero(xfrm?.x);
  const top = numberOrZero(xfrm?.y);
  const width = numberOrZero(xfrm?.cx);
  const height = numberOrZero(xfrm?.cy);
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  };
};

const textFromBody = (txBody?: TxBodyAttrs): string =>
  (txBody?.children ?? [])
    .map((paragraph) => (paragraph.children ?? []).map((run) => run.t || '').join(''))
    .join('\n');

const tableRows = (table?: TblAttrs): string[][] =>
  (table?.trs ?? []).map((row) => row.cells.map((cell) => textFromBody(cell.txBody)));

const tableCellText = (value: unknown): string =>
  String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, '<br>')
    .trim();

/** 表格首行作为表头；行列不齐时按最宽行补空单元格 */
const tableToMarkdown = (rows: readonly (readonly unknown[])[]): string => {
  if (!rows.length) return '';

  const normalized = rows.map((row) => row.map(tableCellText));
  const width = Math.max(...normalized.map((row) => row.length), 0);
  if (width <= 0) return '';

  const padded = normalized.map((row) => [
    ...row,
    ...Array.from({ length: width - row.length }, () => ''),
  ]);
  const [header = [], ...body] = padded;
  const separator = Array.from({ length: width }, () => '---');
  return [header, separator, ...body].map((row) => `| ${row.join(' | ')} |`).join('\n');
};

const escapeImageAlt = (value: string): string => value.replace(/\n/g, ' ').replace(/\]/g, '\\]');

const markdownLinkTarget = (value: string): string => {
  if (/\s|[()#<>]/u.test(value)) return `<${value.replace(/>/g, '%3E')}>`;
  return value;
};

const compareAtomsByPosition = (first: LayoutAtom, second: LayoutAtom): number =>
  first.box.top - second.box.top ||
  first.box.left - second.box.left ||
  first.ooxmlOrder - second.ooxmlOrder ||
  first.order - second.order;

const boxesVerticallyOverlap = (first: BoundingBox, second: BoundingBox): boolean =>
  first.top < second.bottom && first.bottom > second.top;

const boxesOverlapWithArea = (first: BoundingBox, second: BoundingBox): boolean =>
  first.left < second.right &&
  first.right > second.left &&
  first.top < second.bottom &&
  first.bottom > second.top;

const boxArea = (box: BoundingBox): number => box.width * box.height;

const planeDistanceSq = (box: BoundingBox, anchorLeft: number, anchorTop: number): number => {
  const dx = box.left - anchorLeft;
  const dy = box.top - anchorTop;
  return dx * dx + dy * dy;
};

class ReadingOrderExtractor {
  private readonly options: NormalizedOptions;
  private readonly toImageUrl: (key: string) => string;

  constructor(options: PptxConvertOptions) {
    this.options = {
      minImageBytes: options.minImageBytes ?? DEFAULTS.minImageBytes,
      verticalToleranceFactor: options.verticalToleranceFactor ?? DEFAULTS.verticalToleranceFactor,
      absoluteVerticalTolerance:
        options.absoluteVerticalTolerance ?? DEFAULTS.absoluteVerticalTolerance,
      inlineSeparator: options.inlineSeparator ?? DEFAULTS.inlineSeparator,
      blockSeparator: options.blockSeparator ?? DEFAULTS.blockSeparator,
      rowSeparator: options.rowSeparator ?? DEFAULTS.rowSeparator,
      dropEmptyText: options.dropEmptyText ?? DEFAULTS.dropEmptyText,
    };
    this.toImageUrl = options.toImageUrl ?? identityImageUrl;
  }

  public slideToMarkdown(
    sdk: PresentationSdk,
    slide: SlideAttrs,
    shapes: readonly ShapeAttrs[],
    files: Record<string, [string, number, string]>
  ): string {
    return this.parseGroup(this.prepareShapes(sdk, slide, shapes, files));
  }

  private prepareShapes(
    sdk: PresentationSdk,
    slide: SlideAttrs,
    shapes: readonly ShapeAttrs[],
    files: Record<string, [string, number, string]>
  ): LayoutAtom[] {
    const atoms: LayoutAtom[] = [];
    for (let order = 0; order < (shapes ?? []).length; order += 1) {
      const shape = shapes[order];
      if (!shape || shape.hidden) continue;
      atoms.push(this.prepareShape(sdk, slide, shape, files, order));
    }
    return atoms;
  }

  private prepareShape(
    sdk: PresentationSdk,
    slide: SlideAttrs,
    shape: ShapeAttrs,
    files: Record<string, [string, number, string]>,
    order: number
  ): LayoutAtom {
    const styles = sdk.getShapeStyle(slide, shape);
    const xfrm = pickStyle(styles, 'xfrm') as XForm | undefined;
    const kind = this.atomKind(shape);
    const isEntityGroup = shape.type === 'Group';
    const hasChildren = Boolean(shape.children?.length);

    let output = this.shapeOutput(shape, kind, files);
    if (isEntityGroup && hasChildren) {
      output = this.parseGroup(this.prepareShapes(sdk, slide, shape.children ?? [], files));
    }

    return {
      box: boundingBox(xfrm),
      kind,
      order,
      ooxmlOrder: order,
      output,
      isEntityGroup,
      hasChildren,
    };
  }

  private atomKind(shape: ShapeAttrs): AtomKind {
    if (shape.type === 'Group') return 'group';
    if (shape.type === 'Table' || shape.table) return 'table';
    if (shape.type === 'Picture' || shape.picture) return 'image';
    return 'object';
  }

  private shapeOutput(
    shape: ShapeAttrs,
    kind: AtomKind,
    files: Record<string, [string, number, string]>
  ): string {
    const rows = tableRows(shape.table);
    if (rows.length) return tableToMarkdown(rows);

    if (kind === 'image' && shape.picture?.blip) {
      const entry = files[shape.picture.blip];
      if (entry && this.keepImage(entry[1])) {
        const metadata = shape as ShapeAttrs & {
          alt?: string;
          descr?: string;
          title?: string;
        };
        const alt = metadata.alt ?? metadata.descr ?? metadata.title ?? '';
        const target = markdownLinkTarget(this.toImageUrl(entry[0]));
        return `![${escapeImageAlt(alt)}](${target})`;
      }
    }

    return textFromBody(shape.txBody);
  }

  private keepImage(size?: number): boolean {
    if (!this.options.minImageBytes) return true;
    if (size === undefined) return true;
    return size >= this.options.minImageBytes;
  }

  private parseGroup(atoms: LayoutAtom[]): string {
    const participants = atoms.filter((atom) => this.participatesInRowGrouping(atom));
    const rows = this.groupIntoRows(participants);
    rows.sort((first, second) => this.rowTop(first) - this.rowTop(second));

    for (const row of rows) this.sortRowByChainedDistance(row);

    return rows
      .map((row) => this.formatRow(row))
      .filter((text) => Boolean(text) || !this.options.dropEmptyText)
      .join(this.options.rowSeparator);
  }

  private participatesInRowGrouping(atom: LayoutAtom): boolean {
    if (atom.box.width <= 0 && atom.box.height <= 0) return false;
    if (atom.output.trim()) return true;
    return !this.isBackgroundLike(atom);
  }

  private isBackgroundLike(atom: LayoutAtom): boolean {
    return (
      !atom.output.trim() &&
      atom.box.left <= 0 &&
      atom.box.top <= 0 &&
      atom.box.width >= BACKGROUND_MIN_WIDTH &&
      atom.box.height >= BACKGROUND_MIN_HEIGHT
    );
  }

  private groupingBox(atom: LayoutAtom): BoundingBox {
    if (atom.output.trim()) return atom.box;

    const padding = this.options.absoluteVerticalTolerance * 2;
    const top = atom.box.top - padding;
    const height = atom.box.height + padding * 2;
    return {
      ...atom.box,
      top,
      bottom: top + height,
      height,
    };
  }

  private groupIntoRows(atoms: LayoutAtom[]): LayoutAtom[][] {
    const sorted = [...atoms].sort(compareAtomsByPosition);
    const rows: LayoutAtom[][] = [];
    let currentRow: LayoutAtom[] = [];

    for (const atom of sorted) {
      if (!currentRow.length || this.isVerticallyAssociated(atom, currentRow)) {
        currentRow.push(atom);
      } else {
        rows.push(currentRow);
        currentRow = [atom];
      }
    }

    if (currentRow.length) rows.push(currentRow);
    return rows;
  }

  private isVerticallyAssociated(atom: LayoutAtom, row: LayoutAtom[]): boolean {
    const boxes = row.map((item) => this.groupingBox(item));
    const rowTop = Math.min(...boxes.map((box) => box.top));
    const rowBottom = Math.max(...boxes.map((box) => box.bottom));
    const elementBox = this.groupingBox(atom);

    if (elementBox.top < rowBottom && elementBox.bottom > rowTop) return true;

    const verticalGap = elementBox.top - rowBottom;
    if (verticalGap <= 0) return false;

    const rowHeight = rowBottom - rowTop;
    const relativeTolerance = rowHeight * this.options.verticalToleranceFactor;
    const tolerance = Math.max(this.options.absoluteVerticalTolerance, relativeTolerance);
    return verticalGap <= tolerance;
  }

  private rowTop(row: LayoutAtom[]): number {
    const readable = row.filter((atom) => atom.output.trim()).map((atom) => atom.box.top);
    if (readable.length) return Math.min(...readable);
    return Math.min(...row.map((atom) => atom.box.top));
  }

  private formatRow(row: LayoutAtom[]): string {
    const items = row
      .map((atom) => ({ atom, output: atom.output.trim() }))
      .filter((item) => item.output);
    const blockLike = items.some(
      ({ atom, output }) => atom.kind === 'group' || atom.kind === 'table' || output.includes('\n')
    );
    const separator = blockLike ? this.options.blockSeparator : this.options.inlineSeparator;
    return items.map((item) => item.output).join(separator);
  }

  private sortRowByChainedDistance(row: LayoutAtom[]): void {
    if (!row.length) return;

    const anchorLeft = Math.min(...row.map((atom) => atom.box.left));
    const anchorTop = Math.min(...row.map((atom) => atom.box.top));
    const [ordered] = this.chainOrderElements(row, anchorLeft, anchorTop);
    row.splice(0, row.length, ...ordered);
  }

  private chainOrderElements(
    atoms: LayoutAtom[],
    anchorLeft: number,
    anchorTop: number
  ): [LayoutAtom[], LayoutAtom | undefined] {
    const items = this.virtualChainItems(atoms);
    const first = this.firstMeaningfulChainItem(items);
    if (!first) return this.chainOrderItems(items, anchorLeft, anchorTop);

    const remaining = items.filter((item) => item !== first);
    const ordered = this.expandChainItem(first);
    const anchor = this.chainItemAnchor(first);
    const [rest, lastAnchor] = this.chainOrderItems(remaining, anchor.box.left, anchor.box.top);
    return [[...ordered, ...rest], lastAnchor ?? anchor];
  }

  private firstMeaningfulChainItem(items: ChainItem[]): ChainItem | undefined {
    const meaningful = items.filter((item) => this.chainItemHasMeaning(item));
    if (!meaningful.length) return undefined;

    const topmost = [...meaningful].sort((first, second) => {
      const firstAnchor = this.chainItemAnchor(first);
      const secondAnchor = this.chainItemAnchor(second);
      return compareAtomsByPosition(firstAnchor, secondAnchor);
    })[0];
    if (!topmost) return undefined;

    const sideBySide = meaningful.filter((item) =>
      boxesVerticallyOverlap(this.chainItemAnchor(item).box, this.chainItemAnchor(topmost).box)
    );
    const candidates = sideBySide.length ? sideBySide : [topmost];
    return [...candidates].sort((first, second) => {
      const firstAnchor = this.chainItemAnchor(first);
      const secondAnchor = this.chainItemAnchor(second);
      return (
        firstAnchor.box.left - secondAnchor.box.left ||
        firstAnchor.box.top - secondAnchor.box.top ||
        firstAnchor.ooxmlOrder - secondAnchor.ooxmlOrder ||
        firstAnchor.order - secondAnchor.order
      );
    })[0];
  }

  private chainItemHasMeaning(item: ChainItem): boolean {
    if (item.kind === 'element') {
      return item.element.isEntityGroup || Boolean(item.element.output.trim());
    }
    return (
      Boolean(item.mother.output.trim()) ||
      item.children.some((child) => this.chainItemHasMeaning(child))
    );
  }

  private chainOrderItems(
    items: ChainItem[],
    initialAnchorLeft: number,
    initialAnchorTop: number
  ): [LayoutAtom[], LayoutAtom | undefined] {
    const remaining = [...items];
    const ordered: LayoutAtom[] = [];
    let anchorLeft = initialAnchorLeft;
    let anchorTop = initialAnchorTop;
    let lastAnchor: LayoutAtom | undefined;

    while (remaining.length) {
      remaining.sort((first, second) =>
        this.compareChainItems(first, second, anchorLeft, anchorTop)
      );
      const next = remaining.shift();
      if (!next) break;

      ordered.push(...this.expandChainItem(next));
      const anchor = this.chainItemAnchor(next);
      anchorLeft = anchor.box.left;
      anchorTop = anchor.box.top;
      lastAnchor = anchor;
    }

    return [ordered, lastAnchor];
  }

  private compareChainItems(
    first: ChainItem,
    second: ChainItem,
    anchorLeft: number,
    anchorTop: number
  ): number {
    const firstAtom = this.chainItemAnchor(first);
    const secondAtom = this.chainItemAnchor(second);
    return (
      planeDistanceSq(firstAtom.box, anchorLeft, anchorTop) -
        planeDistanceSq(secondAtom.box, anchorLeft, anchorTop) ||
      firstAtom.box.top - secondAtom.box.top ||
      firstAtom.box.left - secondAtom.box.left ||
      firstAtom.ooxmlOrder - secondAtom.ooxmlOrder ||
      firstAtom.order - secondAtom.order
    );
  }

  private virtualChainItems(atoms: LayoutAtom[]): ChainItem[] {
    const mothers = atoms.filter((atom) => this.isVirtualGroupMother(atom));
    const childrenByMother = new Map<LayoutAtom, LayoutAtom[]>(
      mothers.map((mother) => [mother, []])
    );
    const parentByChild = new Map<LayoutAtom, LayoutAtom>();

    for (const atom of atoms) {
      if (!this.isVirtualGroupChild(atom)) continue;
      const mother = this.overlappingVirtualMother(atom, mothers);
      if (!mother) continue;
      parentByChild.set(atom, mother);
      childrenByMother.get(mother)?.push(atom);
    }

    return atoms
      .filter((atom) => !parentByChild.has(atom))
      .map((atom) => this.virtualChainItemFor(atom, childrenByMother));
  }

  private virtualChainItemFor(
    atom: LayoutAtom,
    childrenByMother: Map<LayoutAtom, LayoutAtom[]>
  ): ChainItem {
    const children = childrenByMother.get(atom) ?? [];
    if (!children.length) return { kind: 'element', element: atom };
    return {
      kind: 'virtual-group',
      mother: atom,
      children: children.map((child) => this.virtualChainItemFor(child, childrenByMother)),
    };
  }

  private isVirtualGroupMother(atom: LayoutAtom): boolean {
    return (
      !atom.isEntityGroup &&
      !this.isBackgroundLike(atom) &&
      atom.box.width > 0 &&
      atom.box.height > 0
    );
  }

  private isVirtualGroupChild(atom: LayoutAtom): boolean {
    return !atom.isEntityGroup && !atom.hasChildren;
  }

  private overlappingVirtualMother(
    atom: LayoutAtom,
    mothers: LayoutAtom[]
  ): LayoutAtom | undefined {
    const atomArea = boxArea(atom.box);
    const candidates = mothers.filter(
      (mother) =>
        mother !== atom &&
        boxArea(mother.box) > atomArea &&
        boxesOverlapWithArea(atom.box, mother.box)
    );

    return candidates.sort(
      (first, second) =>
        boxArea(first.box) - boxArea(second.box) ||
        planeDistanceSq(atom.box, first.box.left, first.box.top) -
          planeDistanceSq(atom.box, second.box.left, second.box.top) ||
        first.ooxmlOrder - second.ooxmlOrder ||
        first.order - second.order
    )[0];
  }

  private chainItemAnchor(item: ChainItem): LayoutAtom {
    return item.kind === 'virtual-group' ? item.mother : item.element;
  }

  private expandChainItem(item: ChainItem): LayoutAtom[] {
    if (item.kind === 'element') return [item.element];
    if (!item.children.length) return [item.mother];

    const [children] = this.chainOrderItems(
      item.children,
      item.mother.box.left,
      item.mother.box.top
    );
    return [item.mother, ...children];
  }
}

/** 惰性加载 PPTX 样式解析器；只用其它转换器的调用方不会付出这份体积 */
const loadInitSDK = async (): Promise<typeof InitSDK> => {
  const mod = await import('@deckflow/presentation');
  if (typeof mod?.InitSDK !== 'function') {
    throw new Error('@deckflow/presentation is required to convert pptx.parse results to markdown');
  }
  return mod.InitSDK;
};

export const pptxResult2Markdown = async (
  res: PptxParseResult,
  options: PptxConvertOptions = {}
): Promise<string> => {
  const slides = res?.slides ?? [];
  if (!slides.length) return '';

  const initSDK = await loadInitSDK();
  const sdk = initSDK(res);
  const files = res?.files ?? {};
  const extractor = new ReadingOrderExtractor(options);
  const pages: string[] = [];

  for (const slide of slides) {
    const markdown = extractor.slideToMarkdown(sdk, slide, slide?.spTree ?? [], files).trim();
    if (markdown) pages.push(markdown);
  }

  return pages.join('\n\n---\n\n');
};

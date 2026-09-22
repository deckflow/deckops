import type { DeckIrNode, DeckIrPage } from './schema.js';

/** 两个形状上下重叠至少占较高者的这个比例，才算同一行。按较高者算，高的正文栏不会把旁边图示的标签整列吞进一行。 */
const SAME_ROW_MIN_OVERLAP = 0.5;

/** 版式家具：页脚、日期、页码、页眉占位符。 */
const FURNITURE_TYPES: ReadonlySet<string> = new Set(['footer', 'header', 'page_number']);

/** 子节点按版面重排的容器。表格的行与单元格是结构顺序，不能按位置重排。 */
const SPATIAL_CONTAINERS: ReadonlySet<string> = new Set(['group']);

/**
 * 幻灯片的阅读顺序。
 *
 * OOXML 形状树的先后是 z-order（谁叠在谁上面），不是阅读顺序。图示页上两者差得最远：实测
 * 一页 Cookie 时序图，标签按 z-order 读出来是「响应、响应、cookie 文件、一周后、请求……」，
 * 时序全乱。这里按版面重排：标题占位符最先；接着是正文类占位符（正文、副标题、内容），它们
 * 是这一页的主体；然后是其余有位置的形状。后两组各自自上而下，同一行内自左而右。页脚、页码
 * 这类家具，以及没有位置的节点（讲者备注、嵌入对象关系）排在最后，彼此保持原有先后。组合
 * 内部同样重排，组合本身按它的外框参与排序。
 *
 * 正文占位符不和散落的形状一起按位置排：实测一页「正文栏 + 右侧图示」，图例标签的上沿比
 * 正文框高一点，纯按位置就把「outgoing message queue」排到了「Three major components」前面。
 *
 * 只改 `order`、父节点的 `children` 与页面的 `nodeIds`；z-order 由各解析器记在 `zIndex`。
 * 每页节点原本占着一段连续的 order，重排只在这段里换位，页与页之间互不影响。
 */
export function orderSlideNodes(nodes: readonly DeckIrNode[], pages: DeckIrPage[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const page of pages) {
    const pageNodes = page.nodeIds.flatMap((id) => {
      const node = byId.get(id);
      return node ? [node] : [];
    });
    if (pageNodes.length === 0) continue;
    const inPage = new Set(pageNodes.map((node) => node.id));
    let next = Math.min(...pageNodes.map((node) => node.order));
    const visit = (node: DeckIrNode): void => {
      const kids = node.children.flatMap((id) => {
        const child = byId.get(id);
        return child && inPage.has(child.id) ? [child] : [];
      });
      const sorted = SPATIAL_CONTAINERS.has(node.type) ? readingOrder(kids) : [...kids].sort(byOriginalOrder);
      node.order = next;
      next += 1;
      node.children = [...sorted.map((child) => child.id), ...node.children.filter((id) => !inPage.has(id))];
      sorted.forEach(visit);
    };
    readingOrder(pageNodes.filter((node) => node.parentId === null || !inPage.has(node.parentId))).forEach(visit);
    page.nodeIds = pageNodes.sort((left, right) => left.order - right.order).map((node) => node.id);
  }
}

function readingOrder(items: readonly DeckIrNode[]): DeckIrNode[] {
  type Placed = DeckIrNode & { bbox: [number, number, number, number] };
  const titles: DeckIrNode[] = [];
  const placeholders: Placed[] = [];
  const positioned: Placed[] = [];
  const furniture: DeckIrNode[] = [];
  const unplaced: DeckIrNode[] = [];
  for (const item of items) {
    if (item.type === 'heading') titles.push(item);
    else if (FURNITURE_TYPES.has(item.type)) furniture.push(item);
    else if (!item.bbox) unplaced.push(item);
    else if (isPlaceholder(item)) placeholders.push(item as Placed);
    else positioned.push(item as Placed);
  }
  return [
    ...titles.sort(byOriginalOrder),
    ...rowMajor(placeholders),
    ...rowMajor(positioned),
    ...furniture.sort(byOriginalOrder),
    ...unplaced.sort(byOriginalOrder),
  ];
}

/** 两个解析器都把占位符属性记在 `extensions.placeholder`；标题与家具已在前面分走。 */
function isPlaceholder(node: DeckIrNode): boolean {
  const placeholder = node.extensions?.placeholder;
  return typeof placeholder === 'object' && placeholder !== null;
}

function rowMajor(items: ReadonlyArray<DeckIrNode & { bbox: [number, number, number, number] }>): DeckIrNode[] {
  const sorted = [...items].sort((left, right) =>
    left.bbox[1] - right.bbox[1] || left.bbox[0] - right.bbox[0] || byOriginalOrder(left, right));
  const rows: Array<{ top: number; bottom: number; items: Array<DeckIrNode & { bbox: [number, number, number, number] }> }> = [];
  for (const item of sorted) {
    const [, top, , bottom] = item.bbox;
    const row = rows.at(-1);
    if (row) {
      const overlap = Math.min(row.bottom, bottom) - Math.max(row.top, top);
      const taller = Math.max(row.bottom - row.top, bottom - top);
      if (taller > 0 && overlap >= SAME_ROW_MIN_OVERLAP * taller) {
        row.items.push(item);
        row.top = Math.min(row.top, top);
        row.bottom = Math.max(row.bottom, bottom);
        continue;
      }
    }
    rows.push({ top, bottom, items: [item] });
  }
  return rows.flatMap((row) => row.items.sort((left, right) => left.bbox[0] - right.bbox[0] || byOriginalOrder(left, right)));
}

function byOriginalOrder(left: DeckIrNode, right: DeckIrNode): number {
  return left.order - right.order;
}

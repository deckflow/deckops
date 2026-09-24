import type { ChartData, ChartSeries } from '../../ir/chart-data.js';
import { children, first, textContent, type XmlNode } from '../xml.js';

/** 图表类型元素（`barChart`、`pie3DChart`……）→ 类型名（`bar`、`pie`）。 */
const CHART_ELEMENT = /^(.+?)(?:3D)?Chart$/;

/**
 * 读图表部件（`ppt/charts/chartN.xml`）里缓存的标题、类别与各系列数值；读不出任何系列返回
 * undefined。与 presentation 的 `readCharts` 同一套规则，两个引擎得出同一张表。
 */
export function readChartPart(root: XmlNode): ChartData | undefined {
  const chart = first(first(root, 'chartSpace') ?? root, 'chart');
  if (!chart) return undefined;
  const typeElements = (first(chart, 'plotArea')?.children ?? []).filter((element) => CHART_ELEMENT.test(element.local));
  if (!typeElements.length) return undefined;
  const kind = typeElements[0]!.local.match(CHART_ELEMENT)?.[1] ?? 'chart';
  let categories: string[] = [];
  const series: ChartSeries[] = [];
  for (const typeElement of typeElements) {
    for (const ser of children(typeElement, 'ser')) {
      // 系列名多半引用单元格（文字在缓存里），少数直接写在 `c:v`。
      const tx = first(ser, 'tx');
      const name = cachedStrings(tx)[0] ?? text(tx ? first(tx, 'v') : undefined);
      const values = cachedNumbers(first(ser, 'val') ?? first(ser, 'yVal'));
      if (!values.values.length) continue;
      if (!categories.length) categories = cachedStrings(first(ser, 'cat') ?? first(ser, 'xVal'));
      series.push({ ...(name ? { name } : {}), values: values.values, ...(values.formatCode ? { formatCode: values.formatCode } : {}) });
    }
  }
  if (!series.length) return undefined;
  const titleElement = first(chart, 'title');
  const title = titleElement && first(chart, 'autoTitleDeleted')?.attributes.val !== '1'
    ? text(findDeep(titleElement, ['rich'])) || cachedStrings(titleElement)[0] : undefined;
  return { ...(title ? { title } : {}), kind, categories, series };
}

/** `strCache` / `numCache` / `multiLvlStrCache` 里按 idx 排好的点；多级类别取最内层。 */
function cachedStrings(owner: XmlNode | undefined): string[] {
  const cache = findDeep(owner, ['strCache', 'numCache', 'multiLvlStrCache']);
  if (!cache) return [];
  return points(cache.local === 'multiLvlStrCache' ? first(cache, 'lvl') : cache).map((point) => point ?? '');
}

function cachedNumbers(owner: XmlNode | undefined): { values: Array<number | null>; formatCode?: string } {
  const cache = findDeep(owner, ['numCache']);
  if (!cache) return { values: [] };
  const formatCode = text(first(cache, 'formatCode'));
  const values = points(cache).map((point) => {
    if (point === undefined || point.trim() === '') return null;
    const value = Number(point);
    return Number.isFinite(value) ? value : null;
  });
  return { values, ...(formatCode ? { formatCode } : {}) };
}

/** 缓存里的点按 `idx` 落位，`ptCount` 给出总数；缺的点留空。 */
function points(cache: XmlNode | undefined): Array<string | undefined> {
  if (!cache) return [];
  const count = Number(first(cache, 'ptCount')?.attributes.val ?? 0);
  const result: Array<string | undefined> = [];
  for (const pt of children(cache, 'pt')) {
    const index = Number(pt.attributes.idx ?? result.length);
    if (Number.isInteger(index) && index >= 0) result[index] = text(first(pt, 'v'));
  }
  if (Number.isInteger(count) && count > result.length) result.length = count;
  return Array.from(result, (point) => point);
}

function findDeep(node: XmlNode | undefined, names: readonly string[]): XmlNode | undefined {
  if (!node) return undefined;
  for (const child of node.children) {
    if (names.includes(child.local)) return child;
    const nested = findDeep(child, names);
    if (nested) return nested;
  }
  return undefined;
}

function text(node: XmlNode | undefined): string {
  return node ? textContent(node).trim() : '';
}

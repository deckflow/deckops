import type { DeckIrNode } from './schema.js';

/**
 * 图表部件里缓存的数据，两个引擎共用的形状与表格化规则。
 *
 * 图表原先只留一个空壳（`chart_partial`）：画图用的类别与数值其实就缓存在图表部件里，不必打开
 * 内嵌的工作簿。本地解析器从 `ppt/charts/chartN.xml` 读，云端从 presentation 的 `chart` 字段读，
 * 读出来都按这里的规则变成一张表。
 */

export interface ChartData {
  title?: string | undefined;
  /** 图表类型：`bar`、`line`、`pie`、`doughnut`…… */
  kind: string;
  /** 类别（横轴标签）；散点图是 x 值 */
  categories: string[];
  series: ChartSeries[];
}

export interface ChartSeries {
  name?: string | undefined;
  /** 与类别一一对应；缺的点为 null */
  values: Array<number | null>;
  /** 数值格式，如 `0%`、`General` */
  formatCode?: string | undefined;
}

/**
 * 图表 → 表格：首行是表头（空的类别列 + 各系列名），其后每个类别一行。没有类别就按序号标行。
 * 末尾的空行去掉：缓存常按 `ptCount` 预留点位，实测一个环形图四个点位只有两个有值。
 */
export function chartRows(chart: ChartData): string[][] {
  const count = Math.max(chart.categories.length, ...chart.series.map((series) => series.values.length));
  const rows: string[][] = [];
  for (let index = 0; index < count; index += 1) {
    const values = chart.series.map((series) => formatChartValue(series.values[index] ?? null, series.formatCode));
    rows.push([chart.categories[index] || String(index + 1), ...values]);
  }
  while (rows.length && !chart.categories[rows.length - 1] && rows.at(-1)!.slice(1).every((cell) => cell === '')) rows.pop();
  const header = ['', ...chart.series.map((series, index) => series.name || `Series ${index + 1}`)];
  return rows.length ? [header, ...rows] : [];
}

/** 百分比格式（`0%`、`0.0%`，引号里的 `%` 不算）换成百分数；其余去掉浮点尾巴。 */
export function formatChartValue(value: number | null, formatCode?: string): string {
  if (value === null || !Number.isFinite(value)) return '';
  if (formatCode && formatCode.replace(/"[^"]*"/g, '').replace(/\\./g, '').includes('%')) {
    const decimals = formatCode.match(/\.(0+)%/)?.[1]?.length ?? 0;
    return `${(value * 100).toFixed(decimals)}%`;
  }
  return String(Number(value.toPrecision(12)));
}

/** 读外部数据时的校验：形状不对就当没有。 */
export function asChartData(value: unknown): ChartData | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.kind !== 'string' || !Array.isArray(record.series)) return undefined;
  const series = record.series.flatMap((item): ChartSeries[] => {
    if (!item || typeof item !== 'object' || !Array.isArray((item as Record<string, unknown>).values)) return [];
    const raw = item as Record<string, unknown>;
    return [{
      ...(typeof raw.name === 'string' && raw.name ? { name: raw.name } : {}),
      values: (raw.values as unknown[]).map((point) => (typeof point === 'number' && Number.isFinite(point) ? point : null)),
      ...(typeof raw.formatCode === 'string' && raw.formatCode ? { formatCode: raw.formatCode } : {}),
    }];
  });
  if (!series.length) return undefined;
  const categories = Array.isArray(record.categories) ? record.categories.map((category) => (typeof category === 'string' ? category : '')) : [];
  return { ...(typeof record.title === 'string' && record.title ? { title: record.title } : {}), kind: record.kind, categories, series };
}

/**
 * 把图表数据展开成挂在图表节点下的 table → table_row → table_cell，与两个引擎的表格同一种结构，
 * Markdown 渲染器照常出表。`id` 给每个派生节点一个稳定 id，`order` 依次取序号。
 */
export function chartTableNodes(chartNode: DeckIrNode, chart: ChartData, id: (suffix: string) => string, order: () => number): DeckIrNode[] {
  const rows = chartRows(chart);
  if (!rows.length) return [];
  const base = { ...(chartNode.page ? { page: chartNode.page } : {}) };
  const path = chartNode.sourceRef.path ?? 'chart';
  const table: DeckIrNode = { id: id('table'), type: 'table', parentId: chartNode.id, children: [], order: order(), ...base,
    sourceRef: { ...chartNode.sourceRef, path: `${path}/table` }, extensions: { rows: rows.length, columns: rows[0]!.length } };
  chartNode.children.push(table.id);
  const nodes: DeckIrNode[] = [table];
  rows.forEach((cells, rowIndex) => {
    const row: DeckIrNode = { id: id(`row:${rowIndex}`), type: 'table_row', parentId: table.id, children: [], order: order(), ...base,
      sourceRef: { ...chartNode.sourceRef, path: `${path}/table/row/${rowIndex}` } };
    table.children.push(row.id);
    nodes.push(row);
    cells.forEach((text, column) => {
      const cell: DeckIrNode = { id: id(`row:${rowIndex}:cell:${column}`), type: 'table_cell', parentId: row.id, children: [], order: order(), text, ...base,
        sourceRef: { ...chartNode.sourceRef, path: `${path}/table/row/${rowIndex}/cell/${column}` }, extensions: { row: rowIndex, column } };
      row.children.push(cell.id);
      nodes.push(cell);
    });
  });
  return nodes;
}

import { describe, expect, it } from 'vitest';
import { cloudResultToCandidate } from '../../src/ir/cloud-adapter.js';
import { renderMarkdown } from '../../src/views/markdown.js';
import type { ParseResult } from '../../src/cloud/parse-facade.js';

const source = { sha256: 'a'.repeat(64), name: 'fixture.pptx', bytes: 1 };

const parse = (spTree: unknown[]): Promise<ReturnType<typeof cloudResultToCandidate>> =>
  cloudResultToCandidate(
    {
      taskId: 'task', type: 'pptx.parse', irKey: 'ir/fixture', irSchemaVersion: 'pptx.v1',
      ir: { slides: [{ _ref: 'slide1', spTree }], files: {}, images: [] },
    } as ParseResult,
    source,
  ) as never;

const cell = (text: string, extra: Record<string, unknown> = {}) => ({
  text, txBody: { children: [{ children: [{ t: text }] }] }, ...extra,
});

describe('cloud IR adapter', () => {
  it('expands tables into table_row and table_cell so Markdown can render them', async () => {
    const candidate = await parse([
      {
        id: 1, name: 'Table 1', type: 'Table', xfrm: { x: 0, y: 0, cx: 400, cy: 100 },
        table: {
          grid: { cols: [] },
          trs: [
            { cells: [cell('Name'), cell('Qty')] },
            { cells: [cell('Widget'), cell('12')] },
          ],
        },
      },
    ]);

    const types = candidate.ir.document.nodes.map((node) => node.type);
    expect(types).toEqual(['table', 'table_row', 'table_cell', 'table_cell', 'table_row', 'table_cell', 'table_cell']);

    const table = candidate.ir.document.nodes[0]!;
    expect(table.extensions).toMatchObject({ rows: 2, columns: 2 });
    // 单元格摊成 table 的直接子节点时渲染器一个字都取不到，这里锁住层级。
    const rows = candidate.ir.document.nodes.filter((node) => node.type === 'table_row');
    expect(rows.map((row) => row.parentId)).toEqual([table.id, table.id]);
    expect(rows.every((row) => row.children.length === 2)).toBe(true);

    expect(renderMarkdown(candidate.ir).markdown).toContain('| Name | Qty |\n| --- | --- |\n| Widget | 12 |');
  });

  it('carries merge spans through to the cells', async () => {
    const candidate = await parse([
      {
        id: 1, name: 'Table 1', type: 'Table',
        table: { grid: { cols: [] }, trs: [{ cells: [cell('Wide', { colSpan: 2 }), cell('', { hMerge: true })] }] },
      },
    ]);

    const cells = candidate.ir.document.nodes.filter((node) => node.type === 'table_cell');
    expect(cells[0]!.extensions).toMatchObject({ row: 0, column: 0, gridSpan: 2, rowSpan: 1 });
    expect(cells[1]!.extensions).toMatchObject({ column: 1, hMerge: true });
  });

  it('leaves records without a recognizable grid to the generic walk', async () => {
    const candidate = await parse([
      { id: 1, name: 'Empty', type: 'Table', table: { grid: { cols: [] }, trs: [] } },
    ]);

    expect(candidate.ir.document.nodes.map((node) => node.type)).toEqual(['table']);
  });

  it('types title placeholders as headings and text shapes as text', async () => {
    const candidate = await parse([
      { id: 1, name: 'Title 1', type: 'Shape', ph: { type: 'title' },
        txBody: { children: [{ children: [{ t: 'Application architectures' }] }] }, text: 'Application architectures' },
      { id: 2, name: 'Body 1', type: 'Shape', ph: { type: 'body' },
        txBody: { children: [{ children: [{ t: 'Client-server' }] }] }, text: 'Client-server' },
      // 空的标题占位符靠类型词才建得出节点，改判 heading 会让它整个消失。
      { id: 3, name: 'Empty title', type: 'Shape', ph: { type: 'ctrTitle' }, xfrm: { x: 0, y: 0, cx: 10, cy: 10 } },
    ]);

    expect(candidate.ir.document.nodes.map((node) => node.type)).toEqual(['heading', 'text', 'shape']);
    expect(renderMarkdown(candidate.ir).markdown).toContain('## Application architectures');
  });

  it('does not mistake a freeform geometry path for an asset pointer', async () => {
    const candidate = await parse([
      { id: 1, name: 'Freeform 9', type: 'Shape', path: 'M 0 0 L 10 10 Z', xfrm: { x: 0, y: 0, cx: 10, cy: 10 } },
    ]);

    const [shape] = candidate.ir.document.nodes;
    expect(shape!.extensions?.assetPath).toBeUndefined();
    expect(shape!.issues ?? []).toEqual([]);
    // 几何路径被当成资产时会凭空产出这条告警，并把整份产物顶成 degraded。
    expect(candidate.ir.quality.checks.map((check) => check.code)).not.toContain('cloud_asset_unavailable');
    expect(candidate.ir.quality.status).toBe('pass');
  });

  it('still reports a real asset that the cloud could not materialize', async () => {
    const candidate = await parse([
      { id: 1, name: 'Picture 1', type: 'Picture', assetPath: 'assets/missing.png' },
    ]);

    expect(candidate.ir.document.nodes[0]!.issues).toEqual(['missing_media']);
    expect(candidate.ir.quality.checks.map((check) => check.code)).toContain('cloud_asset_unavailable');
  });
});

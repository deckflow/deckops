import { describe, expect, it } from 'vitest';
import type { DeckIrNode, DeckIrPage } from '../../src/ir/schema.js';
import { orderSlideNodes } from '../../src/ir/slide-order.js';

const node = (id: string, order: number, bbox?: [number, number, number, number], type = 'text'): DeckIrNode =>
  ({ id, type, parentId: null, children: [], order, text: id, sourceRef: {}, ...(bbox ? { bbox } : {}) });

describe('slide reading order', () => {
  it('reads a diagram beside a tall text column top-to-bottom, not by x within one giant row', () => {
    // 左侧正文栏 100–500pt 高；右侧图示三个标签。按「较矮者」判同行时，三个标签都会并进正文那一行、
    // 只按 x 排，时序就乱了；按较高者判，它们各自成行。
    const nodes = [
      node('label-bottom', 1, [400, 420, 480, 440]),
      node('body', 2, [40, 100, 300, 500]),
      node('label-top', 3, [420, 150, 500, 170]),
      node('label-middle', 4, [380, 300, 460, 320]),
      node('notes', 5, undefined, 'speaker_note'),
    ];
    const page: DeckIrPage = { id: 'p', index: 1, nodeIds: nodes.map((item) => item.id), sourceRef: {} };
    orderSlideNodes(nodes, [page]);
    expect(page.nodeIds).toEqual(['body', 'label-top', 'label-middle', 'label-bottom', 'notes']);
    // 重排只在这页原本占用的 order 区间里换位。
    expect(nodes.map((item) => item.order).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('puts the body placeholder before loose diagram labels that start slightly higher', () => {
    const nodes = [
      node('legend', 1, [450, 90, 560, 110]),
      { ...node('body', 2, [40, 100, 400, 500]), extensions: { placeholder: { type: 'body', idx: '1' } } },
      node('diagram-label', 3, [450, 300, 520, 320]),
    ];
    const page: DeckIrPage = { id: 'p', index: 1, nodeIds: nodes.map((item) => item.id), sourceRef: {} };
    orderSlideNodes(nodes, [page]);
    expect(page.nodeIds).toEqual(['body', 'legend', 'diagram-label']);
  });

  it('keeps table rows and cells in structural order', () => {
    const table = { ...node('table', 1, [0, 0, 100, 100], 'table'), children: ['row-1', 'row-0'] };
    const rows = [
      { ...node('row-0', 2, [0, 50, 100, 100], 'table_row'), parentId: 'table' },
      { ...node('row-1', 3, [0, 0, 100, 50], 'table_row'), parentId: 'table' },
    ];
    const page: DeckIrPage = { id: 'p', index: 1, nodeIds: ['table', 'row-0', 'row-1'], sourceRef: {} };
    orderSlideNodes([table, ...rows], [page]);
    expect(table.children).toEqual(['row-0', 'row-1']);
  });
});

import { describe, expect, it } from 'vitest';
import { chartRows, formatChartValue } from '../../src/ir/chart-data.js';

describe('chart data as a table', () => {
  it('puts categories down the side and one column per series', () => {
    expect(chartRows({ kind: 'bar', categories: ['Q1', 'Q2'], series: [{ name: 'Sales', values: [8.2, 3.2] }, { values: [1, null] }] }))
      .toEqual([['', 'Sales', 'Series 2'], ['Q1', '8.2', '1'], ['Q2', '3.2', '']]);
  });

  it('numbers the rows when there are no categories and drops unused trailing points', () => {
    // 实测：环形图没有类别，缓存预留四个点位，只有两个有值。
    expect(chartRows({ kind: 'doughnut', categories: [], series: [{ values: [4000, 18000, null, null] }] }))
      .toEqual([['', 'Series 1'], ['1', '4000'], ['2', '18000']]);
  });

  it('formats percentages and strips floating-point noise', () => {
    expect(formatChartValue(0.25, '0%')).toBe('25%');
    expect(formatChartValue(0.1234, '0.0%')).toBe('12.3%');
    expect(formatChartValue(12, '#,##0"%"')).toBe('12');
    expect(formatChartValue(0.1 + 0.2, 'General')).toBe('0.3');
    expect(formatChartValue(null)).toBe('');
  });
});

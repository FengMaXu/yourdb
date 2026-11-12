import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const setOption = vi.fn();
vi.mock('echarts', () => ({
    init: vi.fn(() => ({ setOption, resize: vi.fn(), dispose: vi.fn(), on: vi.fn(), off: vi.fn() })),
}));
vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });

const { default: WidgetRenderer } = await import('./WidgetRenderer');

const chartSpec = {
    version: 1,
    data: { kind: 'publication', receiptId: 'publication_1' },
    fields: { sales: { type: 'quantitative', storage: 'raw', unit: '亿元', additivity: 'additive', label: '销售额' } },
    chart: { mark: 'cartesian', x: { field: 'industry' }, layers: [{ type: 'bar', y: { field: 'sales' } }] },
};

describe('Versioned widgets', () => {
    beforeEach(() => setOption.mockClear());

    it('compiles a Runtime-built ChartSpec widget and shows its notices and provenance', async () => {
        render(<WidgetRenderer widget={{
            widget_id: 'w1', kind: 'chart', title: '行业销售额', contractVersion: 2, chartSpec,
            dataset: { columns: ['industry', 'sales'], rows: [['批发业', '5234.00'], ['零售业', null]] },
            disclosure: '以下槽位为模型推断', declaredFields: ['sales'],
            semanticChecks: [{ code: 'RATIO_OUT_OF_RANGE', field: 'sales', message: '销售额 声明为比率，但数值范围为 [499.88, 5234.00]' }],
        }} />);
        // The chart widget loads lazily, with ECharts.
        await waitFor(() => expect(setOption).toHaveBeenCalledTimes(1));
        const option = setOption.mock.calls[0]![0] as { xAxis: { data: string[] }; series: { data: unknown[] }[] };
        expect(option.xAxis.data).toEqual(['批发业', '零售业']);
        expect(option.series[0]!.data).toEqual([5234, null]);
        expect(screen.getByText(/按空白显示，未按 0 绘制/)).toBeInTheDocument();
        expect(screen.getByText('以下槽位为模型推断')).toBeInTheDocument();
        expect(screen.getByText(/字段语义来自模型声明/)).toBeInTheDocument();
        expect(screen.getByText(/声明为比率，但数值范围为/)).toBeInTheDocument();
    });

    it('shows compiler errors instead of drawing an altered chart', async () => {
        render(<WidgetRenderer widget={{
            widget_id: 'w2', kind: 'chart', title: 'dup', contractVersion: 2, chartSpec,
            dataset: { columns: ['industry', 'sales'], rows: [['批发业', 1], ['批发业', 2]] },
        }} />);
        expect(await screen.findByRole('alert')).toHaveTextContent('DUPLICATE_KEY');
        expect(setOption).not.toHaveBeenCalled();
    });

    it('draws a chart without a ChartSpec from its data rows', () => {
        render(<WidgetRenderer widget={{ widget_id: 'w3', kind: 'chart', title: 'Sales', data: [{ label: 'North', value: 10 }] }} />);
        expect(screen.getByText('North')).toBeInTheDocument();
        expect(setOption).not.toHaveBeenCalled();
    });

    it('never draws a raw ECharts option, from a new event or an earlier session', () => {
        render(<WidgetRenderer widget={{
            widget_id: 'e1', kind: 'echarts', title: 'Raw', config: { xAxis: { data: ['a'] }, series: [{ type: 'bar', data: [1] }] },
        }} />);
        expect(screen.getByRole('note')).toHaveTextContent(/早期版本|earlier version/);
        expect(setOption).not.toHaveBeenCalled();
    });

    it('formats versioned tables only by declared semantics', () => {
        render(<WidgetRenderer widget={{
            widget_id: 't1', kind: 'table', title: 'T', contractVersion: 2,
            columns: [{ key: 'rate', label: '同比增速' }, { key: 'undeclared_rate', label: '占比' }, { key: 'code', label: '编码' }],
            data: [{ rate: 0.1234, undeclared_rate: 0.5, code: '007' }],
            fields: { rate: { type: 'quantitative', storage: 'ratio', additivity: 'non_additive' } },
        }} />);
        expect(screen.getByText('12.34%')).toBeInTheDocument();
        // A column named like a rate is not guessed to be one, and code text stays as written.
        expect(screen.getByText('0.5')).toBeInTheDocument();
        expect(screen.getByText('007')).toBeInTheDocument();
    });

    it('keeps the original inference for tables replayed from earlier sessions', () => {
        render(<WidgetRenderer widget={{
            widget_id: 't2', kind: 'table', title: 'T',
            columns: [{ key: 'undeclared_rate', label: '占比' }],
            data: [{ undeclared_rate: 0.5 }],
        }} />);
        expect(screen.getByText('50.00%')).toBeInTheDocument();
    });
});

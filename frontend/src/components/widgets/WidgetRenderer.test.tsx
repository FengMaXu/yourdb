import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import WidgetRenderer, { type WidgetSpec } from './WidgetRenderer';

describe('WidgetRenderer chart replay', () => {
    it('renders series points like data points after a widget replay', () => {
        const baseWidget: WidgetSpec = {
            widget_id: 'chart-1',
            kind: 'chart',
            title: 'Sales',
            data: [{ label: 'North', value: 10 }],
        };

        const { rerender } = render(<WidgetRenderer widget={baseWidget} />);
        expect(screen.getByText('North')).toBeInTheDocument();
        expect(screen.getByText('10')).toBeInTheDocument();

        rerender(
            <WidgetRenderer
                widget={{
                    ...baseWidget,
                    data: [],
                    series: [{ label: 'South', value: 25, mark: 'bar', metadata: { source: 'replay' } }],
                }}
            />,
        );

        expect(screen.getByText('South')).toBeInTheDocument();
        expect(screen.getByText('25')).toBeInTheDocument();
        expect(screen.queryByText('North')).not.toBeInTheDocument();
    });

    it('does not render ECharts label configuration objects as React children', () => {
        expect(() => render(
            <WidgetRenderer
                widget={{
                    widget_id: 'chart-echarts-series',
                    kind: 'chart',
                    title: 'Growth',
                    series: [{
                        name: '同比增速',
                        type: 'line',
                        data: [-23.34, 12.98],
                        label: { show: true, formatter: '{c}%', position: 'top' },
                    }],
                    xAxis: { type: 'category', data: ['批发业整体', '剔除比亚迪后'] },
                }}
            />,
        )).not.toThrow();
        expect(screen.getByText('同比增速 · 批发业整体')).toBeInTheDocument();
        expect(screen.getByText('-23.34')).toBeInTheDocument();
    });

    it('right-aligns numeric and percentage table columns while keeping text and code columns left-aligned', () => {
        render(
            <WidgetRenderer
                widget={{
                    widget_id: 'table-align',
                    kind: 'table',
                    title: '分行业明细',
                    contractVersion: 2,
                    columns: [
                        { key: 'industry', label: '行业' },
                        { key: 'code', label: '编码' },
                        { key: 'sales', label: '累计销售额（亿元）' },
                        { key: 'yoy', label: '同比增速' },
                    ],
                    data: [
                        { industry: '批发业', code: '007', sales: 6710.25, yoy: '-25.12%' },
                        { industry: '零售业', code: '008', sales: 499.88, yoy: '16.46%' },
                    ],
                }}
            />,
        );

        expect(screen.getByRole('columnheader', { name: '行业' })).toHaveClass('text-left');
        expect(screen.getByRole('columnheader', { name: '编码' })).toHaveClass('text-left');
        expect(screen.getByRole('columnheader', { name: '累计销售额（亿元）' })).toHaveClass('text-right', 'tabular-nums');
        expect(screen.getByRole('columnheader', { name: '同比增速' })).toHaveClass('text-right', 'tabular-nums');

        expect(screen.getByRole('cell', { name: '批发业' })).toHaveClass('text-left');
        expect(screen.getByRole('cell', { name: '007' })).toHaveClass('text-left');
        expect(screen.getByRole('cell', { name: '6,710.25' })).toHaveClass('text-right', 'tabular-nums');
        expect(screen.getByRole('cell', { name: '-25.12%' })).toHaveClass('text-right', 'tabular-nums');
    });

    it('sorts columns and collapses tables with more than 10 rows', () => {
        const rows = Array.from({ length: 12 }, (_, idx) => ({
            name: `公司 ${idx + 1}`,
            sales: (12 - idx) * 10,
        }));
        render(
            <WidgetRenderer
                widget={{
                    widget_id: 'table-sort-collapse',
                    kind: 'table',
                    title: '企业排行',
                    contractVersion: 2,
                    columns: [
                        { key: 'name', label: '企业' },
                        { key: 'sales', label: '销售额' },
                    ],
                    data: rows,
                }}
            />,
        );

        expect(screen.getByRole('button', { name: '复制表格' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '导出 CSV' })).toBeInTheDocument();
        expect(screen.queryByText('公司 11')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: '展开全部 12 行' }));
        expect(screen.getByText('公司 11')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: '销售额' }));
        const firstBodyRow = screen.getAllByRole('row')[1];
        expect(firstBodyRow).toHaveTextContent('公司 12');
    });
});

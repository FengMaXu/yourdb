import React, { useEffect, useMemo, useRef } from 'react';
import * as echarts from 'echarts';
import { compileChart, type ChartDataset, type PresentationNotice, type SemanticsCheck } from '@data-agent/charts';

export interface ChartSpecWidgetData {
    readonly chartSpec: unknown;
    readonly dataset: ChartDataset;
    readonly notices?: readonly PresentationNotice[];
    readonly disclosure?: string;
    readonly declaredFields?: readonly string[];
    /** Declared semantics the published result's profile makes doubtful. */
    readonly semanticChecks?: readonly SemanticsCheck[];
    /** Set when the rows are a derived dataset: what it was computed from. */
    readonly derivedFrom?: string;
}

/** ECharts measures its box when it mounts, so the size is set inline: it must hold wherever the widget renders, stylesheet or not. */
const CANVAS_SIZE = { width: '100%', height: 360 } as const;

/** Notes under a chart: provenance, disclosures and data checks (checks in amber). */
const NOTE = 'text-[12px] leading-[1.6] text-[#64748b]';
const CHECK = 'text-[12px] leading-[1.6] text-[#b45309]';

/**
 * A chat chart built by the Runtime: a ChartSpec plus the published rows it was
 * resolved against. It compiles in the browser for the interactive target, so
 * formatters and viewports work without any option crossing the wire.
 */
const ChartSpecWidget: React.FC<{ widget: ChartSpecWidgetData }> = ({ widget }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<echarts.ECharts | null>(null);
    const compiled = useMemo(() => compileChart(widget.chartSpec, widget.dataset, { target: 'interactive' }), [widget.chartSpec, widget.dataset]);

    useEffect(() => {
        if (!compiled.ok || !containerRef.current) return;
        chartRef.current ??= echarts.init(containerRef.current, null, { renderer: 'canvas' });
        chartRef.current.setOption(compiled.option, true);
    }, [compiled]);

    useEffect(() => {
        if (!containerRef.current) return;
        const observer = new ResizeObserver(() => chartRef.current?.resize());
        observer.observe(containerRef.current);
        return () => observer.disconnect();
    }, []);

    useEffect(() => () => {
        chartRef.current?.dispose();
        chartRef.current = null;
    }, []);

    if (!compiled.ok) {
        return (
            <div role="alert" className="text-[13px] text-[#b91c1c]">
                {compiled.errors.map((error, index) => <div key={index}>[{error.code}] {error.message}</div>)}
            </div>
        );
    }

    const notices = compiled.notices;
    const checks = widget.semanticChecks ?? [];
    return (
        <div>
            <div ref={containerRef} data-testid="chart-spec-canvas" style={CANVAS_SIZE} />
            {(notices.length > 0 || checks.length > 0 || widget.derivedFrom || widget.disclosure || (widget.declaredFields?.length ?? 0) > 0) && (
                <div className="mt-2 grid gap-0.5">
                    {/* The compiler keeps one notice per code and field, so the code alone is not unique. */}
                    {notices.map((notice) => <div key={`${notice.code}:${notice.field ?? ''}`} className={NOTE}>{notice.message}</div>)}
                    {checks.map((check) => <div key={`check:${check.code}:${check.field}`} className={CHECK}>{check.message}</div>)}
                    {widget.derivedFrom && <div className={NOTE}>{widget.derivedFrom}</div>}
                    {widget.disclosure && <div className={NOTE}>{widget.disclosure}</div>}
                    {(widget.declaredFields?.length ?? 0) > 0 && (
                        <div className={NOTE}>字段语义来自模型声明，未经业务定义核实：{widget.declaredFields!.join('、')}</div>
                    )}
                </div>
            )}
        </div>
    );
};

export default ChartSpecWidget;

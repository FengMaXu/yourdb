import React, { useEffect, useMemo, useRef } from 'react';
import * as echarts from 'echarts';
import { Download, Maximize2 } from 'lucide-react';
import { compileChart, type ChartDataset, type PresentationNotice, type SemanticsCheck } from '@data-agent/charts';
import BasisDisclosureFooter from '../common/BasisDisclosureFooter';
import { useLanguage } from '../../context/LanguageContext';
import { useOptionalPreview } from '../../context/PreviewContext';

export interface ChartSpecWidgetData {
    readonly title?: string;
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

/**
 * A chat chart built by the Runtime: a ChartSpec plus the published rows it was
 * resolved against. It compiles in the browser for the interactive target, so
 * formatters and viewports work without any option crossing the wire.
 */
const ChartSpecWidget: React.FC<{ widget: ChartSpecWidgetData }> = ({ widget }) => {
    const { t } = useLanguage();
    const preview = useOptionalPreview();
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
            <div role="alert" className="text-[13px] text-destructive">
                {compiled.errors.map((error, index) => <div key={index}>[{error.code}] {error.message}</div>)}
            </div>
        );
    }

    const exportPngDataUrl = () => {
        if (!chartRef.current) return null;
        const backgroundColor = typeof document !== 'undefined'
            ? getComputedStyle(document.documentElement).getPropertyValue('--background').trim() || undefined
            : undefined;
        return chartRef.current.getDataURL({
            type: 'png',
            pixelRatio: 2,
            ...(backgroundColor ? { backgroundColor } : {}),
        });
    };

    const handlePreviewImage = () => {
        if (!preview) return;
        const dataUrl = exportPngDataUrl();
        if (!dataUrl) return;
        preview.openPreview(dataUrl, widget.title || 'chart.png', 'png');
    };

    const handleDownloadImage = () => {
        const dataUrl = exportPngDataUrl();
        if (!dataUrl) return;
        const link = document.createElement('a');
        link.href = dataUrl;
        link.download = `${(widget.title || 'chart').replace(/[\\/:*?"<>|]/g, '_')}.png`;
        document.body.appendChild(link);
        link.click();
        link.remove();
    };

    const notices = compiled.notices;
    const checks = widget.semanticChecks ?? [];
    return (
        <div>
            <div className="mb-1 flex items-center justify-end gap-1.5">
                {preview && (
                    <button
                        type="button"
                        onClick={handlePreviewImage}
                        className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-paper px-2 py-1 text-[11.5px] font-medium text-body transition-colors hover:border-border-strong hover:bg-white hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand motion-reduce:transition-none"
                        aria-label={t('widgets.fullscreen')}
                        title={t('widgets.fullscreen')}
                    >
                        <Maximize2 className="size-3" aria-hidden="true" />
                        <span>{t('widgets.fullscreen')}</span>
                    </button>
                )}
                <button
                    type="button"
                    onClick={handleDownloadImage}
                    className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-paper px-2 py-1 text-[11.5px] font-medium text-body transition-colors hover:border-border-strong hover:bg-white hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand motion-reduce:transition-none"
                    aria-label={t('widgets.downloadImage')}
                    title={t('widgets.downloadImage')}
                >
                    <Download className="size-3" aria-hidden="true" />
                    <span>{t('widgets.downloadImage')}</span>
                </button>
            </div>
            <div ref={containerRef} data-testid="chart-spec-canvas" style={CANVAS_SIZE} />
            {(notices.length > 0 || checks.length > 0 || widget.derivedFrom || widget.disclosure || (widget.declaredFields?.length ?? 0) > 0) && (
                <BasisDisclosureFooter
                    basis={widget.derivedFrom}
                    notices={notices}
                    checks={checks}
                    disclosure={widget.disclosure}
                    declaredFields={widget.declaredFields}
                    verified={!widget.disclosure && !(widget.declaredFields?.length)}
                />
            )}
        </div>
    );
};

export default ChartSpecWidget;

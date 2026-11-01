import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ExternalLink, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NARROW_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import { useLanguage } from '../../context/LanguageContext';
import { usePreview } from '../../context/PreviewContext';
import { resolveWorkspaceAssetUrl } from '../../utils/resolveInternalUrl';

import { refreshDashboardViaRuntime } from '../../api/runtime-client';
import { dashboardBridgeTarget, handleDashboardMessage } from './dashboardBridge';

const SUPPORTED_MESSAGE_TYPES = new Set(['drill_down', 'navigate_back']);
const MARKDOWN_TYPES = new Set(['md', 'markdown']);
const CSV_TYPES = new Set(['csv']);
const TEXT_TYPES = new Set(['json', 'txt', 'log']);
const IMAGE_TYPES = new Set(['gif', 'jpeg', 'jpg', 'png', 'svg', 'webp']);
const BASE_IFRAME_WIDTH = 1440;
const MIN_MODAL_WIDTH = 520;
const MIN_MODAL_HEIGHT = 360;

interface PreviewRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const initialPreviewRect = (): PreviewRect => {
    const width = clamp(Math.round(window.innerWidth * 0.78), MIN_MODAL_WIDTH, window.innerWidth - 32);
    const height = clamp(Math.round(window.innerHeight * 0.88), MIN_MODAL_HEIGHT, window.innerHeight - 32);
    return {
        left: Math.round((window.innerWidth - width) / 2),
        top: Math.round((window.innerHeight - height) / 2),
        width,
        height,
    };
};

function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let quoted = false;

    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        const next = text[index + 1];
        if (character === '"' && quoted && next === '"') {
            cell += '"';
            index += 1;
        } else if (character === '"') {
            quoted = !quoted;
        } else if (character === ',' && !quoted) {
            row.push(cell);
            cell = '';
        } else if ((character === '\n' || character === '\r') && !quoted) {
            if (character === '\r' && next === '\n') index += 1;
            row.push(cell);
            if (row.some((item) => item.length > 0)) rows.push(row);
            row = [];
            cell = '';
        } else {
            cell += character;
        }
    }
    if (cell || row.length > 0) {
        row.push(cell);
        if (row.some((item) => item.length > 0)) rows.push(row);
    }
    return rows;
}

function rewriteHtmlAssets(html: string, sourceUrl: string): string {
    if (typeof DOMParser === 'undefined') return html;
    const document = new DOMParser().parseFromString(html, 'text/html');
    document.querySelectorAll<HTMLElement>('[src], [href]').forEach((element) => {
        for (const attribute of ['src', 'href']) {
            const value = element.getAttribute(attribute);
            if (!value || value.startsWith('#') || /^(data|blob|https?:|mailto|tel|javascript):/i.test(value)) continue;
            element.setAttribute(attribute, resolveWorkspaceAssetUrl(value, sourceUrl));
        }
    });
    document.querySelector('base')?.remove();

    const navigationGuard = document.createElement('script');
    navigationGuard.textContent = [
        'document.addEventListener("click", (event) => {',
        '    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;',
        '    const href = link?.getAttribute("href") || "";',
        '    if (!href.startsWith("#")) return;',
        '    event.preventDefault();',
        '    event.stopPropagation();',
        '    document.getElementById(href.slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" });',
        '});',
    ].join("\n");
    document.body.appendChild(navigationGuard);
    return `<!doctype html>${document.documentElement.outerHTML}`;
}
/** A white page inside the preview body, for Markdown, CSV and text. */
const SHEET = 'box-border min-h-full bg-white px-8 pt-7 pb-12';
/** Bordered table cells with a tinted header row. */
const CELLS = '[&_td]:border [&_td]:border-[#e5e7eb] [&_td]:px-[11px] [&_td]:py-[9px] [&_td]:text-left [&_td]:align-top [&_th]:border [&_th]:border-[#e5e7eb] [&_th]:bg-[#f8fafc] [&_th]:px-[11px] [&_th]:py-[9px] [&_th]:text-left [&_th]:align-top [&_th]:font-bold [&_th]:text-[#334155]';

const GlobalPreviewModal: React.FC = () => {
    const { isOpen, url, title, fileType, closePreview, emitPreviewMessage } = usePreview();
    const { t } = useLanguage();
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ mode: 'move' | 'resize'; startX: number; startY: number; rect: PreviewRect } | null>(null);
    const [rect, setRect] = useState<PreviewRect>(() => ({ left: 56, top: 42, width: 980, height: 720 }));
    const [bodySize, setBodySize] = useState({ width: 0, height: 0 });
    const [fileContent, setFileContent] = useState('');
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState('');
    // While the window is dragged or resized, a full-screen layer carries the cursor and keeps the iframe from taking the pointer.
    const [interaction, setInteraction] = useState<'move' | 'resize' | null>(null);
    // A narrow window shows the preview full screen, ignoring the dragged position and size.
    const narrow = useMediaQuery(NARROW_QUERY);

    const normalizedType = fileType.toLowerCase();
    const isHtml = normalizedType === 'html' || normalizedType === 'htm';
    const isMarkdown = MARKDOWN_TYPES.has(normalizedType);
    const isCsv = CSV_TYPES.has(normalizedType);
    const isText = TEXT_TYPES.has(normalizedType);
    const isImage = IMAGE_TYPES.has(normalizedType);
    const needsTextFetch = isHtml || isMarkdown || isCsv || isText;

    useEffect(() => {
        if (!isOpen) return;
        setRect(initialPreviewRect());
    }, [isOpen, url]);

    useEffect(() => {
        if (!isOpen || !url || !needsTextFetch) {
            setFileContent('');
            setLoadError('');
            setLoading(false);
            return undefined;
        }

        const controller = new AbortController();
        setLoading(true);
        setLoadError('');
        fetch(url, { signal: controller.signal })
            .then(async (response) => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() || '';
                // A missing preview route commonly falls through to the SPA and
                // returns index.html. Never feed that HTML shell to a CSV,
                // Markdown, JSON, or text renderer based only on the filename.
                if (!isHtml && contentType === 'text/html') throw new Error('PREVIEW_CONTENT_TYPE_MISMATCH');
                return response.text();
            })
            .then((text) => setFileContent(text))
            .catch((error: unknown) => {
                if (!(error instanceof DOMException && error.name === 'AbortError')) setLoadError(t('preview.loadError'));
            })
            .finally(() => setLoading(false));
        return () => controller.abort();
    }, [isOpen, needsTextFetch, t, url]);

    // A live dashboard the app generated can ask for a refresh; its nonce ties the page to this file.
    const dashboardTarget = useMemo(() => (isHtml && url && fileContent ? dashboardBridgeTarget(fileContent, url) : null), [fileContent, isHtml, url]);

    useEffect(() => {
        if (!isOpen || !url) return undefined;
        const handleMessage = (event: MessageEvent) => {
            const frame = iframeRef.current?.contentWindow;
            if (!frame || event.source !== frame) return;
            const data = event.data;
            if (!data || typeof data !== 'object') return;
            if (dashboardTarget && typeof data.kind === 'string' && data.kind.startsWith('dashboard.')) {
                void handleDashboardMessage(dashboardTarget, data, (message) => frame.postMessage(message, '*'), refreshDashboardViaRuntime);
                return;
            }
            if (SUPPORTED_MESSAGE_TYPES.has(data.type)) {
                emitPreviewMessage(data);
            }
        };
        window.addEventListener('message', handleMessage);
        return () => {
            window.removeEventListener('message', handleMessage);
        };
    }, [dashboardTarget, emitPreviewMessage, isOpen, url]);
    useEffect(() => {
        if (!isOpen) return undefined;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') closePreview();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [closePreview, isOpen]);

    useEffect(() => {
        if (!isOpen || !bodyRef.current) return undefined;
        const observer = new ResizeObserver(([entry]) => {
            if (entry) setBodySize({ width: entry.contentRect.width, height: entry.contentRect.height });
        });
        observer.observe(bodyRef.current);
        return () => observer.disconnect();
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return undefined;
        const handleWindowResize = () => setRect((current) => {
            const width = Math.min(current.width, Math.max(MIN_MODAL_WIDTH, window.innerWidth - 16));
            const height = Math.min(current.height, Math.max(MIN_MODAL_HEIGHT, window.innerHeight - 16));
            return {
                width,
                height,
                left: clamp(current.left, 8, window.innerWidth - width - 8),
                top: clamp(current.top, 8, window.innerHeight - height - 8),
            };
        });
        window.addEventListener('resize', handleWindowResize);
        return () => window.removeEventListener('resize', handleWindowResize);
    }, [isOpen]);

    const handleOpenExternal = () => {
        if (url) window.open(url, '_blank', 'noopener,noreferrer');
    };

    const handlePointerMove = useCallback((event: PointerEvent) => {
        const dragState = dragRef.current;
        if (!dragState) return;
        const deltaX = event.clientX - dragState.startX;
        const deltaY = event.clientY - dragState.startY;
        if (dragState.mode === 'move') {
            setRect({
                ...dragState.rect,
                left: clamp(dragState.rect.left + deltaX, 8, window.innerWidth - dragState.rect.width - 8),
                top: clamp(dragState.rect.top + deltaY, 8, window.innerHeight - dragState.rect.height - 8),
            });
            return;
        }
        setRect({
            ...dragState.rect,
            width: clamp(dragState.rect.width + deltaX, MIN_MODAL_WIDTH, window.innerWidth - dragState.rect.left - 8),
            height: clamp(dragState.rect.height + deltaY, MIN_MODAL_HEIGHT, window.innerHeight - dragState.rect.top - 8),
        });
    }, []);

    const stopPointerInteraction = useCallback(() => {
        dragRef.current = null;
        setInteraction(null);
        window.removeEventListener('pointermove', handlePointerMove);
    }, [handlePointerMove]);

    const startPointerInteraction = (mode: 'move' | 'resize', event: React.PointerEvent<HTMLElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        dragRef.current = { mode, startX: event.clientX, startY: event.clientY, rect };
        setInteraction(mode);
        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerup', stopPointerInteraction, { once: true });
        window.addEventListener('pointercancel', stopPointerInteraction, { once: true });
    };

    const handleResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        setRect((current) => {
            const maxWidth = Math.max(MIN_MODAL_WIDTH, window.innerWidth - current.left - 8);
            const maxHeight = Math.max(MIN_MODAL_HEIGHT, window.innerHeight - current.top - 8);
            if (event.key === 'Home') {
                return { ...current, width: MIN_MODAL_WIDTH, height: MIN_MODAL_HEIGHT };
            }
            if (event.key === 'End') {
                return { ...current, width: maxWidth, height: maxHeight };
            }
            const step = event.shiftKey ? 100 : 40;
            const widthDelta = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0;
            const heightDelta = event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0;
            return {
                ...current,
                width: clamp(current.width + widthDelta, MIN_MODAL_WIDTH, maxWidth),
                height: clamp(current.height + heightDelta, MIN_MODAL_HEIGHT, maxHeight),
            };
        });
    };

    const htmlContent = useMemo(() => (url ? rewriteHtmlAssets(fileContent, url) : ''), [fileContent, url]);
    const iframeScale = bodySize.width > 0 ? Math.min(1, bodySize.width / BASE_IFRAME_WIDTH) : 1;
    const iframeWidth = iframeScale < 1 ? BASE_IFRAME_WIDTH : Math.max(bodySize.width, BASE_IFRAME_WIDTH);
    const iframeHeight = bodySize.height > 0 ? bodySize.height / iframeScale : rect.height;

    const renderCsv = () => {
        const rows = parseCsv(fileContent);
        const headers = rows[0] || [];
        return (
            <div className={cn(SHEET, 'overflow-auto')}>
                <table className={cn(CELLS, 'w-full min-w-[640px] border-collapse bg-white text-[13px]')}>
                    <thead><tr>{headers.map((header, index) => <th key={index}>{header || t('preview.csvColumn').replace('{number}', String(index + 1))}</th>)}</tr></thead>
                    <tbody>{rows.slice(1, 201).map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, columnIndex) => <td key={columnIndex}>{row[columnIndex] || ''}</td>)}</tr>)}</tbody>
                </table>
                {rows.length > 201 && <div className="pt-3 text-xs text-[#64748b]">{t('preview.csvLimit')}</div>}
            </div>
        );
    };

    const renderMarkdown = () => (
        <article className={cn(SHEET, CELLS, 'mx-auto max-w-[1000px] leading-[1.72] text-[#1f2937] [&_img]:mx-auto [&_img]:my-[18px] [&_img]:block [&_img]:h-auto [&_img]:max-w-full [&_img]:rounded-md [&_img]:border [&_img]:border-[#e5e7eb] [&_table]:w-full [&_table]:border-collapse [&_table]:text-[13px]')}>
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                    img: ({ src, alt, ...props }) => <img src={resolveWorkspaceAssetUrl(src, url || undefined)} alt={alt || ''} loading="lazy" {...props} />,
                    a: ({ href, children, ...props }) => <a href={resolveWorkspaceAssetUrl(href, url || undefined)} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>,
                }}
            >
                {fileContent}
            </ReactMarkdown>
        </article>
    );

    if (!isOpen || !url) return null;

    const ICON_BUTTON = 'inline-flex size-[34px] items-center justify-center rounded-lg border border-transparent bg-transparent text-[#475569] transition-[background-color,border-color,color,transform] hover:border-[var(--border-light)] hover:bg-white hover:text-[#111827] active:scale-[0.96]';
    const STATE = 'grid min-h-full place-items-center p-7 text-center text-[0.92rem] text-[var(--text-secondary)]';
    const ready = !loading && !loadError;

    return (
        <div className="pointer-events-none fixed inset-0 z-[2200] p-0 min-[721px]:p-6" role="dialog" aria-modal="false" aria-label={title || t('preview.title')}>
            <section
                className="pointer-events-auto fixed inset-0 flex h-screen w-screen animate-rise-sm [animation-duration:220ms] flex-col overflow-hidden rounded-none border border-white/72 bg-white shadow-[0_34px_90px_-42px_rgba(17,24,39,0.78)] motion-reduce:animate-none min-[721px]:inset-auto min-[721px]:h-auto min-[721px]:min-h-[420px] min-[721px]:w-auto min-[721px]:rounded-[10px]"
                style={narrow ? undefined : { width: rect.width, height: rect.height, left: rect.left, top: rect.top }}
            >
                <header
                    className="flex min-h-14 cursor-move touch-none items-center justify-between gap-4 border-b border-[var(--border-light)] bg-[#f8fafc] py-2.5 pr-2.5 pl-3.5 select-none min-[721px]:min-h-[58px] min-[721px]:py-3 min-[721px]:pr-3.5 min-[721px]:pl-[18px]"
                    onPointerDown={(event) => startPointerInteraction('move', event)}
                >
                    <div className="flex min-w-0 flex-col gap-1">
                        <div className="max-w-[calc(100vw-172px)] truncate text-[0.98rem] font-extrabold text-[#111827] min-[721px]:max-w-[62vw]">{title || t('preview.title')}</div>
                        <div className="text-[0.78rem] font-bold text-[#64748b] uppercase">{normalizedType || t('preview.file')}</div>
                    </div>
                    <div className="flex flex-none cursor-default items-center gap-1.5" onPointerDown={(event) => event.stopPropagation()}>
                        <button type="button" className={ICON_BUTTON} onClick={handleOpenExternal} aria-label={t('preview.openExternal')} title={t('preview.openExternal')}><ExternalLink className="size-[18px]" /></button>
                        <button type="button" className={ICON_BUTTON} onClick={closePreview} aria-label={t('preview.close')} title={t('preview.close')}><X className="size-[19px]" strokeWidth={2} /></button>
                    </div>
                </header>
                <div ref={bodyRef} className={cn('relative min-h-0 flex-1 overflow-auto bg-[#eef2f7]', isImage && 'grid place-items-center p-6')}>
                    {loading && <div className={STATE} role="status">{t('preview.loading')}</div>}
                    {!loading && loadError && <div className={cn(STATE, 'text-[#b91c1c]')} role="alert" aria-live="assertive">{loadError}</div>}
                    {ready && isImage && <img className="block max-h-full max-w-full bg-white object-contain shadow-[0_12px_30px_-24px_rgba(15,23,42,0.72)]" src={url} alt={title || t('preview.file')} />}
                    {ready && isHtml && (
                        <div className="absolute top-0 left-0 origin-top-left" style={{ width: iframeWidth, height: iframeHeight, transform: `scale(${iframeScale})` }}>
                            <iframe ref={iframeRef} srcDoc={htmlContent} title={title || t('preview.title')} className="block border-0 bg-white" sandbox="allow-scripts allow-downloads allow-forms allow-popups" style={{ width: iframeWidth, height: iframeHeight }} />
                        </div>
                    )}
                    {ready && isMarkdown && renderMarkdown()}
                    {ready && isCsv && renderCsv()}
                    {ready && isText && <pre className={cn(SHEET, 'm-0 overflow-auto font-mono text-[13px] leading-[1.65] break-words whitespace-pre-wrap text-[#334155]')}>{fileContent}</pre>}
                    {ready && !isImage && !isHtml && !isMarkdown && !isCsv && !isText && <div className={STATE} role="status">{t('preview.unsupported')}</div>}
                </div>
                {!narrow && (
                    <div
                        className="absolute right-0 bottom-0 size-[22px] cursor-nwse-resize touch-none after:absolute after:right-1.5 after:bottom-1.5 after:size-2.5 after:border-r-2 after:border-b-2 after:border-[rgba(71,85,105,0.52)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-strong)]"
                        role="button"
                        tabIndex={0}
                        aria-label={t('preview.resize')}
                        title={t('preview.resize')}
                        aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Home End"
                        onPointerDown={(event) => startPointerInteraction('resize', event)}
                        onKeyDown={handleResizeKeyDown}
                    />
                )}
            </section>
            {interaction && <div className={cn('pointer-events-auto fixed inset-0 select-none', interaction === 'move' ? 'cursor-grabbing' : 'cursor-nwse-resize')} aria-hidden="true" />}
        </div>
    );
};

export default GlobalPreviewModal;
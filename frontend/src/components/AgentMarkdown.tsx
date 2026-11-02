/**
 * Shared Markdown renderer for chat output and file previews.
 *
 * Workspace links keep their download behavior, while previewable files expose
 * an inline preview action. Relative workspace assets are resolved against the
 * active session so generated report images render as compact preview triggers in chat.
 */

import { FILE_ACTION_BUTTON, FILE_ACTIONS } from './file-actions';
import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Download, Eye } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { usePreview } from '../context/PreviewContext';
import {
    isInternalApiPath,
    isWorkspaceRelativePath,
    workspaceLinkPath,
    resolveWorkspaceAssetUrl,
    resolveWorkspaceDownloadUrl,
    resolveWorkspacePreviewUrl,
} from '../utils/resolveInternalUrl';

const PREVIEWABLE_FILE_TYPES = new Set([
    'csv', 'gif', 'htm', 'html', 'jpeg', 'jpg', 'json', 'md', 'markdown', 'png', 'svg', 'txt', 'webp',
]);

const PUBLICATION_PATH = /\/api\/runtime\/publications\/([^/?#]+)/;

/** Publications are always served as CSV, but their URL carries no extension. */
function getPublicationFileName(href: string | undefined): string {
    const match = href?.match(PUBLICATION_PATH);
    return match ? `${decodeURIComponent(match[1])}.csv` : '';
}

function getWorkspaceDownloadPath(href: string | undefined): string {
    if (!href) return '';
    try {
        const url = new URL(href, 'http://data-agent.local');
        if (!url.pathname.endsWith('/workspace/files/download')) return '';
        return url.searchParams.get('path') || '';
    } catch {
        return '';
    }
}

function getFileTypeFromPath(path: string): string {
    const fileName = path.split(/[\\/]/).pop() || '';
    return (fileName.split('.').pop() || '').toLowerCase();
}

function getFileTitle(path: string, fallback: React.ReactNode): string {
    const fileName = path.split(/[\\/]/).pop();
    if (fileName) return fileName;
    return typeof fallback === 'string' ? fallback : 'preview';
}

function getImagePreviewTitle(src: string | undefined, alt: string | undefined): string {
    if (alt?.trim()) return alt.trim();
    const sourceName = src?.split(/[\\/?#]/).pop() || '';
    return sourceName || 'image';
}

function getImagePreviewType(src: string | undefined): string {
    const sourceName = src?.split(/[\\/?#]/).pop() || '';
    return sourceName.split('.').pop()?.toLowerCase() || 'png';
}

function renderFileActions(
    href: string,
    children: React.ReactNode,
    currentSessionId: string | undefined,
    openPreview: ((url: string, title: string, fileType: string) => void) | undefined,
    t: ((key: string) => string) | undefined,
    linkProps: React.AnchorHTMLAttributes<HTMLAnchorElement> = {},
): React.ReactElement {
    const resolved = resolveWorkspaceDownloadUrl(href, currentSessionId);
    const previewUrl = resolveWorkspacePreviewUrl(href, currentSessionId);
    const filePath = getPublicationFileName(href) || getWorkspaceDownloadPath(resolved) || href;
    const fileType = getFileTypeFromPath(filePath);
    const canPreview = PREVIEWABLE_FILE_TYPES.has(fileType);
    const title = getFileTitle(filePath, children);
    const previewLabel = t?.('widgets.preview') || '查看';
    const downloadLabel = t?.('widgets.download') || '下载';
    const triggerDownload = (event: React.MouseEvent<HTMLElement>) => {
        event.preventDefault();
        const link = document.createElement('a');
        link.href = resolved;
        link.download = title;
        document.body.appendChild(link);
        link.click();
        link.remove();
    };

    return (
        <span className="mt-1 inline-flex max-w-full flex-wrap items-center gap-2 align-top">
            <a
                href={resolved}
                download={title}
                className="max-w-[min(100%,560px)] min-w-0 truncate font-semibold text-[#2563eb] underline decoration-[#bfdbfe] underline-offset-2 hover:text-[#1d4ed8] hover:decoration-current focus-visible:text-[#1d4ed8] focus-visible:decoration-current focus-visible:outline-none"
                {...linkProps}
            >
                {children}
            </a>
            <span className={FILE_ACTIONS}>
                {canPreview && openPreview && previewUrl && (
                    <button
                        type="button"
                        className={FILE_ACTION_BUTTON}
                        onClick={(event) => {
                            event.preventDefault();
                            openPreview(previewUrl, title, fileType);
                        }}
                        title={previewLabel}
                        aria-label={previewLabel}
                    >
                        <Eye size={15} strokeWidth={2} />
                    </button>
                )}
                <button
                    type="button"
                    className={FILE_ACTION_BUTTON}
                    onClick={triggerDownload}
                    title={downloadLabel}
                    aria-label={downloadLabel}
                >
                    <Download size={15} strokeWidth={2} />
                </button>
            </span>
        </span>
    );
}

export const createMarkdownComponents = (
    currentSessionId?: string,
    openPreview?: (url: string, title: string, fileType: string) => void,
    t?: (key: string) => string,
): React.ComponentProps<typeof ReactMarkdown>['components'] => ({
    img: ({ src, alt, ...props }) => {
        const resolvedSrc = resolveWorkspaceAssetUrl(src, undefined, currentSessionId);
        const title = getImagePreviewTitle(src, alt);
        const fileType = getImagePreviewType(src);
        const image = <img src={resolvedSrc} alt={alt || title} loading="lazy" {...props} />;

        if (!openPreview || !resolvedSrc) {
            return <span className="relative my-2.5 inline-flex max-h-80 max-w-[min(100%,720px)] overflow-hidden align-top [&_img]:block [&_img]:h-auto [&_img]:max-h-80 [&_img]:w-auto [&_img]:max-w-full [&_img]:object-contain">{image}</span>;
        }

        return (
            <button
                type="button"
                className="group/image relative my-2.5 inline-flex max-h-80 max-w-[min(100%,720px)] cursor-zoom-in overflow-hidden rounded-lg border border-[#dbe3ec] bg-[#f8fafc] p-0 text-left align-top [font:inherit] transition-[border-color,box-shadow] hover:border-[#94a3b8] hover:shadow-[0_8px_22px_-18px_rgba(15,23,42,0.85)] focus-visible:border-[#94a3b8] focus-visible:shadow-[0_8px_22px_-18px_rgba(15,23,42,0.85)] focus-visible:outline-none [&_img]:block [&_img]:h-auto [&_img]:max-h-80 [&_img]:w-auto [&_img]:max-w-full [&_img]:object-contain"
                onClick={(event) => {
                    event.stopPropagation();
                    openPreview(resolvedSrc, title, fileType);
                }}
                aria-label={title}
                title={title}
            >
                {image}
                <span className="absolute right-2 bottom-2 inline-flex size-[30px] translate-y-[3px] items-center justify-center rounded-full bg-[rgba(15,23,42,0.78)] text-white opacity-0 transition-[opacity,transform] group-hover/image:translate-y-0 group-hover/image:opacity-100 group-focus-visible/image:translate-y-0 group-focus-visible/image:opacity-100" aria-hidden="true">
                    <Eye size={16} strokeWidth={2} />
                </span>
            </button>
        );
    },
    a: ({ href, children, ...props }) => {
        const isWorkspaceLink = isInternalApiPath(href) || workspaceLinkPath(href) !== undefined;
        if (!href || !isWorkspaceLink) {
            return (
                <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                    {children}
                </a>
            );
        }

        return renderFileActions(href, children, currentSessionId, openPreview, t, props);
    },
    code: ({ className, children, node: _node, ...props }) => {
        // Agents often name a produced file as inline code (`dashboards/x.html`) rather than a link;
        // give those the same preview and download actions.
        const text = typeof children === 'string' ? children.trim() : '';
        const isInlinePath = !className && text && !text.includes('\n') && isWorkspaceRelativePath(text);
        if (isInlinePath && PREVIEWABLE_FILE_TYPES.has(getFileTypeFromPath(text))) {
            return renderFileActions(text, <code>{text}</code>, currentSessionId, openPreview, t);
        }
        return <code className={className} {...props}>{children}</code>;
    },
});

interface AgentMarkdownProps {
    children: string;
    currentSessionId?: string;
}

const AgentMarkdown: React.FC<AgentMarkdownProps> = ({ children, currentSessionId }) => {
    const { openPreview } = usePreview();
    const { t } = useLanguage();
    const components = React.useMemo(
        () => createMarkdownComponents(currentSessionId, openPreview, t),
        [currentSessionId, openPreview, t],
    );

    return (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
            {children}
        </ReactMarkdown>
    );
};

export default AgentMarkdown;
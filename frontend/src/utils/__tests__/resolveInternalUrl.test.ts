import { describe, expect, it } from 'vitest';
import {
    isWorkspaceRelativePath,
    workspaceLinkPath,
    resolveInternalUrl,
    resolveWorkspaceAssetUrl,
    resolveWorkspaceDownloadUrl,
    resolveWorkspacePreviewUrl,
} from '../resolveInternalUrl';

describe('workspace markdown link resolution', () => {
    it('recognizes session-relative workspace assets', () => {
        expect(isWorkspaceRelativePath('data/industry_sales_2026_h1.csv')).toBe(true);
        expect(isWorkspaceRelativePath('./data/industry_sales_2026_h1.csv')).toBe(true);
        expect(isWorkspaceRelativePath('reports/summary.html')).toBe(true);
        expect(isWorkspaceRelativePath('https://example.com/result.csv')).toBe(false);
        expect(isWorkspaceRelativePath('/data/result.csv')).toBe(false);
    });

    it('takes every way an agent links a workspace file as a workspace link', () => {
        expect(workspaceLinkPath('reports/summary.md')).toBe('reports/summary.md');
        expect(workspaceLinkPath('charts/trend.svg')).toBe('charts/trend.svg');
        // A report written at the session root, and a link with a leading slash.
        expect(workspaceLinkPath('olist_2018H1_business_report.md')).toBe('olist_2018H1_business_report.md');
        expect(workspaceLinkPath('/dashboards/sales.html')).toBe('dashboards/sales.html');
        expect(workspaceLinkPath('/olist_2018H1_business_report.md')).toBe('olist_2018H1_business_report.md');
        // Not workspace files: web links (also without a scheme), paths out of the session,
        // anchors, app routes, API paths, version-like or bare words.
        for (const href of [
            'https://example.com/a.csv', 'www.baidu.com', 'docs.python.org', 'example.com/page.html', '1.2',
            '../other.md', '../session-2/reports/x.md', 'reports/../../x.md',
            '#top', '//cdn.example.com/x.js', '/app/settings', '/api/runtime/publications/p1', 'mailto:a@b.c', 'notes',
        ]) {
            expect(workspaceLinkPath(href)).toBeUndefined();
        }
    });

    it('resolves a report linked at the session root and a dashboard linked with a leading slash', () => {
        const report = new URL(resolveWorkspacePreviewUrl('olist_2018H1_business_report.md', 'session-123'));
        expect(report.pathname).toBe('/api/workspace/download');
        expect(report.searchParams.get('path')).toBe('session-123/olist_2018H1_business_report.md');
        const dashboard = new URL(resolveWorkspaceDownloadUrl('/dashboards/sales.html', 'session-123'));
        expect(dashboard.searchParams.get('path')).toBe('session-123/dashboards/sales.html');
    });

    it('resolves the charts a report in reports/ links as ../charts/, and an image with a leading slash', () => {
        const source = '/workspace/files/preview?path=session-123%2Freports%2Folist.md';
        const fromReport = new URL(resolveWorkspaceAssetUrl('../charts/trend.svg', source, 'session-123'));
        expect(fromReport.searchParams.get('path')).toBe('session-123/charts/trend.svg');
        // A chart next to a dashboard in a subfolder still resolves next to it.
        const nextToIt = new URL(resolveWorkspaceAssetUrl('charts/a.svg', '/workspace/files/preview?path=session-123%2Fdashboards%2Fsales.html', 'session-123'));
        expect(nextToIt.searchParams.get('path')).toBe('session-123/dashboards/charts/a.svg');
        const rooted = new URL(resolveWorkspaceAssetUrl('/charts/trend.svg', undefined, 'session-123'));
        expect(rooted.searchParams.get('path')).toBe('session-123/charts/trend.svg');
    });

    it('converts a relative CSV link to the authenticated download endpoint', () => {
        const url = new URL(resolveWorkspaceDownloadUrl('data/industry_sales_2026_h1.csv', 'session-123'));
        expect(url.pathname).toBe('/api/workspace/download');
        expect(url.searchParams.get('path')).toBe('session-123/data/industry_sales_2026_h1.csv');
    });

    it('converts an internal preview path to the real web file endpoint', () => {
        const url = new URL(resolveWorkspacePreviewUrl('/workspace/files/preview?path=session-123%2Fdata%2Fresult.csv', 'session-123'));
        expect(url.pathname).toBe('/api/workspace/download');
        expect(url.searchParams.get('path')).toBe('session-123/data/result.csv');
    });

    it('converts a relative asset to the authenticated preview endpoint', () => {
        const url = new URL(resolveWorkspacePreviewUrl('data/industry_sales_2026_h1.csv', 'session-123'));
        expect(url.pathname).toBe('/api/workspace/download');
        expect(url.searchParams.get('path')).toBe('session-123/data/industry_sales_2026_h1.csv');
    });

    it('resolves a bare generated image inside the active session workspace', () => {
        const url = new URL(resolveWorkspaceAssetUrl('chart1_trend.png', undefined, 'session-123'));
        expect(url.searchParams.get('path')).toBe('session-123/chart1_trend.png');
    });

    it('does not double-encode a non-ASCII asset name already percent-encoded by markdown', () => {
        const encoded = `charts/${encodeURIComponent('待纳统企业街道分布')}.svg`;
        const url = new URL(resolveWorkspaceAssetUrl(encoded, undefined, 'session-123'));
        expect(url.searchParams.get('path')).toBe('session-123/charts/待纳统企业街道分布.svg');
    });

    it('routes Receipt-authorized publications through the Electron application protocol', () => {
        window.dataAgentRuntime = { invokeRuntimeCommand: async () => ({}), subscribeRuntimeEvents: () => () => undefined };
        try {
            const url = new URL(resolveInternalUrl('/api/runtime/publications/publication-1?session_id=session-123'));
            expect(url.protocol).toBe('data-agent:');
            expect(url.hostname).toBe('publication');
            expect(url.pathname).toBe('/runtime/publications/publication-1');
            expect(url.searchParams.get('session_id')).toBe('session-123');
        } finally {
            delete window.dataAgentRuntime;
        }
    });

    it('uses the Electron workspace protocol instead of file:// HTTP paths', () => {
        window.dataAgentRuntime = { invokeRuntimeCommand: async () => ({}), subscribeRuntimeEvents: () => () => undefined };
        try {
            const url = new URL(resolveWorkspacePreviewUrl('data/result.csv', 'session-123'));
            expect(url.protocol).toBe('data-agent:');
            expect(url.hostname).toBe('workspace');
            expect(url.pathname).toBe('/workspace/files/preview');
            expect(url.searchParams.get('path')).toBe('session-123/data/result.csv');
        } finally {
            delete window.dataAgentRuntime;
        }
    });
});

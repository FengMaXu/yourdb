import React, { Suspense, lazy } from 'react';
import { LanguageProvider } from './context/LanguageContext';

const AppRoot = lazy(() => import('./App'));
const LandingPage = lazy(() => import('./components/landing/LandingPage'));
// Development only: production builds replace import.meta.env.DEV with false and drop the page.
const KitPage = import.meta.env.DEV ? lazy(() => import('./components/dev/KitPage')) : null;

/** Picks the landing page or the workspace app by route, so each only downloads its own code. */
const Root: React.FC = () => {
    const isDesktopRuntime = typeof window !== 'undefined' && Boolean(window.dataAgent);
    const isAppRoute = typeof window !== 'undefined' && window.location.pathname.startsWith('/app');
    const isKitRoute = KitPage !== null && typeof window !== 'undefined' && window.location.pathname === '/app/__kit';

    return (
        <LanguageProvider>
            <Suspense fallback={null}>
                {isKitRoute && KitPage ? <KitPage /> : isDesktopRuntime || isAppRoute ? <AppRoot /> : <LandingPage />}
            </Suspense>
        </LanguageProvider>
    );
};

export default Root;

import { useEffect, useState } from 'react';

/** Tracks a CSS media query, so layout defaults can follow the window. */
export function useMediaQuery(query: string): boolean {
    const [matches, setMatches] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
    useEffect(() => {
        if (typeof window.matchMedia !== 'function') return;
        const list = window.matchMedia(query);
        const update = () => setMatches(list.matches);
        update();
        list.addEventListener('change', update);
        return () => list.removeEventListener('change', update);
    }, [query]);
    return matches;
}

/** Below this width the workspace collapses to one pane and dialogs fill the screen. */
export const NARROW_QUERY = '(max-width: 720px)';

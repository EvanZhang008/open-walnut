import { useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { lockScroll, unlockScroll } from './useModalOverlay';

/**
 * CSS-promotion fullscreen hook — promotes an existing component to fullscreen
 * via CSS class toggle instead of creating a new component instance.
 *
 * Returns:
 * - isFullscreen: boolean state
 * - enterFullscreen / exitFullscreen: toggle methods
 * - fullscreenClass: CSS class string to apply to the target element
 * - FullscreenBackdrop: ReactPortal to render (backdrop overlay + ESC handler)
 *
 * ⚠️ ROUTE-CHANGE EXIT (do not remove — see below).
 * Every consumer of this hook lives inside MainPage, which App.tsx keeps MOUNTED
 * FOREVER and merely hides with a CSS class on navigation (to preserve chat/WS/
 * scroll state). So `isFullscreen` survives a route change — and the backdrop is
 * a PORTAL onto document.body, i.e. outside the hidden subtree. Result: navigating
 * away while fullscreen left a `position:fixed; z-index:9000; backdrop-filter:
 * blur(4px)` sheet over the whole next page, with no visible way to dismiss it
 * (the fullscreened panel it belonged to was hidden). Reported 2026-08-09 as
 * "click Open in Notes, everything is blur". Fixing it per-consumer would just
 * wait for the next consumer to forget, so the exit lives here.
 */
export function useFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const { pathname } = useLocation();

  const enterFullscreen = useCallback(() => setIsFullscreen(true), []);
  const exitFullscreen = useCallback(() => setIsFullscreen(false), []);

  // Leaving the route drops fullscreen. Keyed on pathname only: a search-param
  // change (`/?s1=…`, the session columns' own deep-link state) is NOT a
  // navigation away and must not collapse a panel the user just expanded.
  useEffect(() => {
    setIsFullscreen(false);
  }, [pathname]);

  // ESC key handler + ref-counted body scroll lock (shares count with useModalOverlay)
  useEffect(() => {
    if (!isFullscreen) return;
    lockScroll();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setIsFullscreen(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      unlockScroll();
    };
  }, [isFullscreen]);

  // Backdrop portal — rendered by the consumer in their JSX
  const FullscreenBackdrop: ReactNode = isFullscreen
    ? createPortal(
        <div
          className="open-walnut-fullscreen-backdrop"
          onClick={exitFullscreen}
          aria-hidden="true"
        />,
        document.body,
      )
    : null;

  const fullscreenClass = isFullscreen ? ' open-walnut-fullscreen' : '';

  return { isFullscreen, enterFullscreen, exitFullscreen, fullscreenClass, FullscreenBackdrop };
}

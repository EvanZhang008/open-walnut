import { useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
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
 */
export function useFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(false);

  const enterFullscreen = useCallback(() => setIsFullscreen(true), []);
  const exitFullscreen = useCallback(() => setIsFullscreen(false), []);

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
          className="walnut-fullscreen-backdrop"
          onClick={exitFullscreen}
          aria-hidden="true"
        />,
        document.body,
      )
    : null;

  const fullscreenClass = isFullscreen ? ' walnut-fullscreen' : '';

  return { isFullscreen, enterFullscreen, exitFullscreen, fullscreenClass, FullscreenBackdrop };
}

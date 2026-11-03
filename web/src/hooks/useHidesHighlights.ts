/**
 * A surface that hides painted words with `visibility: hidden` (Home off its
 * route, the chat under a board peek) calls this with its hidden state, so the
 * highlight registry re-checks what it paints the moment the surface turns
 * (utils/highlight-visibility.ts: WebKit paints hidden words' highlights onto the
 * next words it renders).
 */
import { useLayoutEffect, useRef } from 'react';
import { refreshHighlightVisibility } from '@/utils/highlight-visibility';

export function useHidesHighlights(hidden: boolean): void {
  const first = useRef(true);
  useLayoutEffect(() => {
    const mount = first.current;
    first.current = false;
    // Shown at mount: nothing it holds was ever filtered.
    if (mount && !hidden) return;
    refreshHighlightVisibility();
  }, [hidden]);
}

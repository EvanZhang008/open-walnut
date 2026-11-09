import { useEffect, useRef } from 'react';

/**
 * A message that appears after a click (a refused save, a stale draft) is scrolled into view: the
 * router's settings scroll in their own pane, and an error drawn below the button sat out of sight
 * there, so the person saw the click do nothing (round 3 review, 2026-11-08).
 */
export function useRevealWhen<T extends HTMLElement>(shown: unknown) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (shown) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [shown]);
  return ref;
}

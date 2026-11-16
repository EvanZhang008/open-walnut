import { useLayoutEffect, type RefObject } from 'react';

/** The composer's popovers keep at least this much height, so a cramped one stays usable. */
const MIN_ROOM = 120;
/** Their gap to the composer (margin-bottom) plus a margin to the window's top edge. */
const EDGE = 12;

/**
 * While `active`, write the room between the window's top and `hostRef`'s top onto the host
 * as `varName` (px). The composer's popovers (the command palette, the @ palette, the file
 * popup) open upward from it (`bottom: 100%`) and cap their height with it, so their top row
 * (the @ palette's source tabs) never runs past the top of the window. Their own caps were in
 * vh only, which a short window with a taller composer (the session note band inside the card,
 * 2026-11-16) overran by 36px.
 *
 * Kept in step with the window's size and the composer's own (it grows upward as it is typed in).
 */
export function useRoomAbove(hostRef: RefObject<HTMLElement | null>, active: boolean, varName = '--composer-popover-room'): void {
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!active || !host) return;
    const apply = () => {
      const top = host.getBoundingClientRect().top;
      host.style.setProperty(varName, `${Math.max(MIN_ROOM, Math.floor(top - EDGE))}px`);
    };
    apply();
    window.addEventListener('resize', apply);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(apply) : null;
    ro?.observe(host);
    return () => {
      window.removeEventListener('resize', apply);
      ro?.disconnect();
      host.style.removeProperty(varName);
    };
  }, [hostRef, active, varName]);
}

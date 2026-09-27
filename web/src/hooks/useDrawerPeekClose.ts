/**
 * Closing the drawer's `peek` mode by pointer GEOMETRY (spec 6.1, C28), never
 * by mouseleave: rows re-render under the pointer and a re-rendered row eats
 * the mouseleave, which used to close a drawer the pointer was still on.
 *
 * Once per animation frame the latest pointer position is tested against
 *   [panel.left - 40, drawer.right + 18] x [drawer.top - 18, drawer.bottom + 18].
 * Outside it (and nothing blocks), a 260ms timer closes the drawer; coming back
 * inside cancels it. The pointer leaving the window (`mouseout` with no
 * `relatedTarget`) starts the same timer. Never closes while the search box has
 * focus or a confirm layer / menu is open (`blocked`).
 */
import { useEffect, useRef, type RefObject } from 'react';
import { log } from '@/utils/log';

export const PEEK_CLOSE_MS = 260;
export const PEEK_SLACK_LEFT = 40;
export const PEEK_SLACK = 18;

export interface PeekRegionInput {
  panelLeft: number;
  drawer: { top: number; right: number; bottom: number };
}

/** Pure: is the point inside the region that keeps a peek open? */
export function insidePeekRegion(x: number, y: number, r: PeekRegionInput): boolean {
  return x >= r.panelLeft - PEEK_SLACK_LEFT && x <= r.drawer.right + PEEK_SLACK
    && y >= r.drawer.top - PEEK_SLACK && y <= r.drawer.bottom + PEEK_SLACK;
}

export interface DrawerPeekCloseArgs {
  active: boolean;
  panelRef: RefObject<HTMLElement | null>;
  drawerRef: RefObject<HTMLElement | null>;
  /** True while the search has focus or a confirm / menu is open. */
  blocked: () => boolean;
  onClose: () => void;
  delayMs?: number;
}

export function useDrawerPeekClose({ active, panelRef, drawerRef, blocked, onClose, delayMs = PEEK_CLOSE_MS }: DrawerPeekCloseArgs): void {
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let frame = 0;
    let latest: { x: number; y: number } | null = null;
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const arm = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (blockedRef.current()) return;
        log.info('threads', 'drawer peek closed by pointer geometry');
        closeRef.current();
      }, delayMs);
    };
    const sample = () => {
      frame = 0;
      const panel = panelRef.current;
      const drawer = drawerRef.current;
      if (!latest || !panel || !drawer) return;
      const d = drawer.getBoundingClientRect();
      const inRegion = insidePeekRegion(latest.x, latest.y, { panelLeft: panel.getBoundingClientRect().left, drawer: d });
      if (inRegion || blockedRef.current()) cancel();
      else arm();
    };
    const onMove = (e: PointerEvent) => {
      latest = { x: e.clientX, y: e.clientY };
      if (!frame) frame = requestAnimationFrame(sample);
    };
    const onOut = (e: MouseEvent) => {
      if (e.relatedTarget === null && !blockedRef.current()) arm();
    };
    document.addEventListener('pointermove', onMove, { passive: true, capture: true });
    window.addEventListener('mouseout', onOut);
    return () => {
      document.removeEventListener('pointermove', onMove, { capture: true });
      window.removeEventListener('mouseout', onOut);
      if (frame) cancelAnimationFrame(frame);
      cancel();
    };
  }, [active, panelRef, drawerRef, delayMs]);
}

import { useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { lockScroll, unlockScroll } from './useModalOverlay';
import { traceInteraction } from '@/utils/interaction-timer';

/** Window event every live fullscreen sheet exits on. Fired by `yieldFullscreen`. */
export const FULLSCREEN_YIELD_EVENT = 'fullscreen:yield';

/**
 * Drop every fullscreen sheet because the user's action opened or revealed a
 * column on the home page (the COLUMN-OPEN EXIT documented on the hook below).
 * Call it FROM the code that opens the column (MainPage's openSessionOrToast /
 * openDraftColumn / handleLocateTaskById, which reveals the task panel's row), not from the button: the buttons are many (toast, letter,
 * task row, dock, chat session link, chat task link, the header's "Go to task",
 * fork chip, slash command) and the columns they open are few. `reason` lands in
 * the perf log as `interaction {name: fullscreen-yield, reason}`.
 */
export function yieldFullscreen(reason: string): void {
  window.dispatchEvent(new CustomEvent(FULLSCREEN_YIELD_EVENT, { detail: { reason } }));
}

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
 *
 * ⚠️ COLUMN-OPEN EXIT (same reasoning, same place). A pathname change is not the
 * only way the user leaves a fullscreen panel: on the home page, "Open session ↗"
 * on a permission toast (the toaster stacks ABOVE the sheet, so it is clickable
 * while fullscreen) and "Fork" in the panel's own chip row both open ANOTHER
 * column without touching the URL. The sheet stayed up and covered the column
 * the click had just opened, so the click read as "nothing happened" (reported
 * 2026-09-15). MainPage's column-opening entry points now call `yieldFullscreen`,
 * and every live sheet drops. Two consequences are DECIDED, not accidental:
 *  - the panel whose OWN session was asked for drops too: "take me to the
 *    session" is answered by the plain column, never by a silent no-op under a
 *    Files view;
 *  - "Go to task" in the header and a task link in the chat drop it as well, even
 *    when the task's session is this very panel: what they reveal is the task in
 *    the todo list, which sits under the sheet exactly like a new column does.
 *  A background event never yields: quick-start / fork resolution, restore and
 *  `session:status-changed` write the columns directly, not through those two
 *  entry points, so a sheet only ever drops on the user's own gesture.
 */
export function useFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const { pathname } = useLocation();

  // Timed: "I click outside to get out and it takes like 3 seconds" was reported
  // with no log to point at. Both directions now land in the server log as
  // `[perf] interaction {name: fullscreen-enter|fullscreen-exit, ms}`, and a
  // main-thread block during the collapse is attributed to the phase.
  const enterFullscreen = useCallback(() => {
    traceInteraction('fullscreen-enter');
    setIsFullscreen(true);
  }, []);
  const exitFullscreen = useCallback(() => {
    traceInteraction('fullscreen-exit');
    setIsFullscreen(false);
  }, []);

  // Leaving the route drops fullscreen. Keyed on pathname only: a search-param
  // change (`/?s1=…`, the session columns' own deep-link state) is NOT a
  // navigation away and must not collapse a panel the user just expanded.
  useEffect(() => {
    setIsFullscreen(false);
  }, [pathname]);

  // ESC key handler + column-open yield + ref-counted body scroll lock (shares
  // count with useModalOverlay). All subscribed only WHILE fullscreen, so a page
  // with twenty idle panels pays nothing per yield.
  useEffect(() => {
    if (!isFullscreen) return;
    lockScroll();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setIsFullscreen(false);
      }
    };
    // Its own interaction name, not `fullscreen-exit`: the frame after a yield
    // also mounts the column that caused it, so timing it as an exit would inflate
    // the collapse baseline this file's tracing exists to watch.
    const handleYield = (e: Event) => {
      const reason = (e as CustomEvent<{ reason?: string }>).detail?.reason ?? 'unknown';
      traceInteraction('fullscreen-yield', { reason });
      setIsFullscreen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener(FULLSCREEN_YIELD_EVENT, handleYield);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener(FULLSCREEN_YIELD_EVENT, handleYield);
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

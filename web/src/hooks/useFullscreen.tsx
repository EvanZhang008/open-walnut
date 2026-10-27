import { useState, useCallback, useEffect, useContext } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { RouteShownContext } from '@/contexts/RouteShownContext';
import { hasActiveModalOverlay, lockScroll, unlockScroll } from './useModalOverlay';
import { traceInteraction } from '@/utils/interaction-timer';
import { keyTargetClaimsEscape } from './usePanelKeyRouter';
import { escapeWasConsumedByOthers } from '@/utils/escape-beep-guard';
import { log } from '@/utils/log';

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
export interface UseFullscreenOptions {
  /**
   * Full screen of the TAB (2026-10-27, the user: "during full screen I can
   * still go from home to org"): the sheet stays full screen across a route
   * change and is there again on the way back. Only for an element the hidden
   * home page hides with it (a session panel): while its page is not on show
   * (RouteShownContext) the backdrop is not drawn, Esc is not taken and the body
   * is not locked, so the other page works as usual. A sheet entered while the
   * router is still catching up with a deep link from another page is simply
   * away for that beat, then on show. Everything else (the dock, which shows on
   * every page) keeps the ROUTE-CHANGE EXIT below.
   */
  keepAcrossRoutes?: boolean;
}

export function useFullscreen(options: UseFullscreenOptions = {}) {
  const keepAcrossRoutes = options.keepAcrossRoutes === true;
  const [isFullscreen, setIsFullscreen] = useState(false);
  const { pathname } = useLocation();
  // Off its page (the hidden home page, RouteShownContext) the sheet is away.
  const shown = useContext(RouteShownContext);
  const away = isFullscreen && keepAcrossRoutes && !shown;
  const active = isFullscreen && !away;

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
    if (!keepAcrossRoutes) setIsFullscreen(false);
  }, [pathname, keepAcrossRoutes]);

  // ESC key handler + ref-counted body scroll lock (shares count with
  // useModalOverlay), and the column-open yield below. All subscribed only WHILE
  // fullscreen, so a page with twenty idle panels pays nothing per yield.
  useEffect(() => {
    if (!active) return;
    lockScroll();
    const handleKeyDown = (e: KeyboardEvent) => {
      // A consumer that used the Esc (palette, picker, confirm) prevented it, and a
      // question page or open drawer in the target panel claims it first: one Esc
      // closes one layer, fullscreen exits only at the root with nothing open.
      if (e.key !== 'Escape') return;
      // Esc that does not leave fullscreen was reported as "sometimes dead" with
      // nothing to point at: name the layer that kept it.
      const kept = hasActiveModalOverlay() ? 'modal-overlay'
        : escapeWasConsumedByOthers(e) ? 'consumed-by-other-handler'
        : keyTargetClaimsEscape() ? 'panel-layer-open'
        : null;
      if (kept) {
        log.info('fullscreen', 'escape kept fullscreen open', { reason: kept, target: (e.target as HTMLElement | null)?.tagName });
        return;
      }
      e.stopPropagation();
      setIsFullscreen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      unlockScroll();
    };
  }, [active]);

  // The column-open yield also holds while the sheet is away: a session opened
  // from another page lands in a home column, which a sheet coming back full
  // screen would cover. Its own interaction name, not `fullscreen-exit`: the
  // frame after a yield also mounts the column that caused it, so timing it as
  // an exit would inflate the collapse baseline this file's tracing exists to watch.
  useEffect(() => {
    if (!isFullscreen) return;
    const handleYield = (e: Event) => {
      const reason = (e as CustomEvent<{ reason?: string }>).detail?.reason ?? 'unknown';
      traceInteraction('fullscreen-yield', { reason });
      setIsFullscreen(false);
    };
    window.addEventListener(FULLSCREEN_YIELD_EVENT, handleYield);
    return () => window.removeEventListener(FULLSCREEN_YIELD_EVENT, handleYield);
  }, [isFullscreen]);

  // Backdrop portal — rendered by the consumer in their JSX
  const FullscreenBackdrop: ReactNode = active
    ? createPortal(
        <div
          className="open-walnut-fullscreen-backdrop"
          onClick={exitFullscreen}
          aria-hidden="true"
        />,
        document.body,
      )
    : null;

  // Away, the sheet is hidden outright (fullscreen-tab.css): it is position:fixed,
  // so the hidden home page's overflow does not clip it, and a descendant that
  // sets its own `visibility: visible` would otherwise paint over the other page.
  const fullscreenClass = isFullscreen ? (away ? ' open-walnut-fullscreen open-walnut-fullscreen-away' : ' open-walnut-fullscreen') : '';

  return { isFullscreen, enterFullscreen, exitFullscreen, fullscreenClass, FullscreenBackdrop };
}

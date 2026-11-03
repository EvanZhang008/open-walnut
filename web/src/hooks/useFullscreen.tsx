import { useState, useCallback, useEffect, useLayoutEffect, useContext, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { RouteShownContext } from '@/contexts/RouteShownContext';
import { PluginBoxContext } from '@/contexts/PluginBoxContext';
import { hasActiveModalOverlay, lockScroll, unlockScroll } from './useModalOverlay';
import { traceInteraction } from '@/utils/interaction-timer';
import { useHidesHighlights } from './useHidesHighlights';
import { keyTargetClaimsEscape } from './usePanelKeyRouter';
import { escapeWasConsumedByOthers } from '@/utils/escape-beep-guard';
import { log } from '@/utils/log';
import {
  bindFullscreen, claimFullscreen, clearFullscreen, detachFullscreen, fullscreenHeldBy,
  keepsAcrossRoutes, newFullscreenId, releaseFullscreen, sheetPlace, subscribeFullscreen,
} from './fullscreen-owner';

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
  // A place full screen with no sheet on screen (a page not open now) would come
  // back over the column this opens: the yield ends it too.
  clearFullscreen();
}

/**
 * The place a tab sheet shows (fullscreen-owner.ts `sheetPlace`): `host` names
 * where it is hosted (a home column, the Ask slot, an Org node, a plugin), `item`
 * what it shows (the session). Full screen and the panel's own view are kept per
 * place, so the same session in two hosts keeps two views, and a host off the
 * home page keeps one per page.
 */
export function useSheetPlace(host: string, item: string): string {
  const inPluginBox = useContext(PluginBoxContext);
  const routeShown = useContext(RouteShownContext);
  const { pathname } = useLocation();
  return sheetPlace(host, item, keepsAcrossRoutes(true, routeShown !== null, inPluginBox), pathname);
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
   * every page) keeps the ROUTE-CHANGE EXIT below, and so does a panel in a
   * plugin's box, which a move to another of the plugin's pages leaves.
   *
   * It also makes the sheet one of the tab's (fullscreen-owner.ts): full screen
   * is ONE state for every such sheet, one at a time, and leaving it anywhere
   * leaves it everywhere. A session panel passes it wherever it is hosted.
   */
  keepAcrossRoutes?: boolean;
  /**
   * The place the sheet shows (`useSheetPlace`). With it the tab's full screen
   * is kept on disk as that place: the sheet showing it after a remount (a
   * plugin reloaded, a page reload, a visit to another page, an app restart) is
   * full screen again until the user leaves it, and a move to another page by a
   * sheet that stays mounted is a move to another place.
   */
  place?: string;
}

export function useFullscreen(options: UseFullscreenOptions = {}) {
  const tab = options.keepAcrossRoutes === true;
  const inPluginBox = useContext(PluginBoxContext);
  // Off its page (the hidden home page, RouteShownContext) the sheet is away;
  // outside the home page the context is null and the sheet is always on show.
  const routeShown = useContext(RouteShownContext);
  const shown = routeShown ?? true;
  const keepAcrossRoutes = keepsAcrossRoutes(tab, routeShown !== null, inPluginBox);
  const [id] = useState(newFullscreenId);
  // The tab's sheets share the one owner (fullscreen-owner.ts); a nested or
  // page-wide sheet keeps its own flag.
  const [ownFlag, setOwnFlag] = useState(false);
  const place = tab ? options.place ?? null : null;
  const ownsTab = useSyncExternalStore(subscribeFullscreen, () => fullscreenHeldBy(id, place), () => false);
  const isFullscreen = tab ? ownsTab : ownFlag;
  const { pathname } = useLocation();
  const away = isFullscreen && keepAcrossRoutes && !shown;
  // An away sheet is portalled out of Home and hidden by visibility: its chat's marks must not paint on the page.
  useHidesHighlights(away);
  const active = isFullscreen && !away;
  const leave = useCallback(() => { if (tab) releaseFullscreen(id, place); else setOwnFlag(false); }, [tab, id, place]);

  // Timed: "I click outside to get out and it takes like 3 seconds" was reported
  // with no log to point at. Both directions now land in the server log as
  // `[perf] interaction {name: fullscreen-enter|fullscreen-exit, ms}`, and a
  // main-thread block during the collapse is attributed to the phase.
  const enterFullscreen = useCallback(() => {
    traceInteraction('fullscreen-enter');
    if (tab) claimFullscreen(id, place); else setOwnFlag(true);
  }, [tab, id, place]);
  // Only the sheet that is full screen can leave it: a panel resetting itself
  // (a new session in it, a fresh mount) must never end another sheet's.
  const exitFullscreen = useCallback(() => {
    if (tab ? !fullscreenHeldBy(id, place) : !ownFlag) return;
    traceInteraction('fullscreen-exit');
    leave();
  }, [tab, id, place, ownFlag, leave]);

  // The sheet showing a place that is full screen holds it; going away, or on to
  // another place, it lets go and the place stays full screen for the next sheet
  // that shows it. A sheet with no place ends it when it goes away, so a sheet
  // mounted later never comes up full page.
  useLayoutEffect(() => {
    if (!tab) return;
    if (place === null) return () => releaseFullscreen(id);
    bindFullscreen(id, place);
    return () => detachFullscreen(id);
  }, [tab, id, place]);

  // Leaving the route drops fullscreen. Keyed on pathname only: a search-param
  // change (`/?s1=…`, the session columns' own deep-link state) is NOT a
  // navigation away and must not collapse a panel the user just expanded. A
  // sheet with a place has the page in it: there the move is a move to another place.
  useEffect(() => {
    if (!keepAcrossRoutes && place === null) leave();
  }, [pathname, keepAcrossRoutes, place, leave]);

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
      leave();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      unlockScroll();
    };
  }, [active, leave]);

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
      leave();
    };
    window.addEventListener(FULLSCREEN_YIELD_EVENT, handleYield);
    return () => window.removeEventListener(FULLSCREEN_YIELD_EVENT, handleYield);
  }, [isFullscreen, leave]);

  // Backdrop portal — rendered by the consumer in their JSX. Inside a plugin App's box the sheet
  // stacks inside the box (plugin-bounds.css isolates and clips it), so a backdrop on the body would
  // lie over it and every click would only leave full screen: there the backdrop renders where the
  // consumer puts it, beside the sheet, and both cover the box alone.
  const backdrop = active ? (
    <div
      className="open-walnut-fullscreen-backdrop"
      onClick={exitFullscreen}
      aria-hidden="true"
    />
  ) : null;
  const FullscreenBackdrop: ReactNode = backdrop && !inPluginBox ? createPortal(backdrop, document.body) : backdrop;

  // Away, the sheet is hidden outright (fullscreen-tab.css): it is position:fixed,
  // so the hidden home page's overflow does not clip it, and a descendant that
  // sets its own `visibility: visible` would otherwise paint over the other page.
  const fullscreenClass = isFullscreen ? (away ? ' open-walnut-fullscreen open-walnut-fullscreen-away' : ' open-walnut-fullscreen') : '';

  return { isFullscreen, enterFullscreen, exitFullscreen, fullscreenClass, FullscreenBackdrop };
}

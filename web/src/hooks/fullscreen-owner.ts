/**
 * Full screen is ONE state the user sets for the whole tab, not a flag each
 * sheet keeps (2026-11-02, the user, on a plugin's session panel that was still
 * full page: "isn't this global setting?"). Each useFullscreen instance used to
 * hold its own `useState`, so leaving full screen on one page left another
 * panel (a plugin's session view, an Org panel, a hidden home column) full page,
 * and a plugin panel kept it across the plugin's own pages.
 *
 * The tab's sheets (a session panel, wherever it is hosted: useFullscreen
 * `keepAcrossRoutes`) share it. A sheet of its own inside one (the workflow
 * card in a panel's chat) or beside every page (the dock) keeps its own flag, so
 * opening it never takes full screen from the panel around it.
 *
 * The one state is the PLACE that is full screen (a host and a session, plus the
 * page for a host that is not the home page: `useSheetPlace`), kept on disk with
 * the other view choices (utils/view-memory.ts), and the mounted sheet showing
 * that place now (the holder). Later the same day, the user: "it keep lost my
 * state like the open state of the session, like full screen, file ... remember
 * the state". So a sheet that goes away without the user leaving full screen (a
 * plugin reloaded, the page reloaded, another page visited, the app restarted)
 * lets go of the holder only, and the sheet that shows that place next is full
 * screen again. Entering makes a sheet the holder of its place (any other drops),
 * leaving it clears the place, so no sheet anywhere comes back full screen; and a
 * column opened on Home (yieldFullscreen) clears it too.
 * tests/web/fullscreen-one-state.test.ts pins it.
 */
import { viewKey } from '@/utils/view-memory';

/** Where the place that is full screen is kept (mirrored to ui-prefs like every view choice). */
export const FULLSCREEN_PLACE_KEY = viewKey('tab', 'fullscreen');

let holder: string | null = null;
let place: string | null | undefined;
const listeners = new Set<() => void>();
let seq = 0;

function storedPlace(): string | null {
  if (place !== undefined) return place;
  try {
    const v = JSON.parse(localStorage.getItem(FULLSCREEN_PLACE_KEY) ?? 'null') as unknown;
    place = typeof v === 'string' && v ? v : null;
  } catch {
    place = null;
  }
  return place;
}

function notify(): void {
  for (const fn of [...listeners]) fn();
}

function setPlace(next: string | null): void {
  if (storedPlace() === next) return;
  place = next;
  try { localStorage.setItem(FULLSCREEN_PLACE_KEY, JSON.stringify(next)); } catch { /* storage off: it is kept for this load only */ }
}

/** A new sheet's id. */
export function newFullscreenId(): string {
  seq += 1;
  return `fs-${seq}`;
}

/** The mounted sheet that is full screen now, or null (none, or its place is not on screen). */
export function fullscreenOwner(): string | null {
  return holder;
}

/** The place that is full screen, shown or not. */
export function fullscreenPlace(): string | null {
  return storedPlace();
}

/**
 * Whether sheet `id`, showing `at`, is full screen: it holds it, or nobody holds
 * the place it shows (a sheet that just mounted, before it binds).
 */
export function fullscreenHeldBy(id: string, at: string | null): boolean {
  if (holder !== null) return holder === id;
  return at !== null && storedPlace() === at;
}

export function subscribeFullscreen(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** `id` goes full screen (showing `at`, a place to come back to); whatever was full screen before drops. */
export function claimFullscreen(id: string, at: string | null = null): void {
  if (holder === id && storedPlace() === at) return;
  holder = id;
  setPlace(at);
  notify();
}

/**
 * `id` (showing `at`) leaves full screen: it ends full screen everywhere, and only if it is full
 * screen (it holds it, or nobody does and it shows the place: a second sheet of that place, once
 * the one that held it went).
 */
export function releaseFullscreen(id: string, at: string | null = null): void {
  if (!fullscreenHeldBy(id, at)) return;
  holder = null;
  setPlace(null);
  notify();
}

/** `id` goes away (unmounted, or shows another place now) without the user leaving full screen: its place stays full screen. */
export function detachFullscreen(id: string): void {
  if (holder !== id) return;
  holder = null;
  notify();
}

/** `id` now shows `at`: when that place is full screen and nobody holds it, `id` does. */
export function bindFullscreen(id: string, at: string | null): void {
  if (holder !== null || at === null || storedPlace() !== at) return;
  holder = id;
  notify();
}

/** The user opened something that full screen would cover (a column on Home): nothing is full screen. */
export function clearFullscreen(): void {
  if (holder === null && storedPlace() === null) return;
  holder = null;
  setPlace(null);
  notify();
}

/**
 * Whether a sheet stays full screen across a route change. Only a panel of the
 * home page, which stays mounted (hidden) behind every other page, keeps it, so
 * the full screen is there again on the way back. A panel in a plugin's box is
 * still mounted when the plugin moves to another of its own pages: that move is
 * leaving it, so it opens in its normal place there; so is a panel a plugin
 * shows anywhere else (a sidebar slot's popover). Such a sheet's place names
 * its page, so the page it was full screen on is full screen again on the way back.
 */
export function keepsAcrossRoutes(keepAcrossRoutes: boolean, inHomePage: boolean, inPluginBox: boolean): boolean {
  return keepAcrossRoutes && inHomePage && !inPluginBox;
}

/** A sheet's place: `<host>|<session>`, with the page for a sheet that does not keep across routes. */
export function sheetPlace(host: string, item: string, keepAcrossRoutes: boolean, pathname: string): string {
  return keepAcrossRoutes ? `${host}|${item}` : `${host}@${pathname}|${item}`;
}

/** Tests only. */
export function resetFullscreenOwner(): void {
  holder = null;
  place = undefined;
  listeners.clear();
  seq = 0;
}

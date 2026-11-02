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
 * Here lives the one owner: the id of the sheet that is full screen now, or
 * none. Entering makes a sheet the owner (any other drops), so the only sheet
 * the user can leave full screen from is the owner, and leaving it leaves no
 * sheet full screen anywhere. A sheet that unmounts while it owns it clears it,
 * so a panel mounted later (the plugin page opened again) never comes up full
 * page; a sheet that does not own it (a panel resetting itself) changes nothing.
 * tests/web/fullscreen-one-state.test.ts pins it.
 */

let owner: string | null = null;
const listeners = new Set<() => void>();
let seq = 0;

function set(next: string | null): void {
  if (next === owner) return;
  owner = next;
  for (const fn of [...listeners]) fn();
}

/** A new sheet's id. */
export function newFullscreenId(): string {
  seq += 1;
  return `fs-${seq}`;
}

/** The sheet that is full screen now, or null. */
export function fullscreenOwner(): string | null {
  return owner;
}

export function subscribeFullscreen(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** `id` goes full screen; whatever was full screen before drops. */
export function claimFullscreen(id: string): void {
  set(id);
}

/** `id` leaves full screen, or goes away (unmounted, its page left): it ends full screen only if it held it. */
export function releaseFullscreen(id: string): void {
  if (owner === id) set(null);
}

/**
 * Whether a sheet stays full screen across a route change. Only a panel of the
 * home page, which stays mounted (hidden) behind every other page, keeps it, so
 * the full screen is there again on the way back. A panel in a plugin's box is
 * still mounted when the plugin moves to another of its own pages: that move is
 * leaving it, so it opens in its normal place there; so is a panel a plugin
 * shows anywhere else (a sidebar slot's popover).
 */
export function keepsAcrossRoutes(keepAcrossRoutes: boolean, inHomePage: boolean, inPluginBox: boolean): boolean {
  return keepAcrossRoutes && inHomePage && !inPluginBox;
}

/** Tests only. */
export function resetFullscreenOwner(): void {
  owner = null;
  listeners.clear();
  seq = 0;
}

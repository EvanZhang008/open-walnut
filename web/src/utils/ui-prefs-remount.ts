/**
 * How the user's prefs take effect when they reach the page after it rendered
 * (ui-prefs-sync.ts: the first read timed out and a background retry answered).
 *
 * The components read these keys once, in useState initializers, so a storage event alone
 * reaches only the few stores that listen. Mounting the app again is the one way every reader
 * gets them. That costs nothing the person can see while the page is young and they have not
 * touched it (nothing of theirs is on it yet), so it happens at once then. Otherwise a remount
 * would move the page under them (scroll, open menus, a half-read panel): it waits until the
 * page has been hidden for a while, the moment a stale build's reload waits for too
 * (stale-assets.ts), and never with unsaved text. Until it happens, a component still showing
 * its default may save it again: with no press, key or scroll since the merge that write is the
 * default, and the merged value is put straight back (ui-prefs-sync.ts queue), so neither the
 * server nor the remount ever gets it; after one, the write is the person's own change and
 * syncs as usual (a component that saves a whole object may carry an old field along then:
 * the cost of never dropping a change they made).
 */

export interface LatePrefsHost {
  /** Mount the app again, so every useState initializer reads the user's values. */
  remount: () => void;
  /** False while a remount would lose something (unsaved text, a console that is gone). */
  canRemount: () => boolean;
}

/** A remount in view only this soon after the page loaded. */
export const VISIBLE_REMOUNT_WINDOW_MS = 60_000;
/** Otherwise once the page has been hidden this long. */
export const HIDDEN_REMOUNT_MS = 20_000;

let host: LatePrefsHost | null = null;
let watchingSince = 0;
let interacted = false;
/** Pressed, typed or scrolled since the deferred late merge. */
let touchedSinceMerge = false;
/** Keys the late merge changed that the UI does not show yet, with their merged values. */
const stale = new Map<string, string | null>();
let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
let listeningHidden = false;

/** main.tsx registers this once the app has rendered; until then a late read needs no remount. */
export function setLatePrefsHost(next: LatePrefsHost | null): void { host = next; }

// Scrolling counts: someone reading a long list would lose their place.
const INTERACTION_EVENTS = ['pointerdown', 'keydown', 'input', 'wheel', 'touchstart'] as const;
const markInteracted = (): void => { interacted = true; touchedSinceMerge = true; };

function listen(target: 'window' | 'document', type: string, fn: () => void, on: boolean, opts?: AddEventListenerOptions): void {
  try {
    const t = target === 'window' ? window : typeof document === 'undefined' ? null : document;
    if (!t) return;
    if (on) t.addEventListener(type, fn, opts);
    else t.removeEventListener(type, fn, opts);
  } catch { /* no DOM (tests) */ }
}

/** From page load: was the page pressed, typed in or scrolled? */
export function watchInteraction(on: boolean, now: number = Date.now()): void {
  if (on) watchingSince = now;
  for (const type of INTERACTION_EVENTS) listen('window', type, markInteracted, on, { capture: true, passive: true });
}

/** The merged value of a key the UI does not show yet (undefined: the UI shows it). */
export function staleValueOf(key: string): string | null | undefined { return stale.get(key); }
/** The person pressed, typed or scrolled since the deferred merge. */
export function touchedSinceLateMerge(): boolean { return touchedSinceMerge; }
/** The person set this key: the UI shows their value now. */
export function forgetStale(key: string): void { stale.delete(key); }

function canRemountNow(): boolean {
  try { return !!host && host.canRemount(); } catch { return false; }
}

function remountNow(): void {
  host?.remount();
  stale.clear();
  watchInteraction(false);
  clearTimeout(hiddenTimer);
  if (listeningHidden) { listen('document', 'visibilitychange', onVisibility, false); listeningHidden = false; }
}

function onVisibility(): void {
  clearTimeout(hiddenTimer);
  if (typeof document === 'undefined' || document.visibilityState !== 'hidden') return;
  hiddenTimer = setTimeout(() => {
    if (document.visibilityState === 'hidden' && stale.size > 0 && canRemountNow()) remountNow();
  }, HIDDEN_REMOUNT_MS);
}

/**
 * The late merge changed these keys (the UI reads each in a useState initializer). Returns
 * what happened: shown at once, deferred to a hidden moment, or nothing to do (no app yet).
 */
export function showLatePrefs(changes: ReadonlyArray<readonly [string, string | null]>, now: number = Date.now()): 'remounted' | 'deferred' | 'none' {
  if (changes.length === 0 || !host) { watchInteraction(false); return 'none'; }
  const young = now - watchingSince <= VISIBLE_REMOUNT_WINDOW_MS;
  if (!interacted && young && canRemountNow()) { remountNow(); return 'remounted'; }
  // Still watching presses, keys and scrolls: they tell a default re-saved from a change.
  touchedSinceMerge = false;
  for (const [k, v] of changes) stale.set(k, v);
  if (!listeningHidden) { listen('document', 'visibilitychange', onVisibility, true); listeningHidden = true; }
  onVisibility();
  return 'deferred';
}

/** Test hook. */
export function __resetLateRemountForTests(): void {
  watchInteraction(false);
  clearTimeout(hiddenTimer);
  if (listeningHidden) listen('document', 'visibilitychange', onVisibility, false);
  listeningHidden = false;
  host = null;
  interacted = false;
  touchedSinceMerge = false;
  watchingSince = 0;
  stale.clear();
}

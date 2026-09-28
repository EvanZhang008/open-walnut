/**
 * The attention card's memory for the page session, outside any one mount.
 * Only one card is on screen at a time (the owner rule), but the owner moves:
 * the slot takes over while the task panel is hidden, the draft column while
 * both are. A remount continues from the last frame instead of starting
 * over, so row order, the success hold, the deferral clock, Dismiss all's
 * hidden success rows and every row's expanded flag survive an owner switch.
 * The expanded flag is also the notification panel's System list's: a host
 * row there is the card's row, by the same id.
 *
 * One exception: a success that completed while NO card was mounted is not
 * replayed. A host that healed while the user sat on /notes must not greet
 * them with a 3s success row when they come back to Home.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { EMPTY_BANNER_STATE, type BannerState, type BannerView } from '@/utils/attention-banner-model';

/** A remount this long after the last card went away is a return, not an owner switch. */
export const RESUME_GAP_MS = 1_000;

let state: BannerState = EMPTY_BANNER_STATE;
let hidden: ReadonlyMap<string, number> = new Map();
const expanded = new Map<string, boolean>();
const expandListeners = new Set<() => void>();
let mounted = 0;
let lastUnmountAt: number | null = null;

export function getBannerState(): BannerState { return state; }
export function setBannerState(next: BannerState): void { state = next; }

/** Success rows Dismiss all hid (they carry no stored key) -> server time their 3s ends. */
export function getHiddenReady(): ReadonlyMap<string, number> { return hidden; }
export function setHiddenReady(next: ReadonlyMap<string, number>): void { hidden = next; }

/** The user's own Show / Hide details choice for a row; undefined = the row's default. */
export function getRowExpanded(id: string): boolean | undefined { return expanded.get(id); }

export function setRowExpanded(id: string, open: boolean): void {
  if (expanded.get(id) === open) return;
  expanded.set(id, open);
  for (const l of expandListeners) l();
}

export function subscribeRowExpanded(cb: () => void): () => void {
  expandListeners.add(cb);
  return () => { expandListeners.delete(cb); };
}

/** A row's expanded flag: the user's choice when there is one, else `fallback` (row 1 by position). */
export function useRowExpanded(id: string, fallback: boolean): [boolean, (open: boolean) => void] {
  const get = useCallback(() => getRowExpanded(id), [id]);
  const chosen = useSyncExternalStore(subscribeRowExpanded, get, get);
  const set = useCallback((open: boolean) => setRowExpanded(id, open), [id]);
  return [chosen ?? fallback, set];
}

/** Count a mounted card; the returned function un-counts it (call from a layout effect). */
export function cardMounted(): () => void {
  mounted++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    mounted = Math.max(0, mounted - 1);
    if (mounted === 0) lastUnmountAt = Date.now();
  };
}

/**
 * Is this render a return after a gap (no card on screen for a while)? Read
 * during render: an owner switch renders the new card before the old one's
 * cleanup runs, so it always sees a mounted card and is never a return.
 */
export function isResumingAfterGap(nowWall: number = Date.now()): boolean {
  return mounted === 0 && lastUnmountAt !== null && nowWall - lastUnmountAt > RESUME_GAP_MS;
}

/**
 * Drop the success rows this frame just created (their id was not held by the
 * previous state): used on a return after a gap, when the heal they report
 * happened while nothing was on screen. A success already being held stays.
 */
export function withoutReplayedReady(
  result: { view: BannerView; state: BannerState },
  prev: BannerState,
): { view: BannerView; state: BannerState } {
  const replayed = (id: string, type: string): boolean => type === 'ready' && prev.ready[id] === undefined;
  if (!result.state.order.some((r) => replayed(r.id, r.type))) return result;
  const ready: Record<string, number> = {};
  for (const [id, until] of Object.entries(result.state.ready)) if (prev.ready[id] !== undefined) ready[id] = until;
  return {
    view: { ...result.view, rows: result.view.rows.filter((r) => !replayed(r.id, r.type)) },
    state: { ...result.state, order: result.state.order.filter((r) => !replayed(r.id, r.type)), ready },
  };
}

/** Test hook. */
export function __resetBannerSessionForTests(): void {
  state = EMPTY_BANNER_STATE;
  hidden = new Map();
  expanded.clear();
  expandListeners.clear();
  mounted = 0;
  lastUnmountAt = null;
}

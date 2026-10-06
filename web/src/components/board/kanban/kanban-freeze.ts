/**
 * G9: cards hold still while the user is about to act on them. A drag holds
 * every lane. The pointer holds only the lane it rests in; an open editor,
 * composer, prompt or menu, or focus, holds only the lane of that card. A held
 * lane keeps its cards and their order (the view model still updates each
 * card's content; a card that arrives joins its end, a gone one leaves); a card
 * that left it stays drawn there, marked as moving, and every other lane shows
 * the live layout. Lane counts follow what is drawn (kanban-drawn.ts), so a
 * count never disagrees with the cards under it. 400ms after a lane's last hold
 * ends, it catches up and the cards that moved carry `data-moved` for 600ms.
 * The user's own write applies at once (the card goes where they put it). Pure
 * logic first, the hook after; unit-pinned in tests/web/kanban-freeze.test.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** Lane id to card ids, in display order. */
export type KanbanLayout = Readonly<Record<string, readonly string[]>>;

export const FREEZE_RELEASE_MS = 400;
export const MOVED_FLASH_MS = 600;

export function sameLayout(a: KanbanLayout, b: KanbanLayout): boolean {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const x = a[k], y = b[k];
    if (!y || x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  }
  return true;
}

/**
 * The frozen layout brought up to date without moving anything: cards that
 * still exist keep their lane and place; new cards join the end of their live
 * lane; lanes follow the live lane list (a deleted lane's cards go to their
 * live lane).
 */
export function mergeFrozen(frozen: KanbanLayout, live: KanbanLayout): Record<string, string[]> {
  const liveLaneOf = new Map<string, string>();
  for (const [lane, ids] of Object.entries(live)) for (const id of ids) liveLaneOf.set(id, lane);
  const out: Record<string, string[]> = {};
  const placed = new Set<string>();
  for (const lane of Object.keys(live)) {
    out[lane] = (frozen[lane] ?? []).filter((id) => liveLaneOf.has(id) && !placed.has(id));
    for (const id of out[lane]) placed.add(id);
  }
  for (const [lane, ids] of Object.entries(live)) {
    for (const id of ids) if (!placed.has(id)) { out[lane].push(id); placed.add(id); }
  }
  return out;
}

/** The positions (into `seq`) of one longest strictly increasing subsequence. */
function longestIncreasing(seq: readonly number[]): Set<number> {
  const tails: number[] = [];
  const prevOf: number[] = new Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (seq[tails[mid]] < seq[i]) lo = mid + 1; else hi = mid; }
    if (lo > 0) prevOf[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const keep = new Set<number>();
  for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prevOf[k]) keep.add(k);
  return keep;
}

/**
 * Cards that moved between two layouts: a lane change, or (N5) a card whose
 * order against the cards around it changed. The cards that kept their
 * relative order (one longest run) are not moved, so a card arriving at the
 * top, or one leaving, never marks every card below it. New cards are not moved.
 */
export function movedCards(prev: KanbanLayout, next: KanbanLayout): string[] {
  const at = new Map<string, { lane: string; i: number }>();
  for (const [lane, ids] of Object.entries(prev)) ids.forEach((id, i) => at.set(id, { lane, i }));
  const moved: string[] = [];
  for (const [lane, ids] of Object.entries(next)) {
    const stayed = ids.filter((id) => at.get(id)?.lane === lane);
    const keep = longestIncreasing(stayed.map((id) => at.get(id)!.i));
    const kept = new Set(stayed.filter((_, k) => keep.has(k)));
    for (const id of ids) {
      const was = at.get(id);
      if (was !== undefined && (was.lane !== lane || !kept.has(id))) moved.push(id);
    }
  }
  return moved;
}

/**
 * The released layout with the held lanes on top: a held lane draws its snapshot
 * (cards still on the board, a card that arrived joins the end); a card a held
 * lane keeps is drawn there only.
 */
export function applyHolds(m: KanbanLayout, snaps: ReadonlyMap<string, readonly string[]>): KanbanLayout {
  if (snaps.size === 0) return m;
  const exists = new Set<string>();
  for (const ids of Object.values(m)) for (const id of ids) exists.add(id);
  const out: Record<string, string[]> = {};
  const placed = new Set<string>();
  const lanes = Object.keys(m);
  for (const lane of lanes) {
    const s = snaps.get(lane);
    if (!s) continue;
    out[lane] = s.filter((id) => exists.has(id) && !placed.has(id));
    for (const id of out[lane]) placed.add(id);
  }
  for (const lane of lanes) {
    if (snaps.has(lane)) continue;
    out[lane] = m[lane].filter((id) => !placed.has(id));
    for (const id of out[lane]) placed.add(id);
  }
  for (const lane of lanes) {
    if (!snaps.has(lane)) continue;
    for (const id of m[lane]) if (!placed.has(id)) { out[lane].push(id); placed.add(id); }
  }
  const res: Record<string, string[]> = {};
  for (const lane of lanes) res[lane] = out[lane];
  return sameLayout(res, m) ? m : res;
}

/** The lane holding a card in a layout. */
export function laneOf(layout: KanbanLayout, taskId: string): string | null {
  for (const [lane, ids] of Object.entries(layout)) if (ids.includes(taskId)) return lane;
  return null;
}

/** What a hold covers: a lane, or the lane a card is drawn in. No scope = every lane. */
export interface HoldScope { lane?: string; card?: string }
const ALL = '\u0000all';

export interface FreezeApi {
  /** The layout to draw. */
  layout: KanbanLayout;
  /** Cards flashing `data-moved`. */
  moved: ReadonlySet<string>;
  frozen: boolean;
  /** The reasons holding it now, sorted (the lanes host shows them as `data-hold`). */
  holds: string;
  /** The lanes held now, sorted (`data-held-lanes`); `*` when a drag holds every lane. */
  heldLanes: string;
  /** A reason to hold; held until released. No scope holds every lane. */
  hold(reason: string, on: boolean, scope?: HoldScope): void;
  /** The user's own write: apply the live layout now. */
  applyNow(): void;
}

export function useKanbanFreeze(live: KanbanLayout): FreezeApi {
  const [reasons, setReasons] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [snaps, setSnaps] = useState<ReadonlyMap<string, readonly string[]>>(() => new Map());
  const [base, setBase] = useState<KanbanLayout>(live);
  const [moved, setMoved] = useState<ReadonlySet<string>>(() => new Set());
  const [nowTick, setNowTick] = useState(0);
  const liveRef = useRef(live);
  liveRef.current = live;
  const baseRef = useRef(base);
  baseRef.current = base;
  const reasonsRef = useRef(reasons);
  const snapsRef = useRef(snaps);
  snapsRef.current = snaps;
  const drawnRef = useRef<KanbanLayout>(live);
  const whole = [...reasons.values()].includes(ALL);

  const draw = (b: KanbanLayout, l: KanbanLayout, s: ReadonlyMap<string, readonly string[]>) => {
    const merged = mergeFrozen(b, l);
    return applyHolds(sameLayout(merged, b) ? b : merged, s);
  };

  const hold = useCallback((reason: string, on: boolean, scope?: HoldScope) => {
    const cur = reasonsRef.current;
    let lane: string | null = ALL;
    if (on && scope) lane = scope.lane ?? (scope.card ? laneOf(drawnRef.current, scope.card) : null);
    const want = on && lane !== null;
    if (want ? cur.get(reason) === lane : !cur.has(reason)) return;
    const next = new Map(cur);
    if (want) next.set(reason, lane!); else next.delete(reason);
    reasonsRef.current = next;
    // The lane as it is on screen now is the one to keep.
    if (want && lane !== ALL && !snapsRef.current.has(lane!)) {
      const s = new Map(snapsRef.current);
      s.set(lane!, [...(drawnRef.current[lane!] ?? [])]);
      snapsRef.current = s;
      setSnaps(s);
    }
    setReasons(next);
  }, []);
  const applyNow = useCallback(() => setNowTick((n) => n + 1), []);

  // The user's own write: the live layout, at once, with no flash (a held lane too).
  useEffect(() => {
    if (nowTick === 0) return;
    const l = liveRef.current;
    setBase(l);
    if (snapsRef.current.size) {
      const s = new Map<string, readonly string[]>();
      for (const lane of snapsRef.current.keys()) if (l[lane]) s.set(lane, [...l[lane]]);
      snapsRef.current = s;
      setSnaps(s);
    }
  }, [nowTick]);

  // Lanes no hold covers any more catch up 400ms later; a lane held again keeps its snapshot.
  const laneTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const held = new Set(reasons.values());
    for (const [lane, t] of laneTimers.current) if (held.has(lane)) { clearTimeout(t); laneTimers.current.delete(lane); }
    for (const lane of snaps.keys()) {
      if (held.has(lane) || laneTimers.current.has(lane)) continue;
      laneTimers.current.set(lane, setTimeout(() => {
        laneTimers.current.delete(lane);
        const s = new Map(snapsRef.current);
        if (!s.delete(lane)) return;
        const prev = drawnRef.current;
        const next = draw(baseRef.current, liveRef.current, s);
        snapsRef.current = s;
        setSnaps(s);
        const m = movedCards(prev, next);
        if (m.length) setMoved(new Set(m));
      }, FREEZE_RELEASE_MS));
    }
  }, [reasons, snaps]); // eslint-disable-line react-hooks/exhaustive-deps

  // Not held as a whole: catch up 400ms after the live layout changed. Keyed by the layout's
  // CONTENT and never re-armed while counting: a fresh `live` object arrives with every status
  // update, and re-arming on each one starved the release for as long as sessions were streaming.
  const liveKey = useMemo(() => JSON.stringify(live), [live]);
  const release = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (whole) {
      if (release.current) { clearTimeout(release.current); release.current = null; }
      return;
    }
    if (release.current || sameLayout(baseRef.current, liveRef.current)) return;
    release.current = setTimeout(() => {
      release.current = null;
      const next = liveRef.current;
      const prev = drawnRef.current;
      setBase(next);
      const m = movedCards(prev, applyHolds(next, snapsRef.current));
      if (m.length) setMoved(new Set(m));
    }, FREEZE_RELEASE_MS);
  }, [whole, liveKey]);
  useEffect(() => () => {
    if (release.current) clearTimeout(release.current);
    release.current = null;
    for (const t of laneTimers.current.values()) clearTimeout(t);
    laneTimers.current.clear();
  }, []);

  useEffect(() => {
    if (moved.size === 0) return;
    const t = setTimeout(() => setMoved(new Set()), MOVED_FLASH_MS);
    return () => clearTimeout(t);
  }, [moved]);

  const layout = useMemo(() => draw(base, live, snaps), [base, live, snaps]); // eslint-disable-line react-hooks/exhaustive-deps
  drawnRef.current = layout;
  const holds = useMemo(() => [...reasons.keys()].sort().join(' '), [reasons]);
  const heldLanes = useMemo(() => (whole ? '*' : [...new Set(reasons.values())].sort().join(' ')), [reasons, whole]);
  return { layout, moved, frozen: reasons.size > 0, holds, heldLanes, hold, applyNow };
}

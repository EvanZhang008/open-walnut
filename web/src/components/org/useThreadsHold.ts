/**
 * A Threads list holds still while he reads it (2026-11-23, the user, of cards that came and went
 * around the one he was reading: "it should remain the exact ... keep this location from changing,
 * or it keeps flashing, some things removed, some added, I cannot tell which one changes"):
 *
 *  - order: while the pointer is over the list, every card keeps the place it had in its list
 *    (hold-order.ts, as the Org list and the task rail hold theirs); a card that arrives meanwhile
 *    goes after them, one that leaves is gone. The pointer leaving lets the order follow again;
 *  - position: the card at the top of the view stays where it is on screen when cards above it
 *    come, go or change height, a move's note included (useScrollAnchor, on the box that scrolls
 *    the list, in both engines: WebKit has no CSS scroll anchoring, org-threads.css turns
 *    Chromium's own off there).
 *
 * Both lists of OrgThreads use it: the plain list and the groups (OrgThreadsByState).
 */
import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import type { OrgThread } from '@/api/org-threads';
import { useScrollAnchor } from '@/hooks/useScrollAnchor';
import { usePointerHold } from './hold-order';

/** The cards a person reads by: the anchor is the first one in view. */
export const THREAD_CARD_ROWS = '[data-testid="org-thread"]';

/** The nearest box above `el` that scrolls vertically (the rail's or the session pane's body). */
export function scrollBoxOf(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if (y === 'auto' || y === 'scroll') return p;
  }
  return null;
}

/** `list` in the order `at` gives (the held order), each card not in it after the rest in its own order. Pure. */
export function inHeldOrder(list: readonly OrgThread[], at: ReadonlyMap<string, number>): OrgThread[] {
  const end = at.size;
  return list.map((t, i) => ({ t, i, k: at.get(t.id) ?? end + i })).sort((a, b) => a.k - b.k).map((x) => x.t);
}

export function useThreadsHold<G extends string>(rootRef: RefObject<HTMLElement | null>, open: readonly OrgThread[], groups: Readonly<Record<G, readonly OrgThread[]>> | null): {
  open: readonly OrgThread[];
  groups: Record<G, OrgThread[]> | null;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
} {
  const rows = useMemo(() => (groups ? (Object.values(groups) as OrgThread[][]).flat() : [...open]).map((t) => ({ key: t.id })), [open, groups]);
  const { shown, onPointerEnter, onPointerLeave } = usePointerHold(rows);
  const held = useMemo(() => {
    const at = new Map(shown.map((r, i) => [r.key, i]));
    return {
      open: inHeldOrder(open, at),
      groups: groups ? Object.fromEntries(Object.entries(groups).map(([g, list]) => [g, inHeldOrder(list as readonly OrgThread[], at)])) as Record<G, OrgThread[]> : null,
    };
  }, [shown, open, groups]);
  // The box is found from the list's own root each commit, before the anchor reads it (effects run in order).
  const boxRef = useRef<HTMLElement | null>(null);
  const rootSeen = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (rootSeen.current === rootRef.current && boxRef.current?.isConnected) return;
    rootSeen.current = rootRef.current;
    boxRef.current = scrollBoxOf(rootRef.current);
  });
  useScrollAnchor(boxRef, THREAD_CARD_ROWS);
  return { ...held, onPointerEnter, onPointerLeave };
}

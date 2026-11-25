/**
 * A Threads list holds still while he reads it (2026-11-23, the user, of cards that came and went
 * around the one he was reading: "it should remain the exact ... keep this location from changing,
 * or it keeps flashing, some things removed, some added, I cannot tell which one changes"):
 *
 *  - order: while he is at the list (the pointer over it, or the focus in it: a Follow up box he
 *    types in), every card keeps the place it had in its list (hold-order.ts, as the Org list and
 *    the task rail hold theirs); a card that arrives meanwhile goes after them, one that leaves is
 *    gone. Leaving the list lets the order follow again;
 *  - position: the card he reads stays where it is on screen when anything above it comes, goes
 *    or changes height (a card, a group's head, Watching, a move's note, a read after a reconnect):
 *    at the list, the card under the pointer or holding the focus, at the very top too (2026-11-25,
 *    the user: a new card above "still pushes my page out"; the top of the view was held, and at
 *    the very top nothing); away from it, the card at the top of the view, and at the very top
 *    nothing, so new cards show there. useScrollAnchor, on the box that scrolls the list, in both
 *    engines: WebKit has no CSS scroll anchoring, org-threads.css turns Chromium's own off there.
 *
 * Both lists of OrgThreads use it: the plain list and the groups (OrgThreadsByState).
 */
import { useLayoutEffect, useMemo, useRef, type FocusEvent, type PointerEvent, type RefObject } from 'react';
import type { OrgThread } from '@/api/org-threads';
import { useScrollAnchor } from '@/hooks/useScrollAnchor';
import { SCROLL_REPICK_EVENT } from '@/hooks/scroll-anchor';
import { usePointerHold } from './hold-order';
import { isTypingField } from '@/utils/focus-unless-typing';

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

/**
 * A focus that says he is at the list: in a box he types in, or one the keyboard moved
 * (`:focus-visible`). A button Chromium focused on a click says nothing once the pointer left.
 */
export function focusReads(el: Element | null): boolean {
  if (!el) return false;
  return isTypingField(el) || (typeof el.matches === 'function' && el.matches(':focus-visible'));
}

/**
 * The card he reads while he is at the list: the one holding his focus (focusReads), else the one
 * under the pointer, else (the pointer between cards: a group's head, a line) the first card below
 * it, else (below every card: a folded group's head under Done) the last card above it, so what is
 * under the pointer stays still (2026-11-25, a review: the list itself was held there, whose top
 * never moves, and a new card above pushed everything 265px). Cards with no box (inside a fold) are
 * skipped. The list itself only with no card at all: he is still at it, with nothing to hold. Null
 * only when he is at neither: the anchor reads that as his leaving the list (useScrollAnchor's room
 * at the top goes, and the top comes back).
 */
export function readCard(root: HTMLElement | null, pointer: { x: number; y: number } | null, doc: Pick<Document, 'activeElement' | 'body' | 'elementFromPoint'> = document): Element | null {
  if (!root) return null;
  const active = doc.activeElement;
  if (active && active !== doc.body && root.contains(active) && focusReads(active)) return active.closest(THREAD_CARD_ROWS) ?? active;
  if (!pointer) return null;
  const hit = doc.elementFromPoint(pointer.x, pointer.y);
  const card = hit && root.contains(hit) ? hit.closest(THREAD_CARD_ROWS) : null;
  if (card) return card;
  let above: Element | null = null;
  for (const el of root.querySelectorAll(THREAD_CARD_ROWS)) {
    if (el.getClientRects().length === 0) continue;
    if (el.getBoundingClientRect().bottom > pointer.y) return el;
    above = el;
  }
  return above ?? root;
}

/** What the list's root spreads: the order's hold and where he is reading. */
export interface ThreadsHoldHandlers {
  onPointerEnter: (e: PointerEvent<HTMLElement>) => void;
  onPointerMove: (e: PointerEvent<HTMLElement>) => void;
  onPointerLeave: (e: PointerEvent<HTMLElement>) => void;
  onFocus: (e: FocusEvent<HTMLElement>) => void;
  onBlur: (e: FocusEvent<HTMLElement>) => void;
}

export function useThreadsHold<G extends string>(rootRef: RefObject<HTMLElement | null>, open: readonly OrgThread[], groups: Readonly<Record<G, readonly OrgThread[]>> | null): {
  open: readonly OrgThread[];
  groups: Record<G, OrgThread[]> | null;
  handlers: ThreadsHoldHandlers;
} {
  const rows = useMemo(() => (groups ? (Object.values(groups) as OrgThread[][]).flat() : [...open]).map((t) => ({ key: t.id })), [open, groups]);
  const hold = usePointerHold(rows);
  const held = useMemo(() => {
    const at = new Map(hold.shown.map((r, i) => [r.key, i]));
    return {
      open: inHeldOrder(open, at),
      groups: groups ? Object.fromEntries(Object.entries(groups).map(([g, list]) => [g, inHeldOrder(list as readonly OrgThread[], at)])) as Record<G, OrgThread[]> : null,
    };
  }, [hold.shown, open, groups]);
  // The box is found from the list's own root each commit, before the anchor reads it (effects run in order).
  const boxRef = useRef<HTMLElement | null>(null);
  const rootSeen = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (rootSeen.current === rootRef.current && boxRef.current?.isConnected) return;
    rootSeen.current = rootRef.current;
    boxRef.current = scrollBoxOf(rootRef.current);
  });
  // Where the pointer is over the list, and the card it was last over: a new card under it is a new
  // card he reads, picked again at once (no scroll or commit would pick it).
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const over = useRef<Element | null>(null);
  const repick = () => boxRef.current?.dispatchEvent(new Event(SCROLL_REPICK_EVENT));
  useScrollAnchor(boxRef, THREAD_CARD_ROWS, false, () => readCard(rootRef.current, pointer.current));
  // A focus that dropped to the page (its card left: no blur is sent) holds the order no longer.
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (rootRef.current && (!active || active === document.body)) hold.onBlur({ currentTarget: rootRef.current, relatedTarget: null });
  });
  const handlers: ThreadsHoldHandlers = {
    onPointerEnter: (e) => { pointer.current = { x: e.clientX, y: e.clientY }; hold.onPointerEnter(); repick(); },
    onPointerMove: (e) => {
      pointer.current = { x: e.clientX, y: e.clientY };
      const card = e.target instanceof Element ? e.target.closest(THREAD_CARD_ROWS) : null;
      if (card !== over.current) { over.current = card; repick(); }
    },
    onPointerLeave: (e) => { pointer.current = null; over.current = null; hold.onPointerLeave(e); repick(); },
    onFocus: (e) => { if (!focusReads(e.target instanceof Element ? e.target : null)) return; hold.onFocus(); repick(); },
    onBlur: (e) => { hold.onBlur(e); if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) repick(); },
  };
  return { ...held, handlers };
}

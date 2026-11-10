/**
 * Scroll anchoring by hand: when something above the rows a person is reading changes height, the
 * box scrolls by the same amount, so the row at the top of the view stays where it was.
 *
 * Chromium does this natively (CSS scroll anchoring) and WebKit, which the Mac app runs, does not. A
 * box that relied on the native one held its rows in Chromium and threw them by the height of
 * whatever landed above in WebKit alone (2026-11-01: the mail sidebar's smart group arriving after
 * the second account's folders moved a scrolled pane by 132px). The box using this hook sets
 * `overflow-anchor: none`, so both engines run this one mechanism and never two corrections at once.
 *
 * Held: the row at the top of the view, picked the way the native anchoring picks it (see
 * `pickAnchor`). Corrected on every commit of the owner (before paint) and whenever a direct child
 * of the box changes size (a child's own render, a font, an image). Re-picked on every scroll.
 * Nothing is held at the very top: a person there is looking at the start of the list, and what
 * lands at the start is what they should see. A correction is a plain `scrollTop` write, so one
 * that lands during a trackpad fling ends the fling, where the native one would adjust it; it only
 * happens when something above really moved.
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { anchoredScrollTop, SCROLL_HELD_ATTR, SCROLL_RELEASED_EVENT, type AnchorMark } from './scroll-anchor';

interface Anchor extends AnchorMark {
  el: Element;
  /** The rows right before and after it when it was picked (see `stillInOrder`). */
  prev: Element | null;
  next: Element | null;
}

const hasBox = (el: Element) => el.getClientRects().length > 0;

/**
 * The index of the first row in `list` (document order) whose box reaches below the top edge, or -1.
 * The search starts at `from`, the row held before: a scroll or a commit moves the view by a few
 * rows, so a long list reads the boxes of a handful of rows instead of every row above the view.
 */
function firstReaching(list: Element[], edge: number, from: number): number {
  const reaches = (el: Element) => hasBox(el) && el.getBoundingClientRect().bottom - edge > 0;
  let i = Math.max(0, Math.min(from, list.length - 1));
  while (i < list.length && !reaches(list[i])) i++;
  if (i >= list.length) return -1;
  for (let j = i - 1; j >= 0; j--) {
    if (!hasBox(list[j])) continue;
    if (!reaches(list[j])) break;
    i = j;
  }
  return i;
}

/**
 * The first row (in document order) that is at least partly in view, then the first row inside it
 * that is too, down to the innermost. A row cut by the top edge therefore holds its OWN line rather
 * than the row below it: what opens inside it (a smart row's accounts, below its line) opens in view
 * and nothing scrolls, where anchoring on the next row down would scroll the opened rows out of view.
 */
function pickAnchor(box: HTMLElement, rows: string, hint: Element | null): Anchor | null {
  if (box.scrollTop <= 0) return null;
  const edge = box.getBoundingClientRect().top;
  const height = box.clientHeight;
  let found: { el: Element; top: number; prev: Element | null; next: Element | null } | null = null;
  let scope: Element = box;
  for (;;) {
    const list = Array.from(scope.querySelectorAll(rows));
    const i = firstReaching(list, edge, scope === box && hint ? Math.max(0, list.indexOf(hint)) : 0);
    if (i < 0) break;
    const top = list[i].getBoundingClientRect().top - edge;
    if (top >= height) break;
    found = { el: list[i], top, prev: list[i - 1] ?? null, next: list[i + 1] ?? null };
    scope = list[i];
  }
  return found ? { el: found.el, top: found.top, scrollTop: box.scrollTop, prev: found.prev, next: found.next } : null;
}

/**
 * Whether the held row still sits between the rows it sat between. A row that moved in the list (a
 * drop, a re-sort) is no longer where the person reads: holding it would scroll the whole list after
 * it, so it is let go and a row is picked afresh with no correction, as the browser's own anchoring
 * lets go of a node that moves. Rows added or removed around it keep the order of those that stay.
 */
function stillInOrder(held: Anchor): boolean {
  if (held.prev?.isConnected && !(held.el.compareDocumentPosition(held.prev) & Node.DOCUMENT_POSITION_PRECEDING)) return false;
  if (held.next?.isConnected && !(held.el.compareDocumentPosition(held.next) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
  return true;
}

interface Attached {
  box: HTMLElement;
  stop: () => void;
  observeChildren: () => void;
}

/**
 * `rows` selects the lines a person reads by, inside the box that `ref` points at. While `paused`
 * nothing is held or corrected, and the row held after it is picked afresh: a drag moves its rows
 * by transforms, which a correction would read as rows that moved above the view. The same while
 * another keeper holds the box (`SCROLL_HELD_ATTR`, a fold keeping its clicked row in place).
 */
export function useScrollAnchor(ref: RefObject<HTMLElement | null>, rows: string, paused = false): void {
  const anchor = useRef<Anchor | null>(null);
  const attached = useRef<Attached | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const standsDown = (box: HTMLElement) => pausedRef.current || box.hasAttribute(SCROLL_HELD_ATTR);
  const pick = (box: HTMLElement) => (standsDown(box) ? null : pickAnchor(box, rowsRef.current, anchor.current?.el ?? null));

  // A ref, not a dependency: it is called from the observers attached once per box.
  const keep = useRef((box: HTMLElement) => {
    const held = standsDown(box) ? null : anchor.current;
    if (held && held.el.isConnected && held.el.getClientRects().length > 0 && stillInOrder(held)) {
      const top = held.el.getBoundingClientRect().top - box.getBoundingClientRect().top;
      const target = anchoredScrollTop(held, top, box.scrollTop, box.scrollHeight - box.clientHeight);
      if (target !== box.scrollTop) box.scrollTop = target;
    }
    anchor.current = pick(box);
  }).current;

  useLayoutEffect(() => {
    const box = ref.current;
    if (attached.current?.box !== box) {
      attached.current?.stop();
      anchor.current = null;
      attached.current = box ? attach(box) : null;
    }
    if (!box) return;
    // A child mounted by this commit (the smart group) is watched from now on.
    attached.current?.observeChildren();
    keep(box);
  });

  useEffect(() => () => {
    attached.current?.stop();
    attached.current = null;
  }, []);

  function attach(box: HTMLElement): Attached {
    const onScroll = () => { anchor.current = pick(box); };
    box.addEventListener('scroll', onScroll, { passive: true });
    // The keeper that held the box let go: hold the row on screen from here.
    box.addEventListener(SCROLL_RELEASED_EVENT, onScroll);
    // Fires after layout and before paint, so a correction from here is never drawn as a jump. A
    // scroll changes no size, so the correction cannot feed this observer back.
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => keep(box));
    // Observed once each (observing a target again restarts it and costs a callback per commit), and
    // let go once it leaves the box.
    const watched = new Set<Element>();
    const observeChildren = () => {
      if (!ro) return;
      const now = new Set(Array.from(box.children));
      for (const child of watched) {
        if (now.has(child)) continue;
        ro.unobserve(child);
        watched.delete(child);
      }
      for (const child of now) {
        if (watched.has(child)) continue;
        watched.add(child);
        ro.observe(child);
      }
    };
    observeChildren();
    return {
      box,
      observeChildren,
      stop: () => {
        box.removeEventListener('scroll', onScroll);
        box.removeEventListener(SCROLL_RELEASED_EVENT, onScroll);
        ro?.disconnect();
        watched.clear();
      },
    };
  }
}

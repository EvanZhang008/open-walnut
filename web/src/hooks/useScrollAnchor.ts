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
 * `pickAnchor`). Corrected on every commit of the owner (before paint), whenever a direct child
 * of the box changes size (a child's own render, a font, an image), and on every scroll before it is
 * picked again (a scroll event comes a frame late: see `onScroll`).
 * Nothing is held at the very top: a person there is looking at the start of the list, and what
 * lands at the start is what they should see. A box whose owner knows the row being read (`reading`:
 * the row under the pointer, the one holding the focus) holds THAT row instead, at the very top too
 * (2026-11-25, the Threads list: a new card above the one he read at the top pushed it down). A correction is a plain `scrollTop` write, so one
 * that lands during a trackpad fling ends the fling, where the native one would adjust it; it only
 * happens when something above really moved.
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { anchoredScrollTop, releaseScrollTop, slackStep, SCROLL_HELD_ATTR, SCROLL_RELEASED_EVENT, SCROLL_REPICK_EVENT, type AnchorMark, type ReadSession } from './scroll-anchor';

interface Anchor extends AnchorMark {
  el: Element;
  /** The row the person reads (`reading`): held with room at the top when no scroll can hold it. */
  read?: boolean;
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
function pickAnchor(box: HTMLElement, rows: string, hint: Element | null, reading: Element | null): Anchor | null {
  const read = reading ? readAnchor(box, rows, reading) : null;
  if (read) return read;
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

/** The row being read, held where it is while any of it is in view (null otherwise: the usual pick). */
function readAnchor(box: HTMLElement, rows: string, el: Element): Anchor | null {
  if (!box.contains(el) || !hasBox(el)) return null;
  const edge = box.getBoundingClientRect().top;
  const r = el.getBoundingClientRect();
  if (r.bottom <= edge || r.top - edge >= box.clientHeight) return null;
  const list = Array.from(box.querySelectorAll(rows));
  const i = list.indexOf(el);
  return { el, read: true, top: r.top - edge, scrollTop: box.scrollTop, prev: i > 0 ? list[i - 1] : null, next: i >= 0 ? list[i + 1] ?? null : null };
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
 * `reading` (read at every pick) names the row the person reads now, or null when they are not at
 * the box: that row is held, at the very top too, and when what stands above it got shorter than
 * the box can scroll up, the box keeps the missing height as room at its top (slackStep) until they
 * leave; leaving goes back to the very top when they were there as the hold began and did not
 * scroll themselves (releaseScrollTop). A box with no `reading` is held exactly as before.
 */
export function useScrollAnchor(ref: RefObject<HTMLElement | null>, rows: string, paused = false, reading?: () => Element | null): void {
  const anchor = useRef<Anchor | null>(null);
  const attached = useRef<Attached | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const readingRef = useRef(reading);
  readingRef.current = reading;
  const standsDown = (box: HTMLElement) => pausedRef.current || box.hasAttribute(SCROLL_HELD_ATTR);
  // The room kept at the top for the row being read (px), the box's own top padding before it.
  const slack = useRef(0);
  const padWas = useRef<{ inline: string; px: number } | null>(null);
  // The person at the box since when (a hold), and the scroll this hook wrote last (its own, not theirs).
  const session = useRef<ReadSession | null>(null);
  const own = useRef<number | null>(null);
  const write = (box: HTMLElement, top: number) => {
    const to = Math.max(0, Math.min(box.scrollHeight - box.clientHeight, top));
    if (Math.abs(to - box.scrollTop) < 0.5) return;
    own.current = to;
    box.scrollTop = to;
  };
  const setSlack = (box: HTMLElement, px: number) => {
    if (px === slack.current) return;
    if (!padWas.current) padWas.current = { inline: box.style.paddingTop, px: parseFloat(getComputedStyle(box).paddingTop) || 0 };
    box.style.paddingTop = px > 0 ? `${padWas.current.px + px}px` : padWas.current.inline;
    if (px === 0) padWas.current = null;
    slack.current = px;
  };
  // At the box or not, read at every pick: leaving lets the room go and may go back to the top.
  const presence = (box: HTMLElement, at: boolean) => {
    if (at && !session.current) session.current = { fromTop: box.scrollTop <= 0 && slack.current === 0, scrolled: false };
    if (at || !session.current) return;
    const to = releaseScrollTop(session.current, slack.current, box.scrollTop);
    session.current = null;
    setSlack(box, 0);
    write(box, to);
  };
  const pick = (box: HTMLElement) => {
    if (standsDown(box)) return null;
    const reading = readingRef.current?.() ?? null;
    if (readingRef.current) presence(box, reading !== null);
    return pickAnchor(box, rowsRef.current, anchor.current?.el ?? null, reading);
  };

  // A ref, not a dependency: it is called from the observers attached once per box.
  const keep = useRef((box: HTMLElement) => {
    const held = standsDown(box) ? null : anchor.current;
    if (held && held.el.isConnected && held.el.getClientRects().length > 0 && stillInOrder(held)) {
      const top = held.el.getBoundingClientRect().top - box.getBoundingClientRect().top;
      const max = box.scrollHeight - box.clientHeight;
      if (held.read) {
        // The row being read: what no scroll can do, room at the top does.
        const step = slackStep(slack.current, anchoredScrollTop(held, top, box.scrollTop, max, -Infinity));
        setSlack(box, step.slack);
        write(box, step.scrollTop);
      } else {
        write(box, anchoredScrollTop(held, top, box.scrollTop, max));
      }
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
    // A scroll event is dispatched a frame after the scroll, and a commit that moved the rows in
    // between (a child's own render: a Threads move line) would be taken as where the row stands
    // now, its move never put back (2026-11-25: every "Moved to ..." line above the card he read
    // pushed it 38px). So the row is put back first: the person's own scroll since the mark is
    // taken out of the drift (anchorDrift), only what the layout moved is corrected.
    const onScroll = () => {
      // Not this hook's own correction: the person (or a jump they asked for) scrolled.
      if (own.current !== null && Math.abs(box.scrollTop - own.current) < 1) own.current = null;
      else if (session.current) session.current.scrolled = true;
      keep(box);
    };
    const pickAgain = () => keep(box);
    box.addEventListener('scroll', onScroll, { passive: true });
    // The keeper that held the box let go: hold the row on screen from here.
    box.addEventListener(SCROLL_RELEASED_EVENT, pickAgain);
    // The row being read changed with nothing scrolled or drawn (its owner says so).
    box.addEventListener(SCROLL_REPICK_EVENT, pickAgain);
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
        box.removeEventListener(SCROLL_RELEASED_EVENT, pickAgain);
        box.removeEventListener(SCROLL_REPICK_EVENT, pickAgain);
        ro?.disconnect();
        setSlack(box, 0);
        session.current = null;
        watched.clear();
      },
    };
  }
}

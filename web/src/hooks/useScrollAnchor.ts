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
import { ANCHOR_SLOP_PX, anchoredScrollTop, endClamp, enginePull, heldPlace, holdsRows, releaseScrollTop, roomBelow, slackStep, SCROLL_HELD_ATTR, SCROLL_INPUT_EVENTS, SCROLL_RELEASED_EVENT, SCROLL_REPICK_EVENT, stepScrollInput, type AnchorMark, type ReadSession, type ScrollInput } from './scroll-anchor';
import { isTypingField } from '@/utils/focus-unless-typing';

interface Anchor extends AnchorMark {
  el: Element;
  /** The row the person reads (`reading`): held with room at the top when no scroll can hold it. */
  read?: boolean;
  /** The rows right before and after it when it was picked (see `stillInOrder`). */
  prev: Element | null;
  next: Element | null;
  /** Where those two stood then (a row with a box): in a box with `reading`, one holds the place should the row leave (heldPlace). */
  prevTop?: number;
  nextTop?: number;
  /** A neighbour holding the place of a row that left it: kept until the person moves or scrolls. */
  stand?: boolean;
  /** The box sat at the end of its range when it was picked, at `at` (enginePull). */
  atEnd?: boolean;
  at?: number;
}

const hasBox = (el: Element) => el.getClientRects().length > 0;
/** A row still drawn: in the document, with a box. */
const drawn = (el: Element | null): el is Element => !!el && el.isConnected && hasBox(el);

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
  if (!found) return null;
  const topOf = (row: Element | null) => (row && hasBox(row) ? row.getBoundingClientRect().top - edge : undefined);
  return { el: found.el, top: found.top, scrollTop: box.scrollTop, prev: found.prev, next: found.next, prevTop: topOf(found.prev), nextTop: topOf(found.next) };
}

/**
 * The row being read, held where it is while any of it is in view (null otherwise: the usual pick).
 * A container (the box, a list of rows) is no row: the usual pick, with the person still at the box.
 */
function readAnchor(box: HTMLElement, rows: string, el: Element): Anchor | null {
  if (!box.contains(el) || !hasBox(el) || holdsRows(box, rows, el)) return null;
  const edge = box.getBoundingClientRect().top;
  const r = el.getBoundingClientRect();
  if (r.bottom <= edge || r.top - edge >= box.clientHeight) return null;
  const list = Array.from(box.querySelectorAll(rows));
  const i = list.indexOf(el);
  const prev = i > 0 ? list[i - 1] : null;
  const next = i >= 0 ? list[i + 1] ?? null : null;
  const topOf = (row: Element | null) => (row && hasBox(row) ? row.getBoundingClientRect().top - edge : undefined);
  return { el, read: true, top: r.top - edge, scrollTop: box.scrollTop, prev, next, prevTop: topOf(prev), nextTop: topOf(next) };
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

/**
 * Room kept at one edge of a box for the row being read, as padding on that edge. The box's own
 * padding there is read once, as the room is first made: a stylesheet change while the room is kept
 * (a breakpoint) is not seen until the room goes (restoring the inline value is always right).
 */
function edgeRoom(side: 'paddingTop' | 'paddingBottom') {
  let was: { inline: string; px: number } | null = null;
  const r = {
    px: 0,
    set(box: HTMLElement, px: number) {
      if (px === r.px) return;
      if (!was) was = { inline: box.style[side], px: parseFloat(getComputedStyle(box)[side]) || 0 };
      box.style[side] = px > 0 ? `${was.px + px}px` : was.inline;
      if (px === 0) was = null;
      r.px = px;
    },
  };
  return r;
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
 * scroll themselves (releaseScrollTop). Should that row itself leave its place (a card he answers
 * goes to another group), the row drawn right before it, else right after it, holds the place
 * (heldPlace) until they move or scroll. A box with no `reading` is held exactly as before.
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
  // The room kept at the top and at the bottom for the row being read (edgeRoom). Only a box with
  // `reading` ever makes any: every other box keeps its layout.
  const room = useRef({ top: edgeRoom('paddingTop'), bottom: edgeRoom('paddingBottom') }).current;
  // The person at the box since when (a hold), and the scroll this hook wrote last (its own, not theirs).
  const session = useRef<ReadSession | null>(null);
  const own = useRef<number | null>(null);
  const input = useRef<ScrollInput>({ at: 0, down: false });
  // The box's scroll as this render began, read only while a row is held at the end of the range:
  // what moved it between here and the commit's keep is the commit's own DOM changes (enginePull).
  const before = useRef<number | null>(null);
  before.current = reading && anchor.current?.atEnd ? ref.current?.scrollTop ?? null : null;
  const write = (box: HTMLElement, top: number) => {
    const to = Math.max(0, Math.min(box.scrollHeight - box.clientHeight, top));
    if (Math.abs(to - box.scrollTop) < 0.5) return;
    own.current = to;
    box.scrollTop = to;
  };
  // The box's true end: its range without the room at the bottom.
  const endOf = (box: HTMLElement) => box.scrollHeight - box.clientHeight - room.bottom.px;
  // The room at the bottom shrinks to what the scroll still stands in: nothing on screen moves.
  const trimBelow = (box: HTMLElement) => {
    if (room.bottom.px > 0) room.bottom.set(box, Math.min(room.bottom.px, roomBelow(box.scrollTop, endOf(box))));
  };
  // At the box or not, read at every pick: leaving lets the room at the top go and may go back to
  // the top; the room at the bottom stays while the view still stands in it (trimBelow).
  const presence = (box: HTMLElement, at: boolean) => {
    if (at && !session.current) session.current = { fromTop: box.scrollTop <= 0 && room.top.px === 0, scrolled: false };
    if (at || !session.current) return;
    const to = releaseScrollTop(session.current, room.top.px, box.scrollTop);
    session.current = null;
    room.top.set(box, 0);
    write(box, to);
    trimBelow(box);
  };
  // Whether the box sat at the end of its range as `a` was picked, and when (enginePull).
  const stampEnd = (box: HTMLElement, a: Anchor | null) => {
    if (a && readingRef.current) { a.atEnd = box.scrollTop >= box.scrollHeight - box.clientHeight - ANCHOR_SLOP_PX; a.at = performance.now(); }
    return a;
  };
  const pick = (box: HTMLElement) => {
    if (standsDown(box)) return null;
    const reading = readingRef.current?.() ?? null;
    if (readingRef.current) presence(box, reading !== null);
    return stampEnd(box, pickAnchor(box, rowsRef.current, anchor.current?.el ?? null, reading));
  };
  // The row kept as held, measured again: the row he reads, or a neighbour holding the place of a row
  // that left it (`stand`, the row being read or the top of the view while he is away: `read`).
  const standIn = (box: HTMLElement, el: Element, read: boolean, stand: boolean) => {
    const a = readAnchor(box, rowsRef.current, el);
    if (a) { a.stand = stand; a.read = read; }
    return stampEnd(box, a);
  };

  // A ref, not a dependency: it is called from the observers attached once per box. `from`: the
  // owner's commit, a child's resize (`mark`: a commit of the list alone) or the owner's repick, where
  // a box with `reading` puts back the engine's own pull (enginePull); never a scroll.
  const keep = useRef((box: HTMLElement, from: 'commit' | 'mark' | 'repick' | null = null) => {
    const held = standsDown(box) ? null : anchor.current;
    // The held row; for a row that left its place in a box with `reading`, a neighbour: the row being
    // read, the one before it, else after it; the top of the view, gone (drawn again in another group),
    // the one after it (still in view), else before. The top of the view only moved in the order (his
    // leaving lets the order follow) is let go, as before: holding a neighbour scrolled the list away.
    const prev = held ? { el: held.prev, top: held.prevTop, ok: drawn(held.prev) } : null;
    const next = held ? { el: held.next, top: held.nextTop, ok: drawn(held.next) } : null;
    const near = !held || !readingRef.current ? [] : held.read ? [prev!, next!] : drawn(held.el) ? [] : [next!, prev!];
    const place = held ? heldPlace([{ el: held.el, top: held.top, ok: drawn(held.el) && stillInOrder(held) }, ...near]) : null;
    if (held && place) {
      const top = place.el.getBoundingClientRect().top - box.getBoundingClientRect().top;
      const max = box.scrollHeight - box.clientHeight;
      // The engine's pull is no scroll of the person's: it is taken out of the mark's scroll.
      // Measured from the scroll as the owner's render began, or, for a commit of the list alone (no
      // render of the owner: the ResizeObserver sees it first), as the row was marked (2026-11-25:
      // WebKit pulled 376px in such a commit, read as his own scroll, and the place moved 193px).
      const since = from === 'commit' ? before.current : from === 'mark' || from === 'repick' ? held.scrollTop : null;
      const pull = since !== null && readingRef.current ? enginePull(held, since, box.scrollTop, input.current) : 0;
      const mark = { top: place.top, scrollTop: held.scrollTop - pull };
      if (readingRef.current) {
        // A box with `reading`: what no scroll can do, room does, at the top for the row being read
        // and at the bottom for any held row (the top of the view too, while he is away).
        const end = endOf(box);
        const raw = anchoredScrollTop(mark, top, box.scrollTop, max, held.read ? -Infinity : 0, Infinity);
        const step = held.read ? slackStep(room.top.px, raw) : { slack: room.top.px, scrollTop: raw };
        room.top.set(box, step.slack);
        room.bottom.set(box, roomBelow(step.scrollTop, end));
        write(box, step.scrollTop);
      } else {
        write(box, anchoredScrollTop(mark, top, box.scrollTop, max));
      }
    }
    if (!(held && place)) trimBelow(box);
    // The row he reads stays the row he reads until he moves, scrolls or leaves: a commit or a child's
    // resize never reads a still pointer again, since what is under it now is not what he read
    // (2026-11-25: at the end of the list a card above left, the pointer then rested on the edge of the
    // card above his, and the move's line drawn next pushed his card 38px). A neighbour standing in for
    // the top of the view while he is away keeps it the same way (its line would push it). So does a
    // repick right after his own row left (2026-11-25: he typed in a card that changed group, the focus
    // followed it into its new group, and holding it there let its move line scroll the list 38px).
    const stand = !!held && !!place && (held.stand || place.el !== held.el);
    const still = !!held && !!place && (from === 'commit' || from === 'mark' || (from === 'repick' && place.el !== held.el)) && (held.read ? (readingRef.current?.() ?? null) !== null : stand);
    anchor.current = still ? standIn(box, place!.el, !!held!.read, stand) ?? pick(box) : pick(box);
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
    keep(box, 'commit');
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
      // Not this hook's own correction: the person (or a jump they asked for) scrolled. The mark of
      // its own write is spent by this event either way, so an old one never excuses a later scroll.
      const mine = own.current !== null && Math.abs(box.scrollTop - own.current) < 1;
      own.current = null;
      // The engine's clamp at the end (a row below got shorter): put back from the mark, as a resize.
      const held = standsDown(box) ? null : anchor.current;
      if (!mine && held && readingRef.current && endClamp(held, box.scrollTop, box.scrollHeight - box.clientHeight, input.current)) return keep(box, 'mark');
      if (!mine && session.current) session.current.scrolled = true;
      // His own scroll ends a neighbour's standing in: the row is picked afresh, and the room at the
      // bottom shrinks as he scrolls up out of it (it never holds him there).
      if (!mine && anchor.current) anchor.current.stand = false;
      if (!mine) trimBelow(box);
      keep(box);
    };
    // Picked again because the keeper let go: no neighbour stands in.
    const pickAgain = () => {
      if (anchor.current) anchor.current.stand = false;
      keep(box);
    };
    // Picked again because the row being read changed (its owner says so). A pull the engine made in
    // the same commit is put back from the mark: WebKit blurs a focused box as its card is removed, so
    // this comes in the middle of that commit, before its keep (2026-11-25: the place moved 193px).
    const pickRead = () => {
      if (anchor.current) anchor.current.stand = false;
      keep(box, 'repick');
    };
    const onInput = (e: Event) => {
      const inField = e.type === 'keydown' && e.target instanceof Element && isTypingField(e.target);
      input.current = stepScrollInput(input.current, { type: e.type, buttons: (e as MouseEvent).buttons, key: (e as KeyboardEvent).key, inField }, performance.now());
    };
    // Only a box that knows the row being read looks for the engine's pull (the others keep as before).
    if (readingRef.current) {
      for (const t of SCROLL_INPUT_EVENTS) window.addEventListener(t, onInput, { capture: true, passive: true });
    }
    box.addEventListener('scroll', onScroll, { passive: true });
    // The keeper that held the box let go: hold the row on screen from here.
    box.addEventListener(SCROLL_RELEASED_EVENT, pickAgain);
    // The row being read changed with nothing scrolled or drawn (its owner says so).
    box.addEventListener(SCROLL_REPICK_EVENT, pickRead);
    // Fires after layout and before paint, so a correction from here is never drawn as a jump. A
    // scroll changes no size, so the correction cannot feed this observer back.
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => keep(box, 'mark'));
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
        box.removeEventListener(SCROLL_REPICK_EVENT, pickRead);
        for (const t of SCROLL_INPUT_EVENTS) window.removeEventListener(t, onInput, true);
        ro?.disconnect();
        room.top.set(box, 0);
        room.bottom.set(box, 0);
        session.current = null;
        watched.clear();
      },
    };
  }
}

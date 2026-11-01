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
import { anchoredScrollTop, type AnchorMark } from './scroll-anchor';

interface Anchor extends AnchorMark {
  el: Element;
}

/**
 * The first row (in document order) that is at least partly in view, then the first row inside it
 * that is too, down to the innermost. A row cut by the top edge therefore holds its OWN line rather
 * than the row below it: what opens inside it (a smart row's accounts, below its line) opens in view
 * and nothing scrolls, where anchoring on the next row down would scroll the opened rows out of view.
 */
function pickAnchor(box: HTMLElement, rows: string): Anchor | null {
  if (box.scrollTop <= 0) return null;
  const edge = box.getBoundingClientRect().top;
  const height = box.clientHeight;
  let found: { el: Element; top: number } | null = null;
  let scope: Element = box;
  for (;;) {
    let next: { el: Element; top: number } | null = null;
    for (const el of Array.from(scope.querySelectorAll(rows))) {
      if (el.getClientRects().length === 0) continue;
      const rect = el.getBoundingClientRect();
      const top = rect.top - edge;
      if (top >= height) break;
      if (rect.bottom - edge > 0) { next = { el, top }; break; }
    }
    if (!next) break;
    found = next;
    scope = next.el;
  }
  return found ? { el: found.el, top: found.top, scrollTop: box.scrollTop } : null;
}

interface Attached {
  box: HTMLElement;
  stop: () => void;
  observeChildren: () => void;
}

/** `rows` selects the lines a person reads by, inside the box that `ref` points at. */
export function useScrollAnchor(ref: RefObject<HTMLElement | null>, rows: string): void {
  const anchor = useRef<Anchor | null>(null);
  const attached = useRef<Attached | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // A ref, not a dependency: it is called from the observers attached once per box.
  const keep = useRef((box: HTMLElement) => {
    const held = anchor.current;
    if (held && held.el.isConnected && held.el.getClientRects().length > 0) {
      const top = held.el.getBoundingClientRect().top - box.getBoundingClientRect().top;
      const target = anchoredScrollTop(held, top, box.scrollTop, box.scrollHeight - box.clientHeight);
      if (target !== box.scrollTop) box.scrollTop = target;
    }
    anchor.current = pickAnchor(box, rowsRef.current);
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
    const onScroll = () => { anchor.current = pickAnchor(box, rowsRef.current); };
    box.addEventListener('scroll', onScroll, { passive: true });
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
        ro?.disconnect();
        watched.clear();
      },
    };
  }
}

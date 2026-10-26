/**
 * The letter reader's conversation pane: its own scroll next to the document's,
 * opening at the newest turn (rules in thread-pane-model.ts).
 *
 * All of it is DOM work on refs, never React state, except the "New reply"
 * button: a resize or a scroll must not re-render the letter (a rich body would
 * re-parse its markdown on every wheel tick).
 *
 * Position is kept by hand, the same in every engine: while the reader follows
 * the end, every size change puts them back at it; while they read older turns,
 * the turn at the top of the pane keeps its place when something above or
 * inside it changes height (an image or a rich body finishing its layout).
 * WebKit has no CSS scroll anchoring, so `overflow-anchor` is off and this is
 * the only anchoring there is.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { clampShare, distanceFromEnd, docPaneMax, FOLLOW_WITHIN } from './thread-pane-model';

interface Anchor { el: Element; top: number }

/** The turn at the top of the visible part, and how far below the pane's top it sits. */
function pickAnchor(scroller: HTMLElement): Anchor | null {
  const top = scroller.getBoundingClientRect().top;
  for (const el of scroller.querySelectorAll('.hib-turn')) {
    const rect = el.getBoundingClientRect();
    if (rect.bottom > top) return { el, top: rect.top - top };
  }
  return null;
}

/**
 * What the two panes share: the view minus its head, meta and composer. Read
 * from the view, never from the panes, because before the first sizing the
 * document pane is as tall as its content and overflows.
 */
function paneSpace(view: HTMLElement, doc: HTMLElement, pane: HTMLElement): number {
  let chrome = 0;
  for (const child of view.children) {
    if (child !== doc && child !== pane) chrome += (child as HTMLElement).offsetHeight;
  }
  return view.clientHeight - chrome;
}

/** Vertical padding of an element, from its computed style. */
function paddingY(el: HTMLElement): number {
  const style = getComputedStyle(el);
  return (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
}

export function useThreadPane({ letterId, turns, enabled }: {
  letterId: string;
  /** Thread length: a longer thread while the reader is up the pane shows "New reply". */
  turns: number;
  /** The pane is on screen (the letter has a thread). */
  enabled: boolean;
}) {
  const viewRef = useRef<HTMLDivElement | null>(null);
  const docRef = useRef<HTMLDivElement | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const following = useRef(true);
  const anchor = useRef<Anchor | null>(null);
  const dragged = useRef<number | undefined>(undefined);
  const seenTurns = useRef(turns);
  // The pane's sizes when last seen (a scroll event, a resize, a scroll we
  // made). Only the reader may take a follower away from the end, and a scroll
  // event the reader did not cause comes with a size change: the browser
  // clamping after the content shrank (an image reloading). Without this, a
  // clamp event dispatched after the content grew back read as "scrolled up"
  // and stranded a reader who was following.
  const seenSize = useRef({ h: 0, c: 0 });
  // Wheel and touch (with its fling) count as the reader's even when a size
  // changed under them in the same moment.
  const inputUntil = useRef(0);
  const [newBelow, setNewBelow] = useState(false);

  // Every letter opens at its newest turn, with the default split.
  useLayoutEffect(() => {
    following.current = true;
    anchor.current = null;
    dragged.current = undefined;
    seenTurns.current = 0;
    inputUntil.current = 0;
    setNewBelow(false);
  }, [letterId]);

  /** Size the document pane; the conversation pane takes the rest. */
  const layout = useCallback(() => {
    const view = viewRef.current;
    const doc = docRef.current;
    if (!view || !doc) return;
    const pane = paneRef.current;
    const scroller = scrollRef.current;
    if (!enabled || !pane || !scroller) {
      doc.style.maxHeight = '';
      view.style.removeProperty('--hib-doc-frame');
      return;
    }
    const avail = paneSpace(view, doc, pane);
    // The bar, the border and the scroll's own padding count, not only the turns.
    const threadNeed = pane.offsetHeight - scroller.clientHeight + scroller.scrollHeight;
    const max = docPaneMax(avail, threadNeed, dragged.current);
    doc.style.maxHeight = `${max}px`;
    // The document's own frame fills the pane exactly. A frame that left the
    // pane taller or shorter than this number would move the number again on
    // the next pass, since the pane is part of what sizes the reader.
    view.style.setProperty('--hib-doc-frame', `${Math.max(0, max - paddingY(doc))}px`);
  }, [enabled]);

  const noteSize = (el: HTMLElement) => { seenSize.current = { h: el.scrollHeight, c: el.clientHeight }; };

  const keepPlace = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (following.current) {
      el.scrollTop = el.scrollHeight;
    } else {
      const a = anchor.current;
      if (a && a.el.isConnected) {
        const drift = a.el.getBoundingClientRect().top - el.getBoundingClientRect().top - a.top;
        if (Math.abs(drift) >= 1) el.scrollTop += drift;
      }
    }
    noteSize(el);
  }, []);

  // Before paint, on every render: a re-render may have changed either pane.
  useLayoutEffect(() => {
    layout();
    keepPlace();
  });

  useEffect(() => {
    if (!enabled || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      // The place is kept now, before this frame paints. The split waits for
      // the next frame: resizing a pane inside this callback resizes observed
      // elements above the one that changed, which the browser reports as an
      // undelivered ResizeObserver loop.
      keepPlace();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { layout(); keepPlace(); });
    });
    for (const el of [viewRef.current, scrollRef.current, innerRef.current]) if (el) ro.observe(el);
    const scroller = scrollRef.current;
    const input = (ms: number) => () => { inputUntil.current = performance.now() + ms; };
    const listeners: [string, EventListener][] = [
      ['wheel', input(400)], ['touchstart', input(400)], ['touchmove', input(400)],
      // A fling keeps scrolling after the finger lifts.
      ['touchend', input(2500)],
    ];
    for (const [type, fn] of listeners) scroller?.addEventListener(type, fn, { passive: true });
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
      for (const [type, fn] of listeners) scroller?.removeEventListener(type, fn);
    };
  }, [enabled, letterId, layout, keepPlace]);

  // A turn that arrives while the reader is up the pane: say so, never move them.
  useEffect(() => {
    if (turns > seenTurns.current && seenTurns.current > 0 && !following.current) setNewBelow(true);
    seenTurns.current = turns;
  }, [turns]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const sameSize = el.scrollHeight === seenSize.current.h && el.clientHeight === seenSize.current.c;
    noteSize(el);
    if (distanceFromEnd(el) <= FOLLOW_WITHIN) {
      following.current = true;
      anchor.current = null;
      setNewBelow(false);
      return;
    }
    // Keys, the scrollbar, find-in-page and a screen reader move the pane
    // without changing its size; a clamp always comes with a size change.
    const byReader = sameSize || performance.now() < inputUntil.current;
    if (byReader || !following.current) {
      following.current = false;
      anchor.current = pickAnchor(el);
      return;
    }
    // Not the reader's doing: they were at the end, so they stay there.
    el.scrollTop = el.scrollHeight;
    noteSize(el);
  }, []);

  /** Back to the newest turn, following it again (the button, the human's own send). */
  const follow = useCallback(() => {
    following.current = true;
    anchor.current = null;
    setNewBelow(false);
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      noteSize(el);
    }
  }, []);

  // The bar between the panes moves the split: drag it, double-click resets.
  const setShare = useCallback((share: number | undefined) => {
    dragged.current = share === undefined ? undefined : clampShare(share);
    layout();
    keepPlace();
  }, [layout, keepPlace]);

  const barProps = {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const view = viewRef.current;
      const doc = docRef.current;
      const pane = paneRef.current;
      if (!view || !doc || !pane) return;
      e.preventDefault();
      const bar = e.currentTarget;
      const top = doc.getBoundingClientRect().top;
      const avail = paneSpace(view, doc, pane);
      const grab = e.clientY - bar.getBoundingClientRect().top;
      bar.setPointerCapture(e.pointerId);
      const move = (ev: globalThis.PointerEvent) => setShare((ev.clientY - grab - top) / Math.max(1, avail));
      const up = () => {
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        bar.removeEventListener('pointercancel', up);
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
      bar.addEventListener('pointercancel', up);
    },
    onDoubleClick: () => setShare(undefined),
  };

  return { viewRef, docRef, paneRef, scrollRef, innerRef, onScroll, newBelow, follow, barProps };
}

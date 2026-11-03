/**
 * The fullscreen review sidebar's state (utils/review-sidebar.ts): whether it
 * shows, and where each asked passage sits in content coordinates (the same
 * zero-height-layer trick as useThreadCardPlace), so the cards scroll with the
 * text and nothing reads layout per frame.
 *
 * Passages are measured when the marks re-derive (useThreadMarks' onDerived,
 * already once per frame of DOM change at most) and when the box resizes. A
 * measure that moved nothing changes no state.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { ThreadMark } from '@/utils/thread-mark-hit';
import { anchorsSig, passageNearView, REVIEW_CARD_W, REVIEW_MIN_BOX, reviewGutterOf, reviewSidebarOn, type ReviewGutter } from '@/utils/review-sidebar';
import { useReviewSidebarCollapsed } from './useReviewSidebarCollapsed';
import { log } from '@/utils/log';

export interface ReviewSidebarArgs {
  containerRef: RefObject<HTMLElement | null>;
  conversationMode: boolean;
  hasQuestions: boolean;
}

export interface ReviewSidebar {
  /** It can show here (fullscreen, Conversation Mode, wide, questions): the
   *  passages are measured whether the column is open or folded. */
  available: boolean;
  /** What the history box reserves (null: nothing, no card to show). */
  gutter: ReviewGutter;
  /** The card column shows. */
  on: boolean;
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  layerRef: RefObject<HTMLDivElement | null>;
  /** Question key to its passage's top in the layer's coordinates. */
  anchors: ReadonlyMap<string, number>;
  /** For useThreadMarks: the marks just derived. */
  onMarks: (marks: readonly ThreadMark[]) => void;
}

const NO_ANCHORS: ReadonlyMap<string, number> = new Map();

/** How much taller the text runs with the card column beside it (its width over
 *  the text's width then): a passage's distance from the top row grows by it. */
function narrowScale(box: HTMLElement): number {
  const cs = getComputedStyle(box);
  const text = box.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  const narrow = text - REVIEW_CARD_W - 20;
  return narrow > 120 ? Math.max(1, text / narrow) : 1;
}

/** The first row whose bottom is below the box's top, and where it sits. */
function topRowOnScreen(box: HTMLElement): { id: string; top: number } | null {
  const boxTop = box.getBoundingClientRect().top;
  for (const row of box.querySelectorAll<HTMLElement>('[data-message-id]')) {
    const r = row.getBoundingClientRect();
    if (r.bottom > boxTop) return { id: row.dataset.messageId ?? '', top: r.top - boxTop };
  }
  return null;
}
const REVIEW_EMPTY_HOLD_MS = 1200;

/**
 * Is the passage on a turn the timeline has loaded and draws? A question whose
 * passage sits before "Load earlier turns" has no row here, so it has no card
 * and no place on the bar (2026-10-31, the user: the folded bar showed "1" for
 * an ask on a turn above the loaded ones).
 */
function passageInLoadedTurn(range: Range, container: HTMLElement | null): boolean {
  const node = range.startContainer;
  if (!container || !node.isConnected) return false;
  const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
  const row = el?.closest('[data-message-id]');
  return !!row && container.contains(row);
}

/** The session panel around `el` is fullscreen (useFullscreen's class). */
function inFullscreen(el: HTMLElement | null): boolean {
  return !!el?.closest('.open-walnut-fullscreen');
}

export function useReviewSidebar(a: ReviewSidebarArgs): ReviewSidebar {
  const { containerRef, conversationMode, hasQuestions } = a;
  const [fullscreen, setFullscreen] = useState(false);
  // Only whether the box is wide enough, and only measured in fullscreen: a
  // width in state re-rendered the whole timeline on every frame of a column
  // drag (React bails out on an unchanged boolean).
  const [wide, setWide] = useState(false);
  const available = reviewSidebarOn({ fullscreen, boxWidth: wide ? REVIEW_MIN_BOX : 0, conversationMode, hasQuestions });
  const [collapsed, setCollapsed] = useReviewSidebarCollapsed();

  // Fullscreen is a class on the panel root: follow it.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !conversationMode || !hasQuestions) return;
    const panel = el.closest('.session-panel') ?? el.parentElement;
    const read = () => setFullscreen(inFullscreen(el));
    read();
    const mo = new MutationObserver(read);
    if (panel) mo.observe(panel, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, [containerRef, conversationMode, hasQuestions]);
  // The box's width, while fullscreen only. Its visible height (inside the
  // header and composer padding) goes straight to a CSS variable for the bar,
  // never into state: a column drag must not re-render the timeline per frame.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !fullscreen) { setWide(false); return; }
    const read = () => {
      setWide(el.clientWidth >= REVIEW_MIN_BOX);
      const cs = getComputedStyle(el);
      const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      el.style.setProperty('--review-visible-h', `${Math.max(120, Math.round(el.clientHeight - pad - 8))}px`);
    };
    read();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [containerRef, fullscreen]);

  const layerRef = useRef<HTMLDivElement | null>(null);
  const marksRef = useRef<readonly ThreadMark[]>([]);
  const [anchors, setAnchors] = useState<ReadonlyMap<string, number>>(NO_ANCHORS);
  const sigRef = useRef('');
  const onRef = useRef(available);
  onRef.current = available;

  const measure = useCallback(() => {
    const layer = layerRef.current;
    if (!onRef.current) return;
    if (!layer) {
      if (sigRef.current) { sigRef.current = ''; setAnchors(NO_ANCHORS); }
      return;
    }
    const origin = layer.getBoundingClientRect().top;
    const next = new Map<string, number>();
    for (const m of marksRef.current) {
      if (next.has(m.key) || m.draft || !passageInLoadedTurn(m.range, containerRef.current)) continue;
      const rect = m.range.getClientRects()[0] ?? m.range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) continue;
      const top = Math.round(rect.top - origin);
      if (top < 0) continue;
      next.set(m.key, top);
    }
    const sig = anchorsSig(next);
    if (sig === sigRef.current) return;
    sigRef.current = sig;
    // Which questions the bar counts, by head id (a key carries the quote's words).
    const heads = marksRef.current.filter((m) => next.has(m.key)).map((m) => m.headId ?? '?');
    log.info('thread-review', 'passages beside the text', { count: next.size, headIds: [...new Set(heads)] });
    setAnchors(next.size ? next : NO_ANCHORS);
  }, [containerRef]);

  const onMarks = useCallback((marks: readonly ThreadMark[]) => {
    marksRef.current = marks;
    measure();
  }, [measure]);

  // Text rewraps on a resize and images load without a DOM change of the rows.
  useEffect(() => {
    const el = containerRef.current;
    if (!available || !el) { sigRef.current = ''; setAnchors(NO_ANCHORS); return; }
    measure();
    let raf = 0;
    const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; measure(); }); };
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(later);
    ro?.observe(el);
    el.addEventListener('load', later, true);
    el.addEventListener('toggle', later, true);
    return () => {
      ro?.disconnect();
      el.removeEventListener('load', later, true);
      el.removeEventListener('toggle', later, true);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [available, containerRef, measure]);

  // The column comes at once and goes only after no card has been on screen
  // for REVIEW_EMPTY_HOLD_MS: a frame in which the marks re-derive to nothing
  // (content replaced, a page of turns loading) must not reflow the text twice.
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!available) { setHeld(false); return; }
    if (anchors.size > 0) { setHeld(true); return; }
    const t = setTimeout(() => setHeld(false), REVIEW_EMPTY_HOLD_MS);
    return () => clearTimeout(t);
  }, [available, anchors.size]);
  // Open, the column takes its room only while a card is on screen or about to
  // be (2026-11-03, the user: the chat should be "almost 100%" wide when the
  // review side bar is there with nothing in it; a long conversation with a few
  // asks left a 360px blank column beside the text). Coming needs a passage
  // within half a screen of the visible box, going needs none within a whole
  // screen, so a scroll past one card reflows the text once each way; the top
  // row on screen stays where it was when the text rewraps. Distances are judged
  // as they would be with the column there: the rewrap alone (narrower text runs
  // taller) must never carry a passage across a line, or the column would come
  // and go with no scroll at all.
  const [near, setNear] = useState(false);
  const nearRef = useRef(false);
  const anchorsRef = useRef(anchors);
  anchorsRef.current = anchors;
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const keep = useRef<{ id: string; top: number } | null>(null);
  const checkNear = useCallback(() => {
    const box = containerRef.current;
    const layer = layerRef.current;
    let next = false;
    if (onRef.current && box && layer && anchorsRef.current.size > 0) {
      const base = layer.getBoundingClientRect().top - box.getBoundingClientRect().top;
      const scale = nearRef.current ? 1 : narrowScale(box);
      next = passageNearView([...anchorsRef.current.values()].map((t) => (base + t) * scale), box.clientHeight, nearRef.current);
    }
    if (next === nearRef.current) return;
    // Folded, the bar stays as it is: nothing rewraps, so no row is held.
    keep.current = box && !collapsedRef.current ? topRowOnScreen(box) : null;
    nearRef.current = next;
    setNear(next);
  }, [containerRef]);
  useEffect(() => {
    const el = containerRef.current;
    checkNear();
    if (!available || !el || anchors.size === 0) return;
    let raf = 0;
    const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; checkNear(); }); };
    el.addEventListener('scroll', later, { passive: true });
    return () => { el.removeEventListener('scroll', later); if (raf) cancelAnimationFrame(raf); };
  }, [available, anchors, containerRef, checkNear]);

  // Folded, the bar is there only while a card would be: its count is never 0.
  const cards = anchors.size > 0 || (held && !collapsed) ? Math.max(1, anchors.size) : 0;
  const gutter = reviewGutterOf({ available, collapsed, cards: collapsed || near ? cards : 0 });
  // The text rewraps when the column comes or goes: hold the top row on screen.
  useLayoutEffect(() => {
    const k = keep.current;
    keep.current = null;
    const box = containerRef.current;
    if (!k || !box) return;
    const row = box.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(k.id)}"]`);
    if (!row) return;
    const delta = row.getBoundingClientRect().top - box.getBoundingClientRect().top - k.top;
    if (Math.abs(delta) >= 1) box.scrollTop += delta;
  }, [gutter, containerRef]);
  return { available, gutter, on: gutter === 'open', collapsed, setCollapsed, layerRef, anchors, onMarks };
}

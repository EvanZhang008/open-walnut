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
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { ThreadMark } from '@/utils/thread-mark-hit';
import {
  anchorsSig, clampReviewWidth, isReviewWidth, REVIEW_CARD_W, reviewGutterOf, reviewMinBox, reviewRoomOf, reviewSidebarOn, type ReviewGutter,
} from '@/utils/review-sidebar';
import { usePageView } from '@/utils/view-memory';
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
  /** The card column's width, for its bar (ThreadReviewBar). */
  resize: ReviewResize;
}

/**
 * The card column's width, dragged on its bar (2026-11-10, the user: the line
 * between the text and the cards "can be drag"). One width for every session,
 * kept with the view memory (mirrored to ui-prefs). It is drawn as the CSS
 * variable `--review-col-w` on the fullscreen sheet, read by the history's
 * gutter, the cards and the sheet's outward growth (fullscreen-tab.css), and
 * written straight to the DOM while a drag runs: no render per frame.
 */
export interface ReviewResize {
  /** The width drawn now. */
  width: () => number;
  /** The room the cards and the text share now (undefined: the column is not open). */
  room: () => number | undefined;
  /** Draw this width now, not kept (a drag in progress). */
  preview: (width: number) => void;
  /** Draw and keep it. */
  commit: (width: number, via: string) => void;
  /** Back to the default width. */
  reset: () => void;
  /** A drag runs: the box's own resize leaves the width alone meanwhile. */
  setDragging: (on: boolean) => void;
}

export const REVIEW_WIDTH_VAR = '--review-col-w';

const NO_ANCHORS: ReadonlyMap<string, number> = new Map();
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
  const [want, setWant] = usePageView('session', 'reviewWidth', REVIEW_CARD_W, isReviewWidth);
  const wantRef = useRef(want);
  wantRef.current = want;
  const available = reviewSidebarOn({ fullscreen, boxWidth: wide ? reviewMinBox(want) : 0, conversationMode, hasQuestions, cardWidth: want });
  const [collapsed, setCollapsed] = useReviewSidebarCollapsed();

  // The width drawn: the one wanted, clamped to what the box leaves the text.
  const appliedRef = useRef(clampReviewWidth(want));
  const hostRef = useRef<HTMLElement | null>(null);
  const draggingRef = useRef(false);
  const apply = useCallback((w: number) => {
    appliedRef.current = w;
    const host = containerRef.current?.closest<HTMLElement>('.open-walnut-fullscreen') ?? null;
    if (hostRef.current && hostRef.current !== host) hostRef.current.style.removeProperty(REVIEW_WIDTH_VAR);
    hostRef.current = host;
    if (host && host.style.getPropertyValue(REVIEW_WIDTH_VAR) !== `${w}px`) host.style.setProperty(REVIEW_WIDTH_VAR, `${w}px`);
  }, [containerRef]);
  const room = useCallback((): number | undefined => {
    const el = containerRef.current;
    if (!el || el.getAttribute('data-review-sidebar') !== 'open') return undefined;
    const cs = getComputedStyle(el);
    return reviewRoomOf({
      boxWidth: el.clientWidth, padLeft: parseFloat(cs.paddingLeft) || 0, padRight: parseFloat(cs.paddingRight) || 0, cardWidth: appliedRef.current,
    });
  }, [containerRef]);
  // The box resized, the column opened, or the wanted width changed: draw what fits.
  const fit = useCallback(() => {
    if (draggingRef.current) return;
    apply(clampReviewWidth(wantRef.current, room()));
  }, [apply, room]);
  const fitRef = useRef(fit);
  fitRef.current = fit;

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
      setWide(el.clientWidth >= reviewMinBox(wantRef.current));
      const cs = getComputedStyle(el);
      const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      el.style.setProperty('--review-visible-h', `${Math.max(120, Math.round(el.clientHeight - pad - 8))}px`);
      fitRef.current();
    };
    read();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      hostRef.current?.style.removeProperty(REVIEW_WIDTH_VAR);
      hostRef.current = null;
    };
  }, [containerRef, fullscreen]);
  // A width picked here or in another panel: draw it, and see whether the box still fits.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !fullscreen) return;
    setWide(el.clientWidth >= reviewMinBox(want));
    fit();
  }, [want, fullscreen, containerRef, fit]);

  const resize = useMemo<ReviewResize>(() => ({
    width: () => appliedRef.current,
    room,
    preview: (w) => apply(w),
    commit: (w, via) => {
      draggingRef.current = false;
      apply(w);
      wantRef.current = w;
      log.info('thread-review', 'column width set', { width: w, via });
      setWant(w);
    },
    reset: () => {
      draggingRef.current = false;
      log.info('thread-review', 'column width set', { width: REVIEW_CARD_W, via: 'reset' });
      wantRef.current = REVIEW_CARD_W;
      setWant(REVIEW_CARD_W);
      fitRef.current();
    },
    setDragging: (on) => { draggingRef.current = on; },
  }), [apply, room, setWant]);

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
  // Folded, the bar is there only while a card would be: its count is never 0.
  const gutter = reviewGutterOf({ available, collapsed, cards: anchors.size > 0 || (held && !collapsed) ? Math.max(1, anchors.size) : 0 });
  return { available, gutter, on: gutter === 'open', collapsed, setCollapsed, layerRef, anchors, onMarks, resize };
}

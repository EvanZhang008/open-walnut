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
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { ThreadMark } from '@/utils/thread-mark-hit';
import { anchorsSig, REVIEW_MIN_BOX, reviewSidebarOn } from '@/utils/review-sidebar';

export interface ReviewSidebarArgs {
  containerRef: RefObject<HTMLElement | null>;
  conversationMode: boolean;
  hasQuestions: boolean;
}

export interface ReviewSidebar {
  on: boolean;
  layerRef: RefObject<HTMLDivElement | null>;
  /** Question key to its passage's top in the layer's coordinates. */
  anchors: ReadonlyMap<string, number>;
  /** For useThreadMarks: the marks just derived. */
  onMarks: (marks: readonly ThreadMark[]) => void;
}

const NO_ANCHORS: ReadonlyMap<string, number> = new Map();

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
  const on = reviewSidebarOn({ fullscreen, boxWidth: wide ? REVIEW_MIN_BOX : 0, conversationMode, hasQuestions });

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
  // The box's width, while fullscreen only.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !fullscreen) { setWide(false); return; }
    const read = () => setWide(el.clientWidth >= REVIEW_MIN_BOX);
    read();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [containerRef, fullscreen]);

  const layerRef = useRef<HTMLDivElement | null>(null);
  const marksRef = useRef<readonly ThreadMark[]>([]);
  const [anchors, setAnchors] = useState<ReadonlyMap<string, number>>(NO_ANCHORS);
  const sigRef = useRef('');
  const onRef = useRef(on);
  onRef.current = on;

  const measure = useCallback(() => {
    const layer = layerRef.current;
    if (!onRef.current || !layer) return;
    const origin = layer.getBoundingClientRect().top;
    const next = new Map<string, number>();
    for (const m of marksRef.current) {
      if (next.has(m.key) || m.draft) continue;
      const rect = m.range.getClientRects()[0] ?? m.range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) continue;
      next.set(m.key, Math.round(rect.top - origin));
    }
    const sig = anchorsSig(next);
    if (sig === sigRef.current) return;
    sigRef.current = sig;
    setAnchors(next.size ? next : NO_ANCHORS);
  }, []);

  const onMarks = useCallback((marks: readonly ThreadMark[]) => {
    marksRef.current = marks;
    measure();
  }, [measure]);

  // Text rewraps on a resize and images load without a DOM change of the rows.
  useEffect(() => {
    const el = containerRef.current;
    if (!on || !el) { sigRef.current = ''; setAnchors(NO_ANCHORS); return; }
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
  }, [on, containerRef, measure]);

  return { on, layerRef, anchors, onMarks };
}

/**
 * Question marks (spec 5.4; C26, C36): every passage on the page that has a
 * question under it is painted with a CSS Custom Highlight in its branch hue,
 * and clicking it (with nothing selected) opens that question.
 *
 * Ranges are RE-DERIVED from text after every re-render (AGENTS Range rules: a
 * Range dies with the text node it was built on), rAF-debounced off a
 * MutationObserver. Painted as a faint background in both engines (the WebKit
 * `::highlight` underline is not reliable, and one rule for both engines beats
 * an engine fork); resolved questions paint fainter. Registered AFTER the pin
 * highlight with a higher priority, so a passage that is both pinned and asked
 * shows both and the question wins the click.
 *
 * Highlights cannot be hit-tested and take no `cursor`, so a rAF-throttled
 * pointermove maps the pointer to a caret (thread-mark-hit.ts) and the timeline
 * gets `data-thread-mark-hover` (cursor: pointer) plus an `Open “<title>”` tip.
 * The tip lives in a tiny store read by its own small component: the pointer
 * moves it every frame, and that must never re-render the timeline.
 *
 * A question being answered (`live.keys`) wears its mark without the underline
 * and gets the scanning line instead, drawn into `live.layerRef`
 * (thread-live-lines.ts) on every derive, resize, image load and toggle, and on
 * every scroll when the layer does not scroll with the text.
 */
import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';
import type { SessionPinnedQuote } from '@/types/session';
import {
  caretFromPoint, claimPress, hitMark, rafThrottle, selectionIsEmpty, type ThreadMark,
} from '@/utils/thread-mark-hit';
import { liveLineBars, overflowClipOf, paintLiveBars, textRectsOf, type BoxLike, type LiveBar } from '@/utils/thread-live-lines';
import { log } from '@/utils/log';

export interface ThreadMarkSpec {
  key: string;
  /** The question's head row id: logs name it, never the key (the key carries the quote). */
  headId?: string;
  parentMsgId: string;
  quote: SessionPinnedQuote;
  hue: number;
  resolved: boolean;
  title: string;
  /** Conversation Mode: one neutral paint for every question (no hue). */
  neutral?: boolean;
}

export const MARK_PRIORITY = 2;

/** Highlight name per hue and state (neutral: one grey pair); globals for every
 *  name live in thread-stack-page.css. A live mark (its answer coming in) is the
 *  open mark's fill with no underline: the scanning line draws that. */
export function markHighlightName(hue: number, resolved: boolean, neutral = false, live = false): string {
  const state = live ? '-live' : resolved ? '-done' : '';
  return `thread-mark${state}-${neutral ? 'neutral' : hue}`;
}

// Document-wide paint, merged across panels (CSS.highlights has one namespace).
const panelMarks = new Map<string, Map<string, Range[]>>();
const paintedNames = new Set<string>();

type HighlightCtor = new (...ranges: Range[]) => { priority: number };
function highlightApi(): { reg: Map<string, unknown>; Ctor: HighlightCtor } | null {
  const reg = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
  const Ctor = (globalThis as { Highlight?: HighlightCtor }).Highlight;
  return reg && Ctor ? { reg, Ctor } : null;
}

function repaintMarks() {
  const api = highlightApi();
  if (!api) return;
  const union = new Map<string, Range[]>();
  for (const byName of panelMarks.values()) {
    for (const [name, ranges] of byName) union.set(name, [...(union.get(name) ?? []), ...ranges]);
  }
  for (const name of paintedNames) if (!union.has(name)) api.reg.delete(name);
  paintedNames.clear();
  for (const [name, ranges] of union) {
    const h = new api.Ctor(...ranges);
    h.priority = MARK_PRIORITY;
    api.reg.set(name, h);
    paintedNames.add(name);
  }
}

function setPanelMarks(panelKey: string, marks: ThreadMark[]) {
  const byName = new Map<string, Range[]>();
  for (const m of marks) {
    const name = markHighlightName(m.hue, m.resolved, m.neutral, m.live);
    byName.set(name, [...(byName.get(name) ?? []), m.range]);
  }
  if (byName.size === 0) panelMarks.delete(panelKey); else panelMarks.set(panelKey, byName);
  repaintMarks();
}

export interface UseThreadMarksArgs {
  sessionId: string;
  panelKey: string;
  enabled: boolean;
  containerRef: RefObject<HTMLDivElement | null>;
  specs: readonly ThreadMarkSpec[];
  /** Changes when the rendered rows change (history refetch, page switch). */
  renderNonce: unknown;
  locatePassage: (p: { msgId: string; quote?: SessionPinnedQuote }) => Range | null;
  onOpen: (key: string) => void;
  live?: LiveMarkArgs;
}

export interface LiveMarkArgs {
  /** Questions whose answer is coming in now. */
  keys: ReadonlySet<string>;
  /** Where the scanning lines are drawn (holds nothing else). */
  layerRef: RefObject<HTMLElement | null>;
  /** The layer stays put while the text scrolls (an overlay): re-place on scroll. */
  overlay?: boolean;
  /** Extra clip (viewport) on top of the passage's own clipping ancestors. */
  clip?: () => BoxLike | null;
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((k) => b.has(k));
const NO_KEYS: ReadonlySet<string> = new Set();

/** The questions being answered now, one Set identity while they stay the same
 *  (the live map is rebuilt on every transcript change). */
export function useAnsweringKeys(live: ReadonlyMap<string, string>): ReadonlySet<string> {
  const ref = useRef<ReadonlySet<string>>(NO_KEYS);
  const next = new Set<string>();
  for (const [key, state] of live) if (state === 'answering') next.add(key);
  if (!sameSet(ref.current, next)) ref.current = next.size ? next : NO_KEYS;
  return ref.current;
}

const intersect = (a: BoxLike | null, b: BoxLike | null): BoxLike | null => (!a ? b : !b ? a : {
  left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom),
});

/** The live marks' bars, in `layer`'s coordinates (`within`: the box the layer
 *  lives in, see overflowClipOf). */
export function liveBarsFor(marks: readonly ThreadMark[], layer: HTMLElement, within: Element | null, extraClip: BoxLike | null): Array<LiveBar & { hue?: number }> {
  const out: Array<LiveBar & { hue?: number }> = [];
  let origin: DOMRect | null = null;
  for (const m of marks) {
    if (!m.live) continue;
    origin ??= layer.getBoundingClientRect();
    const clip = intersect(overflowClipOf(m.range, within), extraClip);
    for (const b of liveLineBars(textRectsOf(m.range), origin, clip)) out.push(m.neutral ? b : { ...b, hue: m.hue });
  }
  return out;
}

export interface ThreadMarkTip {
  text: string;
  at: { x: number; y: number };
}

/** The mark tip, outside React state: `set` notifies only on a real change. */
export interface ThreadMarkTipStore {
  get: () => ThreadMarkTip | null;
  subscribe: (listener: () => void) => () => void;
  set: (tip: ThreadMarkTip | null) => void;
}

export function createThreadMarkTipStore(): ThreadMarkTipStore {
  let tip: ThreadMarkTip | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => tip,
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    set: (next) => {
      if (next === tip) return;
      if (next && tip && next.text === tip.text && next.at.x === tip.at.x && next.at.y === tip.at.y) return;
      tip = next;
      for (const l of listeners) l();
    },
  };
}

export function useThreadMarks(args: UseThreadMarksArgs): ThreadMarkTipStore {
  const { panelKey, enabled, containerRef, specs, renderNonce } = args;
  const argsRef = useRef(args);
  argsRef.current = args;
  const marks = useRef<ThreadMark[]>([]);
  const tipStore = useMemo(() => createThreadMarkTipStore(), []);
  const setTip = tipStore.set;
  // A fresh Set every render must not re-derive: the same keys keep their identity.
  const liveKeysRef = useRef<ReadonlySet<string>>(NO_KEYS);
  const nextKeys = args.live?.keys ?? NO_KEYS;
  if (!sameSet(liveKeysRef.current, nextKeys)) liveKeysRef.current = nextKeys;
  const liveKeys = liveKeysRef.current;

  /** Re-place the scanning lines of the live marks (none: the layer empties). */
  const paintLive = useCallback(() => {
    const live = argsRef.current.live;
    const layer = live?.layerRef.current;
    if (!layer) return;
    paintLiveBars(layer, liveBarsFor(marks.current, layer, argsRef.current.containerRef.current, live?.clip?.() ?? null));
  }, []);

  // Derive + paint, and re-derive whenever the text under the ranges changes.
  useEffect(() => {
    const el = containerRef.current;
    const layer = argsRef.current.live?.layerRef.current ?? null;
    if (!enabled || !el || specs.length === 0) {
      marks.current = [];
      setPanelMarks(panelKey, []);
      if (layer) paintLiveBars(layer, []);
      return;
    }
    const derive = () => {
      const out: ThreadMark[] = [];
      for (const s of argsRef.current.specs) {
        const range = argsRef.current.locatePassage({ msgId: s.parentMsgId, quote: s.quote });
        if (range) {
          out.push({
            key: s.key, ...(s.headId ? { headId: s.headId } : {}), range, hue: s.hue, resolved: s.resolved, title: s.title,
            ...(s.neutral ? { neutral: true } : {}), ...(liveKeys.has(s.key) ? { live: true } : {}),
          });
        }
      }
      marks.current = out;
      setPanelMarks(panelKey, out);
      paintLive();
    };
    derive();
    let raf = 0;
    const mo = new MutationObserver(() => {
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; derive(); });
    });
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      mo.disconnect();
      if (raf) cancelAnimationFrame(raf);
      setPanelMarks(panelKey, []);
      if (layer) paintLiveBars(layer, []);
    };
  }, [enabled, containerRef, specs, renderNonce, panelKey, liveKeys, paintLive]);

  // While something is live, its lines follow every layout change that is not
  // a DOM change: the box resizing (text rewraps), an image loading above it, a
  // <details> opening, and a scroll: of an inner scroller (a wide table) for a
  // layer that scrolls with the text, of anything at all for an overlay.
  const liveOn = enabled && liveKeys.size > 0;
  const overlay = !!args.live?.overlay;
  useEffect(() => {
    const el = containerRef.current;
    if (!liveOn || !el) return;
    let raf = 0;
    const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paintLive(); }); };
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(later);
    ro?.observe(el);
    el.addEventListener('load', later, true);
    el.addEventListener('toggle', later, true);
    window.addEventListener('resize', later);
    // Scroll events come once per frame: place the lines right there, not a frame later.
    const scroller: Document | HTMLElement = overlay ? document : el;
    scroller.addEventListener('scroll', paintLive, { capture: true, passive: true });
    return () => {
      ro?.disconnect();
      el.removeEventListener('load', later, true);
      el.removeEventListener('toggle', later, true);
      window.removeEventListener('resize', later);
      scroller.removeEventListener('scroll', paintLive, { capture: true });
      if (raf) cancelAnimationFrame(raf);
    };
  }, [liveOn, overlay, containerRef, paintLive]);

  // A page change (push, pop, landing) or a refetch replaces the rows under the
  // pointer: the tip named a mark of the OLD page, so it goes (N8). The next
  // pointer move over a mark of this page shows that one.
  useEffect(() => {
    setTip(null);
    containerRef.current?.removeAttribute('data-thread-mark-hover');
  }, [renderNonce, containerRef, setTip]);

  // Hit testing: pointer to caret, once per frame; click with nothing selected.
  useEffect(() => {
    const el = containerRef.current;
    if (!enabled || !el || specs.length === 0) return;
    const at = (x: number, y: number) => hitMark(marks.current, caretFromPoint(document, x, y), x, y);
    const move = rafThrottle<{ x: number; y: number }>(({ x, y }) => {
      const hit = at(x, y);
      if (hit) {
        el.setAttribute('data-thread-mark-hover', '');
        setTip({ text: `Open “${hit.title}”`, at: { x, y } });
      } else if (el.hasAttribute('data-thread-mark-hover')) {
        el.removeAttribute('data-thread-mark-hover');
        setTip(null);
      }
    });
    const onMove = (e: PointerEvent) => move.call({ x: e.clientX, y: e.clientY });
    const onLeave = () => { move.cancel(); el.removeAttribute('data-thread-mark-hover'); setTip(null); };
    // The pin popover decides on pointerup, before this click fires: claim the
    // release first (capture phase on the timeline) so a press on a mark never
    // also opens the pin popover of the passage it shares (N38).
    const onRelease = (e: PointerEvent | MouseEvent) => {
      if (e.button !== 0 || !selectionIsEmpty(window.getSelection())) return;
      if (at(e.clientX, e.clientY)) claimPress(e);
    };
    const release = typeof window.PointerEvent === 'function' ? 'pointerup' : 'mouseup';
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || !selectionIsEmpty(window.getSelection())) return;
      const hit = at(e.clientX, e.clientY);
      if (!hit) return;
      // Capture phase: the question wins over the pin popover on the same passage.
      e.stopPropagation();
      e.preventDefault();
      el.removeAttribute('data-thread-mark-hover');
      setTip(null);
      log.info('threads', 'mark click', { sessionId: argsRef.current.sessionId, headId: hit.headId ?? '' });
      argsRef.current.onOpen(hit.key);
    };
    el.addEventListener('pointermove', onMove, { passive: true });
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('click', onClick, true);
    el.addEventListener(release, onRelease as EventListener, true);
    return () => {
      el.removeEventListener(release, onRelease as EventListener, true);
      move.cancel();
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('click', onClick, true);
      el.removeAttribute('data-thread-mark-hover');
      setTip(null);
    };
  }, [enabled, containerRef, specs.length, panelKey, setTip]);

  // Off (the stack view ended): no tip.
  useEffect(() => { if (!enabled) setTip(null); }, [enabled, setTip]);

  return tipStore;
}

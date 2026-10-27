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
 *
 * Neutral marks (Conversation Mode, files) paint their question's state instead
 * (`spec.state`, thread-mark-state.ts): waiting is amber with a slow pulse drawn
 * in the same layer, answering green with the scan, unread red, failed dotted
 * red, read green, resolved grey. Each state has its own highlight priority, so
 * where marks overlap the most urgent paints on top. Tree Mode keeps its branch
 * hues and the live scan by `live.keys`, unchanged.
 */
import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';
import type { SessionPinnedQuote } from '@/types/session';
import {
  caretFromPoint, claimPress, hitMark, rafThrottle, selectionIsEmpty, type ThreadMark,
} from '@/utils/thread-mark-hit';
import { liveLineBars, overflowClipOf, paintLiveBars, textRectsOf, type BoxLike, type PaintedBar } from '@/utils/thread-live-lines';
import { MARK_STATE_TIP, markStateRank, type ThreadMarkState } from '@/utils/thread-mark-state';
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
  /** Neutral marks: the question's state; absent paints as before (open / done / live). */
  state?: ThreadMarkState;
  /** An Ask not sent yet: the waiting paint, no pulse (nothing is waited on). */
  draft?: boolean;
}

/** Above the pin highlight (0). Tree Mode marks and resolved neutral ones sit
 *  here; each more urgent neutral state one higher (thread-mark-state.ts). */
export const MARK_PRIORITY = 2;

export function markPriority(state?: ThreadMarkState): number {
  return MARK_PRIORITY + markStateRank(state);
}

const NEUTRAL_STATE_NAME: Record<ThreadMarkState, string> = {
  waiting: 'thread-mark-waiting-neutral',
  answering: 'thread-mark-live-neutral',
  unread: 'thread-mark-unread-neutral',
  failed: 'thread-mark-failed-neutral',
  read: 'thread-mark-neutral',
  resolved: 'thread-mark-done-neutral',
};

/** Highlight name per hue and state (neutral: one name per question state);
 *  globals for every name live in thread-stack-page.css. A live mark (its answer
 *  coming in) is the open mark's fill with no underline: the scanning line draws
 *  that. */
export function markHighlightName(hue: number, resolved: boolean, neutral = false, live = false, state?: ThreadMarkState): string {
  if (neutral && state) return NEUTRAL_STATE_NAME[state];
  const s = live ? '-live' : resolved ? '-done' : '';
  return `thread-mark${s}-${neutral ? 'neutral' : hue}`;
}

/** The mark's tooltip: `Open “title”`, plus what its state needs said. */
export function markTipText(mark: Pick<ThreadMark, 'title' | 'state' | 'draft'>): string {
  const extra = mark.state && !mark.draft ? MARK_STATE_TIP[mark.state] : null;
  // The state leads, so a long title cut at the tip's edge never hides it.
  return extra ? `${extra[0].toUpperCase()}${extra.slice(1)} · Open “${mark.title}”` : `Open “${mark.title}”`;
}

/** Spec to mark flags: neutral marks by state, hue marks by the live keys. */
export function markFlagsOf(s: Pick<ThreadMarkSpec, 'key' | 'neutral' | 'state' | 'draft'>, liveKeys: ReadonlySet<string>): { live: boolean; wait: boolean } {
  if (s.neutral && s.state) return { live: s.state === 'answering', wait: s.state === 'waiting' && !s.draft };
  return { live: liveKeys.has(s.key), wait: false };
}

/** Most urgent first, so a click on overlapping marks opens the one on top. */
export function byUrgency<M extends { state?: ThreadMarkState }>(marks: M[]): M[] {
  return marks.map((m, i) => ({ m, i }))
    .sort((a, b) => markStateRank(b.m.state) - markStateRank(a.m.state) || a.i - b.i)
    .map((x) => x.m);
}

// Document-wide paint, merged across panels (CSS.highlights has one namespace).
const panelMarks = new Map<string, Map<string, Range[]>>();
const paintedNames = new Set<string>();
const namePriority = new Map<string, number>();

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
    h.priority = namePriority.get(name) ?? MARK_PRIORITY;
    api.reg.set(name, h);
    paintedNames.add(name);
  }
}

function setPanelMarks(panelKey: string, marks: ThreadMark[]) {
  const byName = new Map<string, Range[]>();
  for (const m of marks) {
    const name = markHighlightName(m.hue, m.resolved, m.neutral, m.live, m.state);
    if (m.neutral && m.state) namePriority.set(name, markPriority(m.state));
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
  /** A right-click on a mark (its own menu instead of the row's). */
  onMenu?: (key: string, at: { x: number; y: number }) => void;
  /** The marks just derived, with their ranges (the review sidebar places by them). */
  onDerived?: (marks: readonly ThreadMark[]) => void;
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

/** The live and waiting marks' bars, in `layer`'s coordinates (`within`: the
 *  box the layer lives in, see overflowClipOf). */
export function liveBarsFor(marks: readonly ThreadMark[], layer: HTMLElement, within: Element | null, extraClip: BoxLike | null): PaintedBar[] {
  const out: PaintedBar[] = [];
  let origin: DOMRect | null = null;
  for (const m of marks) {
    if (!m.live && !m.wait) continue;
    origin ??= layer.getBoundingClientRect();
    const clip = intersect(overflowClipOf(m.range, within), extraClip);
    for (const b of liveLineBars(textRectsOf(m.range), origin, clip)) {
      out.push(m.wait && !m.live ? { ...b, kind: 'wait' } : m.neutral ? b : { ...b, hue: m.hue });
    }
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
      argsRef.current.onDerived?.([]);
      return;
    }
    const derive = () => {
      const out: ThreadMark[] = [];
      for (const s of argsRef.current.specs) {
        const range = argsRef.current.locatePassage({ msgId: s.parentMsgId, quote: s.quote });
        if (range) {
          const { live, wait } = markFlagsOf(s, liveKeys);
          out.push({
            key: s.key, ...(s.headId ? { headId: s.headId } : {}), range, hue: s.hue, resolved: s.resolved, title: s.title,
            ...(s.neutral ? { neutral: true } : {}), ...(s.neutral && s.state ? { state: s.state } : {}),
            ...(live ? { live: true } : {}), ...(wait ? { wait: true } : {}), ...(s.draft ? { draft: true } : {}),
          });
        }
      }
      marks.current = byUrgency(out);
      setPanelMarks(panelKey, out);
      paintLive();
      argsRef.current.onDerived?.(out);
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
  const moving = useMemo(() => specs.some((s) => {
    const f = markFlagsOf(s, liveKeys);
    return f.live || f.wait;
  }), [specs, liveKeys]);
  const liveOn = enabled && moving;
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
        setTip({ text: markTipText(hit), at: { x, y } });
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
    // WebKit selects the word under a right press before contextmenu fires, so
    // "a selection is open" is read at the press, not at the menu.
    // A right press, or a ctrl+click (macOS opens the menu on it, button 0).
    // null: no such press came first (the keyboard's menu key): read it now.
    let selectedAtPress: boolean | null = null;
    const onPress = (e: PointerEvent | MouseEvent) => {
      selectedAtPress = e.button === 2 || (e.button === 0 && e.ctrlKey) ? !selectionIsEmpty(window.getSelection()) : null;
    };
    const press = typeof window.PointerEvent === 'function' ? 'pointerdown' : 'mousedown';
    const onContext = (e: MouseEvent) => {
      const menu = argsRef.current.onMenu;
      const selected = selectedAtPress ?? !selectionIsEmpty(window.getSelection());
      selectedAtPress = null;
      if (!menu || selected) return;
      const hit = at(e.clientX, e.clientY);
      if (!hit || hit.draft) return;
      e.stopPropagation();
      e.preventDefault();
      // The engine's own word selection from this press is not the reader's.
      if (!selectionIsEmpty(window.getSelection())) window.getSelection()?.removeAllRanges();
      setTip(null);
      menu(hit.key, { x: e.clientX, y: e.clientY });
    };
    el.addEventListener('pointermove', onMove, { passive: true });
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('click', onClick, true);
    el.addEventListener(press, onPress as EventListener, true);
    el.addEventListener('contextmenu', onContext, true);
    el.addEventListener(release, onRelease as EventListener, true);
    return () => {
      el.removeEventListener(release, onRelease as EventListener, true);
      move.cancel();
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('click', onClick, true);
      el.removeEventListener(press, onPress as EventListener, true);
      el.removeEventListener('contextmenu', onContext, true);
      el.removeAttribute('data-thread-mark-hover');
      setTip(null);
    };
  }, [enabled, containerRef, specs.length, panelKey, setTip]);

  // Off (the stack view ended): no tip.
  useEffect(() => { if (!enabled) setTip(null); }, [enabled, setTip]);

  return tipStore;
}

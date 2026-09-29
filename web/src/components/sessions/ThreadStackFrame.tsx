/**
 * The stack frame (spec 5.1): wraps the ONE timeline scroll container. Active
 * (the session has questions and the stack view is on) it is a positioned flex
 * column holding the stack header, the scroll box and the sliver; inactive it is
 * `display: contents` and adds nothing, so a session without questions renders
 * exactly as before (C10). The wrapper is ALWAYS mounted: toggling it would
 * remount the scroll container and every listener on it.
 *
 * The sliver: min(depth, 4) bars on the content column's left edge, one per
 * ancestor page (root muted, then per-depth lightness of the branch hue). A bar
 * pops on a click that did not travel (a drag that started as a text selection
 * is not a click), shows `Back to <title>` in a portal tooltip, and widens its
 * hit zone to 16px on hover.
 */
import {
  memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore,
  type MutableRefObject, type ReactNode, type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { useMenuPlacement } from '@/hooks/useMenuPlacement';
import { THREAD_OVERLAY_ATTR } from '@/components/sessions/ThreadConfirm';
import { useThreadToast } from '@/components/sessions/ThreadPanelToast';
import type { ThreadToastApi } from '@/components/sessions/thread-ui-contract';
import type { ThreadMarkTipStore } from '@/hooks/useThreadMarks';
import { isStillClick, sliverBarWidth, type SliverBar } from '@/utils/thread-stack-state';
import '@/styles/thread-stack.css';

/** Hands the panel's toast api (from inside its provider) to the panel's own
 *  hooks, which run above the provider. Renders nothing. */
export function ThreadToastBridge({ apiRef }: { apiRef: MutableRefObject<ThreadToastApi | null> }) {
  const api = useThreadToast();
  useLayoutEffect(() => {
    apiRef.current = api;
    return () => { if (apiRef.current === api) apiRef.current = null; };
  }, [api, apiRef]);
  return null;
}

/** A small portal tooltip at a point, placed by useMenuPlacement (never off screen). */
export function ThreadHoverTip({ text, at }: { text: string; at: { x: number; y: number } | null }) {
  const tipRef = useRef<HTMLDivElement>(null);
  const noTrigger = useRef<HTMLElement | null>(null);
  const placement = useMenuPlacement(!!at, noTrigger, tipRef, {
    anchorPoint: at, align: 'start', gap: 10, minHeight: 0,
  });
  if (!at) return null;
  return createPortal(
    <div
      ref={tipRef}
      className="thread-hover-tip"
      role="tooltip"
      {...{ [THREAD_OVERLAY_ATTR]: '' }}
      onPointerDown={(e) => e.stopPropagation()}
      style={placement
        ? { top: placement.top, right: placement.right }
        : { visibility: 'hidden', top: 0, left: 0 }}
    >
      {text}
    </div>,
    document.body,
  );
}

/** The question-mark tip, fed by its store: the pointer moving over a mark
 *  re-renders only this, never the timeline that owns the marks. */
export const ThreadMarkTipLayer = memo(function ThreadMarkTipLayer({ store }: { store: ThreadMarkTipStore }) {
  const tip = useSyncExternalStore(store.subscribe, store.get, store.get);
  return tip ? <ThreadHoverTip text={tip.text} at={tip.at} /> : null;
});

interface SliverProps {
  bars: SliverBar[];
  panelWidth: number;
  left: number;
  top: number;
  onPopTo: (key: string) => void;
}

const ThreadSliver = memo(function ThreadSliver({ bars, panelWidth, left, top, onPopTo }: SliverProps) {
  const down = useRef<{ x: number; y: number } | null>(null);
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  // The tip moves only when the pointer reaches ANOTHER bar, at most once a
  // frame: a pointermove over the same bar costs nothing.
  const tipBar = useRef<string | null>(null);
  const tipRaf = useRef(0);
  const hoverBar = useCallback((id: string, text: string, x: number, y: number) => {
    if (tipBar.current === id) return;
    tipBar.current = id;
    cancelAnimationFrame(tipRaf.current);
    tipRaf.current = requestAnimationFrame(() => setTip({ text, x, y }));
  }, []);
  const leave = useCallback(() => {
    tipBar.current = null;
    cancelAnimationFrame(tipRaf.current);
    setTip(null);
  }, []);
  useEffect(() => () => cancelAnimationFrame(tipRaf.current), []);
  // A pop or push swaps the bars under a resting pointer without a pointermove:
  // the old "Back to …" would stay up naming a page that is no longer an ancestor.
  const barsSig = bars.map((b) => `${b.key}:${b.level}:${b.label}`).join('\n');
  useEffect(() => { leave(); }, [barsSig, leave]);
  const width = sliverBarWidth(panelWidth);
  return (
    <div
      className="thread-sliver"
      style={{ left, top, ['--sliver-bar' as string]: `${width}px` }}
      data-thread-sliver=""
      onPointerLeave={leave}
    >
      {bars.map((bar) => (
        <button
          key={`${bar.key}:${bar.level}`}
          type="button"
          className="thread-sliver-bar"
          data-thread-level={bar.level === 0 ? undefined : bar.level}
          data-root={bar.level === 0 ? '' : undefined}
          aria-label={bar.label}
          style={bar.hue === undefined ? undefined : { ['--thread-hue' as string]: bar.hue }}
          onPointerDown={(e) => { down.current = { x: e.clientX, y: e.clientY }; }}
          onPointerMove={(e) => hoverBar(`${bar.key}:${bar.level}`, bar.label, e.clientX, e.clientY)}
          onClick={(e) => {
            const still = isStillClick(down.current, { x: e.clientX, y: e.clientY });
            down.current = null;
            // A keyboard click has no pointerdown and is always "still".
            if (e.detail === 0 || still) onPopTo(bar.key);
          }}
        />
      ))}
      <ThreadHoverTip text={tip?.text ?? ''} at={tip ? { x: tip.x, y: tip.y } : null} />
    </div>
  );
});

export interface ThreadStackFrameProps {
  /** The session has questions and the stack view is on. */
  active: boolean;
  depth: number;
  bars: SliverBar[];
  containerRef: RefObject<HTMLDivElement | null>;
  /** The stack row (depth >= 1) or the linear banner, above the scroll box,
   *  given the frame's width (the row's narrow rules read it). */
  header?: (panelWidth: number) => ReactNode;
  onPopTo: (key: string) => void;
  /** The scroll container. Always the same element, at every depth. */
  children: ReactNode;
}

/** Content column's left edge inside the frame: the quote head, else the first
 *  full-width row wrapper, else the scroll box's own padding edge. Measured
 *  relative to the scroll box and offset by its LAYOUT position (offsetLeft), so
 *  the push slide's translateX on the box never shifts the sliver. */
function contentLeftOf(scroller: HTMLElement): number {
  const row = scroller.querySelector<HTMLElement>('.thread-quote-head')
    ?? scroller.querySelector<HTMLElement>('[data-message-id]');
  const inner = row
    ? row.getBoundingClientRect().left - scroller.getBoundingClientRect().left
    : parseFloat(getComputedStyle(scroller).paddingLeft || '0');
  return scroller.offsetLeft + inner;
}

export function ThreadStackFrame({ active, depth, bars, containerRef, header, onPopTo, children }: ThreadStackFrameProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [geom, setGeom] = useState({ left: 4, top: 0, width: 0, rail: false });
  const showSliver = active && depth > 0 && bars.length > 0;
  // The frame's width, for the header's narrow rules (kept current by a
  // ResizeObserver while active; the sliver shares the same measurement).
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!active || !frame) return;
    const read = () => {
      const width = Math.round(frame.getBoundingClientRect().width);
      setGeom((g) => (g.width === width ? g : { ...g, width }));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(frame);
    return () => ro.disconnect();
  }, [active]);

  const measure = useCallback(() => {
    const frame = frameRef.current;
    const scroller = containerRef.current;
    if (!frame || !scroller) return;
    const width = Math.round(frame.getBoundingClientRect().width);
    const barW = sliverBarWidth(width);
    const total = bars.length * barW + Math.max(0, bars.length - 1);
    // Beside the content column (spec 5.1); the outline rail steps further left
    // (thread-stack-page.css), so the two never overlap.
    const contentLeft = contentLeftOf(scroller);
    const left = Math.max(2, Math.round(contentLeft - total - 6));
    const top = Math.round(scroller.offsetTop);
    const rail = !!scroller.querySelector('.session-toc, .thread-map[data-shape="rail"]');
    setGeom((g) => (g.left === left && g.top === top && g.width === width && g.rail === rail ? g : { left, top, width, rail }));
  }, [containerRef, bars.length]);

  // The room the sliver takes from the content column (spec 5.1: at most 40px of
  // bars); the scroll box pads its left side by it (thread-stack-page.css).
  // With an outline rail (or the question map's rail) in the same padding, 12px
  // more so its marks clear the bars.
  const room = showSliver
    ? bars.length * sliverBarWidth(geom.width) + Math.max(0, bars.length - 1) + 8 + (geom.rail ? 12 : 0)
    : 0;

  // Measured after every change that moves the content column: depth, the room
  // itself (it pads the scroll box), and any resize of the frame or the box.
  useLayoutEffect(() => {
    if (!showSliver) return;
    measure();
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(frame);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [showSliver, measure, depth, containerRef, room]);

  const head = active && header ? header(geom.width) : null;
  // `data-thread-bare`: nothing above the scroll box (the root page). The panel's
  // glass header rules then treat the frame like the inactive one, so the root
  // page has the geometry of a session without questions (globals.css).
  return (
    <div
      ref={frameRef}
      className={active ? 'thread-stack' : 'thread-stack-off'}
      {...(active ? { 'data-thread-depth': depth } : {})}
      {...(active && !head ? { 'data-thread-bare': '' } : {})}
      {...(room ? { 'data-sliver': '' } : {})}
      style={room ? { ['--thread-sliver-room' as string]: `${room}px` } : undefined}
    >
      {head}
      {children}
      {showSliver ? (
        <ThreadSliver bars={bars} panelWidth={geom.width} left={geom.left} top={geom.top} onPopTo={onPopTo} />
      ) : null}
    </div>
  );
}

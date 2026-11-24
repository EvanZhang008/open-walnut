/**
 * The two side edges of a full-screen session sheet, dragged to make it wider or narrower
 * (the user, 2026-11-23, by voice: in full screen "I want this page at its side to be
 * draggable ... default OK that width, but I can drag it a bit wider. But this margin stays
 * the same"). The default is the sheet's own width (fullscreen-tab.css); a drag on
 * either edge moves both, so the sheet stays centred; the chat inside keeps the margin it had
 * at the default width. The width is kept for the next full screen; a double-click on an edge,
 * or Home on a focused edge, forgets it. Arrow keys on a focused edge step it; Escape during a
 * drag puts back the width it had before the drag and keeps full screen.
 * tests/e2e/browser/sheet-width-edges.spec.ts drags it.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useDragGesture } from '@/hooks/useDragGesture';
import '@/styles/sheet-width.css';

const KEY = 'walnut:session-sheet-width';
/** The narrowest a dragged sheet gets, and the room it leaves the window on each side. */
export const SHEET_MIN_WIDTH = 640;
export const SHEET_WINDOW_GAP = 12;
/** One arrow-key step on a focused edge. */
const KEY_STEP = 32;

function stored(): number | null {
  try {
    const n = Number(localStorage.getItem(KEY));
    return Number.isFinite(n) && n >= SHEET_MIN_WIDTH ? n : null;
  } catch { return null; }
}

function keep(width: number | null): void {
  try {
    if (width === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(Math.round(width)));
  } catch { /* private browsing: kept for this sheet only */ }
}

/** A length custom property of the panel, in px (0 when unset): resolved by a probe box. */
function lengthVar(panel: HTMLElement, name: string): number {
  const probe = document.createElement('div');
  probe.style.cssText = `position:absolute;height:0;width:var(${name}, 0px)`;
  panel.appendChild(probe);
  const w = probe.getBoundingClientRect().width;
  probe.remove();
  return w;
}

/**
 * The page area the sheet sits in (the window beside the sidebar), and the room the review
 * column adds to the sheet while it is open (fullscreen-tab.css, --fullscreen-review-grow).
 * A width here is always the sheet's own, without that room: the review column grows it
 * outward on top, as it does at the default width.
 */
function areaOf(panel: HTMLElement): number { return lengthVar(panel, '--fullscreen-area'); }
function reviewGrow(panel: HTMLElement): number { return lengthVar(panel, '--fullscreen-review-grow'); }
function widthOf(panel: HTMLElement): number { return panel.getBoundingClientRect().width - reviewGrow(panel); }

/** The widest the sheet's own width can be here; in a window too small for the minimum, less. */
function maxOf(panel: HTMLElement): number { return areaOf(panel) - 2 * SHEET_WINDOW_GAP - reviewGrow(panel); }
function minOf(panel: HTMLElement): number { return Math.min(SHEET_MIN_WIDTH, maxOf(panel)); }

function clamp(panel: HTMLElement, width: number): number {
  return Math.round(Math.max(minOf(panel), Math.min(maxOf(panel), width)));
}

/**
 * The chat's margin at the default width: the history's own side padding,
 * clamp(24px, 4%, 40px) of the width it fills (globals.css, .session-history), at the
 * default sheet's width. Worked out from that width rather than read off the padding or the
 * sheet now, which a review column or a thread map open at that moment adds its room to.
 */
function defaultMargin(panel: HTMLElement): string {
  // The default sheet's width, by fullscreen-tab.css's own inset (a tenth of the page area
  // each side, never so much the sheet drops under 960px, never under the gutter); the
  // history fills it.
  const area = areaOf(panel);
  const side = Math.max(SHEET_WINDOW_GAP, Math.min(area * 0.1, (area - 960) / 2));
  return `${Math.min(40, Math.max(24, 0.04 * (area - 2 * side)))}px`;
}

/**
 * A width on the sheet. The sheet is placed by its side insets (fullscreen-tab.css,
 * --fullscreen-side); sheet-width.css turns --sheet-drag-side into that inset while the
 * panel carries data-sheet-width, so the Changed view's own wide sheet is left alone. The
 * inset leaves the sheet centred in the page area and never under the area's gutter.
 */
function apply(panel: HTMLElement, width: number | null): void {
  if (width === null) {
    panel.removeAttribute('data-sheet-width');
    panel.style.removeProperty('--sheet-drag-side');
    panel.style.removeProperty('--sheet-chat-margin');
    return;
  }
  if (!panel.hasAttribute('data-sheet-width')) panel.style.setProperty('--sheet-chat-margin', defaultMargin(panel));
  panel.style.setProperty('--sheet-drag-side',
    `max(var(--fullscreen-gutter), calc((var(--fullscreen-area) - ${Math.round(width)}px) / 2 - var(--fullscreen-review-grow, 0px) / 2))`);
  panel.setAttribute('data-sheet-width', String(Math.round(width)));
}

/** What a screen reader hears: the width the sheet has now and the range a drag allows. */
interface Range { now: number; min: number; max: number; dragged: boolean }

function rangeOf(panel: HTMLElement): Range {
  const max = Math.max(0, Math.round(maxOf(panel)));
  return {
    now: Math.min(max, Math.round(widthOf(panel))),
    min: Math.min(SHEET_MIN_WIDTH, max),
    max,
    dragged: panel.hasAttribute('data-sheet-width'),
  };
}

function Edge({ side, panelRef, range }: {
  side: 'left' | 'right';
  panelRef: RefObject<HTMLElement | null>;
  range: Range | null;
}) {
  const start = useRef(0);
  const before = useRef<number | null>(null);
  const now = useRef(0);
  const drag = useDragGesture({
    cursor: 'ew-resize',
    onStart: () => {
      const panel = panelRef.current;
      const had = panel?.getAttribute('data-sheet-width');
      before.current = had ? Number(had) : null;
      start.current = panel ? widthOf(panel) : 0;
      now.current = start.current;
    },
    onMove: ({ dx }) => {
      const panel = panelRef.current;
      if (!panel || !start.current) return;
      now.current = clamp(panel, start.current + (side === 'right' ? 2 * dx : -2 * dx));
      apply(panel, now.current);
    },
    onEnd: ({ canceled }) => {
      const panel = panelRef.current;
      if (!panel) return;
      // Escape, a lost pointer, or a drag that left the sheet as wide as it was (a still
      // press, a window with no room to give): the width it had before, nothing kept.
      if (canceled || Math.abs(widthOf(panel) - start.current) < 1) {
        apply(panel, before.current);
        return;
      }
      keep(now.current);
    },
  });
  const reset = () => {
    keep(null);
    if (panelRef.current) apply(panelRef.current, null);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (!panel) return;
    if (e.key === 'Home') { e.preventDefault(); reset(); return; }
    const outward = side === 'right' ? 'ArrowRight' : 'ArrowLeft';
    const inward = side === 'right' ? 'ArrowLeft' : 'ArrowRight';
    if (e.key !== outward && e.key !== inward) return;
    e.preventDefault();
    const to = clamp(panel, widthOf(panel) + (e.key === outward ? 2 * KEY_STEP : -2 * KEY_STEP));
    apply(panel, to);
    keep(to);
  };
  return (
    <div
      className={`sheet-width-edge sheet-width-edge--${side}${drag.isDragging ? ' is-dragging' : ''}`}
      data-testid={`sheet-width-edge-${side}`}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Full-screen session width"
      aria-valuemin={range?.min ?? SHEET_MIN_WIDTH}
      aria-valuemax={range?.max}
      aria-valuenow={range?.now}
      aria-valuetext={range ? `${range.now} pixels wide${range.dragged ? '' : ' (default)'}` : undefined}
      title="Drag to make it wider or narrower; double click for the default width (keys: left and right arrows, Home)"
      onPointerDown={drag.onPointerDown}
      onKeyDown={onKey}
      onDoubleClick={reset}
    />
  );
}

/** Rendered inside the full-screen session panel; it sets the panel's width while it is shown. */
export function SheetWidthEdges({ panelRef }: { panelRef: RefObject<HTMLElement | null> }) {
  const [range, setRange] = useState<Range | null>(null);
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    apply(panel, stored());
    // The sheet's size is the one source: a drag, a key, a window resize, the review column.
    const measure = () => setRange((r) => {
      const n = rangeOf(panel);
      return r && r.now === n.now && r.min === n.min && r.max === n.max && r.dragged === n.dragged ? r : n;
    });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(panel);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); apply(panel, null); };
  }, [panelRef]);
  return (
    <>
      <Edge side="left" panelRef={panelRef} range={range} />
      <Edge side="right" panelRef={panelRef} range={range} />
    </>
  );
}

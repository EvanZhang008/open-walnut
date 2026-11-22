import { useState, useCallback, useRef } from 'react';
import { useDragGesture } from './useDragGesture';

const PANEL_PCT_MIN = 10;  // minimum 10% of viewport
const PANEL_PCT_MAX = 70;  // maximum 70% of viewport (supports multi-column sessions)
const PANEL_PCT_DEFAULT = 20;

function clampPct(pct: number): number {
  return Math.min(PANEL_PCT_MAX, Math.max(PANEL_PCT_MIN, pct));
}

/** Migrate old pixel values to percentages. Values > 100 are clearly px. */
function readStoredPct(key: string, defaultPct: number): number {
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      const parsed = parseFloat(stored);
      if (!isNaN(parsed)) {
        // Old pixel values (> 100) → convert to % of a reference 1920px screen
        if (parsed > 100) {
          const migrated = clampPct((parsed / 1920) * 100);
          localStorage.setItem(key, String(migrated));
          return migrated;
        }
        return clampPct(parsed);
      }
    }
  } catch { /* ignore */ }
  return defaultPct;
}

interface UseResizablePanelReturn {
  /** CSS width string, e.g. "20%" */
  width: string;
  /** Raw percentage value */
  pct: number;
  /** Programmatically set the panel width (clamped to min/max). It is stored, unless `save: false`:
   *  a width for now only (a cap while another pane is open), and the stored one stays the user's. */
  setPct: (pct: number, opts?: { save?: boolean }) => void;
  /** Back to the stored width (or the default when none is stored): undoes a `save: false` set. */
  restore: () => void;
  panelRef: React.RefObject<HTMLDivElement | null>;
  /** Spread onto the drag handle: `<div {...handleProps} />` */
  handleProps: { onPointerDown: (e: React.PointerEvent) => void };
  /** Whether the user set a width (one is stored, or a drag or a set ran): until then a caller may
   *  draw its own CSS default rather than `pct`. */
  custom: boolean;
  /** Whether the stored width is one the user dragged (not one a caller set): a caller that sizes
   *  the panel for a layout of its own keeps a dragged width as it is. */
  dragged: boolean;
  /** Forget the stored width: back to the default, and `custom` false. */
  reset: () => void;
}

/**
 * Reusable hook for a resizable panel with width as % of viewport.
 * @param direction 'right' (default) = panel is right of handle (drag left = increase).
 *                  'left' = panel is left of handle (drag right = increase).
 *
 * Drag mechanics (pointer capture, iframe-proof, rAF-coalesced) live in
 * useDragGesture — see that file for why raw document mouse listeners were
 * getting stuck on the Files panel's HTML-preview iframe.
 */
export interface ResizablePanelOptions {
  /** The panel's room now, as % of the viewport (both sides readable): a drag stops at it, in
   *  place of the hook's own 10 to 70% clamp. */
  bounds?: () => { min: number; max: number };
  /** The width that shows now, as % of the viewport, when it can differ from `pct` (a CSS default):
   *  a drag starts from it, so the panel never jumps under the pointer. */
  measure?: () => number | null;
}

function hasStored(key: string): boolean {
  try { return localStorage.getItem(key) !== null; } catch { return false; }
}

/** Beside the width, whether a drag made it (`<key>:dragged`); an older version ignores the key. */
const draggedKey = (key: string) => `${key}:dragged`;
function markDragged(key: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(draggedKey(key), '1');
    else localStorage.removeItem(draggedKey(key));
  } catch { /* ignore */ }
}

export function useResizablePanel(storageKey: string, defaultPct = PANEL_PCT_DEFAULT, direction: 'left' | 'right' = 'right', opts: ResizablePanelOptions = {}): UseResizablePanelReturn {
  const [pct, setPct] = useState(() => readStoredPct(storageKey, defaultPct));
  const [custom, setCustom] = useState(() => hasStored(storageKey));
  const [dragged, setDragged] = useState(() => hasStored(storageKey) && hasStored(draggedKey(storageKey)));
  const boundsRef = useRef(opts.bounds);
  boundsRef.current = opts.bounds;
  const measureRef = useRef(opts.measure);
  measureRef.current = opts.measure;
  const defaultRef = useRef(defaultPct);
  defaultRef.current = defaultPct;
  const movedRef = useRef(false);
  /** The viewport clamp, then the panel's own room when it gives one. */
  const fit = (v: number): number => {
    const b = boundsRef.current?.();
    return b && b.max >= b.min ? Math.min(b.max, Math.max(b.min, v)) : clampPct(v);
  };
  const startPctRef = useRef(pct);
  const pctRef = useRef(pct);
  pctRef.current = pct;
  const panelRef = useRef<HTMLDivElement>(null);

  const { onPointerDown } = useDragGesture({
    cursor: 'col-resize',
    onStart: () => {
      // From what shows: a stored width past the room now starts the drag at the edge, not past it.
      startPctRef.current = fit(measureRef.current?.() ?? pctRef.current);
      movedRef.current = false;
      panelRef.current?.classList.add('resizing');
    },
    onMove: ({ dx }) => {
      const pxDelta = direction === 'right'
        ? -dx   // drag left = increase (panel right of handle)
        : dx;   // drag right = increase (panel left of handle)
      const pctDelta = (pxDelta / window.innerWidth) * 100;
      const next = fit(startPctRef.current + pctDelta);
      // onEnd persists this ref and can run before React renders the last move (WebKit does):
      // set it here, not only from the render, or the drag saves the width it started from.
      pctRef.current = next;
      if (!movedRef.current) { movedRef.current = true; setCustom(true); }
      setPct(next);
    },
    onEnd: () => {
      panelRef.current?.classList.remove('resizing');
      // Persist ONCE per drag. This used to be a `useEffect` keyed on `pct`,
      // i.e. a synchronous localStorage write on every single mousemove —
      // a blocking disk write per frame, and the main source of the drag lag.
      // A click that never moved sets nothing.
      if (!movedRef.current) return;
      try { localStorage.setItem(storageKey, String(pctRef.current)); } catch { /* ignore */ }
      markDragged(storageKey, true);
      setDragged(true);
    },
  });

  const setClampedPct = useCallback((v: number, opts?: { save?: boolean }) => {
    const next = fit(v);
    setPct(next);
    if (opts?.save === false) return;
    setCustom(true);
    // Programmatic sets (e.g. the graduated session-area width) aren't part of
    // a drag, so they persist immediately.
    try { localStorage.setItem(storageKey, String(next)); } catch { /* ignore */ }
    markDragged(storageKey, false);
    setDragged(false);
  }, [storageKey]);

  const restore = useCallback(() => {
    setPct(readStoredPct(storageKey, defaultRef.current));
  }, [storageKey]);

  const reset = useCallback(() => {
    try { localStorage.removeItem(storageKey); } catch { /* ignore */ }
    markDragged(storageKey, false);
    setPct(defaultRef.current);
    setCustom(false);
    setDragged(false);
  }, [storageKey]);

  return { width: `${pct}%`, pct, setPct: setClampedPct, restore, panelRef, handleProps: { onPointerDown }, custom, dragged, reset };
}

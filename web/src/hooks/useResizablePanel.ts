import { useState, useCallback, useEffect, useRef } from 'react';

const PANEL_PCT_MIN = 10;  // minimum 10% of viewport
const PANEL_PCT_MAX = 50;  // maximum 50% of viewport
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
  panelRef: React.RefObject<HTMLDivElement | null>;
  handleResizeStart: (e: React.MouseEvent) => void;
}

/**
 * Reusable hook for a resizable panel with width as % of viewport.
 * Dragging left increases width (panel is on the right side of the handle).
 */
export function useResizablePanel(storageKey: string, defaultPct = PANEL_PCT_DEFAULT): UseResizablePanelReturn {
  const [pct, setPct] = useState(() => readStoredPct(storageKey, defaultPct));
  const resizingRef = useRef(false);
  const startXRef = useRef(0);
  const startPctRef = useRef(0);
  const panelRef = useRef<HTMLDivElement>(null);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    startXRef.current = e.clientX;
    startPctRef.current = pct;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    panelRef.current?.classList.add('resizing');

    const onMouseMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      const pxDelta = startXRef.current - ev.clientX; // drag left = increase
      const pctDelta = (pxDelta / window.innerWidth) * 100;
      setPct(clampPct(startPctRef.current + pctDelta));
    };

    const onMouseUp = () => {
      resizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      panelRef.current?.classList.remove('resizing');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [pct]);

  // Persist percentage changes
  useEffect(() => {
    try { localStorage.setItem(storageKey, String(pct)); } catch { /* ignore */ }
  }, [pct, storageKey]);

  return { width: `${pct}%`, panelRef, handleResizeStart };
}

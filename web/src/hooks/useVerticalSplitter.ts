import { useState, useCallback, useRef } from 'react';
import { useDragGesture } from './useDragGesture';

const RATIO_DEFAULT = 0.65;
const RATIO_MIN = 0.15;
const RATIO_MAX = 0.85;
const STORAGE_KEY = 'open-walnut-todo-detail-ratio-v2';

export interface VerticalSplitterOptions {
  storageKey?: string;
  defaultRatio?: number;
  minRatio?: number;
  maxRatio?: number;
  /** Reuse an external flex-column container instead of the hook's own ref. */
  containerRef?: React.RefObject<HTMLDivElement | null>;
}

export interface UseVerticalSplitterReturn {
  /** Detail pane ratio (0–1). Higher = detail takes more space. */
  ratio: number;
  /** Attach to the flex-column container (.todo-panel). */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Spread onto the drag handle: `<div {...handleProps} />` */
  handleProps: { onPointerDown: (e: React.PointerEvent) => void };
  /** True while user is actively dragging. */
  isResizing: boolean;
}

/**
 * Ratio-based vertical splitter for list/detail panes.
 * Mouse UP (negative deltaY) → ratio increases (top pane grows).
 *
 * Drag mechanics (pointer capture, iframe-proof, rAF-coalesced) live in
 * useDragGesture.
 */
export function useVerticalSplitter(opts: VerticalSplitterOptions = {}): UseVerticalSplitterReturn {
  const storageKey = opts.storageKey ?? STORAGE_KEY;
  const defaultRatio = opts.defaultRatio ?? RATIO_DEFAULT;
  const minRatio = opts.minRatio ?? RATIO_MIN;
  const maxRatio = opts.maxRatio ?? RATIO_MAX;

  const clampRatio = useCallback(
    (r: number) => Math.max(minRatio, Math.min(maxRatio, r)),
    [minRatio, maxRatio],
  );

  const readStoredRatio = useCallback((): number => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed = parseFloat(stored);
        if (!isNaN(parsed)) return clampRatio(parsed);
      }
    } catch { /* ignore */ }
    return defaultRatio;
  }, [storageKey, defaultRatio, clampRatio]);

  const [ratio, setRatio] = useState(readStoredRatio);
  const ratioRef = useRef(ratio);
  ratioRef.current = ratio;
  const ownContainerRef = useRef<HTMLDivElement>(null);
  const containerRef = opts.containerRef ?? ownContainerRef;
  const startRatioRef = useRef(ratio);
  const containerHeightRef = useRef(0);

  const { onPointerDown, isDragging } = useDragGesture({
    cursor: 'row-resize',
    onStart: () => {
      const container = containerRef.current;
      startRatioRef.current = ratioRef.current;
      // Measured once at grab — reading it per move would force a sync layout
      // every frame, and the height doesn't change during the drag anyway.
      containerHeightRef.current = container?.getBoundingClientRect().height ?? 0;
      container?.classList.add('splitter-resizing');
    },
    onMove: ({ dy }) => {
      const h = containerHeightRef.current;
      if (!h) return;
      // Moving pointer up (negative dy) → detail grows → ratio increases
      setRatio(clampRatio(startRatioRef.current + -dy / h));
    },
    onEnd: () => {
      containerRef.current?.classList.remove('splitter-resizing');
      try { localStorage.setItem(storageKey, String(ratioRef.current)); } catch { /* ignore */ }
    },
  });

  return { ratio, containerRef, handleProps: { onPointerDown }, isResizing: isDragging };
}

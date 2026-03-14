import { useState, useCallback, useRef } from 'react';

const RATIO_DEFAULT = 0.65;
const RATIO_MIN = 0.15;
const RATIO_MAX = 0.85;
const STORAGE_KEY = 'open-walnut-todo-detail-ratio-v2';

function clampRatio(r: number): number {
  return Math.max(RATIO_MIN, Math.min(RATIO_MAX, r));
}

function readStoredRatio(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = parseFloat(stored);
      if (!isNaN(parsed)) return clampRatio(parsed);
    }
  } catch { /* ignore */ }
  return RATIO_DEFAULT;
}

export interface UseVerticalSplitterReturn {
  /** Detail pane ratio (0–1). Higher = detail takes more space. */
  ratio: number;
  /** Attach to the flex-column container (.todo-panel). */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** onMouseDown for the drag handle element. */
  handleMouseDown: (e: React.MouseEvent) => void;
  /** True while user is actively dragging. */
  isResizing: boolean;
}

/**
 * Ratio-based vertical splitter for list/detail panes.
 * Mouse UP (negative deltaY) → ratio increases (detail grows).
 */
export function useVerticalSplitter(): UseVerticalSplitterReturn {
  const [ratio, setRatio] = useState(readStoredRatio);
  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const startYRef = useRef(0);
  const startRatioRef = useRef(0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;

    startYRef.current = e.clientY;
    startRatioRef.current = ratio;
    setIsResizing(true);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    container.classList.add('splitter-resizing');

    const containerHeight = container.getBoundingClientRect().height;

    const onMouseMove = (ev: MouseEvent) => {
      const deltaY = ev.clientY - startYRef.current;
      // Moving mouse up (negative deltaY) → detail grows → ratio increases
      const deltaRatio = -deltaY / containerHeight;
      const newRatio = clampRatio(startRatioRef.current + deltaRatio);
      setRatio(newRatio);
    };

    const onMouseUp = () => {
      setIsResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      container.classList.remove('splitter-resizing');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      // Persist final ratio
      try {
        // Read latest ratio from state via the container's flex children
        // (simpler: just persist whatever setRatio last set)
        setRatio((current) => {
          try { localStorage.setItem(STORAGE_KEY, String(current)); } catch { /* ignore */ }
          return current;
        });
      } catch { /* ignore */ }
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [ratio]);

  return { ratio, containerRef, handleMouseDown, isResizing };
}

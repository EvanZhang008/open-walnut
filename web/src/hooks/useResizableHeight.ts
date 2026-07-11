import { useState, useRef, useCallback, useEffect } from 'react';

/**
 * Pixel-height drag resize, persisted to localStorage. `null` height means
 * "no cap yet" (auto/natural height) — the caller only applies a maxHeight
 * style once the user has actually dragged, so untouched sections keep
 * growing/shrinking with their content instead of starting pre-clamped.
 */
export function useResizableHeight(storageKey: string, opts: { min?: number; max?: number } = {}) {
  const min = opts.min ?? 60;
  const max = opts.max ?? 2000;

  const readHeight = useCallback((): number | null => {
    try {
      const v = localStorage.getItem(storageKey);
      if (v) return Math.max(min, Math.min(max, parseInt(v, 10)));
    } catch { /* ignore */ }
    return null;
  }, [storageKey, min, max]);

  const [height, setHeight] = useState<number | null>(readHeight);
  const heightRef = useRef(height);
  heightRef.current = height;
  const dragging = useRef(false);
  const startY = useRef(0);
  const startH = useRef(0);
  const [isDragging, setIsDragging] = useState(false);

  const handleMouseDown = useCallback((e: React.MouseEvent, currentRenderedHeight: number) => {
    e.preventDefault();
    dragging.current = true;
    startY.current = e.clientY;
    startH.current = heightRef.current ?? currentRenderedHeight;
    setIsDragging(true);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = e.clientY - startY.current;
      const newH = Math.max(min, Math.min(max, startH.current + delta));
      setHeight(newH);
    };
    const onMouseUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      setIsDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        if (heightRef.current != null) localStorage.setItem(storageKey, String(heightRef.current));
      } catch { /* ignore */ }
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [min, max, storageKey]);

  return { height, handleMouseDown, isDragging };
}

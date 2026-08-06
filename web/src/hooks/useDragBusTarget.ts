import { useEffect, useRef } from 'react';
import { dragBus, type DropTargetSpec } from '@/utils/drag-bus';

/**
 * Register a component as a drag-bus drop target for its mount lifetime.
 * Handlers are read through a ref, so callers can pass fresh closures every
 * render without re-registering (and without useCallback ceremony).
 */
export function useDragBusTarget(spec: DropTargetSpec, enabled = true): void {
  const specRef = useRef(spec);
  specRef.current = spec;

  useEffect(() => {
    if (!enabled) return;
    return dragBus.register({
      element: () => specRef.current.element(),
      onDragOver: (p, payload) => specRef.current.onDragOver?.(p, payload),
      onDragLeave: () => specRef.current.onDragLeave?.(),
      onDrop: (p, payload) => specRef.current.onDrop(p, payload),
    });
  }, [enabled]);
}

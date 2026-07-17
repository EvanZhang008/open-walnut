import { useState, useRef, useCallback, useEffect } from 'react';

/** Nearest ancestor that actually scrolls vertically (overflow-y auto/scroll + overflowing). */
function findScrollAncestor(el: HTMLElement | null): HTMLElement | null {
  let cur = el?.parentElement ?? null;
  while (cur) {
    const s = getComputedStyle(cur);
    if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && cur.scrollHeight > cur.clientHeight) return cur;
    cur = cur.parentElement;
  }
  return null;
}

/**
 * Pixel-height drag resize, persisted to localStorage. `null` height means
 * "no cap yet" (auto/natural height) — the caller only applies a maxHeight
 * style once the user has actually dragged, so untouched sections keep
 * growing/shrinking with their content instead of starting pre-clamped.
 *
 * Tracking model: rect-driven, not pointer-delta. On every mousemove we place
 * the target's BOTTOM edge at the cursor (minus the grab offset captured on
 * mousedown), reading the target's live getBoundingClientRect().
 *
 * Scroll-geometry freeze: when the target lives inside a scrollable ancestor,
 * shrinking it shrinks that ancestor's scrollHeight, which force-clamps
 * scrollTop — visually the WHOLE panel slides down while the handle stays
 * pinned at the container bottom (the exact inverse of "handle follows the
 * mouse"). During the drag we freeze the geometry: a temporary paddingBottom
 * on the scroll ancestor keeps scrollHeight constant, and scrollTop is locked
 * to its mousedown value. Only the handle moves. Both are released on mouseup.
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
  const targetRef = useRef<HTMLElement | null>(null);
  const grabOffset = useRef(0); // cursor distance below the target's bottom edge at grab
  const startY = useRef(0);
  const startH = useRef(0);
  const startRectH = useRef(0); // ACTUAL rendered height at grab (≤ persisted maxHeight)
  // Scroll-ancestor freeze state for the duration of one drag. `maxShrink` makes
  // the compensation padding MONOTONIC within a drag: it only ever grows. Reducing
  // it mid-drag (on a downward move) would momentarily dip scrollHeight — the
  // padding shrinks synchronously but React grows the list a frame later — and
  // that dip clamps scrollTop → the whole panel jumps for one frame (flicker).
  const scrollLock = useRef<{ el: HTMLElement; top: number; basePad: number; maxShrink: number } | null>(null);
  const relockRaf = useRef(0);
  // Post-release settle animation (see onMouseUp). Cancelable on re-grab/unmount.
  const settleRaf = useRef(0);
  const settleCleanup = useRef<(() => void) | null>(null);
  const cancelSettle = useCallback(() => {
    if (settleRaf.current) { cancelAnimationFrame(settleRaf.current); settleRaf.current = 0; }
    if (settleCleanup.current) { settleCleanup.current(); settleCleanup.current = null; }
  }, []);
  const [isDragging, setIsDragging] = useState(false);

  /** `target` is the element being resized (the scrollable list the handle sits
   *  under). Pass the handle's previousElementSibling. Falls back to pointer-delta
   *  tracking when null. */
  const handleMouseDown = useCallback((e: React.MouseEvent, target: HTMLElement | null) => {
    e.preventDefault();
    // A re-grab during a previous drag's settle animation must finalize that
    // settle first — otherwise basePad below would absorb its leftover padding.
    cancelSettle();
    dragging.current = true;
    targetRef.current = target;
    const rect = target?.getBoundingClientRect();
    startY.current = e.clientY;
    startH.current = heightRef.current ?? rect?.height ?? min;
    startRectH.current = rect?.height ?? startH.current;
    grabOffset.current = rect ? e.clientY - rect.bottom : 0;
    const anc = findScrollAncestor(target);
    scrollLock.current = anc
      ? { el: anc, top: anc.scrollTop, basePad: parseFloat(getComputedStyle(anc).paddingBottom) || 0, maxShrink: 0 }
      : null;
    setIsDragging(true);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, [min]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const el = targetRef.current;
      let newH: number;
      if (el) {
        // Rect-driven: bottom edge follows the cursor regardless of layout shifts.
        const rect = el.getBoundingClientRect();
        newH = Math.max(min, Math.min(max, e.clientY - grabOffset.current - rect.top));
      } else {
        const delta = e.clientY - startY.current;
        newH = Math.max(min, Math.min(max, startH.current + delta));
      }
      const lock = scrollLock.current;
      if (lock) {
        // Pad BEFORE React shrinks the list so scrollHeight never dips → no clamp.
        // Baseline is the RENDERED height at grab: rendered_new = min(content, newH),
        // so max(0, startRectH - newH) equals the actual pixel shrink exactly.
        // Monotonic (never decreases mid-drag) — see scrollLock comment.
        const shrink = Math.max(0, startRectH.current - newH);
        if (shrink > lock.maxShrink) {
          lock.maxShrink = shrink;
          lock.el.style.paddingBottom = `${lock.basePad + shrink}px`;
        }
        if (lock.el.scrollTop !== lock.top) lock.el.scrollTop = lock.top;
        // Re-assert after React commits this frame's height (the clamp, if any,
        // happens at that layout — a mousemove-time write alone can't catch it).
        if (!relockRaf.current) {
          relockRaf.current = requestAnimationFrame(() => {
            relockRaf.current = 0;
            const l = scrollLock.current;
            if (l && dragging.current && l.el.scrollTop !== l.top) l.el.scrollTop = l.top;
          });
        }
      }
      setHeight(newH);
    };
    const onMouseUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      targetRef.current = null;
      const lock = scrollLock.current;
      scrollLock.current = null;
      if (lock) {
        if (lock.maxShrink > 0.5) {
          // Ease the compensation padding out (~160ms) instead of dropping it in
          // one frame. When scrollTop sits at/near max, an instant release forces
          // the browser to clamp it by up to maxShrink px in a single frame — the
          // whole panel visibly snaps. Gradual release turns that into a smooth
          // settle; when no clamp is needed it's visually a no-op.
          const el = lock.el, basePad = lock.basePad, fromShrink = lock.maxShrink;
          // Distance-scaled duration keeps the per-frame velocity gentle for big
          // releases (320px over 160ms ease-out opened at ~60px/frame — too snappy).
          const t0 = performance.now(), DUR = Math.min(300, Math.max(140, fromShrink * 0.8));
          settleCleanup.current = () => { el.style.paddingBottom = ''; };
          const step = (now: number) => {
            const t = Math.min(1, (now - t0) / DUR);
            const eased = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t); // ease-in-out
            const extra = fromShrink * (1 - eased);
            if (t >= 1) {
              settleRaf.current = 0;
              el.style.paddingBottom = '';
              settleCleanup.current = null;
            } else {
              el.style.paddingBottom = `${basePad + extra}px`;
              settleRaf.current = requestAnimationFrame(step);
            }
          };
          settleRaf.current = requestAnimationFrame(step);
        } else {
          lock.el.style.paddingBottom = '';
        }
      }
      if (relockRaf.current) { cancelAnimationFrame(relockRaf.current); relockRaf.current = 0; }
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
      cancelSettle();
    };
  }, [min, max, storageKey, cancelSettle]);

  return { height, handleMouseDown, isDragging };
}

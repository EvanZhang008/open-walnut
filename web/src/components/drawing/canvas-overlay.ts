/**
 * How much of the canvas's bottom an overlay shows in (DrawingViewProps.canvasExtra, such as the
 * walkthrough's caption strip): the editor keeps its own buttons above it (the selection's "Make a
 * diagram", ExcalidrawCanvas pillTop), so neither covers the other. The overlay's children are
 * measured whenever they change or the canvas resizes; nothing shown is room 0.
 */
import { useEffect, useState, type RefObject } from 'react';

/** Where the selection's "Make a diagram" button sits: `y` is its bottom, or its top when `below`; `height` the canvas's. */
export interface SelectionPill { x: number; y: number; below: boolean; height: number }

/** The button's top edge (CSS `top`, before its own translate) clear of an overlay's room at the bottom; it is 28 px high. */
export function pillTop(pill: SelectionPill, bottomRoom: number): number {
  if (bottomRoom <= 0) return pill.y;
  const lowest = pill.height - bottomRoom - 8;
  return pill.below ? Math.min(pill.y, lowest - 28) : Math.min(pill.y, lowest);
}

export function overlayRoom(box: { bottom: number }, children: ArrayLike<{ top: number; height: number }>): number {
  let top = box.bottom;
  for (let i = 0; i < children.length; i++) if (children[i].height > 0) top = Math.min(top, children[i].top);
  return Math.max(0, Math.round(box.bottom - top));
}

export function useOverlayRoom(overlay: RefObject<HTMLElement | null>, active: boolean): number {
  const [room, setRoom] = useState(0);
  useEffect(() => {
    const el = overlay.current;
    const canvas = el?.parentElement;
    if (!active || !el || !canvas) { setRoom(0); return undefined; }
    const measure = () => setRoom(overlayRoom(canvas.getBoundingClientRect(), Array.from(el.children, (c) => c.getBoundingClientRect())));
    measure();
    const changes = new MutationObserver(measure);
    changes.observe(el, { childList: true, subtree: true, characterData: true, attributes: true });
    const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    sizes?.observe(canvas);
    return () => { changes.disconnect(); sizes?.disconnect(); };
  }, [overlay, active]);
  return room;
}

import { useCallback, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

/** How long a row that just moved ignores pointer clicks. */
export const SHIFT_GUARD_MS = 450;

/**
 * Rows that slide under a still pointer (an answered toast leaves and the next
 * one moves up into its place) ignore pointer clicks for SHIFT_GUARD_MS after
 * they move, so a second click meant for the row that left never answers the
 * one that took its place. So does a row that appears while the pointer is over
 * the list (a new ask pushed in under it) or just after a click there (an ask
 * unfolding where the answered one was). A row that stays put, a new row that
 * appears away from the pointer, and a key press (a click with no pointer)
 * answer at once.
 */
export function useShiftClickGuard(rowSelector: string): {
  ref: (root: HTMLElement | null) => void;
  onClickCapture: (e: ReactMouseEvent) => void;
} {
  const movedAt = useRef(new WeakMap<Element, number>());
  const stop = useRef<(() => void) | null>(null);

  const ref = useCallback((root: HTMLElement | null) => {
    stop.current?.();
    stop.current = null;
    if (!root) return;
    // Each row's edges on screen, less what the root and its ancestors have scrolled, so a scroll
    // never reads as a move while a list that shrinks toward its anchored edge (a bottom-anchored
    // stack whose lower row left) still does: there the root's own top moves with the row. A row
    // moved when both its edges did; one that only grew or shrank (its note opened) stayed put.
    const edges = new WeakMap<Element, [number, number]>();
    function scrolled(): number {
      let sum = 0;
      for (let el: Element | null = root; el && el !== document.documentElement; el = el.parentElement) sum += el.scrollTop;
      return sum;
    }
    // Rows observed now: one that left is let go, so a long-lived list holds only what it shows.
    const observed = new Set<Element>();
    let lastDown = Number.NEGATIVE_INFINITY;
    let inside = false;
    const down = () => { lastDown = performance.now(); inside = true; };
    const over = () => { inside = true; };
    const out = () => { inside = false; };
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => read()) : null;
    // A guarded row says so (its choices dim for the moment), so an ignored click never reads as a miss.
    const timers = new Map<Element, number>();
    function guard(row: Element, now: number): void {
      movedAt.current.set(row, now);
      row.setAttribute('data-settling', '');
      window.clearTimeout(timers.get(row));
      // Only the newest mark's timer takes it off (a root attached again marks rows of its own).
      timers.set(row, window.setTimeout(() => {
        if (movedAt.current.get(row) === now) row.removeAttribute('data-settling');
        timers.delete(row);
      }, SHIFT_GUARD_MS));
    }
    function read(): void {
      const base = -scrolled();
      const now = performance.now();
      const rows = new Set(root!.querySelectorAll(rowSelector));
      for (const row of observed) if (!rows.has(row)) { resize?.unobserve(row); observed.delete(row); }
      for (const row of rows) {
        const box = row.getBoundingClientRect();
        const top = Math.round(box.top - base);
        const bottom = Math.round(box.bottom - base);
        const was = edges.get(row);
        if (was === undefined) {
          resize?.observe(row);
          observed.add(row);
          if (inside || now - lastDown < SHIFT_GUARD_MS) guard(row, now);
        } else if (was[0] !== top && was[1] !== bottom) guard(row, now);
        edges.set(row, [top, bottom]);
      }
    }
    read();
    const mutations = typeof MutationObserver === 'function' ? new MutationObserver(read) : null;
    mutations?.observe(root, { childList: true, subtree: true });
    resize?.observe(root);
    root.addEventListener('pointerdown', down, true);
    root.addEventListener('pointermove', over, true);
    root.addEventListener('pointerleave', out);
    stop.current = () => {
      mutations?.disconnect(); resize?.disconnect();
      // A row still settling keeps its mark until its own timer ends it: the click check reads
      // movedAt, which outlives this root, so a mark taken off here left a row that looked ready
      // and ignored the click (the toaster's root is attached again when its corner moves).
      root.removeEventListener('pointerdown', down, true);
      root.removeEventListener('pointermove', over, true);
      root.removeEventListener('pointerleave', out);
    };
  }, [rowSelector]);

  const onClickCapture = useCallback((e: ReactMouseEvent) => {
    if (e.detail === 0) return;
    const row = (e.target as Element | null)?.closest?.(rowSelector);
    const at = row ? movedAt.current.get(row) : undefined;
    if (at === undefined || performance.now() - at >= SHIFT_GUARD_MS) return;
    e.preventDefault();
    e.stopPropagation();
  }, [rowSelector]);

  return { ref, onClickCapture };
}

/**
 * Keeps a pop-up hung on its key by CSS alone inside the window (2026-11-28, the UI audit: on the
 * Agents page at 390 x 844 the menu of the last card on screen opened at y 833 to 975, under the
 * window's edge, because `.agent-menu` is `position: absolute; top: 100%` and nothing measured it).
 *
 * Menus portalled into <body> are placed by useMenuPlacement. Many family members are not: they
 * sit in their key's wrapper and are hung by CSS (`top: 100%` below it, `bottom: 100%` above it).
 * This places all of those, once, for every window: a family member (`.wn-overlay`) or an opted-in
 * pop-up (`[data-fit-window]`) whose computed position is `absolute`, when it shows, is measured
 * and, only if it runs past the window, moved:
 *   - past the bottom (or the top) when hung below (or above) its key: it flips to the other side
 *     of its key, keeping its gap, when it fits there;
 *   - otherwise it is shifted into the window, and capped to the window's height (it scrolls);
 *   - past the left or right edge: shifted in.
 * It moves by `translate`, on top of the pop-up's own (some centre themselves with it), so its layout
 * stays as its CSS made it (a pop-up stretched between two insets keeps its width) and the family's
 * entrance (`scale`) is untouched; it puts back what the pop-up had once the room is there again.
 *
 * Measures run in a frame (never in React's commit): on show, for a few frames while it settles
 * (it grows in), and while one is open on a page scroll, a window resize or its own growth.
 * Guard: tests/web/inline-overlay-fit.test.ts (the maths and the class), and
 * tests/e2e/browser/inline-overlay-fit.spec.ts (a real menu at the window's foot).
 */

import { movedBy } from './translate-by';

/** The room a pop-up keeps from the window's edges. */
export const FIT_MARGIN = 8;
/** What this layer places: the family's floating surfaces, and pop-ups that opt in. */
export const FIT_SELECTOR = '.wn-overlay, [data-fit-window]';
/** Frames a pop-up is followed after it shows (its entrance). */
const SETTLE_FRAMES = 24;

export interface Box { top: number; left: number; width: number; height: number }
export interface Fit { dx: number; dy: number; maxHeight?: number }

/**
 * Where a pop-up goes so it stays in the window. `box` is where its CSS put it, `anchor` the box of
 * what it hangs on (its containing block), `view` the window. Pure, so it is tested alone.
 */
export function fitInWindow(box: Box, anchor: Box, view: { width: number; height: number }, margin = FIT_MARGIN): Fit {
  const bottom = box.top + box.height;
  const right = box.left + box.width;
  let dy = 0;
  let maxHeight: number | undefined;
  if (bottom > view.height - margin || box.top < margin) {
    const anchorBottom = anchor.top + anchor.height;
    const below = box.top >= anchorBottom - 1;
    const above = bottom <= anchor.top + 1;
    let flipped: number | null = null;
    if (below && bottom > view.height - margin) {
      const top = anchor.top - (box.top - anchorBottom) - box.height;
      if (top >= margin) flipped = top;
    } else if (above && box.top < margin) {
      const top = anchorBottom + (anchor.top - bottom);
      if (top + box.height <= view.height - margin) flipped = top;
    }
    if (flipped !== null) dy = flipped - box.top;
    else {
      const room = view.height - 2 * margin;
      if (box.height > room) { dy = margin - box.top; maxHeight = Math.max(0, room); }
      else dy = Math.min(Math.max(box.top, margin), view.height - margin - box.height) - box.top;
    }
  }
  let dx = 0;
  if (right > view.width - margin || box.left < margin) {
    const width = Math.min(box.width, view.width - 2 * margin);
    dx = Math.min(Math.max(box.left, margin), view.width - margin - width) - box.left;
  }
  return { dx: Math.round(dx), dy: Math.round(dy), maxHeight: maxHeight === undefined ? undefined : Math.floor(maxHeight) };
}

/** What this layer set on a pop-up: its move and its cap, and the inline values it had before. */
interface Placed { dx: number; dy: number; cap?: number; own: string; translate: string; maxHeight: string; overflowY: string }
const placed = new Map<HTMLElement, Placed>();
/** Pop-ups on screen now, followed on scroll, resize and growth. */
const open = new Set<HTMLElement>();
const settling = new Map<HTMLElement, number>();
let frame = 0;
let installed = false;
let grows: ResizeObserver | null = null;

/** Put back what the pop-up had inline before this layer moved it. */
function unplace(el: HTMLElement) {
  const p = placed.get(el);
  if (!p) return;
  el.style.translate = p.translate;
  el.style.maxHeight = p.maxHeight;
  el.style.overflowY = p.overflowY;
  el.removeAttribute('data-window-fit');
  placed.delete(el);
}

/** It closed or is no longer one this layer places. */
function release(el: HTMLElement) {
  unplace(el);
  open.delete(el);
  settling.delete(el);
  grows?.unobserve(el);
}

/**
 * Measure one pop-up where its own CSS puts it (its box less this layer's move; its full height
 * when this layer capped it) and move it in if it runs past the window. Nothing is cleared to
 * measure, so a capped list keeps its scroll, and nothing is written when the fit is the same.
 */
function place(el: HTMLElement) {
  if (!el.isConnected || el.getClientRects().length === 0) { release(el); return; }
  const cs = getComputedStyle(el);
  if (cs.position !== 'absolute') { release(el); return; }
  const parent = (el.offsetParent as HTMLElement | null) ?? el.parentElement;
  if (!parent) return;
  if (!open.has(el)) { open.add(el); grows?.observe(el); }
  const was = placed.get(el);
  const r = el.getBoundingClientRect();
  const height = was?.cap !== undefined ? el.scrollHeight + (el.offsetHeight - el.clientHeight) : r.height;
  const a = parent.getBoundingClientRect();
  const fit = fitInWindow(
    { top: r.top - (was?.dy ?? 0), left: r.left - (was?.dx ?? 0), width: r.width, height },
    { top: a.top, left: a.left, width: a.width, height: a.height },
    { width: window.innerWidth, height: window.innerHeight },
  );
  if (was && was.dx === fit.dx && was.dy === fit.dy && was.cap === fit.maxHeight) return;
  if (!fit.dx && !fit.dy && fit.maxHeight === undefined) { unplace(el); return; }
  // Its own translate (some pop-ups centre themselves with it), read before this layer wrote one.
  const base = was ?? { own: cs.translate, translate: el.style.translate, maxHeight: el.style.maxHeight, overflowY: el.style.overflowY };
  placed.set(el, { ...base, dx: fit.dx, dy: fit.dy, cap: fit.maxHeight });
  el.setAttribute('data-window-fit', '');
  // On top of its own translate; its layout stays as its CSS made it.
  el.style.translate = movedBy(base.own, fit.dx, fit.dy);
  if (fit.maxHeight !== undefined) { el.style.maxHeight = `${fit.maxHeight}px`; el.style.overflowY = 'auto'; }
  else { el.style.maxHeight = base.maxHeight; el.style.overflowY = base.overflowY; }
}

function run() {
  frame = 0;
  for (const el of document.querySelectorAll<HTMLElement>(FIT_SELECTOR)) {
    if (!open.has(el) && !el.hasAttribute('data-overlay-exit') && el.getClientRects().length > 0) settling.set(el, SETTLE_FRAMES);
  }
  for (const el of open) if (!settling.has(el)) settling.set(el, 1);
  for (const [el, left] of settling) {
    place(el);
    if (!open.has(el) || left <= 1) settling.delete(el);
    else settling.set(el, left - 1);
  }
  if (settling.size) frame = requestAnimationFrame(run);
}

function wake() { if (!frame) frame = requestAnimationFrame(run); }

/** Does a mutation show or add a pop-up this layer places (cheap: no layout read). */
function touches(node: Node): boolean {
  if (!(node instanceof Element)) return false;
  return node.matches(FIT_SELECTOR) || node.querySelector(FIT_SELECTOR) !== null;
}

/** Installed once per window, from main.tsx. */
export function installInlineOverlayFit(): void {
  if (installed || typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
  installed = true;
  const mo = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes' ? touches(r.target) : Array.from(r.addedNodes).some(touches)) { wake(); return; }
    }
  });
  mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'open'] });
  // Rows that arrive after it opened (an async list): measured again.
  grows = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { if (open.size) wake(); });
  window.addEventListener('resize', () => { if (open.size) wake(); }, { passive: true });
  // The page scrolled under an open pop-up (its key moved); a scroll inside the pop-up itself is its own.
  document.addEventListener('scroll', (e) => {
    if (!open.size) return;
    const t = e.target;
    if (t instanceof Element) for (const el of open) if (el.contains(t)) return;
    wake();
  }, { capture: true, passive: true });
}

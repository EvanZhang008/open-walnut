/**
 * Slide an element from where it was to where a layout change put it, without laying the
 * page out again on every frame.
 *
 * A transition on `width` (or any property that moves other elements) makes the browser lay
 * out everything beside it on each frame. The sidebar did that to the whole page: measured in
 * the Mac app's WebKit on 2026-11-22, each frame of its 250 ms slide took 35 to 50 ms of
 * layout on Org (3,500 elements) before anything else, so the slide could never reach 60
 * frames a second.
 *
 * Here the layout changes once, at the click, and the motion is a `transform` that ends at
 * rest. WebKit and Chromium run a transform animation on the compositor, so it stays smooth
 * while the main thread is busy.
 *
 * The caller reads the element's left edge before the change and calls `slideFrom` in a
 * layout effect after it. A new member of the class (a transition or keyframes on a layout
 * property) fails tests/web/layout-animation-guard.test.ts.
 */

export const SLIDE_MS = 220;
export const SLIDE_EASING = 'cubic-bezier(0.2, 0, 0, 1)';

/** How far the element moved, in whole pixels; 0 when it did not. */
export function slideDistance(beforeLeft: number, afterLeft: number): number {
  const distance = Math.round(beforeLeft - afterLeft);
  return Math.abs(distance) < 1 ? 0 : distance;
}

function reducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/**
 * Start the slide. Null when there is nothing to slide: the element did not move, the
 * browser has no Web Animations, or the user asked for reduced motion.
 */
export function slideFrom(el: HTMLElement, beforeLeft: number): Animation | null {
  if (typeof el.animate !== 'function' || reducedMotion()) return null;
  const distance = slideDistance(beforeLeft, el.getBoundingClientRect().left);
  if (distance === 0) return null;
  return el.animate(
    [{ transform: `translateX(${distance}px)` }, { transform: 'translateX(0)' }],
    { duration: SLIDE_MS, easing: SLIDE_EASING },
  );
}

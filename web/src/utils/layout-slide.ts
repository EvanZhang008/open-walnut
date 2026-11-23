/**
 * Slide an element to where a layout change puts it, without laying the page out again on
 * every frame, and without waiting for that layout to start moving.
 *
 * A transition on `width` (or any property that moves other elements) makes the browser lay
 * out everything beside it on each frame. The sidebar did that to the whole page: measured in
 * the Mac app's WebKit on 2026-11-22, each frame of its 250 ms slide took 35 to 50 ms of
 * layout on Org (3,500 elements) before anything else, so the slide could never reach 60
 * frames a second.
 *
 * Here the layout changes once and the motion is a `transform`, which WebKit and Chromium run
 * on the compositor, off the page's main thread.
 *
 * The motion also has to START before the layout. Measured on 2026-11-23 on live production
 * (Home, 5,900 elements), reading the layer's place on screen every 4 ms: the one layout the
 * click causes (React, style, layout, every ResizeObserver) held the main thread for 150 to
 * 180 ms, and a slide created after it reached the compositor with 72 to 93 % of its way
 * already behind it, so the page jumped and crept the rest. So a `LeadSlide` runs in two
 * steps. `lead` starts the transform at the click, by the distance the layout will move the
 * page, and the caller changes the layout once that frame is on its way to the screen.
 * `land`, in the layout effect, leaves the transform running and takes the layout's move
 * back with a static `translate`, so the page is drawn where the transform has it, whenever
 * that frame reaches the screen. (A second transform swapped in there is shown a slow frame's
 * time behind the first, 60 ms measured: the page stepped back 50 px.) When the transform
 * ends, both are dropped in one frame and the page rests where the layout put it.
 *
 * A new member of the class (a transition or keyframes on a layout property) fails
 * tests/web/layout-animation-guard.test.ts.
 */

export const SLIDE_MS = 220;
/**
 * Slow in, slow out. The first frame of a slide is on screen 40 to 50 ms after the click; an
 * ease that starts fast had covered half the way by then (measured), so the page jumped.
 */
export const SLIDE_EASING = 'cubic-bezier(0.4, 0, 0.2, 1)';
/**
 * The lead holds still for its first two frames: its clock runs from the click, and its first
 * frame is on screen 30 to 60 ms later, so without the hold that much of the way is never
 * shown (17 to 34 % measured with the ease above). The hold is a keyframe, not a `delay`:
 * WebKit hands a delayed animation to the compositor only when the delay is over, which is
 * after the layout (measured: first on screen 140 to 185 ms after the click).
 */
export const LEAD_HOLD_MS = 32;

/** How far the element moved, in whole pixels; 0 when it did not. */
export function slideDistance(beforeLeft: number, afterLeft: number): number {
  const distance = Math.round(beforeLeft - afterLeft);
  return Math.abs(distance) < 1 ? 0 : distance;
}

function reducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

const shift = (px: number) => ({ transform: `translateX(${px}px)` });

export interface LeadSlide {
  /**
   * At the click, before the layout changes: start moving `el` to where it will be drawn once
   * the layout has moved it by `layoutShift` px. Null when nothing moves (no Web Animations,
   * reduced motion, already drawn there): the caller changes the layout at once.
   */
  lead(el: HTMLElement, layoutShift: number): Animation | null;
  /**
   * In the layout effect, after each layout change: keep the page drawn where the lead has
   * it. Returns the slide still on its way, or null when the page is at rest.
   */
  land(el: HTMLElement): Animation | null;
  /** Drop the motion: the element is drawn where the layout puts it. */
  settle(): void;
  /** The slide on its way, if any. */
  running(): Animation | null;
}

export function createLeadSlide(): LeadSlide {
  // `end` is the transform the lead ends at; `layoutLeft` the element's left edge in the
  // layout (offsetLeft: no transform in it) when it started; `landed` once the layout moved.
  let state: { el: HTMLElement; anim: Animation; end: number; layoutLeft: number; landed: boolean } | null = null;
  const rest = () => {
    if (!state) return;
    const { el, anim } = state;
    state = null;
    anim.cancel();
    el.style.translate = '';
  };
  return {
    lead(el, layoutShift) {
      if (typeof el.animate !== 'function' || reducedMotion()) return null;
      const drawnLeft = el.getBoundingClientRect().left;
      rest();
      const offset = slideDistance(drawnLeft, el.getBoundingClientRect().left);
      if (slideDistance(offset, layoutShift) === 0) return null;
      // Held at its end: the layout may land after the motion's time is up.
      const anim = el.animate(
        [
          shift(offset),
          { ...shift(offset), offset: LEAD_HOLD_MS / (LEAD_HOLD_MS + SLIDE_MS), easing: SLIDE_EASING },
          shift(layoutShift),
        ],
        { duration: LEAD_HOLD_MS + SLIDE_MS, fill: 'forwards' },
      );
      state = { el, anim, end: layoutShift, layoutLeft: el.offsetLeft, landed: false };
      const over = () => { if (state?.anim === anim && state.landed) rest(); };
      anim.finished.then(over, () => {});
      return anim;
    },
    land(el) {
      if (!state) return null;
      const moved = el.offsetLeft - state.layoutLeft;
      // The layout moved again under a lead that had landed: take the whole move back.
      if (state.landed) { el.style.translate = `${-moved}px 0`; return state.anim; }
      // The layout moved the page by `moved` and the lead is still drawn on top of it:
      // take the move back, so the lead alone says where the page is.
      if (state.anim.playState === 'finished' && Math.abs(state.end - moved) < 1) { rest(); return null; }
      el.style.translate = `${-moved}px 0`;
      state.landed = true;
      if (state.anim.playState === 'finished') {
        // The lead aimed somewhere else than the layout went: close the difference.
        const { anim: lead, end } = state;
        const last = el.animate([shift(end), shift(moved)], { duration: SLIDE_MS / 2, easing: SLIDE_EASING, fill: 'forwards' });
        lead.cancel();
        state.anim = last;
        last.finished.then(() => { if (state?.anim === last) rest(); }, () => {});
      }
      return state.anim;
    },
    settle: rest,
    running: () => state?.anim ?? null,
  };
}

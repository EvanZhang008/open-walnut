/**
 * The picked tab or segment's capsule slides from the one picked before to the one picked now, as a
 * segmented control or a tab bar does on a Mac or a phone, instead of jumping (styles/motion.css).
 *
 * Each item still draws its own picked look at rest; only while it moves, a capsule of the same look
 * (`.wn-slide-thumb`, choice-controls.css) is drawn under the items, in the strip itself, so it
 * passes under the old item's words rather than over them, and the new item draws no look of its
 * own until the capsule has arrived. The capsule moves by `transform`, on the compositor, and sizes
 * itself to the new item's width on the way: it is one small box positioned on its own, so its
 * width lays out only itself, never the strip.
 */
import { useLayoutEffect, useRef, type RefObject } from 'react';
import { EASE, MOTION_MS, fullMotion } from './motion';

export const SLIDE_SELECTION_MS = MOTION_MS.base;
const EASING = EASE.inOut;

interface Box { left: number; top: number; width: number; height: number }
const boxOf = (el: HTMLElement): Box => ({ left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight });

/**
 * Where `el` comes to rest. A strip whose items change size with the pick (Home's task-list tabs
 * spell out only the picked tab's name, growing it over 180 ms) is read with its running
 * transitions held at their end, then put back where they were.
 */
function restingBox(strip: HTMLElement, el: HTMLElement): Box {
  const moving = strip.getAnimations({ subtree: true }).filter((a) => a.playState === 'running');
  if (moving.length === 0) return boxOf(el);
  const at = moving.map((a) => a.currentTime);
  for (const a of moving) {
    const end = a.effect?.getComputedTiming().endTime;
    if (typeof end === 'number' && Number.isFinite(end)) a.currentTime = Math.max(0, end - 0.01);
  }
  const box = boxOf(el);
  moving.forEach((a, i) => { a.currentTime = at[i]; });
  return box;
}

/** The capsule's way from the old item to the new one, or null when it should not move. */
export function slideFrames(from: Box, to: Box): Keyframe[] | null {
  if (to.width <= 0 || to.height <= 0 || from.width <= 0 || from.height <= 0) return null;
  const dx = Math.round(from.left - to.left);
  const dy = Math.round(from.top - to.top);
  if (dx === 0 && dy === 0) return null;
  return [
    { transform: `translate(${dx}px, ${dy}px)`, width: `${from.width}px`, height: `${from.height}px` },
    { transform: 'translate(0px, 0px)', width: `${to.width}px`, height: `${to.height}px` },
  ];
}

/** Apply a style change to `el` with no transition, so a look it takes back does not fade in. */
function snap(el: HTMLElement, change: () => void) {
  const was = el.style.transition;
  el.style.transition = 'none';
  change();
  void getComputedStyle(el).backgroundColor;
  el.style.transition = was;
}

const running = new WeakMap<HTMLElement, () => void>();

/** Slide the strip's capsule from `from` to `to` (both items of `strip`, its offsetParent). */
export function slideSelection(strip: HTMLElement, from: HTMLElement, to: HTMLElement): void {
  running.get(strip)?.();
  if (from.offsetParent !== strip || to.offsetParent !== strip) return;
  const target = restingBox(strip, to);
  const frames = slideFrames(boxOf(from), target);
  if (!frames) return;
  const thumb = document.createElement('span');
  thumb.className = 'wn-slide-thumb';
  thumb.setAttribute('aria-hidden', 'true');
  thumb.style.left = `${target.left}px`;
  thumb.style.top = `${target.top}px`;
  strip.prepend(thumb);
  snap(from, () => { from.dataset.slideFrom = ''; });
  snap(to, () => { to.dataset.slideTo = ''; });
  const anim = thumb.animate(frames, { duration: SLIDE_SELECTION_MS, easing: EASING, fill: 'forwards' });
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    running.delete(strip);
    snap(to, () => { delete to.dataset.slideTo; });
    snap(from, () => { delete from.dataset.slideFrom; });
    thumb.remove();
  };
  running.set(strip, finish);
  anim.finished.then(finish, finish);
  // A window in the background draws no frames: the motion waits there, and ends (and is
  // dropped) the moment the window shows again, so no timer stands in for its end.
}

/**
 * In a strip's component: after each render, when the item that matches `selector` is another one
 * than last time, slide the capsule to it. The strip must be the items' offsetParent
 * (`position: relative`).
 */
export function useSelectionSlide(stripRef: RefObject<HTMLElement | null>, selector: string, enabled = true): void {
  const lastRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const now = strip.querySelector<HTMLElement>(selector);
    const was = lastRef.current;
    lastRef.current = now;
    if (!enabled || !now || !was || was === now || !was.isConnected || !strip.contains(was) || !fullMotion()) return;
    slideSelection(strip, was, now);
  });
}

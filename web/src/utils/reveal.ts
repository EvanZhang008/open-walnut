/**
 * Rows a heading just opened slide down into place from under it, as an outline does on a Mac
 * (styles/motion.css). Only for the click that opened them: the caller passes `reveal` on the one
 * render that mounts them and is told at once (`onRevealed`) to drop it, so a later draw of the same
 * rows (a filter, a count that went to 0 and back) shows them at once. Opacity and transform only.
 */
import { useLayoutEffect, type RefObject } from 'react';
import { EASE, MOTION_MS, fadesRun, fullMotion } from './motion';

export function useRevealOnMount(ref: RefObject<HTMLElement | null>, reveal: boolean, onRevealed?: () => void): void {
  useLayoutEffect(() => {
    if (!reveal) return;
    onRevealed?.();
    const el = ref.current;
    if (!el || !fadesRun() || typeof el.animate !== 'function') return;
    // Reduce Motion keeps the fade and drops the slide.
    const from: Keyframe = fullMotion() ? { opacity: 0, transform: 'translateY(-6px)' } : { opacity: 0 };
    el.animate([from, {}], { duration: MOTION_MS.base, easing: EASE.out });
    // Only the mount counts: a later `reveal` flag on the same rows is not a click on its heading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

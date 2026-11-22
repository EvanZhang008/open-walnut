/**
 * Whether a text cut to its lines (a line clamp, a max height) hides some of itself: the one
 * measure behind every "show the rest" toggle on a card, the ask card's More (actions/AskCard.tsx)
 * and a thread card's Expand (org/thread-card-text.tsx).
 *
 * It measures again when the box changes size and when its words change, never on every render.
 * While the hover peek (utils/truncation-peek-row.ts) holds the text open, its height says nothing
 * of the cut, so the answer stays as it was and nothing under the pointer moves.
 */
import { useLayoutEffect, useState, type RefObject } from 'react';

const PEEK_OPEN = '[data-peek-open], [data-peek-expanded], [data-peek-down]';

export function useCutOff(root: RefObject<HTMLElement | null>, { parts, whole, slack = 1 }: {
  /** The cut texts inside `root`; absent, `root` itself. */
  parts?: string;
  /** Shown whole now: nothing to measure. */
  whole: boolean;
  /** Pixels a box may overflow by and still count as whole (a descender, a rounding). */
  slack?: number;
}): boolean {
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || whole) return;
    const boxes = () => (parts ? [...el.querySelectorAll<HTMLElement>(parts)] : [el]);
    const measure = () => {
      if (el.closest(PEEK_OPEN) || el.querySelector(PEEK_OPEN)) return;
      setCut(boxes().some((b) => b.scrollHeight > b.clientHeight + slack));
    };
    measure();
    const resized = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    for (const b of boxes()) resized?.observe(b);
    const changed = typeof MutationObserver !== 'undefined' ? new MutationObserver(() => {
      resized?.disconnect();
      for (const b of boxes()) resized?.observe(b);
      measure();
    }) : null;
    changed?.observe(el, { childList: true, subtree: true, characterData: true });
    return () => { resized?.disconnect(); changed?.disconnect(); };
  }, [root, parts, whole, slack]);
  return cut;
}

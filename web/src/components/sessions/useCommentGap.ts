/**
 * While the passage Comment box or the Ask choice is open, the text makes room for
 * it under the passage (comment-gap.ts), the box sits in that room, the timeline
 * scrolls the least it needs to show the passage and the gap, and the timeline's
 * jump-to-latest button steps aside (it would sit on the passage's last line).
 * Closing the box gives the text its own spacing back.
 */
import { useLayoutEffect, type RefObject } from 'react';
import { openGapUnder, passageEndBlock, revealBand } from './comment-gap';
import type { HeldPassageApi } from './useHeldPassage';
import { setHeldQuoteRange } from '@/utils/pin-highlights';

/** Room around the box inside the gap, the same above (the placement gap) and below. */
export const GAP_ABOVE = 10;
const GAP_BELOW = 10;

export function useCommentGap(
  open: boolean,
  held: HeldPassageApi,
  boxRef: RefObject<HTMLElement | null>,
  scrollerRef: RefObject<HTMLElement | null>,
): void {
  useLayoutEffect(() => {
    if (!open) return;
    const range = held.heldRef.current?.range;
    const box = boxRef.current;
    const first = range ? passageEndBlock(range) : null;
    if (!range || !box || !first) return;
    let block = first;
    const room = () => box.offsetHeight + GAP_ABOVE + GAP_BELOW;
    let gap = openGapUnder(block, room());
    // Paint the passage's mark again once its block moved (a re-rendered block): the
    // mark must stay on the words the box is about.
    const repaint = () => { const r = held.heldRef.current?.range; if (r) setHeldQuoteRange(r); };
    const root = document.documentElement;
    root.classList.add('quote-comment-open');
    // Reveal after the timeline has reacted to the taller content: its own
    // keep-the-reader-in-place passes run on that growth (layout effects and
    // resize observers) and would put a reveal made now straight back. Two frames:
    // the first lets those observers run, the second scrolls past them.
    let raf = 0;
    const reveal = () => {
      const scroller = scrollerRef.current;
      if (!scroller || !block.isConnected) return;
      const words = (held.heldRef.current?.range ?? range).getBoundingClientRect();
      // In the last lines of a message, its own footer (copy, time) comes into view too.
      const msg = block.closest('[data-message-id]')?.getBoundingClientRect();
      const end = msg && msg.bottom - gap.bottom() < 48 ? Math.max(msg.bottom, gap.bottom()) : gap.bottom();
      revealBand(scroller, words.top, end);
      held.repair();
    };
    raf = requestAnimationFrame(() => { raf = requestAnimationFrame(reveal); });
    // The box can still be growing then (the Ask choice measures its rows a frame
    // later): while it settles, a taller room is revealed again, so the message's own
    // footer never ends up under the composer.
    const openedAt = performance.now();
    // Re-anchor at once too: the box belongs in the gap from the first frame.
    held.repair();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
      gap.update(room());
      if (performance.now() - openedAt < 600) { cancelAnimationFrame(raf); raf = requestAnimationFrame(reveal); }
    }) : null;
    ro?.observe(box);
    // The message body is rendered from HTML: a reply still streaming in (or a
    // re-render) replaces the block, and the gap with it, while the held passage
    // moves onto the new nodes. Keep the gap under the block the passage ends in now,
    // or the box would lie on the text that follows.
    let moRaf = 0;
    const follow = () => {
      const now = held.heldRef.current?.range;
      const next = now ? passageEndBlock(now) : null;
      if (!next || next === block) return;
      gap.close();
      block = next;
      gap = openGapUnder(block, room());
      repaint();
      held.repair();
    };
    const scroller = scrollerRef.current;
    const mo = scroller && typeof MutationObserver !== 'undefined'
      ? new MutationObserver(() => { cancelAnimationFrame(moRaf); moRaf = requestAnimationFrame(follow); })
      : null;
    if (scroller) mo?.observe(scroller, { childList: true, subtree: true, characterData: true });
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(moRaf);
      mo?.disconnect();
      ro?.disconnect();
      gap.close();
      root.classList.remove('quote-comment-open');
    };
    // One gap per open: the held range and refs are read when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

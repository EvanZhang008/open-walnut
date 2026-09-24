import { useEffect, type RefObject } from 'react';

/**
 * A fold toggle keeps the row that was clicked where it was on screen: only what is
 * below it moves (2026-09-23: "it should stay where it was clicked, the below
 * collapses", then "all thing should be like this").
 *
 * One listener instead of a scroll fix in every handler: the task panel's fold rows
 * belong to half a dozen components, and some folds reach rows other than the one
 * clicked ("Collapse all tiers", an older every-tier project fold). Chromium's
 * native scroll anchoring covers part of this and WebKit, which the Mac app runs,
 * has none. So the clicked row's top is read in the capture phase, before any
 * handler runs, and the nearest scroller is moved by the row's drift in the frames
 * after the fold commits, before they paint.
 *
 * A fold near the end of the list is the case scrolling alone cannot answer: the
 * content gets shorter than the scroll position, the browser clamps it, and every
 * row moves down. The scroller then gets that much room past its end, which drains
 * as the user scrolls back up (only the part still on screen is kept).
 */

const FOLD_ROWS = [
  '.navigation-heading', // Pinned, Projects and every tier heading
  '.tier-project-label', // a project's run inside a tier
  '.task-group-chip', // a folder
  '.todo-group-project-header', // a project in the Projects list
  '.todo-search-fold-toggle', // a fold in the search results
].join(', ');
/** Menu items that fold: ContextMenu renders each item's key as `data-menu-key`. */
const FOLD_MENU_ITEMS = '.wn-context-menu-item[data-menu-key^="collapse"]';
/** Frames the row is held for. A fold commits inside its click, so the first frame
 *  already carries it; the rest catch a follow-up render. */
const HOLD_FRAMES = 3;

/** The nearest ancestor that scrolls. One that only COULD (overflow auto, content fits)
 *  is a fallback: the stacked view nests scroll boxes that are switched off that way. */
function scrollParent(el: Element, root: Element): HTMLElement | null {
  let fallback: HTMLElement | null = null;
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') {
      if (node.scrollHeight > node.clientHeight) return node;
      fallback ??= node;
    }
    if (node === root) break;
  }
  return fallback;
}

export function useFoldAnchor(rootRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // `expected` = where the scroller should be; anything else means something else
    // scrolled it, and the hold lets go rather than pull it back.
    let hold: { row: Element; top: number; scroller: HTMLElement; frames: number; expected: number; anchor: string } | null = null;
    let raf = 0;
    // The row a menu was opened from. Its fold items render in a portal outside the
    // panel, so the click that folds carries no trace of the row.
    let menuOrigin: Element | null = null;

    // Room added past the scroller's end, as extra bottom padding.
    let endRoom: { scroller: HTMLElement; px: number; base: number; inline: string } | null = null;
    const setEndRoom = (px: number) => {
      if (!endRoom) return;
      const { scroller } = endRoom;
      if (px > 0) {
        endRoom.px = px;
        scroller.style.paddingBottom = `${endRoom.base + px}px`;
        return;
      }
      scroller.style.paddingBottom = endRoom.inline;
      scroller.removeEventListener('scroll', drainEndRoom);
      endRoom = null;
    };
    const addEndRoom = (scroller: HTMLElement, px: number) => {
      if (endRoom && endRoom.scroller !== scroller) setEndRoom(0);
      if (!endRoom) {
        endRoom = { scroller, px: 0, base: parseFloat(getComputedStyle(scroller).paddingBottom) || 0, inline: scroller.style.paddingBottom };
        scroller.addEventListener('scroll', drainEndRoom, { passive: true });
      }
      setEndRoom(endRoom.px + px);
    };
    /** Keeps only the part of the added room that is on screen; the rest was never seen. */
    function drainEndRoom() {
      if (!endRoom) return;
      const { scroller, px } = endRoom;
      const onScreen = Math.ceil(scroller.scrollTop + scroller.clientHeight - (scroller.scrollHeight - px));
      if (onScreen < px) setEndRoom(Math.max(0, onScreen));
    }

    const release = () => {
      cancelAnimationFrame(raf);
      if (hold) hold.scroller.style.overflowAnchor = hold.anchor;
      hold = null;
    };
    const step = () => {
      if (!hold) return;
      const { row, scroller } = hold;
      const now = scroller.scrollTop;
      // A fold that shortens the content at the very bottom clamps the scroller; that
      // is the fold's doing, not another scroll.
      const clamped = now < hold.expected && now >= scroller.scrollHeight - scroller.clientHeight - 1;
      if (!row.isConnected || (Math.abs(now - hold.expected) > 1 && !clamped)) { release(); return; }
      const drift = row.getBoundingClientRect().top - hold.top;
      if (Math.abs(drift) >= 0.5) {
        const want = now + drift;
        const short = want - (scroller.scrollHeight - scroller.clientHeight);
        if (short > 0) addEndRoom(scroller, short);
        scroller.scrollTop = want;
      }
      // A fold that grew the content may have pushed earlier room off screen.
      drainEndRoom();
      hold.expected = scroller.scrollTop;
      if (--hold.frames > 0) raf = requestAnimationFrame(step);
      else release();
    };
    const pin = (row: Element) => {
      const scroller = scrollParent(row, root);
      if (!scroller) return;
      release();
      hold = { row, top: row.getBoundingClientRect().top, scroller, frames: HOLD_FRAMES, expected: scroller.scrollTop, anchor: scroller.style.overflowAnchor };
      // Chromium's own anchoring would move the scroller by a rule of its own; off
      // for the hold, so both engines end up exactly here.
      scroller.style.overflowAnchor = 'none';
      raf = requestAnimationFrame(step);
    };

    const onClick = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      if (root.contains(target)) {
        const row = target.closest(FOLD_ROWS);
        if (row && root.contains(row)) pin(row);
      } else if (target.closest(FOLD_MENU_ITEMS) && menuOrigin?.isConnected && root.contains(menuOrigin)) {
        pin(menuOrigin.closest(FOLD_ROWS) ?? menuOrigin);
      }
    };
    // Any new press or scroll gesture ends a hold, so it never fights the user.
    const onPress = (e: Event) => {
      release();
      if (e.target instanceof Element && root.contains(e.target)) menuOrigin = e.target;
    };
    const onContextMenu = (e: Event) => { if (e.target instanceof Element) menuOrigin = e.target; };

    const passive = { capture: true, passive: true } as const;
    document.addEventListener('click', onClick, true);
    root.addEventListener('pointerdown', onPress, true);
    root.addEventListener('contextmenu', onContextMenu, true);
    root.addEventListener('wheel', release, passive);
    root.addEventListener('touchmove', release, passive);
    root.addEventListener('keydown', release, true);
    return () => {
      release();
      setEndRoom(0);
      document.removeEventListener('click', onClick, true);
      root.removeEventListener('pointerdown', onPress, true);
      root.removeEventListener('contextmenu', onContextMenu, true);
      root.removeEventListener('wheel', release, passive);
      root.removeEventListener('touchmove', release, passive);
      root.removeEventListener('keydown', release, true);
    };
  }, [rootRef]);
}

/**
 * A choice strip that scrolls sideways (a TabList, a SegmentedControl, the bell panel's sections, a
 * menu's Pin to row) says so: the edge with more past it fades (`data-strip-more="left"`, `"right"`
 * or `"left right"` on the strip, drawn in choice-controls.css for any element that carries it),
 * and the picked item is brought into the strip's view when it changes, scrolling the strip only,
 * never the page. On a phone the Usage page's segments stopped at
 * "Outside Walnut $0.0(" and "Toke" with nothing saying the row went on (2026-11-26 audit).
 *
 * The attribute is set on the element itself, not through React state, so a scroll never renders.
 */
import { useLayoutEffect, type RefObject } from 'react'

export function stripMore(el: { scrollLeft: number; clientWidth: number; scrollWidth: number }): string {
  const left = el.scrollLeft > 1
  const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
  return [left ? 'left' : '', right ? 'right' : ''].filter(Boolean).join(' ')
}

/** How far from an edge a pick must sit: past the 36 px fade (choice-controls.css), so no part of it is faded. */
export const PICK_MARGIN = 40;

/** The scrollLeft that shows `item` (its offset and width inside the strip) clear of the edge fades,
 *  or null when it shows already. At either end the strip stops there, where no fade is drawn. */
export function scrollToShow(strip: { scrollLeft: number; clientWidth: number; scrollWidth: number }, itemLeft: number, itemWidth: number): number | null {
  const max = Math.max(0, strip.scrollWidth - strip.clientWidth);
  let to: number | null = null;
  if (itemLeft - PICK_MARGIN < strip.scrollLeft) to = Math.max(0, itemLeft - PICK_MARGIN);
  else if (itemLeft + itemWidth + PICK_MARGIN > strip.scrollLeft + strip.clientWidth) to = Math.min(max, itemLeft + itemWidth + PICK_MARGIN - strip.clientWidth);
  return to === null || Math.abs(to - strip.scrollLeft) < 1 ? null : to;
}

/** `pickedSelector` may match inside an item (a tab in a box with its close button): the strip's own child holding it is measured. */
export function useStripEdges(stripRef: RefObject<HTMLElement | null>, pickedSelector: string, enabled = true): void {
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip || !enabled) return;
    // A scroll the person made: then data that widens an item no longer moves the strip, until a
    // new pick. A scroll event shortly after the hook's own write is the hook's.
    let ownUntil = 0;
    let theirs = false;
    const read = () => {
      const more = stripMore(strip);
      if (more) strip.setAttribute('data-strip-more', more);
      else strip.removeAttribute('data-strip-more');
    };
    const showPicked = () => {
      let item = strip.querySelector<HTMLElement>(pickedSelector);
      if (!item || strip.scrollWidth <= strip.clientWidth) return;
      while (item.parentElement && item.parentElement !== strip) item = item.parentElement;
      const left = item.getBoundingClientRect().left - strip.getBoundingClientRect().left + strip.scrollLeft;
      const to = scrollToShow(strip, left, item.offsetWidth);
      if (to === null) return;
      ownUntil = performance.now() + 400;
      strip.scrollLeft = to;
    };
    const onScroll = () => {
      if (performance.now() > ownUntil) theirs = true;
      read();
    };
    showPicked();
    read();
    strip.addEventListener('scroll', onScroll, { passive: true });
    // The strip and each item: a strip that gets its width late (a hidden panel, a font) or an
    // item that widens shows the pick and marks its edges again.
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      if (!theirs) showPicked();
      read();
    });
    const observeAll = () => {
      ro?.observe(strip);
      for (const c of Array.from(strip.children)) ro?.observe(c);
    };
    observeAll();
    // A new pick is brought into view. Items that arrive or change keep the pick in view too,
    // until the person scrolls the strip themselves.
    const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver((records) => {
      const picked = records.some((r) => r.type === 'attributes');
      if (picked) theirs = false;
      if (records.some((r) => r.type === 'childList')) observeAll();
      if (picked || !theirs) showPicked();
      read();
    });
    mo?.observe(strip, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-selected', 'aria-checked', 'aria-current', 'aria-pressed'] });
    return () => {
      strip.removeEventListener('scroll', onScroll);
      ro?.disconnect();
      mo?.disconnect();
      strip.removeAttribute('data-strip-more');
    };
  }, [stripRef, pickedSelector, enabled]);
}

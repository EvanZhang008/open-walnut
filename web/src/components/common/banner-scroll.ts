/**
 * The host list's scroll area (.hpb-scroll) of the attention card:
 *   useScrollCue    how many problem rows sit wholly below the visible part
 *                   (the 'N more below' cue and the bottom fade);
 *   useFirstRowMin  the first row's headline and buttons always fit (--hpb-first,
 *                   the scroll area's min-height), whatever the local section takes;
 *   keepRowInView   a focused control inside a row never scrolls that row's
 *                   headline away (focus scrolling shows the row, not half a button).
 */
import { useLayoutEffect, useState } from 'react';

const ROW_SEL = 'li.hpb-row:not(.hpb-leaving):not(.hpb-ready)';

/** Rows whose first line has not started to show above `viewportBottom` (12px: one line of text). */
export function rowsBelow(viewportBottom: number, rowTops: readonly number[], lineAllowance = 12): number {
  return rowTops.filter((t) => t > viewportBottom - lineAllowance).length;
}

/**
 * `below`: rows wholly under the fold; `clamped`: the list is cut at all (it can
 * scroll), so the cue's place in the footer is kept even when it reads nothing
 * (scrolled to the end), and Dismiss all never moves (N8).
 */
/** Rows whose last line has scrolled above `viewportTop` (the mirror of rowsBelow). */
export function rowsAbove(viewportTop: number, rowBottomsPx: readonly number[], lineAllowance = 12): number {
  return rowBottomsPx.filter((b) => b < viewportTop + lineAllowance).length;
}

export function useScrollCue(scroll: HTMLElement | null, dep: string): { below: number; above: number; clamped: boolean } {
  const [below, setBelow] = useState(0);
  const [above, setAbove] = useState(0);
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    if (!scroll) { setBelow(0); setAbove(0); setClamped(false); return; }
    const read = (): void => {
      const box = scroll.getBoundingClientRect();
      const rects = Array.from(scroll.querySelectorAll<HTMLElement>(ROW_SEL)).map((li) => li.getBoundingClientRect());
      setBelow(rowsBelow(box.bottom, rects.map((r) => r.top)));
      setAbove(rowsAbove(box.top, rects.map((r) => r.bottom)));
      setClamped(scroll.scrollHeight > scroll.clientHeight + 1);
    };
    read();
    scroll.addEventListener('scroll', read, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(read) : null;
    ro?.observe(scroll);
    if (scroll.firstElementChild) ro?.observe(scroll.firstElementChild);
    return () => { scroll.removeEventListener('scroll', read); ro?.disconnect(); };
  }, [scroll, dep]);
  return { below, above, clamped };
}

/** A row's head: its height down to the bottom of its buttons (or its headline when it has none). */
export function rowHeadPx(li: HTMLElement): number {
  const stop = li.querySelector<HTMLElement>('.hpb-actions')
    ?? li.querySelector<HTMLElement>('.hft-headline, .hpb-headline, .hpb-trying, .hpb-fixing');
  if (!stop) return 0;
  return Math.ceil(stop.getBoundingClientRect().bottom - li.getBoundingClientRect().top) + 2;
}

/** The first row's head (it always fits the list). */
export function firstRowMinPx(scroll: HTMLElement): number {
  const li = scroll.querySelector<HTMLElement>(ROW_SEL);
  return li ? rowHeadPx(li) : 0;
}

/**
 * An undo line's height: about one row, the dismissed row's head (an opened
 * row's details are not kept as blank space under 'Hidden until it changes.', N7).
 */
export function undoLinePx(li: HTMLElement | null | undefined): number {
  if (!li) return 0;
  const whole = li.getBoundingClientRect().height;
  const head = rowHeadPx(li);
  return head > 0 ? Math.min(whole, Math.max(head, 34)) : whole;
}

/** Keep --hpb-first on the scroll area current (no re-render: a style property). */
export function useFirstRowMin(scroll: HTMLElement | null, dep: string): void {
  useLayoutEffect(() => {
    if (!scroll) return;
    const write = (): void => { scroll.style.setProperty('--hpb-first', `${firstRowMinPx(scroll)}px`); };
    write();
    const li = scroll.querySelector<HTMLElement>(ROW_SEL);
    let raf = 0;
    const ro = typeof ResizeObserver !== 'undefined' && li
      ? new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(write); }) : null;
    if (li) ro?.observe(li);
    return () => { ro?.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [scroll, dep]);
}

/**
 * Scroll `scroll` so the focused `target` is whole and its row's top stays in
 * view when row-top-to-target fits; else just the target. Returns the delta.
 */
export function keepRowInView(scroll: HTMLElement, target: HTMLElement): number {
  const li = target.closest('li');
  if (!li || !scroll.contains(li)) return 0;
  const sr = scroll.getBoundingClientRect();
  const top = li.getBoundingClientRect().top - sr.top;
  const tr = target.getBoundingClientRect();
  const tTop = tr.top - sr.top;
  const bottom = tr.bottom - sr.top;
  const h = scroll.clientHeight;
  let d = 0;
  if (bottom - top <= h) d = top < 0 ? top : bottom > h ? bottom - h : 0;
  else d = tTop < 0 ? tTop : bottom > h ? bottom - h : 0;
  if (d) scroll.scrollTop += d;
  return d;
}

/** Where the visible part may end, in px from the list's top: each row's bottom and each line block's inside it. */
export function lineBottoms(list: HTMLElement): number[] {
  const top = list.getBoundingClientRect().top;
  const out: number[] = [];
  for (const li of Array.from(list.children) as HTMLElement[]) {
    out.push(li.getBoundingClientRect().bottom - top);
    for (const el of Array.from(li.querySelectorAll<HTMLElement>('.hpb-body > *, .hpb-body > .hft > *, .hpb-actions'))) {
      const r = el.getBoundingClientRect();
      if (r.height > 0) out.push(r.bottom - top);
    }
  }
  return out;
}

/** Each row's bottom, in px from the list's top. */
export function rowBottoms(list: HTMLElement): number[] {
  const top = list.getBoundingClientRect().top;
  return (Array.from(list.children) as HTMLElement[]).map((li) => li.getBoundingClientRect().bottom - top);
}

/**
 * The host list's max height (null: no clamp, everything fits): what the card's
 * cap leaves after the rest of the card, never less than the first row. It ends
 * on the last WHOLE row that fits (N3-18: never a headline without its buttons);
 * only when not even one row fits does it end on a line boundary inside it, so
 * no button or line is ever sliced (N2, N9).
 */
export function scrollMaxPx(
  capPx: number, restPx: number, firstPx: number, contentPx: number, bottoms: readonly number[], rows?: readonly number[],
): number | null {
  const budget = Math.max(firstPx, capPx - restPx);
  if (contentPx <= budget + 0.5) return null;
  const lastFit = (list: readonly number[]): number => {
    let best = 0;
    for (const b of list) if (b <= budget + 0.5 && b > best) best = b;
    return best;
  };
  const best = (rows && lastFit(rows)) || lastFit(bottoms);
  return Math.ceil(Math.max(firstPx, best || budget));
}

/**
 * Below this cap, a card with both the local section and host rows takes its
 * fitted form (N3-3): the local section without its copy chip and every
 * folded host row one line (dot, host, first action, x). Decided from the cap
 * alone, never from a measurement of the fitted card, so it cannot flip back.
 */
// 250: a 600-650px window is fitted; 720px and up keeps two-line rows, which fit there
// down to the narrowest usual task panel (206px wide: the rest of the card ~209px + one row).
export const FIT_CAP_PX = 250;

export function fitsTight(capPx: number | null, both: boolean): boolean {
  return both && capPx != null && capPx < FIT_CAP_PX;
}

/**
 * Inside the fitted form, host rows go one line (dot, host, first action, x) only
 * when the list's room under the cap cannot hold one two-line row (a 206px-wide
 * panel in a 600px window). The room is the cap minus the rest of the card, which
 * the row form does not change, and the exit is higher than the entry.
 */
export const COMPACT_ROW_PX = 46;
export const COMPACT_HYSTERESIS_PX = 6;
/** `denseHeadPx`: the first row's head as last measured in its two-line form (46 by default). */
export function nextCompact(prev: boolean, roomPx: number, denseHeadPx: number = COMPACT_ROW_PX): boolean {
  return prev ? roomPx < denseHeadPx + COMPACT_HYSTERESIS_PX : roomPx < denseHeadPx;
}

/**
 * The ONE scroll region of the card is the host list: the card itself never
 * scrolls (the local section and the footer always show whole), and the list
 * takes what the cap leaves (--hpb-max). No re-render: a style property.
 */
export function useScrollBudget(
  card: HTMLElement | null, scroll: HTMLElement | null, capPx: number | null, dep: string,
  onRoom?: (roomPx: number, firstRowPx: number) => void,
): void {
  useLayoutEffect(() => {
    if (!card || !scroll) return;
    const list = scroll.firstElementChild as HTMLElement | null;
    const write = (): void => {
      const rest = card.offsetHeight - scroll.offsetHeight;
      if (capPx != null) onRoom?.(capPx - rest, firstRowMinPx(scroll));
      const max = capPx == null || !list ? null
        : scrollMaxPx(capPx, rest, firstRowMinPx(scroll), list.offsetHeight, lineBottoms(list), rowBottoms(list));
      if (max == null) scroll.style.removeProperty('--hpb-max');
      else if (scroll.style.getPropertyValue('--hpb-max') !== `${max}px`) scroll.style.setProperty('--hpb-max', `${max}px`);
    };
    write();
    // Next frame, not inside the callback: the write resizes the card it observes (N3-21).
    let raf = 0;
    const ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(write); }) : null;
    ro?.observe(card);
    if (list) ro?.observe(list);
    return () => { ro?.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [card, scroll, capPx, dep, onRoom]);
}

/** 'N more below': bring the first row the fold cuts to the top of the list (the list scrolls, never the page). */
export function scrollRowIntoView(scroll: HTMLElement, li: HTMLElement): void {
  scroll.scrollTop += li.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
}

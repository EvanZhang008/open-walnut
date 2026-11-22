import { useLayoutEffect, useState, type CSSProperties } from 'react';

/** Below this width the session title row puts its labels on a line under the title. */
export const TITLE_ROW_TIGHT_PX = 440;

/**
 * A title that wraps: the row's first line band (`band`, the height the row would have with a
 * one-line title) and the title's own line height (`line`), both in CSS pixels.
 */
export interface TitleRowBand { band: number; line: number }

/** What the title row carries for a wrapped title (session-header-labels.css reads it). */
export function titleRowBandProps(b: TitleRowBand | null): { 'data-title-band'?: 'wrapped'; style?: CSSProperties } {
  if (!b) return {};
  return {
    'data-title-band': 'wrapped',
    style: { '--title-band': `${b.band}px`, '--title-line': `${b.line}px` } as CSSProperties,
  };
}

/** An element's height with its vertical margins (a -4px margin-block gives room back to the row). */
function outerHeight(el: Element): number {
  const cs = getComputedStyle(el);
  return el.getBoundingClientRect().height + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
}

/** The row's flex items, through a `display: contents` box (the narrow row's labels group). */
function flexItems(el: Element): Element[] {
  return [...el.children].flatMap((c) => (getComputedStyle(c).display === 'contents' ? [...c.children] : [c]));
}

/**
 * The first line band of a title row whose title wraps, or null for a one-line title (the row is
 * then left exactly as it was: everything centred on one line). The band is the height of the
 * tallest thing beside the title's first line (the labels, the kebab, the host's leading control,
 * the phase circle) or one title line, so the first line of a wrapped title sits where a one-line
 * title would, and everything beside it centres on that line instead of on the whole block.
 * Heights are read from the leaves (a box the wrapped layout stretches to the band is skipped), so
 * the answer does not depend on itself.
 */
export function readTitleRowBand(row: HTMLElement): TitleRowBand | null {
  const area = row.querySelector<HTMLElement>(':scope > .session-panel-title-area');
  const title = area?.querySelector<HTMLElement>(':scope > .session-panel-title');
  if (!area || !title) return null;
  const tcs = getComputedStyle(title);
  const line = parseFloat(tcs.lineHeight);
  if (!(line > 0)) return null;
  const textH = title.getBoundingClientRect().height - (parseFloat(tcs.paddingTop) || 0) - (parseFloat(tcs.paddingBottom) || 0)
    - (parseFloat(tcs.borderTopWidth) || 0) - (parseFloat(tcs.borderBottomWidth) || 0);
  if (textH < line * 1.5) return null;
  const a = area.getBoundingClientRect();
  let band = line;
  for (const item of flexItems(row)) {
    if (item === area) continue;
    const r = item.getBoundingClientRect();
    // Beside the title only: a box the row wrapped onto a line of its own does not count.
    if (r.height === 0 && item.children.length === 0) continue;
    const leaves = item.children.length ? [...item.children] : [item];
    const rects = leaves.map((l) => l.getBoundingClientRect());
    const top = Math.min(r.top, ...rects.map((x) => x.top));
    if (top >= a.bottom - 1) continue;
    for (const l of leaves) band = Math.max(band, outerHeight(l));
  }
  for (const c of area.children) {
    if (c === title || getComputedStyle(c).position === 'absolute') continue;
    const leaves = c.children.length ? [...c.children] : [c];
    for (const l of leaves) band = Math.max(band, outerHeight(l));
  }
  return { band: Math.round(band * 100) / 100, line };
}

/**
 * Whether the session header's title row is narrow (a third column, a slim window), so
 * its labels (Wait, Cron, Trigger, Worker, Leader, the tags) move to a line under the
 * title, each in full, and the title keeps the whole first line. One width for the whole
 * row, never label by label. Read with a ResizeObserver rather than a CSS container
 * query: a container query needs layout containment on the row, which would make it the
 * containing block of any fixed-position child drawn inside it.
 *
 * The same observer reads the row's first line band when the title wraps (readTitleRowBand),
 * so the labels and the kebab line up with the title's FIRST line, never the middle of the block.
 *
 * Returns a callback ref for the row (it mounts after the record loads) and the answers.
 */
export function useTitleRowTight(): [(el: HTMLElement | null) => void, boolean, TitleRowBand | null] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [tight, setTight] = useState(false);
  const [band, setBand] = useState<TitleRowBand | null>(null);
  // Before paint at mount, so a narrow column never shows the words for one frame.
  useLayoutEffect(() => {
    if (!el) return;
    const read = () => {
      const w = el.getBoundingClientRect().width;
      setTight(w > 0 && w < TITLE_ROW_TIGHT_PX);
      const next = readTitleRowBand(el);
      setBand((prev) => (prev?.band === next?.band && prev?.line === next?.line ? prev : next));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    // A resize is read on the next frame, never inside the observer's callback: the labels
    // moving to their own line changes the header's height, and a box above the row changing
    // inside the callback (or inside the tool row's flushSync in the same pass) is what WebKit
    // reports as 'ResizeObserver loop completed with undelivered notifications' (2026-11-07).
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { raf = 0; read(); });
    });
    ro.observe(el);
    // The title wrapping onto a second line can leave the row's size alone (labels already on their
    // own line): watch the title area too.
    const area = el.querySelector(':scope > .session-panel-title-area');
    if (area) ro.observe(area);
    return () => { ro.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [el]);
  return [setEl, tight, band];
}

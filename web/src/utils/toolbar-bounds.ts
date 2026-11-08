/**
 * A floating toolbar over a selection stays inside the box the selection is shown in: the
 * pane, the sheet, the panel (2026-11-10 review: the Changed tab's Ask here / Quote in chat pill
 * stuck out past the sheet's right edge and over the file tree, clamped only to the window).
 *
 * The box is the visible part of the element the selection lives in: its box cut by every
 * ancestor that really clips it (utils/clip-ancestors.ts) and by the viewport. A clip narrower than the
 * toolbar (a code cell that scrolls sideways) gives way to the next one out, so the toolbar is
 * never squeezed onto the text it is about.
 */

import { clippingAncestors } from './clip-ancestors';

export interface Box { left: number; top: number; right: number; bottom: number }

const EDGE = 4;

function cut(a: Box, b: Box): Box {
  return { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
}

/**
 * The visible boxes around `el`, innermost first; the last one is the viewport. Only the
 * ancestors that really clip it count (utils/clip-ancestors.ts): a full-screen sheet is
 * `position: fixed` inside its old column, whose overflow no longer cuts it.
 */
export function clipBoxesOf(el: Element | null): Box[] {
  const view: Box = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  const boxes: Box[] = [];
  let clip = view;
  // Outermost first, so each box is already cut by everything around it.
  const clips = clippingAncestors(el, { self: true });
  for (let i = clips.length - 1; i >= 0; i--) {
    const { el: e, x, y } = clips[i]!;
    const r = e.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    clip = cut(clip, {
      left: x ? r.left : clip.left, right: x ? r.right : clip.right,
      top: y ? r.top : clip.top, bottom: y ? r.bottom : clip.bottom,
    });
    boxes.unshift(clip);
  }
  boxes.push(view);
  return boxes;
}

/** The innermost box with room for a toolbar this size. */
export function roomyBox(boxes: readonly Box[], w: number, h: number): Box {
  for (const b of boxes) if (b.right - b.left >= w + 2 * EDGE && b.bottom - b.top >= h + 2 * EDGE) return b;
  return boxes[boxes.length - 1]!;
}

/**
 * Where a toolbar of `size` goes for a selection `rect`: on its preferred side unless that side
 * has no room inside `box`, at the pointer's x kept over the selection, and wholly inside `box`.
 */
export function placeToolbar(
  rect: Box, pointerX: number, size: { w: number; h: number }, box: Box, preferBelow: boolean, gap = 8,
): { left: number; top: number; below: boolean } {
  let below = preferBelow;
  if (below && rect.bottom + gap + size.h > box.bottom - EDGE) below = false;
  if (!below && rect.top - gap - size.h < box.top + EDGE) below = true;
  const cx = Math.min(Math.max(pointerX, rect.left), rect.right);
  const left = Math.max(box.left + EDGE, Math.min(cx - size.w / 2, box.right - size.w - EDGE));
  const raw = below ? rect.bottom + gap : rect.top - gap - size.h;
  // A selection taller than the box (or scrolled half out of it): the toolbar stays in sight.
  const top = Math.max(box.top + EDGE, Math.min(raw, box.bottom - size.h - EDGE));
  return { left, top, below };
}

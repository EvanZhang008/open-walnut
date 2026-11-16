/**
 * Beside placement for useMenuPlacement: a popover that opens to the SIDE of its
 * anchor (right first, then left) with an arrow pointing at it, the way a
 * calendar's new-event popover sits next to the block it creates instead of
 * covering it. When neither side has room the hook falls back to its usual
 * below/above placement and this module gives that placement its arrow.
 *
 * Pure geometry, no DOM: tests/web/menu-placement-beside.test.ts drives it.
 */

/** Which edge of the menu the arrow sits on, and the viewport point of its base's middle. */
export interface PlacementArrow {
  edge: 'left' | 'right' | 'top' | 'bottom';
  x: number;
  y: number;
}

export interface BesideInput {
  anchor: { top: number; bottom: number; left: number; right: number };
  /** The menu's natural, uncapped height (0 before it has mounted). */
  naturalHeight: number;
  menuWidth: number;
  viewportWidth: number;
  viewportHeight: number;
  /** Room between anchor and menu: must hold the arrow. */
  gap: number;
  margin: number;
  /** Space taken at the top (the phone top bar). */
  topInset?: number;
}

/** How far below the menu's top the arrow sits when nothing pushes it: level with a title row. */
const ARROW_LEAD = 36;
/** The arrow never sits closer than this to a rounded corner. */
const ARROW_INSET = 16;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * Right of the anchor when the menu fits there, else left of it, else null
 * (the caller places it below or above). The menu's top is set so the arrow
 * points at the visible part of the anchor, then clamped into the viewport.
 */
export function besidePlacement(input: BesideInput): { top: number; right: number; maxHeight: number; arrow: PlacementArrow } | null {
  const { anchor, naturalHeight, menuWidth, viewportWidth, viewportHeight, gap, margin } = input;
  if (menuWidth <= 0) return null;
  const topInset = input.topInset ?? 0;
  let menuLeft: number;
  let edge: 'left' | 'right';
  if (menuWidth <= viewportWidth - anchor.right - gap - margin) {
    menuLeft = anchor.right + gap;
    edge = 'left';
  } else if (menuWidth <= anchor.left - gap - margin) {
    menuLeft = anchor.left - gap - menuWidth;
    edge = 'right';
  } else {
    return null;
  }

  const cap = Math.max(viewportHeight - topInset - margin * 2, Math.min(viewportHeight, 48));
  const height = Math.min(naturalHeight || cap, cap);
  // Point at the part of the anchor on screen: a long drag-selected block, or one
  // scrolled half away, still gets an arrow at a part the user can see.
  const visTop = Math.max(anchor.top, topInset + margin);
  const visBottom = Math.min(anchor.bottom, viewportHeight - margin);
  const target = visBottom > visTop
    ? Math.min((visTop + visBottom) / 2, visTop + 24)
    : clamp(anchor.top, topInset + margin, viewportHeight - margin);
  let top = target - Math.min(ARROW_LEAD, height / 2);
  top = Math.min(top, viewportHeight - height - margin);
  top = Math.max(top, margin + topInset);
  const y = clamp(target, top + ARROW_INSET, top + height - ARROW_INSET);
  return {
    top,
    right: viewportWidth - menuLeft - menuWidth,
    maxHeight: cap,
    arrow: { edge, x: edge === 'left' ? menuLeft : menuLeft + menuWidth, y },
  };
}

/** The arrow of a below/above placement: on the edge facing the anchor, under its middle. */
export function verticalArrow(
  placed: { top: number; right: number; maxHeight: number; side: 'up' | 'down' },
  anchor: { left?: number; right: number },
  menuWidth: number,
  naturalHeight: number,
  viewportWidth: number,
): PlacementArrow {
  const menuLeft = viewportWidth - placed.right - menuWidth;
  const mid = ((anchor.left ?? anchor.right) + anchor.right) / 2;
  const x = clamp(mid, menuLeft + ARROW_INSET, menuLeft + menuWidth - ARROW_INSET);
  const height = Math.min(naturalHeight || placed.maxHeight, placed.maxHeight);
  return placed.side === 'up'
    ? { edge: 'bottom', x, y: placed.top + height }
    : { edge: 'top', x, y: placed.top };
}

export function sameArrow(a?: PlacementArrow, b?: PlacementArrow): boolean {
  if (!a || !b) return a === b;
  return a.edge === b.edge && a.x === b.x && a.y === b.y;
}

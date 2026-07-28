/**
 * useMenuPlacement — single source of truth for placing a `position: fixed`
 * dropdown next to its trigger button.
 *
 * Why this exists: a kebab/dropdown here escapes its clipping ancestors by
 * rendering `position: fixed`, which means the component owns the placement
 * math. Several components hand-rolled that math, and two of them GUESSED the
 * menu height with a hardcoded constant (`extraSection ? 560 : 350`). The real
 * two-section menu measures ~770px, so the guess was low: it reported "fits
 * below", opened downward, and the tail hung off the bottom. And since a fixed
 * menu sits in NO scroll container, those overflowing items weren't merely
 * scrolled away — they were unreachable, with no scrollbar and no wheel target.
 *
 * This hook instead MEASURES the menu's natural height after mount and returns
 * a `maxHeight` for the space actually available, so the menu scrolls its own
 * content rather than overflowing the viewport.
 *
 * ⚠️ CONTRACT: `maxHeight` only helps if the menu's CSS also sets
 * `overflow-y: auto`. Without it, a capped menu is clipped-and-unreachable —
 * exactly the original bug. See `.task-kebab-menu` in globals.css.
 *
 * Placement rules:
 *   - Prefer opening downward; flip upward only when the menu doesn't fit below
 *     AND above has more room (a plain `>`, no threshold — see computePlacement).
 *   - `maxHeight` = the space available on the chosen side, except when that is
 *     below `minHeight`: a menu squeezed to 40px is useless, so minHeight wins
 *     and the menu is clamped into the viewport and scrolls instead.
 *   - Right-aligned to the trigger, then clamped so the left edge stays on-screen.
 *
 * Adopted by TaskQuickActions + TaskKebabMenu. NOT adopted (yet) by
 * ViewDropdown / SessionForkButton — those already measure correctly — nor by
 * TaskBatchMenu, which anchors by `bottom` and so needs a different return shape.
 *
 * Measurement happens in `useLayoutEffect` (before paint, so no visible jump)
 * and is kept in sync on scroll/resize via a rAF-throttled listener.
 */

import { useState, useLayoutEffect, type RefObject } from 'react';

export interface MenuPlacement {
  top: number;
  right: number;
  maxHeight: number;
}

interface Options {
  /** Gap between the trigger and the menu. */
  gap?: number;
  /** Minimum gutter kept between the menu and the viewport edges. */
  margin?: number;
  /**
   * Never shrink the menu below this — a menu squeezed into a 40px sliver is
   * useless even if technically "on screen". When the chosen side has less room
   * than this, minHeight wins and `top` is clamped so the menu still lands fully
   * on screen and scrolls internally. 180px ≈ 6 rows of .task-kebab-item (28px
   * each) plus padding — enough to be worth opening.
   */
  minHeight?: number;
  /**
   * Anchor at a viewport point instead of the trigger element — used by the
   * right-click-a-task-row path, which opens the menu at the cursor. Must be
   * referentially stable (keep it in state), since it is a dependency.
   */
  anchorPoint?: { x: number; y: number } | null;
}

export interface PlacementInput {
  /**
   * Anchor box in viewport coords. Only `right` is used horizontally: the menu's
   * RIGHT edge aligns to it, so a cursor-anchored menu opens leftward from the
   * click (deliberate — a task row's kebab lives at the row's right edge, and
   * matching that keeps right-click and button paths visually identical).
   * A cursor anchor is zero-height: `top === bottom === cursor y`.
   */
  anchor: { top: number; bottom: number; right: number };
  /** The menu's natural, uncapped height (0 before it has mounted). */
  naturalHeight: number;
  /** The menu's rendered width (0 before it has mounted). */
  menuWidth: number;
  viewportWidth: number;
  viewportHeight: number;
  gap: number;
  margin: number;
  minHeight: number;
}

/**
 * The placement math, extracted as a pure function so the invariants that
 * actually broke ("never taller than the viewport", "never clipped off the
 * bottom", "cap equals the space available") are unit-testable without a DOM.
 */
export function computePlacement(input: PlacementInput): MenuPlacement {
  const { anchor, naturalHeight, menuWidth, viewportWidth, viewportHeight, gap, margin, minHeight } = input;

  const spaceBelow = viewportHeight - anchor.bottom - gap - margin;
  const spaceAbove = anchor.top - gap - margin;

  // Open downward unless it doesn't fit AND there is more room above.
  const openUp = naturalHeight > spaceBelow && spaceAbove > spaceBelow;
  const available = Math.max(openUp ? spaceAbove : spaceBelow, 0);

  // Cap to the space available, but never below minHeight and never above the
  // viewport itself (a minHeight bigger than the window would re-introduce the
  // very clipping this fixes).
  const viewportCap = Math.max(viewportHeight - margin * 2, 0);
  // `|| available` carries the pre-mount pass, where naturalHeight is still 0.
  // Without it that first frame would collapse to maxHeight === minHeight.
  const wanted = naturalHeight || available;
  const maxHeight = Math.min(Math.max(Math.min(wanted, available), minHeight), viewportCap);
  const height = Math.min(wanted || maxHeight, maxHeight);

  // Clamp into the viewport so a menu taller than the chosen side (i.e. one that
  // bottomed out at minHeight) still lands fully on screen and scrolls inside.
  let top = openUp ? anchor.top - gap - height : anchor.bottom + gap;
  top = Math.min(top, viewportHeight - height - margin);
  top = Math.max(top, margin);

  // Right-aligned to the anchor, clamped so the left edge stays visible.
  let right = viewportWidth - anchor.right;
  if (menuWidth > 0) {
    right = Math.min(right, Math.max(margin, viewportWidth - menuWidth - margin));
  }
  right = Math.max(right, margin);

  return { top, right, maxHeight };
}

/**
 * @param open      Whether the menu is rendered.
 * @param triggerRef The button the menu is anchored to.
 * @param menuRef   The menu element (measured for its natural height/width).
 * @returns `null` until measured, then fixed-position coords + a height cap.
 */
export function useMenuPlacement(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  menuRef: RefObject<HTMLElement | null>,
  options: Options = {},
): MenuPlacement | null {
  const { gap = 2, margin = 8, minHeight = 180, anchorPoint = null } = options;
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);

  useLayoutEffect(() => {
    if (!open) { setPlacement(null); return; }

    const place = () => {
      const menu = menuRef.current;
      // A cursor anchor is a zero-size rect at the click point; otherwise use
      // the trigger button's box.
      const r = anchorPoint
        ? { top: anchorPoint.y, bottom: anchorPoint.y, right: anchorPoint.x }
        : triggerRef.current?.getBoundingClientRect();
      if (!r) return;

      const next = computePlacement({
        anchor: { top: r.top, bottom: r.bottom, right: r.right },
        // Natural (unconstrained) height: scrollHeight ignores our own max-height
        // cap, so re-measuring on every reposition stays stable instead of
        // ratcheting down to whatever we capped it at last time.
        naturalHeight: menu ? menu.scrollHeight : 0,
        menuWidth: menu ? menu.offsetWidth : 0,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        gap, margin, minHeight,
      });

      // ⚠️ LOAD-BEARING, not a micro-optimisation: the ResizeObserver below
      // watches the very element whose size we set (we apply maxHeight → its box
      // changes → RO fires → place() runs again). Two things break that cycle:
      // reading `scrollHeight` (independent of our cap, see above) makes the
      // computed result identical, and this identity bail-out then stops the
      // state update. Remove it and you get an infinite render loop.
      setPlacement((prev) =>
        prev && prev.top === next.top && prev.right === next.right && prev.maxHeight === next.maxHeight
          ? prev
          : next);
    };

    place();

    let raf = 0;
    const onScrollOrResize = (e?: Event) => {
      // A scroll INSIDE the menu is the user reading a capped menu — don't
      // reposition (and re-measuring mid-scroll would fight the scrollbar).
      if (e && menuRef.current?.contains(e.target as Node)) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(place);
    };
    // capture:true — any nested scroller moving the trigger must reposition us.
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);

    // The menu's own content can grow AFTER mount — an async task fetch filling
    // in rows, a date picker switching months, an "investigate" result line. A
    // one-shot measurement would then be stale (too-small cap, wrong flip), so
    // track the element itself.
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined' && menuRef.current) {
      ro = new ResizeObserver(() => onScrollOrResize());
      ro.observe(menuRef.current);
    }

    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [open, triggerRef, menuRef, gap, margin, minHeight, anchorPoint]);

  return placement;
}

/** Inline style for a menu placed by {@link useMenuPlacement}. */
export function menuPlacementStyle(p: MenuPlacement | null): React.CSSProperties | undefined {
  if (!p) {
    // Pre-measurement pass: park the menu off-screen so the frame before
    // placement is known never flashes at 0,0. It must stay LAID OUT (hence a
    // position offset rather than display:none) for scrollHeight/offsetWidth to
    // be measurable.
    return { position: 'fixed', top: 0, left: -9999, zIndex: 9999 };
  }
  return { position: 'fixed', top: p.top, right: p.right, maxHeight: p.maxHeight, zIndex: 9999 };
}

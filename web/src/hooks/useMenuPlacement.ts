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
 *     AND above has more room. The side is decided ONCE and then latched for the
 *     lifetime of that open, so scrolling repositions the menu without ever
 *     flipping it mid-scroll (see PlacementInput.forceSide).
 *   - `maxHeight` = the space available on the chosen side, except when that is
 *     below `minHeight`: a menu squeezed to 40px is useless, so minHeight wins
 *     and the menu is clamped into the viewport and scrolls instead.
 *   - Right-aligned to the trigger, then clamped so the left edge stays on-screen.
 *
 * Adopted by TaskQuickActions, TaskKebabMenu and DatePicker (popover mode). NOT
 * adopted by ViewDropdown / SessionForkButton — those already measure correctly —
 * nor by TaskBatchMenu, which anchors by `bottom` and so needs a different return
 * shape, nor by PriorityPicker, which is short enough to only need the flip.
 *
 * Measurement happens in `useLayoutEffect` (before paint, so no visible jump)
 * and is kept in sync on scroll/resize via a rAF-throttled listener.
 */

import { useState, useRef, useLayoutEffect, type CSSProperties, type RefObject } from 'react';

export interface MenuPlacement {
  top: number;
  right: number;
  maxHeight: number;
}

export interface MenuPlacementOptions {
  /**
   * Called when the anchor stops being placeable — the trigger was unmounted or
   * `display:none`d while the menu was open (the live search filter, a tab
   * switch, a WS-driven re-render). Its rect then reads all zeros, which is NOT
   * a position: without this the menu is placed at the top-left corner detached
   * from everything, and the components' own "did the trigger scroll away?"
   * check can't help because `0 < 0 || 0 > innerHeight` is false. The owner
   * should close the menu.
   */
  onAnchorLost?: () => void;
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

/** Which side the menu opens toward. `null` = decide from the geometry. */
export type OpenSide = 'up' | 'down' | null;

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
  /**
   * Force a side instead of deriving one. The hook latches the first decision
   * for the lifetime of one open: `place()` re-runs on every scroll frame, and
   * re-deciding there makes a tall menu teleport (measured: a 5px scroll of the
   * trigger past the viewport midpoint flipped the menu 354px). The pre-refactor
   * code decided once at open time; latching preserves that feel while keeping
   * the position glued to the trigger.
   */
  forceSide?: OpenSide;
}

/**
 * The placement math, extracted as a pure function so the invariants that
 * actually broke ("never taller than the viewport", "never clipped off the
 * bottom", "cap equals the space available") are unit-testable without a DOM.
 */
export function computePlacement(input: PlacementInput): MenuPlacement & { side: 'up' | 'down' } {
  const { anchor, naturalHeight, menuWidth, viewportWidth, viewportHeight, gap, margin, minHeight, forceSide } = input;

  const spaceBelow = viewportHeight - anchor.bottom - gap - margin;
  const spaceAbove = anchor.top - gap - margin;

  // Open downward unless it doesn't fit AND there is more room above. A caller
  // that already opened (forceSide) keeps its side — see PlacementInput.forceSide.
  const openUp = forceSide
    ? forceSide === 'up'
    : naturalHeight > spaceBelow && spaceAbove > spaceBelow;
  const available = Math.max(openUp ? spaceAbove : spaceBelow, 0);

  // Cap to the space available, but never below minHeight and never above the
  // viewport itself (a minHeight bigger than the window would re-introduce the
  // very clipping this fixes).
  //
  // The viewport cap is the LAST clamp, so it must never reach 0: a zero-height
  // menu shows nothing at all, which is strictly worse than the clipping this
  // fixes. `viewportHeight <= margin * 2` (a very short window, or a caller
  // passing a large margin) would otherwise produce exactly that — so give up
  // the margins before giving up the menu.
  const ABSOLUTE_MIN = 48;   // ~1 row + padding: still usable, still scrollable
  const viewportCap = Math.max(viewportHeight - margin * 2, Math.min(viewportHeight, ABSOLUTE_MIN));
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

  return { top, right, maxHeight, side: openUp ? 'up' : 'down' };
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
  options: MenuPlacementOptions = {},
): MenuPlacement | null {
  const { gap = 2, margin = 8, minHeight = 180, anchorPoint = null, onAnchorLost } = options;
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);
  // The side is decided ONCE per open and then latched — see PlacementInput.forceSide.
  const sideRef = useRef<OpenSide>(null);
  // Latest callback without making it a dependency (a fresh arrow per render
  // would otherwise tear down and re-run the whole effect every render).
  const onAnchorLostRef = useRef(onAnchorLost);
  onAnchorLostRef.current = onAnchorLost;

  useLayoutEffect(() => {
    // Reset the latch on close AND on a new anchor: a second right-click at a
    // different point (or right-click → kebab-button) changes the anchor without
    // `open` ever going false, and a side latched for the old anchor can then be
    // badly wrong (measured: 'down' latched for a cursor at y=660 in a 700px
    // window placed the menu 148px ABOVE the cursor, squeezed to minHeight).
    sideRef.current = null;
    if (!open) { setPlacement(null); return; }

    const place = () => {
      const menu = menuRef.current;
      // A cursor anchor is a zero-size rect at the click point; otherwise use
      // the trigger button's box.
      const trigger = triggerRef.current;
      const r = anchorPoint
        ? { top: anchorPoint.y, bottom: anchorPoint.y, right: anchorPoint.x }
        : trigger?.getBoundingClientRect();
      if (!r) return;

      // A trigger that was unmounted or display:none'd while the menu is open
      // reports an all-zero rect. That is "no anchor", not "anchor at 0,0":
      // placing against it parks the menu in the top-left corner (measured:
      // right: 1280px on a 1280px viewport, i.e. fully off-screen left) and no
      // scroll can recover it. Cursor anchors are exempt — they're legitimately
      // zero-HEIGHT, and they don't depend on the trigger still existing.
      if (!anchorPoint && trigger
          && (trigger.offsetWidth === 0 || trigger.offsetHeight === 0 || !trigger.isConnected)) {
        onAnchorLostRef.current?.();
        return;
      }

      // Natural (unconstrained) height. Two subtleties, both load-bearing:
      //  · scrollHeight ignores our own max-height cap, so re-measuring on every
      //    reposition stays stable instead of ratcheting down to whatever we
      //    capped it at last time.
      //  · scrollHeight is a PADDING-box measure, but these menus are
      //    box-sizing: border-box with a 1px border, and max-height applies to
      //    the border box. Feeding the raw scrollHeight back as max-height
      //    therefore leaves exactly (border-top + border-bottom) px permanently
      //    unreachable — a menu that fits perfectly still shows a scrollbar and
      //    swallows wheel events via overscroll-behavior. Add the border back.
      //
      // Read the border from computed style, NOT from `offsetHeight -
      // clientHeight`: that difference is border PLUS any horizontal scrollbar,
      // so the moment a cap makes one appear it inflates by ~16px, and the next
      // pass adds that on top again — the cap then ratchets DOWN instead of
      // tracking the content (measured: a menu with 628px of content in 764px of
      // space stuck at 472px). Computed border widths depend on nothing we set.
      const borderY = menu
        ? (() => {
            const cs = getComputedStyle(menu);
            return (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
          })()
        : 0;

      const next = computePlacement({
        anchor: { top: r.top, bottom: r.bottom, right: r.right },
        naturalHeight: menu ? menu.scrollHeight + borderY : 0,
        menuWidth: menu ? menu.offsetWidth : 0,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        gap, margin, minHeight,
        forceSide: sideRef.current,
      });
      // Latch on the first pass only — but not before the menu has been measured,
      // or we'd freeze a side chosen from naturalHeight 0 (which always "fits
      // below") and never reconsider once the real height is known.
      if (menu && sideRef.current === null) sideRef.current = next.side;

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
    // in rows, a date picker switching months, an "investigate" result line — and
    // a one-shot measurement would leave the cap and the flip decision stale.
    //
    // ⚠️ Observe the CHILDREN, not the menu. ResizeObserver watches the border
    // box, and once we apply maxHeight that box is pinned: content growth then
    // changes only scrollHeight, so observing the menu itself fires ZERO times
    // (measured: 400px of content added under a cap → 0 callbacks, vs 1 when
    // uncapped). That is exactly backwards — it would work only for menus that
    // already fit. The children are unclamped, so their resize is observable.
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined' && menuRef.current) {
      ro = new ResizeObserver(() => onScrollOrResize());
      for (const child of Array.from(menuRef.current.children)) ro.observe(child);
    }
    // Rows appearing/disappearing changes the child LIST, which no
    // ResizeObserver reports — re-observe the new children and re-place.
    //
    // Two rAFs, not one: a MutationObserver callback runs as a microtask right
    // after the mutation, BEFORE the frame's layout, so scrollHeight there still
    // reports the old content (measured: a +160px insertion moved the cap by only
    // the 2.5px border correction). Waiting one extra frame lets layout settle so
    // the re-measure sees the real height.
    let mo: MutationObserver | undefined;
    let moRaf = 0;
    if (typeof MutationObserver !== 'undefined' && menuRef.current) {
      const menuEl = menuRef.current;
      mo = new MutationObserver(() => {
        if (ro) for (const child of Array.from(menuEl.children)) ro.observe(child);
        cancelAnimationFrame(moRaf);
        moRaf = requestAnimationFrame(() => { moRaf = requestAnimationFrame(place); });
      });
      mo.observe(menuEl, { childList: true, subtree: true });
    }

    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(moRaf);
      ro?.disconnect();
      mo?.disconnect();
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [open, triggerRef, menuRef, gap, margin, minHeight, anchorPoint]);

  return placement;
}

/** Inline style for a menu placed by {@link useMenuPlacement}. */
export function menuPlacementStyle(p: MenuPlacement | null): CSSProperties {
  if (!p) {
    // Pre-measurement pass: park the menu off-screen so the frame before
    // placement is known never flashes at 0,0. It must stay LAID OUT (hence a
    // position offset rather than display:none) for scrollHeight/offsetWidth to
    // be measurable. pointerEvents:none because an element at left:-9999 is
    // still hit-testable and still matches Playwright's `:visible`, so without
    // it a click could land on the unplaced frame.
    return { position: 'fixed', top: 0, left: -9999, zIndex: 9999, pointerEvents: 'none' };
  }
  return { position: 'fixed', top: p.top, right: p.right, maxHeight: p.maxHeight, zIndex: 9999 };
}

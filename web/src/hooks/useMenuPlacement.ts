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
  /**
   * Horizontal alignment relative to the anchor. Default 'right' (menu's right
   * edge at the anchor — matches kebab buttons at a row's right edge). 'left'
   * opens rightward from the anchor: used by the calendar's quick-create
   * popover, where opening leftward covered the very slot/day just clicked.
   * 'center' centers the menu on the anchor's midpoint (spreads evenly both
   * ways) and clamps at the viewport edges: used by the draft column's folder
   * picker, which opens from a pill and should grow symmetrically around it.
   * 'start' puts the menu's LEFT edge on the anchor's LEFT edge (a flyout that
   * reads as belonging to a small trigger, like the plugin provenance info
   * button); like 'left' it falls back to right-aligned when the right side of
   * the viewport leaves no room.
   */
  align?: 'right' | 'left' | 'center' | 'start';
  /**
   * What happens when a 'left' or 'start' aligned menu would run off the right
   * edge. Default 'flip': fall back to right-aligned at the anchor (a small
   * flyout stays glued to its trigger). 'clamp': keep the side and slide the
   * menu left only as far as the viewport margin needs, so a wide panel opened
   * from a narrow column's button stays over THAT column instead of jumping
   * across the neighbouring one (measured: a 480px popover from a 298px
   * rightmost session column flipped to x 551..1031 and covered the column to
   * its left, composer and "+" included; clamped it sits at 788..1268).
   */
  edgeOverflow?: 'flip' | 'clamp';
  /**
   * Take the anchor's TOP and BOTTOM from this element instead of the trigger
   * (left/right still come from the trigger). For a menu that belongs to one
   * button of a toolbar but must clear the whole toolbar: the session engine
   * settings popover opens upward from the composer's "+" and, anchored to the
   * button alone, sat on top of the textarea the user would want to click next.
   * Anchored to the composer box it floats above the whole composer. Falls back
   * to the trigger when the element is missing or not connected.
   */
  verticalAnchorRef?: RefObject<HTMLElement | null>;
  /**
   * Which side to PREFER when both fit. Default 'down' (the classic dropdown
   * expectation). 'up' inverts it — open upward unless it doesn't fit above
   * AND below has more room. Used by the draft launch bar, whose triggers sit
   * at the column's bottom: its folder picker opens upward, so its project
   * flyout opening downward read as two different behaviors for two pills in
   * the same row. The flip/clamp/maxHeight rules are unchanged either way.
   */
  preferSide?: 'up' | 'down';
}

/**
 * How long a trigger that is still in the document may measure 0x0 before the
 * menu treats it as gone. Long enough to survive a re-layout of the surface it
 * belongs to, short enough that a row hidden by a live filter still takes its
 * menu with it while the user is looking at the same screen.
 */
const ANCHOR_LOST_GRACE_MS = 600;

/** Which side the menu opens toward. `null` = decide from the geometry. */
export type OpenSide = 'up' | 'down' | null;

export interface PlacementInput {
  /**
   * Anchor box in viewport coords. Horizontally, `right` drives the default and
   * 'left' alignments; 'center' additionally reads `left` (when present) to
   * find the anchor's midpoint. A cursor anchor is zero-height:
   * `top === bottom === cursor y`.
   */
  anchor: { top: number; bottom: number; right: number; left?: number };
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
  /** See MenuPlacementOptions.align. */
  align?: 'right' | 'left' | 'center' | 'start';
  /** See MenuPlacementOptions.edgeOverflow. */
  edgeOverflow?: 'flip' | 'clamp';
  /** See MenuPlacementOptions.preferSide. */
  preferSide?: 'up' | 'down';
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

  // Open toward the preferred side (default: down) unless it doesn't fit AND
  // the other side has more room. A caller that already opened (forceSide)
  // keeps its side — see PlacementInput.forceSide.
  const openUp = forceSide
    ? forceSide === 'up'
    : input.preferSide === 'up'
      ? !(naturalHeight > spaceAbove && spaceBelow > spaceAbove)
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

  // Horizontal: right edge at the anchor (default), left edge for align:'left'
  // (menu opens rightward, keeping the anchor visible — flips back leftward
  // when the last columns leave no room, else the viewport clamp slides the
  // menu OVER the very day column being clicked), or align:'center' (menu's
  // midpoint at the anchor's midpoint — spreads evenly both ways; the shared
  // clamps below keep it on screen near the edges).
  const anchorLeft = anchor.left ?? anchor.right;
  const anchorMid = (anchorLeft + anchor.right) / 2;
  let right =
    input.align === 'center' && menuWidth > 0
      ? viewportWidth - anchorMid - menuWidth / 2
      : input.align === 'left' && menuWidth > 0
        ? viewportWidth - anchor.right - menuWidth
        : input.align === 'start' && menuWidth > 0
          ? viewportWidth - anchorLeft - menuWidth
          : viewportWidth - anchor.right;
  if ((input.align === 'left' || input.align === 'start') && menuWidth > 0 && right < margin
      && input.edgeOverflow !== 'clamp') {
    right = viewportWidth - anchor.right;
  }
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
  const {
    gap = 2, margin = 8, minHeight = 180, anchorPoint = null, align = 'right', preferSide = 'down',
    edgeOverflow = 'flip', verticalAnchorRef, onAnchorLost,
  } = options;
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);
  // The side is decided ONCE per open and then latched — see PlacementInput.forceSide.
  const sideRef = useRef<OpenSide>(null);
  // Latest callback without making it a dependency (a fresh arrow per render
  // would otherwise tear down and re-run the whole effect every render).
  const onAnchorLostRef = useRef(onAnchorLost);
  onAnchorLostRef.current = onAnchorLost;
  /** When the trigger first measured 0x0 while still in the document; null while it has a box. */
  const lostSinceRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    // Reset the latch on close AND on a new anchor: a second right-click at a
    // different point (or right-click → kebab-button) changes the anchor without
    // `open` ever going false, and a side latched for the old anchor can then be
    // badly wrong (measured: 'down' latched for a cursor at y=660 in a 700px
    // window placed the menu 148px ABOVE the cursor, squeezed to minHeight).
    sideRef.current = null;
    if (!open) { setPlacement(null); return; }

    let lostTimer: ReturnType<typeof setTimeout> | undefined;
    const place = () => {
      const menu = menuRef.current;
      // A cursor anchor is a zero-size rect at the click point; otherwise use
      // the trigger button's box.
      const trigger = triggerRef.current;
      const triggerRect = trigger?.getBoundingClientRect();
      const vertical = verticalAnchorRef?.current;
      // Vertical anchor: the element's own top/bottom, the trigger's left/right.
      const r = anchorPoint
        ? { top: anchorPoint.y, bottom: anchorPoint.y, right: anchorPoint.x }
        : triggerRect && vertical && vertical.isConnected && vertical.offsetHeight > 0
          ? (() => { const v = vertical.getBoundingClientRect(); return { top: v.top, bottom: v.bottom, left: triggerRect.left, right: triggerRect.right }; })()
          : triggerRect;
      if (!r) return;

      // A trigger that was unmounted or display:none'd while the menu is open
      // reports an all-zero rect. That is "no anchor", not "anchor at 0,0":
      // placing against it parks the menu in the top-left corner (measured:
      // right: 1280px on a 1280px viewport, i.e. fully off-screen left) and no
      // scroll can recover it. Cursor anchors are exempt — they're legitimately
      // zero-HEIGHT, and they don't depend on the trigger still existing.
      //
      // A trigger that is still IN the document but momentarily 0x0 is a
      // different story, and telling the two apart matters: a panel that
      // re-lays-out under load (a session column resizing, a collapsed column
      // painting) can measure 0x0 for a frame or two, and closing a dialog the
      // user opened because of that loses whatever they were doing in it. So a
      // connected-but-empty trigger is given ANCHOR_LOST_GRACE_MS to come back,
      // re-checked by a timer (a hidden trigger fires no scroll, resize or
      // mutation of its own), while a disconnected one is lost immediately.
      const empty = trigger && (trigger.offsetWidth === 0 || trigger.offsetHeight === 0);
      if (!anchorPoint && trigger && (empty || !trigger.isConnected)) {
        if (!trigger.isConnected) { onAnchorLostRef.current?.(); return; }
        if (lostSinceRef.current === null) lostSinceRef.current = Date.now();
        if (Date.now() - lostSinceRef.current >= ANCHOR_LOST_GRACE_MS) { onAnchorLostRef.current?.(); return; }
        clearTimeout(lostTimer);
        lostTimer = setTimeout(place, ANCHOR_LOST_GRACE_MS);
        // Keep the last placement: the menu stays where it was rather than
        // jumping to the corner while the trigger is measuring 0x0.
        return;
      }
      lostSinceRef.current = null;

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
        anchor: { top: r.top, bottom: r.bottom, right: r.right, ...('left' in r ? { left: r.left } : {}) },
        naturalHeight: menu ? menu.scrollHeight + borderY : 0,
        menuWidth: menu ? menu.offsetWidth : 0,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        gap, margin, minHeight, align, preferSide, edgeOverflow,
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
      // A window `resize` targets the Window, which is not a Node: `contains`
      // throws on it, and that exception used to abort every re-placement on
      // resize (an open menu stayed where the old viewport put it).
      if (e && e.target instanceof Node && menuRef.current?.contains(e.target)) return;
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
      // Also watch the TRIGGER. A row hidden with display:none (the live search
      // filter) collapses it to 0x0 without firing scroll, resize or any mutation
      // the menu can see — so nothing would re-run place(), and the anchor-lost
      // check inside it would never get a chance to close the menu.
      if (triggerRef.current) ro.observe(triggerRef.current);
      if (verticalAnchorRef?.current) ro.observe(verticalAnchorRef.current);
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
      clearTimeout(lostTimer);
      lostSinceRef.current = null;
      ro?.disconnect();
      mo?.disconnect();
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [open, triggerRef, menuRef, gap, margin, minHeight, anchorPoint, align, preferSide, edgeOverflow, verticalAnchorRef]);

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

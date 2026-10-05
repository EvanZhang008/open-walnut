/**
 * FilterBar: the filter row right above the home task list (`.fb-row`, spec 6.4),
 * under the toolbar, the tier heading and the tab bar. One chip per non-default
 * dimension (body opens the chip menu, x removes), `Clear`, and the right-aligned
 * count. Rendered only while there is something to say: a chip, a view name with
 * the tab bar hidden, or search mode. Opening the Display menu adds nothing: the
 * menu hangs from its button, and the bars above the list stay where they are
 * (2026-10-04: a two-line placeholder row floated over the Focus heading and the
 * tab bar while the menu was open).
 *
 * Layout promises: at most three chip lines (four in a narrow panel), the rest
 * behind a `+N` chip (FilterOverflowMenu); the first visible list row keeps its
 * screen position when the row mounts or unmounts (scrollTop compensation, C41);
 * removing the last chip with the pointer keeps the row's height until the
 * pointer leaves it (G30), so a quick second click never lands on a list row
 * that moved up.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ICON_CHECK } from '../common/Icons';
import '@/styles/filter-bar-row.css';
import type { FilterBarController, FilterChip, FilterDim } from './filter-bar-types';
import { FilterChipMenu } from './FilterChipMenu';
import { filterCountText } from './FilterMenu';
import { FilterChipView, FilterOverflowMenu, type RemoveHow } from './FilterOverflowMenu';
import { useFilterWriter } from './FilterValueList';

export const ROW_COLLAPSE_MS = 120;

export interface FilterBarProps {
  controller: FilterBarController;
}

/** Number of wrapped lines among a flex-wrap box's children (centers clustered). */
export function countLines(box: HTMLElement): number {
  const centers = Array.from(box.children)
    .map((el) => (el as HTMLElement).offsetTop + (el as HTMLElement).offsetHeight / 2)
    .sort((a, b) => a - b);
  let lines = 0;
  let last = -Infinity;
  for (const y of centers) {
    if (y - last > 10) { lines += 1; last = y; }
  }
  return lines;
}

/** Where focus goes after a removal (6.4): next chip's x, previous chip's x, the Display button. */
function focusAfterRemoval(c: FilterBarController, order: (FilterDim | undefined)[]): void {
  for (const dim of order) {
    if (!dim) continue;
    const x = document.querySelector<HTMLElement>(
      `.fb-row .fb-chip[data-chip-dim="${dim}"] .fb-chip-x, .fb-overflow-menu .fb-chip[data-chip-dim="${dim}"] .fb-chip-x`,
    );
    if (x) { x.focus({ preventScroll: true }); return; }
  }
  c.buttonRef.current?.focus({ preventScroll: true });
}

/** The element that actually scrolls the list: the controller's box, or the list inside it. */
export function listScroller(root: HTMLElement | null): HTMLElement | null {
  if (!root) return null;
  if (root.scrollHeight > root.clientHeight + 1) return root;
  const inner = root.querySelector<HTMLElement>('.todo-panel-list');
  return inner && inner.scrollHeight > inner.clientHeight + 1 ? inner : root;
}

interface ChipMenuState {
  dim: FilterDim;
  anchor: HTMLElement;
}

export function FilterBar({ controller: c }: FilterBarProps) {
  const chips = c.chips;
  const w = useFilterWriter(c);
  const [chipMenu, setChipMenu] = useState<ChipMenuState | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [linger, setLinger] = useState(false);
  // A pointer removal holds the row's height until the pointer leaves it, so the
  // next x never moves up under the cursor (F03, G30).
  const [holdHeight, setHoldHeight] = useState<number | null>(null);
  const [collapsing, setCollapsing] = useState(false);
  const [fit, setFit] = useState(Infinity);
  const [width, setWidth] = useState(0);
  const chipsRef = useRef<HTMLDivElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<(FilterDim | undefined)[] | null>(null);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const visible = chips.length > 0 || c.viewItem !== null || c.search.active || linger;

  // Any chip (from anywhere) ends a pending pointer-removal hold of an empty row.
  useEffect(() => {
    if (chips.length > 0 && linger) { setLinger(false); setCollapsing(false); }
  }, [chips.length, linger]);
  // A write from outside the row (popover, footer, search) releases a held height.
  const chipKey = chips.map((ch) => ch.dim).join('|');
  const heldKey = useRef<string | null>(null);
  useEffect(() => {
    if (holdHeight !== null && heldKey.current !== null && heldKey.current !== chipKey && !linger) setHoldHeight(null);
  }, [chipKey, holdHeight, linger]);
  useEffect(() => () => { if (collapseTimer.current) clearTimeout(collapseTimer.current); }, []);

  const setChipMenuOpen = c.setChipMenuOpen;
  useEffect(() => { setChipMenuOpen?.(chipMenu !== null); }, [chipMenu, setChipMenuOpen]);
  useEffect(() => () => setChipMenuOpen?.(false), [setChipMenuOpen]);

  // Close a chip menu whose chip went away.
  useEffect(() => {
    if (chipMenu && !chips.some((ch) => ch.dim === chipMenu.dim)) setChipMenu(null);
  }, [chips, chipMenu]);

  // Track the CHIP BOX's width (not the row's): the count beside it changes
  // width too ("Loading completed" -> "37 tasks"), and the fit must follow.
  useEffect(() => {
    const el = chipsRef.current;
    if (!visible || !el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => setWidth(Math.round(entries[0]?.contentRect.width ?? 0)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [visible]);

  // Shrink `fit` until the box wraps into at most `maxLines` lines (F02: the row
  // wraps the whole set and overflows only when space is really gone). The menu
  // hangs from the Display button, not from this row, so the row growing under an
  // open menu moves no menu row (C47).
  // Once the fit settles: close an overflow that has nothing left to hold, and
  // move focus after a removal (never on a refit frame, which draws every chip).
  const maxLines = width > 0 && width < 360 ? 4 : 3;
  const sig = `${maxLines}#${chips.map((ch) => `${ch.dim}=${ch.value}`).join('|')}#${width}#${c.search.active}#${c.viewItem?.label ?? ''}#${c.archiveLoading}#${c.count}`;
  const lastSig = useRef('');
  useLayoutEffect(() => {
    if (lastSig.current !== sig) {
      lastSig.current = sig;
      if (fit !== Infinity) { setFit(Infinity); return; }
    }
    const box = chipsRef.current;
    const shownNow = Math.min(fit, chips.length);
    if (box && shownNow > 0 && countLines(box) > maxLines) { setFit(shownNow - 1); return; }
    if (box && overflowOpen && shownNow >= chips.length) setOverflowOpen(false);
    const order = pendingFocus.current;
    pendingFocus.current = null;
    if (order) focusAfterRemoval(c, order);
  });
  const shown = Math.min(fit, chips.length);
  const visibleChips = chips.slice(0, shown);
  const hiddenChips = chips.slice(shown);
  // An open overflow keeps its anchor and its rows through a refit frame.
  const lastHidden = useRef<readonly FilterChip[]>([]);
  if (hiddenChips.length > 0) lastHidden.current = hiddenChips;
  const overflowChips = hiddenChips.length > 0 ? hiddenChips
    : overflowOpen ? chips.filter((ch) => lastHidden.current.some((h) => h.dim === ch.dim)) : [];
  const showPlus = hiddenChips.length > 0 || (overflowOpen && chips.length > 0);
  useEffect(() => {
    // Close only when nothing is left: a refit renders every chip for one frame.
    if (overflowOpen && chips.length === 0) setOverflowOpen(false);
  }, [overflowOpen, chips.length]);

  const inFlowHeight = useRef(0);

  // C41: the list's first visible row keeps its screen place whenever the row's
  // in-flow height changes (the scroll box sits below it). The box is taken at
  // render time: a parent's inline ref callback is detached (null) while this
  // layout effect runs and re-attached after it.
  const scrollerRef = useRef<HTMLElement | null>(null);
  scrollerRef.current = listScroller(c.listScrollRef.current) ?? scrollerRef.current;
  useLayoutEffect(() => {
    const h = !visible ? 0 : c.rowRef.current?.offsetHeight ?? 0;
    const delta = h - inFlowHeight.current;
    inFlowHeight.current = h;
    const el = scrollerRef.current;
    if (el?.isConnected && Math.abs(delta) >= 1) el.scrollTop += delta;
  });

  // Only a pointer removal from the row itself holds the row (the pointer is on
  // it and will leave it); removals from a portalled menu collapse at once.
  const remove = (chip: FilterChip, how: RemoveHow) => {
    const i = chips.findIndex((ch) => ch.dim === chip.dim);
    pendingFocus.current = [chips[i + 1]?.dim, chips[i - 1]?.dim];
    const fromRow = how === 'pointer' && !!c.rowRef.current?.matches(':hover');
    if (fromRow) {
      heldKey.current = chips.filter((ch) => ch.dim !== chip.dim).map((ch) => ch.dim).join('|');
      setHoldHeight(c.rowRef.current?.offsetHeight ?? null);
    } else setHoldHeight(null);
    setLinger(fromRow && chips.length === 1);
    w.write(chip.reset, 'chip-menu');
  };
  const clear = () => {
    setLinger(false);
    setHoldHeight(null);
    setCollapsing(false);
    c.clearAll();
    c.buttonRef.current?.focus({ preventScroll: true });
  };
  const onPointerLeave = () => {
    if (holdHeight !== null && !linger) { setHoldHeight(null); return; }
    if (!linger || collapsing) return;
    setCollapsing(true);
    collapseTimer.current = setTimeout(() => {
      collapseTimer.current = null;
      setLinger(false);
      setCollapsing(false);
      setHoldHeight(null);
    }, ROW_COLLAPSE_MS);
  };
  // WebKit can drop the row's pointerleave when the hovered x is removed under
  // the pointer, so a held row also watches where the pointer goes next.
  const leaveRef = useRef(onPointerLeave);
  leaveRef.current = onPointerLeave;
  useEffect(() => {
    if ((!linger && holdHeight === null) || collapsing) return;
    const onMove = (e: PointerEvent) => {
      const r = c.rowRef.current?.getBoundingClientRect();
      if (r && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) leaveRef.current();
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [linger, holdHeight, collapsing, c.rowRef]);
  const openChipMenu = (dim: FilterDim, anchor: HTMLElement) =>
    setChipMenu((cur) => (cur?.dim === dim ? null : { dim, anchor }));
  const chipMenuAnchor = useMemo(() => ({ current: chipMenu?.anchor ?? null }), [chipMenu]);
  const menuChip = chipMenu ? chips.find((ch) => ch.dim === chipMenu.dim) : undefined;

  if (!visible) return null;
  const countText = c.archiveLoading ? 'Loading completed' : c.count === null ? '' : filterCountText(c.count);
  const inc = c.search.active ? c.search.includeComplete : null;
  const rowStyle = holdHeight !== null ? { minHeight: holdHeight } : undefined;
  return (
    <div
      ref={c.rowRef}
      className={`fb-row${collapsing ? ' is-collapsing' : ''}${c.search.active ? ' is-search' : ''}`}
      role="toolbar"
      aria-label="Active filters"
      style={rowStyle}
      onPointerLeave={onPointerLeave}
    >
      <div ref={chipsRef} className="fb-row-chips">
        {c.search.active && (
          <span className="fb-row-lead">{chips.length > 0 ? 'Search uses these filters' : 'Searching all tasks'}</span>
        )}
        {inc && (
          <button type="button" className="fb-toggle" tabIndex={0} aria-pressed={inc.on} onClick={inc.toggle}>
            {inc.on && <span className="fb-check" aria-hidden="true">{ICON_CHECK}</span>}
            <span>{`Include Complete (${inc.count})`}</span>
          </button>
        )}
        {c.viewItem && (
          <button
            type="button"
            className="fb-view-item"
            tabIndex={0}
            aria-label={`View: ${c.viewItem.label}, change in Display`}
            title="Change the view in Display"
            onClick={c.openDisplay}
          >
            <span className="fb-chip-dim">{'View: '}</span>
            <span className="fb-chip-val">{c.viewItem.label}</span>
          </button>
        )}
        {visibleChips.map((chip) => (
          <FilterChipView
            key={chip.dim}
            chip={chip}
            menuOpen={chipMenu?.dim === chip.dim}
            onOpenMenu={(anchor) => openChipMenu(chip.dim, anchor)}
            onRemove={(how) => remove(chip, how)}
          />
        ))}
        {showPlus && (
          <button
            ref={plusRef}
            type="button"
            className="fb-chip fb-chip-plus"
            tabIndex={0}
            aria-label={`${hiddenChips.length} more filters`}
            aria-haspopup="dialog"
            aria-expanded={overflowOpen}
            onClick={() => setOverflowOpen((o) => !o)}
          >
            {`+${hiddenChips.length}`}
          </button>
        )}
        {chips.length === 0 && !c.search.active && !c.viewItem && (
          <span className="fb-row-empty">No filters</span>
        )}
      </div>
      {/* The tail sits outside the chip box at the top right: the count, then Clear. Its
          width ("Loading completed" to "6 tasks", Clear coming and going) never re-wraps
          the chips (C47), and Clear never sits alone on a line of its own. */}
      <span className="fb-row-tail">
        <span
          className="fb-count"
          data-testid="filter-count"
          aria-live="polite"
          aria-label={c.count !== null && !c.archiveLoading ? countText : undefined}
        >
          {c.archiveLoading || c.count === null ? countText : (
            <>
              <span className="fb-count-num">{c.count}</span>
              <span className="fb-count-word">{c.count === 1 ? ' task' : ' tasks'}</span>
            </>
          )}
        </span>
        {chips.length > 0 && (
          <button type="button" className="fb-text-btn fb-clear" tabIndex={0} aria-label="Clear all filters" onClick={clear}>
            Clear
          </button>
        )}
      </span>
      {overflowOpen && showPlus && (
        <FilterOverflowMenu
          anchorRef={plusRef}
          chips={overflowChips}
          chipMenuDim={chipMenu?.dim ?? null}
          onOpenChipMenu={openChipMenu}
          onRemove={(chip) => remove(chip, 'keyboard')}
          onClose={() => setOverflowOpen(false)}
        />
      )}
      {chipMenu && menuChip && (
        <FilterChipMenu
          controller={c}
          dim={chipMenu.dim}
          anchorRef={chipMenuAnchor}
          onClose={() => setChipMenu(null)}
          onRemove={() => remove(menuChip, 'keyboard')}
        />
      )}
    </div>
  );
}

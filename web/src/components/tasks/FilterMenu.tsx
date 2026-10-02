/**
 * FilterMenu: the toolbar's Filter button and its portalled `.fb-menu`
 * popover (spec 6.1 to 6.3). Presentational: state lives in the
 * FilterBarController (open state included, so the F shortcut and the
 * board's "Filter to this project" can drive it); every write goes through
 * `controller.apply` / `controller.clearAll`.
 *
 * Height (G25, F14): measured at open (and once more when loading ends) as
 * the natural height of what is drawn, capped at 460px and by the space the
 * placement hook finds; it stays fixed while the user types a search, so the
 * results never resize the box per keystroke. The `More filters` fold is the
 * one thing that re-measures: it grows the box below the toggle and shrinks it
 * back, and a folded popover carries no blank space for rows it does not show.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ICON_CLOSE, ICON_FILTER, ICON_SEARCH } from '../common/Icons';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { clampToPanelLeft, panelLeftOf } from './panel-menu-clamp';
import { useOverlayLayer, type OverlayCloseReason } from '@/hooks/useOverlayLayer';
import { chipSummary, moreSetCount, pickValue } from './filter-bar-model';
import { readMoreOpen, writeMoreOpen } from './filter-bar-persist';
import { searchFilterDims } from './filter-bar-search';
import type { FilterBarController } from './filter-bar-types';
import { FilterDimRows, flyoutOptions, takeFilterSnapshot, type FlyoutRequest } from './FilterDimRows';
import { FilterSearchResults, SEARCH_LIST_ID, addFromSearch, searchHitId } from './FilterSearchResults';
import { FilterValuesFlyout, useFilterWriter } from './FilterValuesFlyout';
import '@/styles/filter-toolbar-base.css';
import '@/styles/filter-bar.css';

export const FILTER_MENU_MAX_HEIGHT = 460;
/** Child portals that count as inside the popover for its outside-press closer. */
export const FILTER_MENU_EXEMPT = ['.fb-values-flyout', '.fb-chip-menu', '.fb-overflow-menu'] as const;

export function filterCountText(n: number): string {
  return n === 1 ? '1 task' : `${n} tasks`;
}

export function badgeText(n: number): string {
  return n > 9 ? '9+' : String(n);
}

export interface FilterButtonProps {
  controller: FilterBarController;
}

/** The funnel button (6.1) plus, while open, the popover. */
export function FilterButton({ controller: c }: FilterButtonProps) {
  const n = c.chips.length;
  return (
    <>
      <button
        ref={c.buttonRef}
        type="button"
        className="tp-btn fb-filter-btn"
        tabIndex={0}
        aria-label="Filter"
        title={n > 0 ? `Filter tasks (${n} active)` : 'Filter tasks'}
        aria-haspopup="dialog"
        aria-expanded={c.menuOpen}
        onClick={() => c.setMenuOpen(!c.menuOpen)}
      >
        {ICON_FILTER}
        <span className="tp-btn-label">Filter</span>
        {n > 0 && <span className="tp-badge" data-testid="filter-badge">{badgeText(n)}</span>}
      </button>
      {c.menuOpen && <FilterMenu controller={c} />}
    </>
  );
}

/** The popover itself; mounted only while open, so its snapshot is "state at open". */
export function FilterMenu({ controller: c }: FilterButtonProps) {
  const writer = useFilterWriter(c);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [snap, setSnap] = useState(() => takeFilterSnapshot(c));
  const [moreOpen, setMoreOpen] = useState(() => readMoreOpen() || moreSetCount(c.state) > 0);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [alreadyOn, setAlreadyOn] = useState<number | null>(null);
  const [flyout, setFlyout] = useState<FlyoutRequest | null>(null);
  const [height, setHeight] = useState<number | null>(null);

  // The project list arrives after open: take the snapshot again, once.
  const wasLoading = useRef(c.lists.loading);
  useEffect(() => {
    if (wasLoading.current && !c.lists.loading) {
      wasLoading.current = false;
      setSnap(takeFilterSnapshot(c));
    }
  }, [c.lists.loading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Measure at open, BEFORE the placement hook's first measure (declaration
  // order), and write the height straight onto the node so that measure already
  // sees it. Again whenever the rows' natural height changes while the rows are
  // shown: the snapshot retaken after loading (a height taken over `Loading
  // projects` would cut the loaded rows short), facet counts landing and
  // re-wrapping a row, the footer appearing with the first chip, and every More
  // filters toggle (the fold's rows are below the toggle, so the box grows and
  // shrinks under the pointer's row, never through it). Not while a search is
  // typed: its results keep the height the rows had, so the box never resizes
  // per keystroke.
  const searching = query.trim().length > 0;
  const hasFoot = c.chips.length > 0;
  const [contentTick, setContentTick] = useState(0);
  useEffect(() => {
    const dims = menuRef.current?.querySelector('.fb-dims');
    if (searching || !dims || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setContentTick((n) => n + 1));
    ro.observe(dims);
    return () => ro.disconnect();
  }, [searching]);
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el || searching) return;
    const maxHeight = el.style.maxHeight;
    el.style.height = '';
    el.style.maxHeight = 'none';
    el.setAttribute('data-measuring', '');
    const natural = el.offsetHeight;
    el.removeAttribute('data-measuring');
    el.style.maxHeight = maxHeight;
    const h = Math.min(natural, FILTER_MENU_MAX_HEIGHT);
    el.style.height = `${h}px`;
    setHeight(h);
  }, [snap, moreOpen, hasFoot, contentTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = (reason: OverlayCloseReason | 'lost') => {
    c.setMenuOpen(false);
    if (reason === 'escape') c.buttonRef.current?.focus({ preventScroll: true });
  };
  const placement = useMenuPlacement(true, c.buttonRef, menuRef, {
    verticalAnchorRef: c.rowRef,
    align: 'right',
    onAnchorLost: () => close('lost'),
  });
  useOverlayLayer({
    open: true,
    refs: [menuRef, c.buttonRef, c.rowRef],
    exemptSelectors: FILTER_MENU_EXEMPT,
    onClose: close,
    onEscape: () => {
      if (!query) return false;
      setQuery('');
      inputRef.current?.focus({ preventScroll: true });
      return true;
    },
  });
  useLayoutEffect(() => { inputRef.current?.focus({ preventScroll: true }); }, []);

  const search = useMemo(() => searchFilterDims(query, c.state, c.lists), [query, c.state, c.lists]);
  const hits = search.hits;
  const activeIndex = Math.min(active, Math.max(0, hits.length - 1));
  const onQuery = (text: string) => {
    setQuery(text);
    setActive(0);
    setAlreadyOn(null);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!query || hits.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((activeIndex + step + hits.length) % hits.length);
      setAlreadyOn(null);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = hits[activeIndex];
      if (!hit) return;
      if (hit.selected) setAlreadyOn(activeIndex);
      else writer.write((s) => addFromSearch(s, hit), 'search');
    }
  };
  const onMoreOpenChange = (open: boolean) => {
    setMoreOpen(open);
    writeMoreOpen(open);
  };

  const flyAnchor = useMemo(() => ({ current: flyout?.anchor ?? null }), [flyout]);
  const fly = flyout ? flyoutOptions(snap, flyout.dim) : null;
  const summary = chipSummary(c.chips);
  const clamped = clampToPanelLeft({
    placement, menuWidth: menuRef.current?.offsetWidth ?? 0, panelLeft: panelLeftOf(c.buttonRef.current), viewportWidth: window.innerWidth,
  });
  // F34: the cap follows the room below, not the height measured at open: the
  // popover re-measures once the project list lands and must not clip that.
  const roomBelow = clamped ? Math.max(clamped.maxHeight, window.innerHeight - clamped.top - 8) : undefined;
  const style = { ...menuPlacementStyle(clamped), ...(roomBelow ? { maxHeight: roomBelow } : null), ...(height !== null ? { height } : null) };

  return createPortal(
    <div
      ref={menuRef}
      className="fb-menu tp-pop"
      role="dialog"
      aria-label="Filter tasks"
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="fb-search fb-menu-search">
        <span className="fb-search-icon" aria-hidden="true">{ICON_SEARCH}</span>
        <input
          ref={inputRef}
          type="text"
          className="fb-search-input"
          placeholder="Search filters"
          aria-label="Search filters"
          aria-controls={searching ? SEARCH_LIST_ID : undefined}
          aria-autocomplete="list"
          aria-activedescendant={searching && hits.length > 0 ? searchHitId(activeIndex) : undefined}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {query && (
          <button
            type="button"
            className="fb-search-clear"
            aria-label="Clear search"
            onClick={() => { onQuery(''); inputRef.current?.focus(); }}
          >
            {ICON_CLOSE}
          </button>
        )}
      </div>
      <div className="fb-menu-body">
        {searching ? (
          <FilterSearchResults
            controller={c}
            query={query}
            hits={hits}
            pinHint={search.pinHint}
            viewHint={search.viewHint}
            activeIndex={activeIndex}
            alreadyOnIndex={alreadyOn}
            onActiveIndexChange={(i) => { setActive(i); setAlreadyOn(null); }}
            writer={writer}
          />
        ) : (
          <FilterDimRows
            controller={c}
            snap={snap}
            flyout={flyout}
            onOpenFlyout={setFlyout}
            moreOpen={moreOpen}
            onMoreOpenChange={onMoreOpenChange}
            writer={writer}
          />
        )}
      </div>
      {c.chips.length > 0 && (
        <div className="fb-menu-foot">
          <span className="fb-menu-summary" title={summary}>{summary}</span>
          <button type="button" className="fb-text-btn" onClick={() => { c.clearAll(); inputRef.current?.focus({ preventScroll: true }); }}>
            Clear
          </button>
          <span className="fb-menu-count">{c.count === null ? '' : filterCountText(c.count)}</span>
        </div>
      )}
      {flyout && fly && (
        <FilterValuesFlyout
          anchorRef={flyAnchor}
          dim={flyout.dim}
          label={fly.label}
          options={fly.options}
          searchLabel={fly.searchLabel}
          state={c.state}
          counts={flyout.dim === 'project' || flyout.dim === 'source' || flyout.dim === 'tags' ? c.facets[flyout.dim] : undefined}
          closeOnPick={flyout.dim === 'date'}
          onPick={(value, mode) => writer.write((s) => pickValue(s, flyout.dim, value, mode), 'menu')}
          onClose={() => setFlyout(null)}
        />
      )}
    </div>,
    document.body,
  );
}

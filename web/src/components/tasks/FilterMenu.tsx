/**
 * FilterMenu: the toolbar's Filter button and its portalled `.fb-menu`
 * (spec 6.1 to 6.3). A small two-page menu with one search box on top:
 * page one lists the picks the user makes most and one row per property
 * (FilterHome); a property row opens page two, that property's values as a
 * checklist (FilterValuesPage). Typing searches every value of every property
 * on page one and filters the rows on page two. Presentational: state lives in
 * the FilterBarController (open state included, so the F shortcut and the
 * board's "Filter to this project" can drive it); every write goes through
 * `controller.apply` / `controller.clearAll`.
 *
 * Size: the menu is as tall as its page, capped by the room below the button;
 * the body scrolls past the cap. Page one is a handful of rows, so it never
 * reaches the cap on an ordinary screen.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ICON_CLOSE, ICON_FILTER, ICON_SEARCH } from '../common/Icons';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { clampToPanelLeft, panelLeftOf } from './panel-menu-clamp';
import { useOverlayLayer, type OverlayCloseReason } from '@/hooks/useOverlayLayer';
import { chipSummary, dimLabel, dimValues } from './filter-bar-model';
import { readMoreOpen, writeMoreOpen } from './filter-bar-persist';
import { searchFilterDims } from './filter-bar-search';
import type { FilterBarController, FilterDim, FilterValueOption } from './filter-bar-types';
import { FilterHome, HOME_ITEM, takeHomeSnapshot } from './FilterHome';
import { FilterSearchResults, SEARCH_LIST_ID, addFromSearch, searchHitId } from './FilterSearchResults';
import { FilterValuesPage } from './FilterValuesPage';
import { SEARCHABLE_DIMS, SEARCH_AFTER, useFilterWriter } from './FilterValueList';
import '@/styles/filter-toolbar-base.css';
import '@/styles/filter-bar.css';

export const FILTER_MENU_MAX_HEIGHT = 460;
/** Child portals that count as inside the menu for its outside-press closer. */
export const FILTER_MENU_EXEMPT = ['.fb-chip-menu', '.fb-overflow-menu'] as const;

export function filterCountText(n: number): string {
  return n === 1 ? '1 task' : `${n} tasks`;
}

export function badgeText(n: number): string {
  return n > 9 ? '9+' : String(n);
}

/** The search box's placeholder: page one searches everything, page two one property. */
export function searchPlaceholder(dim: FilterDim | null): string {
  if (dim === null) return 'Search filters';
  if (dim === 'project') return 'Search projects';
  if (dim === 'tags') return 'Search tags';
  if (dim === 'sprint') return 'Search sprints';
  if (dim === 'source') return 'Search sources';
  return `Search ${dimLabel(dim).toLowerCase()}`;
}

export interface FilterButtonProps {
  controller: FilterBarController;
}

/** The funnel button (6.1) plus, while open, the menu. */
export function FilterButton({ controller: c }: FilterButtonProps) {
  const n = c.chips.length;
  return (
    <>
      <button
        ref={c.buttonRef}
        type="button"
        className={`tp-btn fb-filter-btn${n > 0 ? ' is-active' : ''}`}
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

interface Page {
  dim: FilterDim;
  /** Row order frozen when the page opened (G5); selection stays live. */
  options: FilterValueOption[];
}

/** The menu itself; mounted only while open, so its snapshot is "state at open". */
export function FilterMenu({ controller: c }: FilterButtonProps) {
  const writer = useFilterWriter(c);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [snap, setSnap] = useState(() => takeHomeSnapshot(c));
  const [moreOpen, setMoreOpen] = useState(readMoreOpen);
  const [page, setPage] = useState<Page | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [alreadyOn, setAlreadyOn] = useState<number | null>(null);

  // The project list arrives after open: take the snapshot again, once, and
  // give an open page the rows it was waiting for.
  const wasLoading = useRef(c.lists.loading);
  useEffect(() => {
    if (wasLoading.current && !c.lists.loading) {
      wasLoading.current = false;
      setSnap(takeHomeSnapshot(c));
      setPage((p) => (p ? { dim: p.dim, options: dimValues(p.dim, c.state, c.lists) } : p));
    }
  }, [c.lists.loading]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = (reason: OverlayCloseReason | 'lost' | 'pick') => {
    c.setMenuOpen(false);
    if (reason === 'escape' || reason === 'pick') c.buttonRef.current?.focus({ preventScroll: true });
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
  const focusInput = () => inputRef.current?.focus({ preventScroll: true });
  useLayoutEffect(() => { focusInput(); }, []);

  const searching = page === null && query.trim().length > 0;
  const search = useMemo(() => (searching ? searchFilterDims(query, c.state, c.lists) : null), [searching, query, c.state, c.lists]);
  const hits = search?.hits ?? [];
  const activeIndex = Math.min(active, Math.max(0, hits.length - 1));
  const onQuery = (text: string) => {
    setQuery(text);
    setActive(0);
    setAlreadyOn(null);
  };
  const openDim = (dim: FilterDim) => {
    setPage({ dim, options: dimValues(dim, c.state, c.lists) });
    setQuery('');
    setActive(0);
    // The search box filters a long list; a short one is read as it is, so the first row takes focus.
    const searchable = SEARCHABLE_DIMS.includes(dim) && dimValues(dim, c.state, c.lists).length > SEARCH_AFTER;
    requestAnimationFrame(() => {
      if (searchable) focusInput();
      else {
        const body = bodyRef.current;
        (body?.querySelector<HTMLElement>('.fb-opt-body[aria-pressed="true"]') ?? body?.querySelector<HTMLElement>('.fb-opt-body'))?.focus({ preventScroll: true });
      }
    });
  };
  const goBack = () => {
    const dim = page?.dim;
    setPage(null);
    setQuery('');
    requestAnimationFrame(() => {
      const row = dim ? bodyRef.current?.querySelector<HTMLElement>(`.fb-prop[data-filter-dim="${dim}"]`) : null;
      (row ?? inputRef.current)?.focus({ preventScroll: true });
    });
  };
  const firstRow = () => bodyRef.current?.querySelector<HTMLElement>(page ? '.fb-opt-body' : HOME_ITEM);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !query && page) { e.preventDefault(); goBack(); return; }
    if (!searching) {
      if (e.key === 'ArrowDown') { e.preventDefault(); firstRow()?.focus({ preventScroll: true }); }
      else if (e.key === 'Enter' && page) { e.preventDefault(); firstRow()?.click(); }
      return;
    }
    if (hits.length === 0) return;
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

  const summary = chipSummary(c.chips);
  const clamped = clampToPanelLeft({
    placement, menuWidth: menuRef.current?.offsetWidth ?? 0, panelLeft: panelLeftOf(c.buttonRef.current), viewportWidth: window.innerWidth,
  });
  // F34: the cap follows the room below, never a height measured earlier.
  const roomBelow = clamped ? Math.max(clamped.maxHeight, window.innerHeight - clamped.top - 8) : undefined;
  const style = { ...menuPlacementStyle(clamped), ...(roomBelow ? { maxHeight: Math.min(roomBelow, FILTER_MENU_MAX_HEIGHT) } : { maxHeight: FILTER_MENU_MAX_HEIGHT }) };

  return createPortal(
    <div
      ref={menuRef}
      className="fb-menu tp-pop"
      role="dialog"
      aria-label="Filter tasks"
      data-page={page ? page.dim : 'home'}
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="fb-search fb-menu-search">
        <span className="fb-search-icon" aria-hidden="true">{ICON_SEARCH}</span>
        <input
          ref={inputRef}
          type="text"
          className="fb-search-input"
          placeholder={searchPlaceholder(page?.dim ?? null)}
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
            onClick={() => { onQuery(''); focusInput(); }}
          >
            {ICON_CLOSE}
          </button>
        )}
      </div>
      <div ref={bodyRef} className="fb-menu-body">
        {searching && search ? (
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
        ) : page ? (
          <FilterValuesPage
            controller={c}
            writer={writer}
            dim={page.dim}
            options={page.options}
            loading={page.dim === 'project' && c.lists.loading}
            query={query}
            onBack={goBack}
            onSinglePick={() => close('pick')}
            onExitTop={focusInput}
          />
        ) : (
          <FilterHome
            controller={c}
            writer={writer}
            snap={snap}
            moreOpen={moreOpen}
            onMoreOpenChange={onMoreOpenChange}
            onOpenDim={openDim}
            onExitTop={focusInput}
          />
        )}
      </div>
      {c.chips.length > 0 && (
        <div className="fb-menu-foot" title={summary}>
          <span className="fb-menu-count">{c.count === null ? '' : filterCountText(c.count)}</span>
          <button type="button" className="fb-text-btn" onClick={() => { c.clearAll(); focusInput(); }}>
            Clear filters
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}

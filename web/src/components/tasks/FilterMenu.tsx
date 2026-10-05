/**
 * PanelMenu: the task panel's one menu, under the toolbar's Display button
 * (spec 6.1 to 6.5). A small two-page menu with one search box on top. Page
 * one: the filter rows (FilterHome: one row per property with its value, the
 * rare ones folded), then the display rows (DisplaySections: Sort, Group,
 * View, Show tab bar, Session columns, the view slot). A property row or the
 * View row opens page two: that property's values as a checklist
 * (FilterValuesPage) or the list of views (DisplayViewsPage). Typing searches
 * every filter value and every view on page one and filters the rows on page
 * two. Presentational: filter state lives in the FilterBarController (open
 * state included, so the F shortcut and the board's "Filter to this project"
 * can drive it); display state in DisplayMenuProps.
 *
 * Size: the menu is as tall as its page, capped by the room below the button;
 * the body scrolls past the cap.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ICON_CHEVRON_LEFT, ICON_CLOSE, ICON_SEARCH } from '../common/Icons';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { clampToPanelLeft, panelLeftOf } from './panel-menu-clamp';
import { useOverlayLayer, type OverlayCloseReason } from '@/hooks/useOverlayLayer';
import { dimLabel, dimValues } from './filter-bar-model';
import { readMoreOpen, writeMoreOpen } from './filter-bar-persist';
import { searchFilterDims } from './filter-bar-search';
import { rankByMatch, rankByUse, useCount } from './filter-home-model';
import type { DisplayMenuProps, FilterBarController, FilterDim, FilterValueOption } from './filter-bar-types';
import { FilterHome, takeHomeSnapshot } from './FilterHome';
import { FilterSearchResults, SEARCH_LIST_ID, addFromSearch, searchHitId, type SearchItem } from './FilterSearchResults';
import { FilterValuesPage } from './FilterValuesPage';
import { SEARCHABLE_DIMS, SEARCH_AFTER, arrowFocus, useFilterWriter } from './FilterValueList';
import { DisplaySections, DisplayViewsPage, useMenuViews } from './DisplaySections';
import { viewLabel } from './tab-bar-model';
import '@/styles/filter-toolbar-base.css';
import '@/styles/filter-bar.css';

export const PANEL_MENU_MAX_HEIGHT = 520;
export const PANEL_MENU_WIDTH = 320;
/** Child portals that count as inside the menu for its outside-press closer. */
export const PANEL_MENU_EXEMPT = ['.fb-chip-menu', '.fb-overflow-menu'] as const;
/** Page one's keyboard rows: filter rows and the View row, a segmented row's active segment, the switch, the action. */
const HOME_ROWS = '.fb-item, .tp-seg-btn[tabindex="0"], .dm-switch-row, .dm-action';

export function filterCountText(n: number): string {
  return n === 1 ? '1 task' : `${n} tasks`;
}

/** The search box's placeholder: page one searches everything, page two one list. */
export function searchPlaceholder(page: FilterDim | 'view' | null): string {
  if (page === null) return 'Search filters and views';
  if (page === 'view') return 'Search views';
  if (page === 'project') return 'Search projects';
  if (page === 'tags') return 'Search tags';
  if (page === 'sprint') return 'Search sprints';
  if (page === 'source') return 'Search sources';
  return `Search ${dimLabel(page).toLowerCase()}`;
}

type Page = { kind: 'dim'; dim: FilterDim; options: FilterValueOption[] } | { kind: 'view' };

export interface PanelMenuProps {
  filters: FilterBarController;
  display: DisplayMenuProps;
  flashOption: string | null;
}

/** The menu itself; mounted only while open, so its snapshot is "state at open". */
export function PanelMenu({ filters: c, display: d, flashOption }: PanelMenuProps) {
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
  // After the first key the focused control draws its ring in every engine: WebKit
  // skips :focus-visible on a focus moved by script, which is how the rows take it.
  const [keyed, setKeyed] = useState(false);
  const views = useMenuViews(d.customTiers);

  // The project list arrives after open: take the snapshot again, once, and
  // give an open page the rows it was waiting for.
  const wasLoading = useRef(c.lists.loading);
  useEffect(() => {
    if (wasLoading.current && !c.lists.loading) {
      wasLoading.current = false;
      setSnap(takeHomeSnapshot(c));
      setPage((p) => (p?.kind === 'dim' ? { kind: 'dim', dim: p.dim, options: dimValues(p.dim, c.state, c.lists) } : p));
    }
  }, [c.lists.loading]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = (reason: OverlayCloseReason | 'lost' | 'pick') => {
    c.setMenuOpen(false);
    if (reason === 'escape' || reason === 'pick') c.buttonRef.current?.focus({ preventScroll: true });
  };
  // Hangs from the Display button, never from the filter row: the row comes, goes
  // and grows while the menu is open, and a menu riding on it would move.
  const placement = useMenuPlacement(true, c.buttonRef, menuRef, {
    align: 'right',
    onAnchorLost: () => close('lost'),
  });
  useOverlayLayer({
    open: true,
    refs: [menuRef, c.buttonRef, c.rowRef],
    exemptSelectors: PANEL_MENU_EXEMPT,
    onClose: close,
    onEscape: () => {
      if (!query) return false;
      setQuery('');
      inputRef.current?.focus({ preventScroll: true });
      return true;
    },
  });
  const focusInput = () => inputRef.current?.focus({ preventScroll: true });
  // The hint that opened the menu points at a display row: start there, not in the box.
  useLayoutEffect(() => {
    if (flashOption) {
      const row = bodyRef.current?.querySelector<HTMLElement>(`[data-view-option="${flashOption}"] [aria-pressed="true"], [data-view-option="${flashOption}"] button`);
      if (row) { row.focus({ preventScroll: true }); return; }
    }
    focusInput();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const searching = page === null && query.trim().length > 0;
  const items = useMemo<SearchItem[]>(() => {
    if (!searching) return [];
    const hits = searchFilterDims(query, c.state, c.lists).hits;
    const ranked = rankByUse(hits, (h) => useCount(c.recent, h.dim, h.value));
    const q = query.trim().toLowerCase();
    const viewHits = [...views.first, ...views.more]
      .filter((v) => v.label.toLowerCase().includes(q))
      .map((v) => ({ kind: 'view' as const, view: { id: v.id, label: v.label, selected: v.id === d.section } }));
    // The label the text names outright comes first, whichever kind it is.
    return rankByMatch(
      [...ranked.map((hit) => ({ kind: 'filter' as const, hit })), ...viewHits],
      (item) => (item.kind === 'view' ? item.view.label : item.hit.valueLabel),
      query,
    );
  }, [searching, query, c.state, c.lists, c.recent, views, d.section]);
  const activeIndex = Math.min(active, Math.max(0, items.length - 1));
  const onQuery = (text: string) => {
    setQuery(text);
    setActive(0);
    setAlreadyOn(null);
  };
  const pickView = (id: string) => {
    d.onSectionChange(id);
    close('pick');
  };
  const openDim = (dim: FilterDim) => {
    const options = dimValues(dim, c.state, c.lists);
    setPage({ kind: 'dim', dim, options });
    setQuery('');
    setActive(0);
    // The search box filters a long list; a short one is read as it is, so the first (selected) row takes focus.
    const searchable = SEARCHABLE_DIMS.includes(dim) && options.length > SEARCH_AFTER;
    requestAnimationFrame(() => {
      if (searchable) { focusInput(); return; }
      const body = bodyRef.current;
      (body?.querySelector<HTMLElement>('.fb-opt-body[aria-pressed="true"]') ?? body?.querySelector<HTMLElement>('.fb-opt-body'))?.focus({ preventScroll: true });
    });
  };
  const openViews = () => {
    setPage({ kind: 'view' });
    setQuery('');
    setActive(0);
    requestAnimationFrame(() => {
      const body = bodyRef.current;
      (body?.querySelector<HTMLElement>('.dm-view[aria-pressed="true"]') ?? body?.querySelector<HTMLElement>('.dm-view'))?.focus({ preventScroll: true });
    });
  };
  const goBack = () => {
    const from = page;
    setPage(null);
    setQuery('');
    requestAnimationFrame(() => {
      const sel = from?.kind === 'dim' ? `.fb-prop[data-filter-dim="${from.dim}"]` : from?.kind === 'view' ? '[data-view-option="view"]' : null;
      const row = sel ? bodyRef.current?.querySelector<HTMLElement>(sel) : null;
      (row ?? inputRef.current)?.focus({ preventScroll: true });
    });
  };
  const firstRow = () => bodyRef.current?.querySelector<HTMLElement>(page?.kind === 'view' ? '.dm-view' : page ? '.fb-opt-body' : HOME_ROWS);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !query && page) { e.preventDefault(); goBack(); return; }
    if (!searching) {
      if (e.key === 'ArrowDown') { e.preventDefault(); firstRow()?.focus({ preventScroll: true }); }
      else if (e.key === 'Enter' && page) { e.preventDefault(); firstRow()?.click(); }
      return;
    }
    if (items.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((activeIndex + step + items.length) % items.length);
      setAlreadyOn(null);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[activeIndex];
      if (!item) return;
      if (item.kind === 'view') { pickView(item.view.id); return; }
      if (item.hit.selected) setAlreadyOn(activeIndex);
      else writer.write((s) => addFromSearch(s, item.hit), 'search');
    }
  };
  const onMoreOpenChange = (open: boolean) => {
    setMoreOpen(open);
    writeMoreOpen(open);
  };
  // Page one: ArrowUp/Down walk every row (a segmented row counts once, by its
  // active segment), ArrowUp on the first row returns to the box, ArrowRight on a
  // property row or the View row opens its page. A page's own list handles its
  // rows; ArrowLeft on a property page's rows goes back.
  const onBodyKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    if (e.key === 'ArrowLeft' && page?.kind === 'dim' && !el.closest('.tp-seg, input')) { e.preventDefault(); goBack(); return; }
    if (page || searching) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(HOME_ROWS)).filter((r) => r.offsetParent !== null);
      const at = rows.indexOf(el);
      if (e.key === 'ArrowUp' && at === 0) { e.preventDefault(); focusInput(); return; }
      arrowFocus(e, HOME_ROWS);
      return;
    }
    if (e.key === 'ArrowRight') {
      const dim = el.closest<HTMLElement>('.fb-prop')?.dataset.filterDim as FilterDim | undefined;
      if (dim) { e.preventDefault(); openDim(dim); return; }
      if (el.closest('[data-view-option="view"]')) { e.preventDefault(); openViews(); }
    }
  };

  const width = Math.min(PANEL_MENU_WIDTH, window.innerWidth - 16);
  const clamped = clampToPanelLeft({ placement, menuWidth: width, panelLeft: panelLeftOf(c.buttonRef.current), viewportWidth: window.innerWidth });
  // F34: the cap follows the room below, never a height measured earlier.
  const roomBelow = clamped ? Math.max(clamped.maxHeight, window.innerHeight - clamped.top - 8) : undefined;
  const style = { ...menuPlacementStyle(clamped), width, maxHeight: Math.min(roomBelow ?? PANEL_MENU_MAX_HEIGHT, PANEL_MENU_MAX_HEIGHT) };
  const pageKey = page?.kind === 'dim' ? page.dim : page?.kind === 'view' ? 'view' : null;
  const viewsHead = (
    <div className="fb-page-head">
      <button type="button" className="fb-back" aria-label="Back to all filters" title="Back" onClick={goBack}>
        {ICON_CHEVRON_LEFT}
      </button>
      <span className="fb-page-title">View</span>
    </div>
  );

  return createPortal(
    <div
      ref={menuRef}
      className="fb-menu tp-pop"
      role="dialog"
      aria-label="Filter and display"
      data-page={pageKey ?? 'home'}
      data-keyed={keyed || undefined}
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDownCapture={() => { if (!keyed) setKeyed(true); }}
    >
      <div className="fb-search fb-menu-search">
        <span className="fb-search-icon" aria-hidden="true">{ICON_SEARCH}</span>
        <input
          ref={inputRef}
          type="text"
          className="fb-search-input"
          placeholder={searchPlaceholder(pageKey)}
          aria-label="Search filters"
          aria-controls={searching ? SEARCH_LIST_ID : undefined}
          aria-autocomplete="list"
          aria-activedescendant={searching && items.length > 0 ? searchHitId(activeIndex) : undefined}
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
      <div ref={bodyRef} className="fb-menu-body" onKeyDown={onBodyKeyDown}>
        {searching ? (
          <FilterSearchResults
            controller={c}
            query={query}
            items={items}
            activeIndex={activeIndex}
            alreadyOnIndex={alreadyOn}
            onActiveIndexChange={(i) => { setActive(i); setAlreadyOn(null); }}
            onPickView={pickView}
            writer={writer}
          />
        ) : page?.kind === 'view' ? (
          <DisplayViewsPage
            views={views}
            active={d.section}
            query={query}
            onPick={pickView}
            onBack={goBack}
            onExitTop={focusInput}
            head={viewsHead}
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
          <>
            <FilterHome
              controller={c}
              snap={snap}
              moreOpen={moreOpen}
              onMoreOpenChange={onMoreOpenChange}
              onOpenDim={openDim}
              onClear={() => { c.clearAll(); focusInput(); }}
            />
            <DisplaySections display={d} flashOption={flashOption} viewLabel={viewLabel(d.section, d.customTiers) || d.section} onOpenViews={openViews} />
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

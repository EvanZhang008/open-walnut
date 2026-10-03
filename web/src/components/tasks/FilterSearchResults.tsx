/**
 * FilterSearchResults: the flat hit list that replaces the menu's first page
 * while the search box has text (spec 6.3): every filter value the text
 * matches (`Status  In Progress`), then every view it matches (`View  Pinned`).
 * The input owns the keyboard (ArrowUp/Down move `aria-activedescendant`,
 * Enter adds a filter or picks a view); this component draws the rows and
 * handles clicks (a click toggles a filter hit, so it can be removed too).
 */
import { ICON_CHECK } from '../common/Icons';
import { pickValue } from './filter-bar-model';
import type { FilterSearchHit } from './filter-bar-search';
import type { FilterBarController, FilterState } from './filter-bar-types';
import { dimIcon, ICON_VIEW } from './filter-dim-icons';
import { clickMode, useFilterWriter, type FilterWriter } from './FilterValueList';

export const SEARCH_LIST_ID = 'fb-search-results';

export function searchHitId(index: number): string {
  return `fb-search-hit-${index}`;
}

/** Enter on a hit: add it; a selected hit is left alone. */
export function addFromSearch(state: FilterState, hit: FilterSearchHit): FilterState {
  if (hit.selected) return state;
  return pickValue(state, hit.dim, hit.value, 'add');
}

export interface ViewHit {
  id: string;
  label: string;
  selected: boolean;
}

export type SearchItem = { kind: 'filter'; hit: FilterSearchHit } | { kind: 'view'; view: ViewHit };

export interface FilterSearchResultsProps {
  controller: FilterBarController;
  query: string;
  items: readonly SearchItem[];
  activeIndex: number;
  /** Index whose Enter found it already on (draws `Already on`). */
  alreadyOnIndex: number | null;
  onActiveIndexChange(i: number): void;
  onPickView(id: string): void;
  /** The menu's shared writer; the list makes its own when absent. */
  writer?: FilterWriter;
}

export function FilterSearchResults({
  controller: c, query, items, activeIndex, alreadyOnIndex, onActiveIndexChange, onPickView, writer,
}: FilterSearchResultsProps) {
  const own = useFilterWriter(c);
  const w = writer ?? own;
  return (
    <div className="fb-search-results" role="listbox" id={SEARCH_LIST_ID} aria-label="Matching filters and views">
      {items.map((item, i) => {
        const active = i === activeIndex;
        const common = {
          id: searchHitId(i),
          role: 'option' as const,
          'aria-selected': active,
          onPointerMove: () => { if (!active) onActiveIndexChange(i); },
        };
        if (item.kind === 'view') {
          const v = item.view;
          return (
            <div
              key={`view:${v.id}`}
              {...common}
              data-view-option={v.id}
              className={`fb-hit${active ? ' is-active' : ''}${v.selected ? ' is-selected' : ''}`}
              onClick={() => onPickView(v.id)}
            >
              <span className="fb-item-icon" aria-hidden="true">{ICON_VIEW}</span>
              <span className="fb-hit-dim">View</span>
              <span className="fb-hit-value">{v.label}</span>
              <span className="fb-item-check" aria-hidden="true">{v.selected ? ICON_CHECK : null}</span>
            </div>
          );
        }
        const h = item.hit;
        return (
          <div
            key={`${h.dim}:${h.value}`}
            {...common}
            data-filter-dim={h.dim}
            data-filter-value={h.valueLabel}
            className={`fb-hit${active ? ' is-active' : ''}${h.selected ? ' is-selected' : ''}`}
            onClick={() => w.write((s) => pickValue(s, h.dim, h.value, clickMode(h.dim)), 'search')}
          >
            <span className="fb-item-icon" aria-hidden="true">{dimIcon(h.dim)}</span>
            {/* `Blocked  Blocked` would say it twice: the values name the property themselves. */}
            {h.dim !== 'blocked' && <span className="fb-hit-dim">{h.dimLabel}</span>}
            <span className="fb-hit-value">{h.valueLabel}</span>
            {alreadyOnIndex === i && h.selected && <span className="fb-hit-note">Already on</span>}
            <span className="fb-item-check" aria-hidden="true">{h.selected ? ICON_CHECK : null}</span>
          </div>
        );
      })}
      {items.length === 0 && (
        <div className="fb-empty">{`Nothing matches "${query.trim()}"`}</div>
      )}
    </div>
  );
}

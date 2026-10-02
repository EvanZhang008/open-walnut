/**
 * FilterSearchResults: the flat hit list that replaces the dimension rows
 * while the popover's search box has text (spec 6.3). The input owns the
 * keyboard (ArrowUp/Down move `aria-activedescendant`, Enter only adds); this
 * component draws the rows and handles clicks (a click toggles, so a hit can
 * be removed with the pointer).
 */
import { ICON_CHECK } from '../common/Icons';
import { pickValue } from './filter-bar-model';
import type { FilterSearchHit } from './filter-bar-search';
import type { FilterBarController, FilterState } from './filter-bar-types';
import { PAIR_DIMS, useFilterWriter, type FilterWriter } from './FilterValuesFlyout';

export const SEARCH_LIST_ID = 'fb-search-results';

export function searchHitId(index: number): string {
  return `fb-search-hit-${index}`;
}

/** Enter on a hit: add it (Project and Source replace, 6.2); a selected hit is left alone. */
export function addFromSearch(state: FilterState, hit: FilterSearchHit): FilterState {
  if (hit.selected) return state;
  return pickValue(state, hit.dim, hit.value, PAIR_DIMS.includes(hit.dim) ? 'replace' : 'add');
}

export interface FilterSearchResultsProps {
  controller: FilterBarController;
  query: string;
  hits: readonly FilterSearchHit[];
  pinHint: boolean;
  /** A view the query names (Pinned, Focus, ...): `<view> is a view: open Display` (F27). */
  viewHint?: string | null;
  activeIndex: number;
  /** Index whose Enter found it already on (draws `Already on`). */
  alreadyOnIndex: number | null;
  onActiveIndexChange(i: number): void;
  /** The popover's shared writer; the list makes its own when absent. */
  writer?: FilterWriter;
}

export function FilterSearchResults({
  controller: c, query, hits, pinHint, viewHint, activeIndex, alreadyOnIndex, onActiveIndexChange, writer,
}: FilterSearchResultsProps) {
  const own = useFilterWriter(c);
  const w = writer ?? own;
  const hint = viewHint ?? (pinHint ? 'Pinned' : null);
  const openDisplay = () => {
    c.setMenuOpen(false);
    c.openDisplay();
  };
  return (
    <div className="fb-search-results" role="listbox" id={SEARCH_LIST_ID} aria-label="Matching filters">
      {hits.map((h, i) => (
        <div
          key={`${h.dim}:${h.value}`}
          id={searchHitId(i)}
          role="option"
          aria-selected={i === activeIndex}
          data-filter-dim={h.dim}
          data-filter-value={h.valueLabel}
          className={`fb-hit${i === activeIndex ? ' is-active' : ''}${h.selected ? ' is-selected' : ''}`}
          onPointerMove={() => { if (i !== activeIndex) onActiveIndexChange(i); }}
          onClick={() => w.write((s) => pickValue(s, h.dim, h.value, 'replace'), 'search')}
        >
          <span className="fb-check" aria-hidden="true">{h.selected ? ICON_CHECK : null}</span>
          <span className="fb-hit-dim">{h.dimLabel}</span>
          <span className="fb-hit-value">{h.valueLabel}</span>
          {alreadyOnIndex === i && h.selected && <span className="fb-hit-note">Already on</span>}
        </div>
      ))}
      {hint && (
        <button type="button" className="fb-hit fb-pin-hint" onClick={openDisplay}>
          {`${hint} is a view: open Display`}
        </button>
      )}
      {hits.length === 0 && !hint && (
        <div className="fb-empty">{`No filter matches "${query.trim()}"`}</div>
      )}
    </div>
  );
}

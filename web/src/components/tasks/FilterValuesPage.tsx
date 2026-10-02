/**
 * FilterValuesPage: the Filter menu's second page, one property's values
 * (spec 6.2). A header with the way back and the property's name (plus Reset
 * while something is set), the Time window's basis segments where they apply,
 * then the shared checklist. The menu's search box filters the rows; the
 * caller decides what a pick does to the menu (a single-select pick closes it).
 */
import { ICON_CHEVRON_LEFT } from '../common/Icons';
import { dimLabel, isDimDefault, pickValue, resetDim } from './filter-bar-model';
import type { FilterBarController, FilterDim, FilterPickMode, FilterValueOption } from './filter-bar-types';
import { COUNT_DIMS, FilterValueList, MULTI_DIMS, type FilterWriter } from './FilterValueList';
import { CustomTime, TimeBasis } from './FilterTimeControls';

export interface FilterValuesPageProps {
  controller: FilterBarController;
  writer: FilterWriter;
  dim: FilterDim;
  /** Row order, frozen when the page opened. */
  options: readonly FilterValueOption[];
  query: string;
  /** The rows are still on their way (the project list after a cold open). */
  loading?: boolean;
  onBack(): void;
  /** After a pick on a single-select property (the menu closes). */
  onSinglePick?(): void;
  onExitTop?(): void;
}

export function FilterValuesPage({ controller: c, writer: w, dim, options, query, loading, onBack, onSinglePick, onExitTop }: FilterValuesPageProps) {
  const counts = COUNT_DIMS.includes(dim) ? c.facets[dim] : undefined;
  const isSet = !isDimDefault(c.state, dim);
  const onPick = (value: string, mode: FilterPickMode) => {
    w.write((s) => pickValue(s, dim, value, mode), 'menu');
    if (!MULTI_DIMS.includes(dim) && dim !== 'time') onSinglePick?.();
  };
  return (
    <div className="fb-page" data-filter-dim={dim}>
      <div className="fb-page-head">
        <button type="button" className="fb-back" aria-label="Back to all filters" title="Back" onClick={onBack}>
          {ICON_CHEVRON_LEFT}
        </button>
        <span className="fb-page-title">{dimLabel(dim)}</span>
        {isSet && (
          <button type="button" className="fb-text-btn fb-page-reset" onClick={() => w.write((s) => resetDim(s, dim), 'menu')}>
            Reset
          </button>
        )}
      </div>
      {dim === 'time' && <div className="fb-page-sub"><TimeBasis c={c} w={w} origin="menu" /></div>}
      {loading ? <div className="fb-empty">Loading projects</div> : <FilterValueList
        dim={dim}
        options={options}
        state={c.state}
        counts={counts}
        query={query}
        onPick={onPick}
        onExitTop={onExitTop}
      />}
      {dim === 'time' && c.state.time.preset === 'custom' && <CustomTime c={c} w={w} origin="menu" />}
    </div>
  );
}

/**
 * FilterHome: the filter half of the panel menu's first page (spec 6.2). A
 * short list: a `Filter` title (with Clear while something is set), one row
 * per property with its current value at the right, the rarely used
 * properties folded behind `More filters` unless one of them is set. A
 * property row opens that property's values as the menu's second page.
 * Presentational: every write goes through the shared writer; which rows are
 * listed is frozen at open (G5).
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { ICON_CHEVRON_RIGHT } from '../common/Icons';
import { dimLabel } from './filter-bar-model';
import { dimSummary, homeRows } from './filter-home-model';
import { dimIcon } from './filter-dim-icons';
import type { FilterBarController, FilterDim } from './filter-bar-types';

export interface FilterHomeSnapshot {
  shown: FilterDim[];
  folded: FilterDim[];
}

export function takeHomeSnapshot(c: Pick<FilterBarController, 'state' | 'lists'>): FilterHomeSnapshot {
  return homeRows(c.state, c.lists);
}

function Item({ className, children, ...rest }: { className?: string; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`fb-item${className ? ` ${className}` : ''}`} {...rest}>
      {children}
    </button>
  );
}

/** One property row: icon, name, its current value, a chevron into its page. */
function PropRow({ c, dim, onOpen }: { c: FilterBarController; dim: FilterDim; onOpen(dim: FilterDim, anchor: HTMLElement): void }) {
  const summary = dimSummary(dim, c.state, c.chips);
  const loading = dim === 'project' && c.lists.loading;
  return (
    <Item
      className="fb-prop"
      data-filter-dim={dim}
      aria-haspopup="true"
      title={`${dimLabel(dim)}: ${summary.text}`}
      onClick={(e) => onOpen(dim, e.currentTarget)}
    >
      <span className="fb-item-icon" aria-hidden="true">{dimIcon(dim)}</span>
      <span className="fb-item-text">{dimLabel(dim)}</span>
      <span className={`fb-prop-summary${summary.isDefault ? ' is-default' : ''}`}>{loading ? 'Loading' : summary.text}</span>
      <span className="fb-item-chevron" aria-hidden="true">{ICON_CHEVRON_RIGHT}</span>
    </Item>
  );
}

export interface FilterHomeProps {
  controller: FilterBarController;
  snap: FilterHomeSnapshot;
  moreOpen: boolean;
  onMoreOpenChange(open: boolean): void;
  onOpenDim(dim: FilterDim, anchor: HTMLElement): void;
  /** Clear every filter (the title's button, shown while something is set). */
  onClear(): void;
}

export function FilterHome({ controller: c, snap, moreOpen, onMoreOpenChange, onOpenDim, onClear }: FilterHomeProps) {
  return (
    <div className="fb-home fb-group" data-section="filters">
      <div className="fb-group-title">
        <span>Filter</span>
        {c.chips.length > 0 && (
          <button type="button" className="fb-text-btn fb-group-action" onClick={onClear}>
            Clear
          </button>
        )}
      </div>
      {snap.shown.map((dim) => <PropRow key={dim} c={c} dim={dim} onOpen={onOpenDim} />)}
      {snap.folded.length > 0 && (
        <>
          <Item
            className="fb-more-toggle"
            aria-expanded={moreOpen}
            aria-controls="fb-more-body"
            onClick={() => onMoreOpenChange(!moreOpen)}
          >
            <span className="fb-item-icon fb-more-chevron" aria-hidden="true">{ICON_CHEVRON_RIGHT}</span>
            <span className="fb-item-text">More filters</span>
            <span className="fb-prop-summary is-default">{snap.folded.map((d) => dimLabel(d)).join(', ')}</span>
          </Item>
          <div id="fb-more-body" className="fb-more-body" hidden={!moreOpen}>
            {snap.folded.map((dim) => <PropRow key={dim} c={c} dim={dim} onOpen={onOpenDim} />)}
          </div>
        </>
      )}
    </div>
  );
}

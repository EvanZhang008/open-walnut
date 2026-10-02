/**
 * FilterHome: the Filter menu's first page (spec 6.2). A short list: the few
 * picks the user makes most (`Most used`, one click each), then one row per
 * property with its current value at the right; the rarely used properties
 * fold behind `More filters` unless one of them is set. A property row opens
 * that property's values as the menu's second page. Presentational: every
 * write goes through the shared writer; what is listed is frozen at open (G5).
 */
import type { ButtonHTMLAttributes, KeyboardEvent, ReactNode } from 'react';
import { ICON_CHECK, ICON_CHEVRON_RIGHT } from '../common/Icons';
import { dimLabel } from './filter-bar-model';
import { dimSummary, homeRows, mostUsed } from './filter-home-model';
import { applyRecentEntry, isRecentActive, recentEntryLabel } from './filter-recent';
import { dimIcon } from './filter-dim-icons';
import type { FilterBarController, FilterDim, RecentEntry } from './filter-bar-types';
import { arrowFocus, type FilterWriter } from './FilterValueList';

export const HOME_ITEM = '.fb-item';

export interface FilterHomeSnapshot {
  mostUsed: RecentEntry[];
  shown: FilterDim[];
  folded: FilterDim[];
}

export function takeHomeSnapshot(c: Pick<FilterBarController, 'state' | 'lists' | 'recent'>): FilterHomeSnapshot {
  const rows = homeRows(c.state, c.lists);
  return { mostUsed: mostUsed(c.recent), shown: rows.shown, folded: rows.folded };
}

function Item({ className, children, ...rest }: { className?: string; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`fb-item${className ? ` ${className}` : ''}`} {...rest}>
      {children}
    </button>
  );
}

/** One `Most used` row: `Project  Home`, ticked while it is on; a click toggles it. */
function MostUsedRow({ c, w, entry }: { c: FilterBarController; w: FilterWriter; entry: RecentEntry }) {
  const on = isRecentActive(c.state, entry);
  const label = recentEntryLabel(entry, c.lists);
  const at = label.indexOf(': ');
  const dim = at > 0 ? label.slice(0, at) : null;
  const value = at > 0 ? label.slice(at + 2) : label;
  return (
    <Item
      className="fb-quick"
      data-recent-dim={entry.dim}
      data-filter-value={label}
      aria-pressed={on}
      title={on ? `${label} is on. Click to remove it` : `Filter by ${label}`}
      onClick={() => w.write((st) => applyRecentEntry(st, entry), 'recent')}
    >
      <span className="fb-item-icon" aria-hidden="true">{dimIcon(entry.dim)}</span>
      <span className="fb-item-text">
        {dim && <span className="fb-quick-dim">{dim}</span>}
        <span className="fb-quick-val">{value}</span>
      </span>
      <span className="fb-item-check" aria-hidden="true">{on ? ICON_CHECK : null}</span>
    </Item>
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
  writer: FilterWriter;
  snap: FilterHomeSnapshot;
  moreOpen: boolean;
  onMoreOpenChange(open: boolean): void;
  onOpenDim(dim: FilterDim, anchor: HTMLElement): void;
  /** ArrowUp on the first row: the caller's search box takes focus. */
  onExitTop?(): void;
}

export function FilterHome({ controller: c, writer: w, snap, moreOpen, onMoreOpenChange, onOpenDim, onExitTop }: FilterHomeProps) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowUp' && onExitTop) {
      const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(HOME_ITEM)).filter((el) => el.offsetParent !== null);
      if (items.indexOf(document.activeElement as HTMLElement) === 0) { e.preventDefault(); onExitTop(); return; }
    }
    if (e.key === 'ArrowRight') {
      const el = document.activeElement as HTMLElement | null;
      const dim = el?.closest<HTMLElement>('.fb-prop')?.dataset.filterDim as FilterDim | undefined;
      if (dim && el) { e.preventDefault(); onOpenDim(dim, el); return; }
    }
    arrowFocus(e, HOME_ITEM);
  };
  return (
    <div className="fb-home" onKeyDown={onKeyDown}>
      {snap.mostUsed.length > 0 && (
        <div className="fb-group" data-section="most-used">
          <div className="fb-group-title">Most used</div>
          {snap.mostUsed.map((entry) => (
            <MostUsedRow key={`${entry.dim}:${String(entry.value)}`} c={c} w={w} entry={entry} />
          ))}
        </div>
      )}
      <div className="fb-group" data-section="properties">
        {snap.mostUsed.length > 0 && <div className="fb-group-title">Filter by</div>}
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
    </div>
  );
}

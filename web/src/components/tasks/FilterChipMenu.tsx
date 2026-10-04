/**
 * FilterChipMenu: the portalled `.fb-chip-menu` a filter-row chip opens
 * (spec 6.4). The property's values in the shared FilterValueList (a search
 * box on top past a few values; checklist rows toggle and show `Only`), the
 * Time window's basis and Custom controls where they apply, and a
 * `Remove filter` row at the bottom.
 */
import { useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ICON_CLOSE, ICON_SEARCH } from '../common/Icons';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useOverlayLayer, type OverlayCloseReason } from '@/hooks/useOverlayLayer';
import { dimLabel, dimValues, pickValue } from './filter-bar-model';
import type { FilterBarController, FilterDim } from './filter-bar-types';
import { COUNT_DIMS, FilterValueList, SEARCHABLE_DIMS, SEARCH_AFTER, useFilterWriter } from './FilterValueList';
import { CustomTime, TimeBasis } from './FilterTimeControls';
import type { RemoveHow } from './FilterOverflowMenu';

function searchWord(dim: FilterDim): string {
  if (dim === 'project') return 'projects';
  if (dim === 'source') return 'sources';
  if (dim === 'sprint') return 'sprints';
  return 'tags';
}

export interface FilterChipMenuProps {
  controller: FilterBarController;
  dim: FilterDim;
  anchorRef: RefObject<HTMLElement | null>;
  onClose(reason: OverlayCloseReason | 'removed'): void;
  onRemove(how: RemoveHow): void;
}

export function FilterChipMenu({ controller: c, dim, anchorRef, onClose, onRemove }: FilterChipMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const w = useFilterWriter(c);
  const [query, setQuery] = useState('');
  // Row order is fixed while the menu is open (G5); selection stays live.
  const [options] = useState(() => dimValues(dim, c.state, c.lists));
  const placement = useMenuPlacement(true, anchorRef, ref, { align: 'start', minHeight: 120, onAnchorLost: () => onClose('outside') });
  useOverlayLayer({
    open: true,
    refs: [ref, anchorRef],
    onClose: (reason) => {
      onClose(reason);
      if (reason === 'escape') anchorRef.current?.focus({ preventScroll: true });
    },
  });
  const searchable = SEARCHABLE_DIMS.includes(dim) && options.length > SEARCH_AFTER;
  const counts = COUNT_DIMS.includes(dim) ? c.facets[dim] : undefined;
  return createPortal(
    <div
      ref={ref}
      className="fb-chip-menu tp-pop"
      role="dialog"
      aria-label={`${dimLabel(dim)} filter`}
      data-chip-menu-dim={dim}
      style={menuPlacementStyle(placement)}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {searchable && (
        <div className="fb-search fb-list-search">
          <span className="fb-search-icon" aria-hidden="true">{ICON_SEARCH}</span>
          <input
            ref={inputRef}
            type="text"
            className="fb-search-input"
            placeholder={`Search ${searchWord(dim)}`}
            aria-label={`Search ${searchWord(dim)}`}
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button type="button" className="fb-search-clear" aria-label="Clear search" onClick={() => { setQuery(''); inputRef.current?.focus(); }}>
              {ICON_CLOSE}
            </button>
          )}
        </div>
      )}
      {dim === 'time' && <div className="fb-page-sub"><TimeBasis c={c} w={w} origin="chip-menu" /></div>}
      <FilterValueList
        dim={dim}
        options={options}
        state={c.state}
        counts={counts}
        query={query}
        autoFocus={!searchable}
        anyRow={false}
        onPick={(value, mode) => w.write((s) => pickValue(s, dim, value, mode), 'chip-menu')}
      />
      {dim === 'time' && c.state.time.preset === 'custom' && <CustomTime c={c} w={w} origin="chip-menu" />}
      <div className="fb-chip-menu-foot">
        <button
          type="button"
          className="fb-chip-menu-remove"
          onClick={(e) => {
            onClose('removed');
            onRemove(e.detail > 0 ? 'pointer' : 'keyboard');
          }}
        >
          Remove filter
        </button>
      </div>
    </div>,
    document.body,
  );
}

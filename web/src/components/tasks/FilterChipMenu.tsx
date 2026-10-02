/**
 * FilterChipMenu: the portalled `.fb-chip-menu` a filter-row chip opens
 * (spec 6.4). The dimension's values in the shared FilterValueList (search on
 * top past 8 values; Project and Source rows replace, the square adds; other
 * multi-select rows toggle and show `Only`), a Custom editor for Time window
 * (number input + Hours / Days segments, never a native select), and a
 * `Remove filter` row at the bottom.
 */
import { useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useOverlayLayer, type OverlayCloseReason } from '@/hooks/useOverlayLayer';
import { dimLabel, dimValues, pickValue } from './filter-bar-model';
import { TIME_BASIS_OPTIONS } from './view-filter-model';
import type { FilterBarController, FilterDim, FilterState } from './filter-bar-types';
import { FilterValueList, useFilterWriter, type FilterWriter } from './FilterValuesFlyout';
import type { RemoveHow } from './FilterOverflowMenu';

const SEARCHABLE: readonly FilterDim[] = ['project', 'tags', 'source', 'sprint'];
const SEARCH_AFTER = 8;

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

function CustomTime({ c, w }: { c: FilterBarController; w: FilterWriter }) {
  const time = c.state.time;
  const [draft, setDraft] = useState(String(time.customValue));
  const write = (patch: Partial<FilterState['time']>) =>
    w.write((s) => ({ ...s, time: { ...s.time, preset: 'custom', ...patch } }), 'chip-menu');
  return (
    <div className="fb-custom-time">
      <input
        type="number"
        className="fb-custom-input"
        min={1}
        step={1}
        aria-label="Custom window length"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = Math.floor(Number(e.target.value));
          if (Number.isFinite(n) && n > 0) write({ customValue: n });
        }}
      />
      <span className="tp-seg" role="radiogroup" aria-label="Custom window unit">
        {(['hours', 'days'] as const).map((unit) => (
          <button
            key={unit}
            type="button"
            role="radio"
            className="tp-seg-btn"
            aria-checked={time.customUnit === unit}
            onClick={() => write({ customUnit: unit })}
          >
            {unit === 'hours' ? 'Hours' : 'Days'}
          </button>
        ))}
      </span>
    </div>
  );
}

function TimeBasis({ c, w }: { c: FilterBarController; w: FilterWriter }) {
  return (
    <span className="tp-seg fb-time-basis" role="radiogroup" aria-label="Time basis">
      {TIME_BASIS_OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          className="tp-seg-btn"
          aria-checked={c.state.time.basis === o.value}
          onClick={() => w.write((s) => ({ ...s, time: { ...s.time, basis: o.value } }), 'chip-menu')}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

export function FilterChipMenu({ controller: c, dim, anchorRef, onClose, onRemove }: FilterChipMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const w = useFilterWriter(c);
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
  const searchLabel = SEARCHABLE.includes(dim) && options.length > SEARCH_AFTER ? `Search ${searchWord(dim)}` : null;
  const counts = SEARCHABLE.includes(dim) ? c.facets[dim] : undefined;
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
      {dim === 'time' && <div className="fb-chip-menu-head"><TimeBasis c={c} w={w} /></div>}
      <FilterValueList
        dim={dim}
        options={options}
        state={c.state}
        counts={counts}
        searchLabel={searchLabel}
        autoFocus
        onPick={(value, mode) => w.write((s) => pickValue(s, dim, value, mode), 'chip-menu')}
      />
      {dim === 'time' && c.state.time.preset === 'custom' && <CustomTime c={c} w={w} />}
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

/**
 * FilterTimeControls: the Time window property's extra controls, shared by the
 * Filter menu's Time page and the row chip's menu. The basis segments
 * (Updated / Created / Either) sit above the preset rows; the Custom editor
 * (number input + Hours / Days segments, never a native select) appears under
 * them while the Custom preset is on.
 */
import { useState } from 'react';
import { TIME_BASIS_OPTIONS } from './view-filter-model';
import type { FilterBarController, FilterOrigin, FilterState } from './filter-bar-types';
import type { FilterWriter } from './FilterValueList';
import { SegmentedControl } from '@/components/controls';

export function CustomTime({ c, w, origin }: { c: FilterBarController; w: FilterWriter; origin: FilterOrigin }) {
  const time = c.state.time;
  const [draft, setDraft] = useState(String(time.customValue));
  const write = (patch: Partial<FilterState['time']>) =>
    w.write((s) => ({ ...s, time: { ...s.time, preset: 'custom', ...patch } }), origin);
  return (
    <div className="fb-custom-time">
      <input data-no-draft="number"
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
      <SegmentedControl
        className="tp-seg"
        aria-label="Custom window unit"
        horizontalKeys
        value={time.customUnit}
        onChange={(unit) => write({ customUnit: unit })}
        options={[
          { value: 'hours', label: 'Hours', className: 'tp-seg-btn' },
          { value: 'days', label: 'Days', className: 'tp-seg-btn' },
        ]}
      />
    </div>
  );
}

export function TimeBasis({ c, w, origin }: { c: FilterBarController; w: FilterWriter; origin: FilterOrigin }) {
  // No window set: the basis reads as a choice, not as a live filter (F21).
  return (
    <SegmentedControl
      className={`tp-seg fb-time-basis${c.state.time.preset === null ? ' is-unset' : ''}`}
      aria-label="Time basis"
      horizontalKeys
      value={c.state.time.basis}
      onChange={(basis) => w.write((s) => ({ ...s, time: { ...s.time, basis } }), origin)}
      options={TIME_BASIS_OPTIONS.map((o) => ({
        value: o.value,
        label: o.label,
        className: 'tp-seg-btn',
        data: { 'data-time-basis': o.value },
        title: o.value === 'created_or_updated' ? 'Created or updated in the window' : `${o.label} in the window`,
      }))}
    />
  );
}

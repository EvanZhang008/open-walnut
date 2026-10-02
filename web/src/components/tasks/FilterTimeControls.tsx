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

export function CustomTime({ c, w, origin }: { c: FilterBarController; w: FilterWriter; origin: FilterOrigin }) {
  const time = c.state.time;
  const [draft, setDraft] = useState(String(time.customValue));
  const write = (patch: Partial<FilterState['time']>) =>
    w.write((s) => ({ ...s, time: { ...s.time, preset: 'custom', ...patch } }), origin);
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

export function TimeBasis({ c, w, origin }: { c: FilterBarController; w: FilterWriter; origin: FilterOrigin }) {
  // No window set: the basis reads as a choice, not as a live filter (F21).
  return (
    <span className={`tp-seg fb-time-basis${c.state.time.preset === null ? ' is-unset' : ''}`} role="radiogroup" aria-label="Time basis">
      {TIME_BASIS_OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          className="tp-seg-btn"
          aria-checked={c.state.time.basis === o.value}
          data-time-basis={o.value}
          title={o.value === 'created_or_updated' ? 'Created or updated in the window' : `${o.label} in the window`}
          onClick={() => w.write((s) => ({ ...s, time: { ...s.time, basis: o.value } }), origin)}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

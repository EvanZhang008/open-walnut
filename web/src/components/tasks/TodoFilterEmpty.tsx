/**
 * TodoFilterEmpty: what the list says when the filters hide something.
 *  - the empty state when chips are set and nothing matches (spec 5.3); its
 *    button runs the same Clear as the filter row (undoable through the toast);
 *  - the focus-override line on a row the filters would hide (5.12), in the
 *    chips' own words with one Show per reason, or the `Outside filters` pill
 *    on a task created moments ago (5.11).
 */
import { memo, type PointerEvent, type MouseEvent } from 'react';
import type { FilterDim } from './filter-bar-types';
import { hiddenByText, type HiddenReason } from './filter-predicate';

export interface TodoFilterEmptyProps {
  onClear(): void;
}

export const TodoFilterEmpty = memo(function TodoFilterEmpty({ onClear }: TodoFilterEmptyProps) {
  return (
    <div className="todo-filter-empty" data-testid="todo-filter-empty" role="status">
      <div className="todo-filter-empty-title">No tasks match these filters</div>
      <button type="button" className="todo-filter-empty-clear" onClick={onClear}>
        Clear filters
      </button>
    </div>
  );
});

/** A task this new was just created here: its override reads `Outside filters` (5.11). */
export const JUST_CREATED_MS = 2 * 60_000;

export function isJustCreated(createdAt: string | undefined, now = Date.now()): boolean {
  const at = createdAt ? Date.parse(createdAt) : NaN;
  return Number.isFinite(at) && now - at >= -5_000 && now - at < JUST_CREATED_MS;
}

export interface FilterOverrideReasonsProps {
  reasons: readonly HiddenReason[];
  created: boolean;
  onShow(dim: FilterDim): void;
}

const stop = (e: PointerEvent | MouseEvent) => e.stopPropagation();

export const FilterOverrideReasons = memo(function FilterOverrideReasons({ reasons, created, onShow }: FilterOverrideReasonsProps) {
  const title = hiddenByText(reasons);
  if (created) {
    return (
      <div className="task-filter-override-row">
        <span className="task-filter-outside-pill" data-testid="filter-outside-pill" title={title}>Outside filters</span>
      </div>
    );
  }
  return (
    <div className="task-filter-override-row" data-testid="filter-override-reasons" title={title}>
      {reasons.map((r, i) => (
        <span key={r.dim} className="task-filter-override-badge" data-reason-dim={r.dim}>
          {i > 0 && <span aria-hidden="true">, </span>}
          {r.text}
          <button
            type="button"
            className="task-filter-override-show"
            aria-label={r.ariaLabel}
            onPointerDown={stop}
            onClick={(e) => { stop(e); onShow(r.dim); }}
          >
            Show
          </button>
        </span>
      ))}
    </div>
  );
});

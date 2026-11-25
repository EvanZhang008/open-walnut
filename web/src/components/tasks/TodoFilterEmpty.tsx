/**
 * TodoFilterEmpty: what the list says when the filters hide something.
 *  - the empty state when chips are set and nothing matches (spec 5.3); its
 *    button runs the same Clear as the filter row (undoable through the toast);
 *  - the focus-override line on a row the filters would hide (5.12), in the
 *    chips' own words with one Show per reason, or the `Outside filters` pill
 *    on a task created moments ago (5.11);
 *  - the note on a task opened from outside that the tab the user is on does not
 *    draw: the panel never changes the tab by itself, the note's button does.
 */
import { memo, type PointerEvent, type MouseEvent } from 'react';
import type { FilterDim } from './filter-bar-types';
import { hiddenByText, type HiddenReason } from './filter-predicate';
import { ICON_CLOSE } from '../common/Icons';
import { EmptyState } from '../common/EmptyState';

export interface TodoFilterEmptyProps {
  onClear(): void;
}

export const TodoFilterEmpty = memo(function TodoFilterEmpty({ onClear }: TodoFilterEmptyProps) {
  return (
    <EmptyState
      testId="todo-filter-empty"
      title="No tasks match these filters"
      hint="Clear them to see every task in this tab."
      action={{ label: 'Clear filters', onClick: onClear }}
    />
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
        <span className="badge task-filter-outside-pill" data-testid="filter-outside-pill" title={title}>Outside filters</span>
      </div>
    );
  }
  return (
    <div className="task-filter-override-row" data-testid="filter-override-reasons" title={title}>
      {/* Quiet words, as the row's other metadata: one reason and its Show link each. */}
      {reasons.map((r, i) => (
        <span key={r.dim} className="task-filter-override-reason" data-reason-dim={r.dim}>
          {i > 0 && <span aria-hidden="true">, </span>}
          <span>{r.text}</span>
          <button
            type="button"
            className="btn btn-link btn-sm task-filter-override-show"
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

export interface OffViewNoteProps {
  title: string;
  /** The tab the user is on, and the one that draws the task. */
  here: string;
  there: string;
  onShow(): void;
  onDismiss(): void;
}

/** A task opened from outside (a chat reference, Locate, a new task) that this tab does not draw. */
export const OffViewNote = memo(function OffViewNote({ title, here, there, onShow, onDismiss }: OffViewNoteProps) {
  return (
    <div className="todo-offview-note" data-testid="todo-offview-note" role="status" title={`${title} is not in ${here}.`}>
      {/* Only the title shortens; "is not in <tab>." always shows. A narrow panel puts the
          buttons on a line of their own rather than cut the sentence. */}
      <span className="todo-offview-text">
        <span className="todo-offview-title wn-title">{title}</span>
        <span className="todo-offview-where">{` is not in ${here}.`}</span>
      </span>
      <span className="todo-offview-actions">
        <button type="button" className="btn btn-sm todo-offview-show" data-testid="todo-offview-show" onPointerDown={stop} onClick={(e) => { stop(e); onShow(); }}>
          Show in {there}
        </button>
        <button type="button" className="btn btn-icon btn-sm todo-offview-dismiss" aria-label="Dismiss" title="Dismiss" onPointerDown={stop} onClick={(e) => { stop(e); onDismiss(); }}>
          {ICON_CLOSE}
        </button>
      </span>
    </div>
  );
});

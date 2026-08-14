/**
 * TaskFilterChips — compact "Filtered by" strip for the shared task query model.
 *
 * Interaction is modelled on `web/src/components/usage/UsageFilterChips.tsx`
 * (click a chip to remove that one condition, "Clear all" to reset), and it
 * reuses that component's `.usage-chip*` styling so the two surfaces read as one
 * system. Only the LOOK is shared: the props, chip keys, and labels stay in task
 * vocabulary, so this never becomes a generic chip widget both domains fight over.
 *
 * One chip = ONE removable condition. A multi-value dimension gets one chip per
 * value, so a user can drop a single project without losing the rest of the OR
 * group. Tag chips render with `TagChip` since tags already have a pill look.
 */

import type { TaskPhase, TaskPriority } from '@open-walnut/core';
import type { TaskCompletion } from '@open-walnut/task-query';
import { TagChip } from './TagChip';
import {
  COMPLETION_OPTIONS,
  DEFAULT_TASK_QUERY_FILTER_STATE,
  PHASE_FILTER_OPTIONS,
  QUERY_PRIORITY_OPTIONS,
  timeWindowLabel,
  toggleQueryValue,
  type TaskQueryFilterState,
} from './ViewDropdown';

interface TaskFilterChip {
  key: string;
  /** Dimension label, e.g. "Status". */
  label: string;
  /** Display value, e.g. "To Do". */
  value: string;
  /** Rendered as a tag pill instead of a plain chip. */
  isTag?: boolean;
  onRemove: () => void;
}

interface Props {
  query: TaskQueryFilterState;
  onQueryChange: (next: TaskQueryFilterState) => void;
  /** Called after a Clear all, so a surface can also reset its own view state. */
  onClearAll?: () => void;
}

function labelOf<T extends string>(options: { value: T; label: string }[], value: T): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

/** Build the chip list for a query state (one chip per removable condition). */
function buildTaskFilterChips(
  query: TaskQueryFilterState,
  onQueryChange: (next: TaskQueryFilterState) => void,
): TaskFilterChip[] {
  const chips: TaskFilterChip[] = [];
  const patch = (p: Partial<TaskQueryFilterState>) => onQueryChange({ ...query, ...p });

  for (const value of query.completion) {
    chips.push({
      key: `completion:${value}`,
      label: 'Status',
      value: labelOf<TaskCompletion>(COMPLETION_OPTIONS, value),
      onRemove: () => patch({ completion: toggleQueryValue(query.completion, value) }),
    });
  }
  for (const value of query.phases) {
    chips.push({
      key: `phase:${value}`,
      label: 'Phase',
      value: labelOf<TaskPhase>(PHASE_FILTER_OPTIONS, value),
      onRemove: () => patch({ phases: toggleQueryValue(query.phases, value) }),
    });
  }
  for (const value of query.projects) {
    chips.push({
      key: `project:${value}`,
      label: 'Project',
      // '' is a real, selectable value (the Inbox bucket), not an empty chip.
      value: value === '' ? 'Inbox' : value,
      onRemove: () => patch({ projects: toggleQueryValue(query.projects, value) }),
    });
  }
  for (const value of query.priorities) {
    chips.push({
      key: `priority:${value}`,
      label: 'Priority',
      value: labelOf<TaskPriority>(QUERY_PRIORITY_OPTIONS, value),
      onRemove: () => patch({ priorities: toggleQueryValue(query.priorities, value) }),
    });
  }
  for (const value of query.sources) {
    chips.push({
      key: `source:${value}`,
      label: 'Source',
      value,
      onRemove: () => patch({ sources: toggleQueryValue(query.sources, value) }),
    });
  }
  for (const value of query.sprints) {
    chips.push({
      key: `sprint:${value}`,
      label: 'Sprint',
      value,
      onRemove: () => patch({ sprints: toggleQueryValue(query.sprints, value) }),
    });
  }
  for (const value of query.tagsAny) {
    chips.push({
      key: `tag:${value}`,
      label: 'Tag',
      value,
      isTag: true,
      onRemove: () => patch({ tagsAny: toggleQueryValue(query.tagsAny, value) }),
    });
  }

  for (const [field, label] of [['pinned', 'Pinned'], ['starred', 'Starred'], ['blocked', 'Blocked']] as const) {
    const value = query[field];
    if (value === undefined) continue;
    chips.push({
      key: field,
      label,
      // false is an ACTIVE condition ("not pinned"), not an absent one.
      value: value ? 'Yes' : 'No',
      onRemove: () => patch({ [field]: undefined } as Partial<TaskQueryFilterState>),
    });
  }

  const time = timeWindowLabel(query);
  if (time) {
    chips.push({
      key: 'time',
      label: 'Time',
      value: time,
      onRemove: () => patch({ timePreset: null }),
    });
  }

  return chips;
}

export function TaskFilterChips({ query, onQueryChange, onClearAll }: Props) {
  const chips = buildTaskFilterChips(query, onQueryChange);
  if (chips.length === 0) return null;

  const clearAll = () => {
    // Keep the chosen sort: it is the view's ordering, not one of the conditions
    // the user just cleared (matching toTaskQuery, where sort is never a filter).
    onQueryChange({ ...DEFAULT_TASK_QUERY_FILTER_STATE, sort: query.sort });
    onClearAll?.();
  };

  return (
    <div className="usage-filter-chips task-filter-chips">
      <span className="usage-filter-chips-label">Filtered by</span>
      {chips.map((c) => (
        c.isTag ? (
          <TagChip key={c.key} tag={c.value} inline active onRemove={c.onRemove} />
        ) : (
          <button
            key={c.key}
            className="usage-chip"
            data-chip-key={c.key}
            onClick={c.onRemove}
            title={`Remove ${c.label} filter`}
          >
            <span className="usage-chip-dim">{c.label}</span>
            <span className="usage-chip-val">{c.value}</span>
            <span className="usage-chip-x">×</span>
          </button>
        )
      ))}
      {/* Offered from the FIRST chip: with one condition set, "Clear all" is the
          only control that also resets the surface's own view state (onClearAll),
          so hiding it until a second chip appears made the single-condition case
          need two different gestures for the same intent. */}
      <button className="usage-chip-clear-all" onClick={clearAll}>Clear all</button>
    </div>
  );
}

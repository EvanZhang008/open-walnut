/**
 * TodoFilterFooter: what the current view's DEFAULT filters hide, one click to
 * see it (spec 5.6). The filter row says what the user added; this says what
 * the defaults took out. Counts use the same predicate as the list, with only
 * the one condition the item is about let go (passesChips `except`), so
 * `3 Complete hidden` under `Project: Garden` means three Garden rows appear.
 */
import { Fragment, memo, useMemo, type ReactNode } from 'react';
import type { Task, TaskPhase } from '@open-walnut/core';
import * as ICONS from '../common/Icons';
import type { FilterDim, FilterState } from './filter-bar-types';
import { orderStatus } from './filter-bar-model';
import { passesChips, type FilterEvalContext } from './filter-predicate';

/** Chips that narrow which archived (not yet loaded) completed tasks would show. */
const NARROWING_DIMS: readonly FilterDim[] = ['project', 'source', 'priority', 'blocked', 'tags', 'sprint', 'time'];

export interface FooterCounts {
  waiting: number;
  complete: number;
  notAvailable: number;
}

/**
 * Footer counts over `tasks` (already scoped to the current view). `archiveHidden`
 * (completed tasks the list has not fetched yet) joins the Complete count only
 * when no chip besides Status and Date narrows the view: the archive's rows
 * cannot be checked against a Project or Tag chip before they load.
 */
export function footerCounts(tasks: readonly Task[], ctx: FilterEvalContext, archiveHidden = 0): FooterCounts {
  let waiting = 0;
  let complete = 0;
  let notAvailable = 0;
  const datePending = ctx.state.date === 'now';
  for (const t of tasks) {
    const done = t.status === 'done' || t.phase === 'COMPLETE';
    if (t.phase === 'WAITING' || done) {
      if (passesChips(t, ctx, { except: 'status' })) {
        if (done) complete += 1; else waiting += 1;
      }
      continue;
    }
    if (datePending && passesChips(t, ctx, { except: 'date' }) && !passesChips(t, ctx)) notAvailable += 1;
  }
  const narrowed = NARROWING_DIMS.some((d) => !ctx.defaults.has(d));
  return { waiting, complete: complete + (narrowed ? 0 : archiveHidden), notAvailable };
}

/** Add `phase` to the Status set, or take it out (never leaving it empty). */
export function toggleStatusPhase(state: FilterState, phase: TaskPhase): FilterState {
  const has = state.status.includes(phase);
  const next = has ? state.status.filter((p) => p !== phase) : [...state.status, phase];
  return next.length ? { ...state, status: orderStatus(next) } : state;
}

interface FooterItem {
  key: 'waiting' | 'completed' | 'date';
  text: string;
  title: string;
  on: boolean;
  icon?: ReactNode;
  next: FilterState;
}

export function footerItems(state: FilterState, counts: FooterCounts): FooterItem[] {
  const items: FooterItem[] = [];
  const waitingOn = state.status.includes('WAITING');
  if (counts.waiting > 0) {
    items.push({
      key: 'waiting', on: waitingOn, icon: ICONS.ICON_PHASE_WAITING,
      text: `${counts.waiting} Waiting ${waitingOn ? 'shown' : 'hidden'}`,
      title: waitingOn ? 'Hide the Waiting tasks again' : 'Show the Waiting tasks (on hold until a date or an event)',
      next: toggleStatusPhase(state, 'WAITING'),
    });
  }
  const completeOn = state.status.includes('COMPLETE');
  if (counts.complete > 0) {
    items.push({
      key: 'completed', on: completeOn, icon: ICONS.ICON_PHASE_COMPLETE,
      text: `${counts.complete} Complete ${completeOn ? 'shown' : 'hidden'}`,
      title: completeOn ? 'Hide the Complete tasks again' : 'Show the Complete tasks',
      next: toggleStatusPhase(state, 'COMPLETE'),
    });
  }
  // Only while Date is the default: any other Date value is a chip already.
  if (state.date === 'now' && counts.notAvailable > 0) {
    items.push({
      key: 'date', on: false,
      text: `${counts.notAvailable} not available yet: show`,
      title: 'Tasks that start later are hidden by Date: Available now. Click to show every date.',
      next: { ...state, date: '' },
    });
  }
  return items;
}

export interface TodoFilterFooterProps {
  /** The tasks the current view draws from (All, a tier's members, the pins). */
  tasks: readonly Task[];
  ctx: FilterEvalContext;
  archiveHidden: number;
  onApply(next: FilterState): void;
}

export const TodoFilterFooter = memo(function TodoFilterFooter({ tasks, ctx, archiveHidden, onApply }: TodoFilterFooterProps) {
  const counts = useMemo(() => footerCounts(tasks, ctx, archiveHidden), [tasks, ctx, archiveHidden]);
  const items = footerItems(ctx.state, counts);
  if (items.length === 0) return null;
  return (
    <div className="todo-filter-footer" data-testid="todo-filter-footer">
      {items.map((item, i) => (
        <Fragment key={item.key}>
          {i > 0 && <span className="todo-filter-footer-sep" aria-hidden="true">, </span>}
          <button
            type="button"
            className={`todo-filter-footer-chip${item.on ? ' on' : ''}`}
            data-testid={`todo-filter-footer-${item.key}`}
            aria-pressed={item.key === 'date' ? undefined : item.on}
            title={item.title}
            onClick={() => onApply(item.next)}
          >
            {item.icon && <span className="todo-filter-footer-icon" aria-hidden="true">{item.icon}</span>}
            {item.text}
          </button>
        </Fragment>
      ))}
    </div>
  );
});

/** The tasks a view draws from, for the footer: tiers and Pinned count their members only. */
export function footerScope(
  tasks: readonly Task[],
  section: string,
  sets: {
    pinned?: ReadonlySet<string>;
    focus?: ReadonlySet<string>;
    wait?: ReadonlySet<string>;
    custom?: Record<string, ReadonlySet<string>>;
  },
): readonly Task[] {
  if (section === 'all' || section === 'tasks' || section === 'recent') return tasks;
  const pinned = sets.pinned;
  if (!pinned) return [];
  const inCustom = (id: string) => Object.values(sets.custom ?? {}).some((s) => s.has(id));
  const member = (id: string): boolean => {
    if (!pinned.has(id)) return false;
    switch (section) {
      case 'pinned': return true;
      case 'focus': return !!sets.focus?.has(id);
      case 'wait': return !!sets.wait?.has(id);
      case 'satellite':
        return !sets.focus?.has(id) && !sets.wait?.has(id) && !inCustom(id);
      default: return !!sets.custom?.[section]?.has(id);
    }
  };
  return tasks.filter((t) => member(t.id));
}

/**
 * Status sections of the home task panel (2026-10-29, the user: "instead of the
 * filter way, put them in a section, default collapsed, and when the user clicks it
 * will expand"). Every view draws its tasks under four status headings, plus the
 * user's Watching list on top:
 *
 *   Watching   open    tasks the user keeps in front of them, whatever their state
 *   Needs you  open    the task's user status is Needs you, or To read (it finished, or
 *                      answered the user, asking nothing: 2026-11-02, the user, under Waiting
 *                      "this is not waiting"; 2026-11-03, "I dont wnat serpeate to read"); each
 *                      row's line says what to do with it: Take a look, Decide, Review, Can close
 *   Working    open    its user status is Working: a turn runs, or its own work goes on
 *   Waiting    folded  its user status is Waiting: not started, stopped, on a watch,
 *                      a time, another task or something outside, or snoozed; each row
 *                      says which (waitingReason) and wears the wait or snooze mark
 *   Completed  folded  done
 *
 * The state sections are the one user status (src/core/user-status.ts) as is, the same as
 * the Org page, the Board and the phone (2026-10-31, the user: Working held tasks whose
 * sessions had stopped hours to months ago, and tasks nobody started).
 *
 * The sections span the whole view and group by project inside, so "what needs me"
 * is one place at the top instead of a red row inside each project. This file is the
 * pure half: which section a task is in, the order inside a section, the project
 * runs, and the stored open state. StatusSections.tsx draws them.
 */
import type { Task } from '@open-walnut/core';
import { taskUserState } from '@/utils/session-status';
import { NEEDS_CATEGORY_LABELS, USER_STATE_LABELS, USER_STATE_MEANINGS, limitedLine, needsLineOf, shownState, type NeedsCategory } from '@open-walnut/user-status';
import { sameAskLine, waitingLine, waitingSentence } from '../board/board-status-model';
import { recentActivityTime } from './recent-activity-time';

export type StatusSectionKey = 'watching' | 'needs' | 'working' | 'waiting' | 'done';
/** The sections a task falls into by its state (Watching is the user's own pick). */
export type StateSectionKey = Exclude<StatusSectionKey, 'watching'>;

export const STATUS_SECTION_ORDER: readonly StatusSectionKey[] = ['watching', 'needs', 'working', 'waiting', 'done'];

const { read: _readLabel, ...SHOWN_LABELS } = USER_STATE_LABELS;
const { read: _readMeaning, ...SHOWN_MEANINGS } = USER_STATE_MEANINGS;

export const STATUS_SECTION_LABELS: Record<StatusSectionKey, string> = {
  watching: 'Watching',
  ...SHOWN_LABELS,
};

export const STATUS_SECTION_TITLES: Record<StatusSectionKey, string> = {
  watching: 'Tasks you watch: kept here whatever their state',
  ...SHOWN_MEANINGS,
  needs: 'It asks you something, or has a result or an answer for you to look at',
  waiting: 'It waits on something: not started, stopped, a watch, a time, another task, or you snoozed it',
};

/** A fold's tooltip: what the section holds, then what a click does (one period, whichever
 *  meaning it shows). */
export function statusFoldTooltip(key: StatusSectionKey, open: boolean): string {
  return `${STATUS_SECTION_TITLES[key].replace(/\.$/, '')}. Click to ${open ? 'collapse' : 'expand'}.`;
}

/** Rows a section draws before its "Show more" row. */
export const STATUS_SECTION_BATCH = 30;

/** localStorage key of the sections' fold store (section-fold-rule.ts; walnut-todo-* keys sync across devices, ui-prefs-sync.ts). */
export const LS_STATUS_SECTIONS_KEY = 'walnut-todo-status-sections';
/** The status sections' folds inside a project jump (project-jump.ts), kept apart from the saved ones. */
export const LS_JUMP_SECTIONS_KEY = 'walnut-todo-jump-status-sections';

type Watchable = Pick<Task, 'id'> & { watched_at?: string | null };

export function isWatched(task: Watchable): boolean {
  return !!task.watched_at;
}

/** The state section a task belongs to: its one user status (taskUserState), where the
 *  server already weighed a snooze (the task's own start date or an ancestor's). `snoozed`
 *  is the panel's own read of the start date, used only for a task the server has not
 *  derived yet. Nothing else moves a task between sections (tests/web/home-sections-user-status.test.ts). */
export function stateSectionOf(task: Task, snoozed?: (task: Task) => boolean): StateSectionKey {
  return shownState(taskUserState(task, !task.user_status && !!snoozed?.(task)));
}

/** Why a row under Waiting waits, in the Board's words (not started, stopped, a watch...).
 *  When it wakes is the row's own pill (the snooze date, the wait clock); a time the row has
 *  no pill for rides on the words, through `formatUntil`. */
export function waitingReason(task: Task, formatUntil: (iso: string) => string): string {
  const us = task.user_status;
  // Not derived yet (an older server): its wait clock pill says when; nothing says why.
  if (us?.state !== 'waiting') return '';
  const on = (us.waitingOn ?? '').trim();
  // Snoozed is why it sleeps here, whatever it would wait on after; its date is on the row.
  if (us.snoozed) return 'Snoozed';
  const limited = limitedLine(us);
  if (limited) return limited;
  if (us.kind === 'stuck') return on || 'Stopped: nothing will wake it';
  if (us.kind === 'time') {
    const when = us.until && !task.wait_until && !us.snoozed ? formatUntil(us.until) : '';
    return [on || 'A set time', when].filter(Boolean).join(', ');
  }
  return waitingLine(us, formatUntil);
}

/** A waiting row's hover text: the whole sentence when its line is the short form (sameAskLine). */
export function waitingHover(task: Task, formatUntil: (iso: string) => string): string {
  const us = task.user_status;
  return us && !us.snoozed && sameAskLine(us) ? waitingSentence(us) : waitingReason(task, formatUntil);
}

/** Where a row goes in a design with no state sections for open work (By project, and the
 *  list of Recent and Projects): the list is the user's to-do list, so every open task stays
 *  in it, a task nobody started and one that stopped included, except one parked, or one
 *  snoozed while Date reads "Available now" (`snoozed` given: any other Date shows it in the
 *  list), which folds under Waiting, and a row is drawn in one place only
 *  (tests/web/home-sections-user-status.test.ts). */
export function stateSectionNoNeeds(task: Task, snoozed?: (task: Task) => boolean): StateSectionKey {
  const s = stateSectionOf(task, snoozed);
  if (s === 'done') return s;
  const asleep = !!snoozed && (task.user_status ? !!task.user_status.snoozed : snoozed(task));
  // A parked row folds, unless its own work goes on (its build, its test run: Working, 2026-11-02)
  // or it is for the user (Needs you, its result or answer to look at); the list never draws one
  // (hiddenAsWaiting).
  const toRead = s === 'needs' && taskUserState(task) === 'read';
  return (task.phase === 'WAITING' && s !== 'working' && !toRead) || (s === 'waiting' && asleep) ? 'waiting' : 'working';
}

/** A Needs you row's line: what to do with it (its category) and what it asks or has to read. */
export function needsLine(task: Task): { category: NeedsCategory; label: string; text: string } | null {
  const us = task.user_status;
  if (!us || stateSectionOf(task) !== 'needs') return null;
  const line = needsLineOf(us);
  return line ? { ...line, label: NEEDS_CATEGORY_LABELS[line.category] } : null;
}

/** When a waiting row wakes: its clock, else its start date. */
export function wakeAt(task: Pick<Task, 'phase' | 'wait_until' | 'start_date'>): string {
  return (task.phase === 'WAITING' && task.wait_until) || task.start_date || '';
}

/** The section a task is DRAWN in: a watched task stays on top whatever its state. */
export function statusSectionOf(task: Task): StatusSectionKey {
  return isWatched(task) ? 'watching' : stateSectionOf(task);
}

const byDesc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);

/**
 * Order inside a section. Watching keeps the order the user added them (a new watch
 * lands at the bottom, nothing reshuffles); Needs you and Working put the latest
 * activity first; Waiting the rows a usage limit holds first (the Limited summary over the
 * sections leads to them), then the soonest wake, then the ones with no clock;
 * Completed the latest completion first.
 */
export function sortSectionTasks(key: StatusSectionKey, tasks: readonly Task[]): Task[] {
  const rows = [...tasks];
  const activity = (t: Task) => recentActivityTime(t, 'updated').at;
  switch (key) {
    case 'watching':
      return rows.sort((a, b) => ((a as Watchable).watched_at ?? '').localeCompare((b as Watchable).watched_at ?? '') || a.id.localeCompare(b.id));
    case 'waiting':
      return rows.sort((a, b) => {
        const la = a.user_status?.limit, lb = b.user_status?.limit;
        if (!!la !== !!lb) return la ? -1 : 1;
        // Among them, the one Walnut continues soonest first.
        if (la && lb) {
          const ka = la.dueAt ?? la.resetsAt ?? '', kb = lb.dueAt ?? lb.resetsAt ?? '';
          if (ka !== kb) return !ka ? 1 : !kb ? -1 : ka.localeCompare(kb);
        }
        const wa = wakeAt(a), wb = wakeAt(b);
        if (wa && wb) return wa.localeCompare(wb);
        if (wa || wb) return wa ? -1 : 1;
        return byDesc(activity(a), activity(b));
      });
    case 'done':
      return rows.sort((a, b) => byDesc(a.completed_at ?? a.updated_at ?? '', b.completed_at ?? b.updated_at ?? ''));
    default:
      return rows.sort((a, b) => byDesc(activity(a), activity(b)));
  }
}

export interface ProjectRun {
  project: string;
  tasks: Task[];
}

/**
 * The section's rows gathered by project, projects in the order their first row
 * appears (so the project holding the most urgent row leads). One run when the
 * section holds a single project: a lone label separates nothing.
 */
export function projectRuns(tasks: readonly Task[]): ProjectRun[] {
  const runs = new Map<string, Task[]>();
  for (const t of tasks) {
    const key = t.project || '';
    const run = runs.get(key);
    if (run) run.push(t); else runs.set(key, [t]);
  }
  return [...runs.entries()].map(([project, rows]) => ({ project, tasks: rows }));
}

export interface StatusSectionsModel {
  watching: Task[];
  needs: Task[];
  waiting: Task[];
  done: Task[];
  /** Open tasks under Working: Flat draws them as rows, By project's list draws them itself. */
  working: Task[];
  workingCount: number;
  /** Completed tasks not loaded yet that belong in the Completed count (the archive). */
  doneUnloaded: number;
  /** Completed tasks not loaded yet that a chip may or may not keep (not counted): the
   *  Completed section offers to load them, so older ones stay reachable. */
  archiveLeft: boolean;
}

export interface StatusSectionsInput {
  /** The tasks the current view draws from (a tier's members, the pins, every task). */
  scope: readonly Task[];
  /** Every task, for Watching: a watched task shows in every view. */
  all: readonly Task[];
  /** The view's chips, with the Status rule let go (each section is a status), and
   *  the default Date rule too (a snoozed task is a section of its own). */
  passes: (task: Task) => boolean;
  /** A start date still to come: the task sleeps under Waiting / snoozed. */
  snoozed?: (task: Task) => boolean;
  /** Completed tasks the list has not fetched; counted only when `archiveCounts`. */
  archiveHidden?: number;
  /** True when the scope is the whole board and no chip narrows the archive. */
  archiveCounts?: boolean;
  /** True when the scope is the whole board but a chip narrows it: the archive is
   *  offered (not counted), since some of it may pass the chip. */
  archiveOffered?: boolean;
  /** A place that wins over the task's state: a row in its exit grace stays where it
   *  was drawn (completed from Needs you, it fades out there, not in the list). */
  placeOf?: (task: Task) => StateSectionKey | undefined;
}

/** Split the view into its sections. Pure; TodoPanel memoizes it. */
export function buildStatusSections(input: StatusSectionsInput): StatusSectionsModel {
  const watching: Task[] = [];
  const needs: Task[] = [];
  const waiting: Task[] = [];
  const done: Task[] = [];
  const working: Task[] = [];
  const seen = new Set<string>();
  for (const t of input.scope) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    if (isWatched(t) || !input.passes(t)) continue;
    switch (input.placeOf?.(t) ?? stateSectionOf(t, input.snoozed)) {
      case 'needs': needs.push(t); break;
      case 'waiting': waiting.push(t); break;
      case 'done': done.push(t); break;
      default: working.push(t);
    }
  }
  for (const t of input.all) if (isWatched(t) && input.passes(t)) watching.push(t);
  return {
    watching: sortSectionTasks('watching', watching),
    needs: sortSectionTasks('needs', needs),
    waiting: sortSectionTasks('waiting', waiting),
    done: sortSectionTasks('done', done),
    working: sortSectionTasks('working', working),
    workingCount: working.length,
    doneUnloaded: input.archiveCounts ? input.archiveHidden ?? 0 : 0,
    archiveLeft: !input.archiveCounts && !!input.archiveOffered && (input.archiveHidden ?? 0) > 0,
  };
}

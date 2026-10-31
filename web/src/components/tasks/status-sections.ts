/**
 * Status sections of the home task panel (2026-10-29, the user: "instead of the
 * filter way, put them in a section, default collapsed, and when the user clicks it
 * will expand"). Every view draws its tasks under four status headings, plus the
 * user's Watching list on top:
 *
 *   Watching   open    tasks the user keeps in front of them, whatever their state
 *   Needs you  open    the one user status says the task waits on the user
 *   Working    open    everything else that is open: the view's own list, with its
 *                      order, folders and drag
 *   Waiting    folded  parked (phase WAITING) until a time or an event, or snoozed:
 *                      a start date ("Start / Snooze until") still to come
 *   Completed  folded  done
 *
 * The sections span the whole view and group by project inside, so "what needs me"
 * is one place at the top instead of a red row inside each project. This file is the
 * pure half: which section a task is in, the order inside a section, the project
 * runs, and the stored open state. StatusSections.tsx draws them.
 */
import type { Task } from '@open-walnut/core';
import { taskUserState } from '@/utils/session-status';
import { USER_STATE_LABELS } from '@open-walnut/user-status';
import { recentActivityTime } from './recent-activity-time';

export type StatusSectionKey = 'watching' | 'needs' | 'working' | 'waiting' | 'done';
/** The sections a task falls into by its state (Watching is the user's own pick). */
export type StateSectionKey = Exclude<StatusSectionKey, 'watching'>;

export const STATUS_SECTION_ORDER: readonly StatusSectionKey[] = ['watching', 'needs', 'working', 'waiting', 'done'];

export const STATUS_SECTION_LABELS: Record<StatusSectionKey, string> = {
  watching: 'Watching',
  ...USER_STATE_LABELS,
};

export const STATUS_SECTION_TITLES: Record<StatusSectionKey, string> = {
  watching: 'Tasks you watch: kept here whatever their state',
  needs: 'Waiting on you: a question, a review or a reply',
  working: 'Open work: running, or ready to pick up',
  waiting: 'Parked until a time or an event, or snoozed until a start date',
  done: 'Completed tasks',
};

/** Open on a first visit: what is in front of the user now. Waiting and Completed fold. */
export const STATUS_SECTION_DEFAULT_OPEN: Record<StatusSectionKey, boolean> = {
  watching: true,
  needs: true,
  working: true,
  waiting: false,
  done: false,
};

/** Rows a section draws before its "Show more" row. */
export const STATUS_SECTION_BATCH = 30;

/** localStorage key (walnut-todo-* keys sync across devices, ui-prefs-sync.ts). */
export const LS_STATUS_SECTIONS_KEY = 'walnut-todo-status-sections';

type Watchable = Pick<Task, 'id'> & { watched_at?: string | null };

export function isWatched(task: Watchable): boolean {
  return !!task.watched_at;
}

/** The state section a task belongs to: the one user status (taskUserState), where the
 *  server already weighed a snooze (the task's own start date or an ancestor's, 2026-10-31).
 *  `snoozed` is the panel's own read of the start date, used only for a task the server has
 *  not derived yet. One mapping of the panel's: a task nobody started and not snoozed is open
 *  work, ready to pick up, so it sits under Working, not Waiting ("Not started yet"). */
export function stateSectionOf(task: Task, snoozed?: (task: Task) => boolean): StateSectionKey {
  const us = task.user_status;
  const asleep = us ? !!us.snoozed : !!snoozed?.(task);
  const state = taskUserState(task, !us && asleep);
  if (state !== 'waiting') return state;
  const notStarted = us ? us.kind === 'not-started' : task.phase === 'TODO';
  return notStarted && !asleep ? 'working' : 'waiting';
}

/** The state section in a design with no Needs you section: a row that needs the user
 *  is open work, unless it is parked (the list would hide it there). */
export function stateSectionNoNeeds(task: Task, snoozed?: (task: Task) => boolean): StateSectionKey {
  const s = stateSectionOf(task, snoozed);
  if (s !== 'needs') return s;
  return task.phase === 'WAITING' ? 'waiting' : 'working';
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
 * activity first; Waiting the soonest wake first, then the ones with no clock;
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

/** The stored open state: only the sections the user flipped away from the default. */
export function readSectionOpen(raw: string | null): Record<StatusSectionKey, boolean> {
  const open = { ...STATUS_SECTION_DEFAULT_OPEN };
  if (!raw) return open;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') {
      for (const key of STATUS_SECTION_ORDER) {
        const v = (parsed as Record<string, unknown>)[key];
        if (typeof v === 'boolean') open[key] = v;
      }
    }
  } catch { /* a corrupt value reads as the defaults */ }
  return open;
}

export function writeSectionOpen(open: Record<StatusSectionKey, boolean>): string | null {
  const diff: Partial<Record<StatusSectionKey, boolean>> = {};
  for (const key of STATUS_SECTION_ORDER) if (open[key] !== STATUS_SECTION_DEFAULT_OPEN[key]) diff[key] = open[key];
  return Object.keys(diff).length ? JSON.stringify(diff) : null;
}

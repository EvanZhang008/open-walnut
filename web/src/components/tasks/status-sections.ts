/**
 * Status sections of the home task panel (2026-10-29, the user: "instead of the
 * filter way, put them in a section, default collapsed, and when the user clicks it
 * will expand"). Every view draws its tasks under four status headings, plus the
 * user's Watching list on top:
 *
 *   Watching   open    tasks the user keeps in front of them, whatever their state, drawn
 *                      from the view's own scope like every other section: a tier tab shows
 *                      only that tier's watched tasks (2026-11-11, the user: a Focus task is
 *                      Watching only inside Focus); All, Projects and Recent show every one
 *   Needs you  open    the task's user status is Needs you, or To read (it finished, or
 *                      answered the user, asking nothing: 2026-11-02, the user, under Waiting
 *                      "this is not waiting"; 2026-11-03, "I dont wnat serpeate to read"); each
 *                      row's line says what to do with it: Take a look, Decide, Review, Can close
 *   Working    open    its user status is Working: a turn runs, or its own work goes on
 *   Waiting    folded  its user status is Waiting: stopped, on a watch, a time, another
 *                      task or something outside, or snoozed; each row says which
 *                      (waitingReason) and wears the wait or snooze mark
 *   Not started folded Flat only: its user status is Waiting because nobody started it
 *                      (kind `not-started`: never run, marked in progress with no session,
 *                      or a start that failed), and it is not snoozed (2026-11-09, the user:
 *                      "a new category not started, to put the not stared one not mix in to
 *                      wait and snooze they are completeli differnet"); its rows wear the
 *                      dashed ring, never the hourglass
 *   Background folded  open tasks the user put out of the way (Task.background_at): long-running
 *                      work such as a CR review or a recurring job (2026-11-11, the user: "无论
 *                      task 是什么 status，它不会出来"). Not a status: such a task is drawn here
 *                      only, whatever its user status, and its heading carries a dot when one of
 *                      them asks the user something. Placed by hand (the task menu), never by a
 *                      rule ("我不想 be smart"); a completed one goes under Completed
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

export type StatusSectionKey = 'watching' | 'needs' | 'working' | 'waiting' | 'notstarted' | 'background' | 'done';
/** The sections a task falls into by its one user status (Watching is the user's own pick,
 *  Not started is a part of Waiting that Flat draws on its own). */
export type StateSectionKey = 'needs' | 'working' | 'waiting' | 'done';
/** A section a task is drawn in by its state (a user status section, or Not started), or
 *  Background, where a row in its exit grace stays too. */
export type DrawnSectionKey = Exclude<StatusSectionKey, 'watching'>;

export const STATUS_SECTION_ORDER: readonly StatusSectionKey[] = ['watching', 'needs', 'working', 'waiting', 'notstarted', 'background', 'done'];

const { read: _readLabel, ...SHOWN_LABELS } = USER_STATE_LABELS;
const { read: _readMeaning, ...SHOWN_MEANINGS } = USER_STATE_MEANINGS;

export const STATUS_SECTION_LABELS: Record<StatusSectionKey, string> = {
  watching: 'Watching',
  ...SHOWN_LABELS,
  notstarted: 'Not started',
  background: 'Background',
};

export const STATUS_SECTION_TITLES: Record<StatusSectionKey, string> = {
  watching: 'Tasks you watch: kept here whatever their state',
  ...SHOWN_MEANINGS,
  needs: 'It asks you something, or has a result or an answer for you to look at',
  waiting: 'It waits on something: stopped, a watch, a time, another task, or you snoozed it',
  notstarted: 'Nobody started it yet: no session has run it, or its start failed',
  background: 'Long-running work you put out of the way: kept here whatever its state',
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

type Backgroundable = Pick<Task, 'phase' | 'status'> & { background_at?: string | null };

/** In Background: the user put it there (`background_at`) and it is still open. A completed task
 *  keeps its mark (a reopen brings it back to Background) but is drawn under Completed. */
export function isBackground(task: Backgroundable): boolean {
  return !!task.background_at && task.phase !== 'COMPLETE' && task.status !== 'done';
}

/** Background's heading dot: how many of its tasks ask the user something (Needs you, To read
 *  left out: a long-running task's finished run is no ask). They stay in Background; the dot says so. */
export function backgroundNeedsCount(rows: readonly Task[]): number {
  return rows.filter((t) => taskUserState(t) === 'needs').length;
}

/** A watched row's place in Watching: its `watched_at` (when watched, or where the user dragged it). */
function watchTime(task: Watchable): number {
  const t = Date.parse(task.watched_at ?? '');
  return Number.isFinite(t) ? t : 0;
}

/**
 * The writes that put a dragged Watching row at `toIndex` (2026-11-09, the user: "I want this watch
 * to be able to reorder by drag"). Watching is ordered by `watched_at`, so the order is the tasks'
 * own field and every surface that lists the watch (Home on every device, the Org page, the phone)
 * reads it with no list of its own: the moved row takes a time between its new neighbours (one
 * write); a new watch is stamped now, so it lands at the bottom. When its neighbours leave no room
 * (the same millisecond), the rows after it that would tie move on by a millisecond each, so only
 * that run is written. `rows` is the whole of Watching in the order it shows, the rows behind its
 * "Show more" included, so a drop on the last row shown never jumps past them.
 */
export function watchReorder(rows: readonly Watchable[], fromId: string, toIndex: number, now: number): { id: string; watched_at: string }[] {
  const from = rows.findIndex((r) => r.id === fromId);
  if (from < 0 || toIndex < 0 || toIndex >= rows.length || from === toIndex) return [];
  const next = rows.filter((r) => r.id !== fromId);
  next.splice(toIndex, 0, rows[from]);
  const t = next.map(watchTime);
  const k = toIndex;
  const tb = k > 0 ? t[k - 1] : NaN, ta = k < t.length - 1 ? t[k + 1] : NaN;
  if (k > 0 && k < t.length - 1) t[k] = ta - tb >= 2 ? Math.floor((tb + ta) / 2) : tb + 1;
  else if (k === 0) t[k] = ta > 1000 ? ta - 1000 : 1;
  else t[k] = Math.max(tb + 1, now);
  // No room: the rows after it that now tie or go backwards move on, a millisecond each.
  for (let j = k + 1; j < t.length && t[j] <= t[j - 1]; j++) t[j] = t[j - 1] + 1;
  const out: { id: string; watched_at: string }[] = [];
  next.forEach((r, i) => {
    const iso = new Date(t[i]).toISOString();
    if (i === k || watchTime(r) !== t[i]) out.push({ id: r.id, watched_at: iso });
  });
  return out;
}

/** The state section a task belongs to: its one user status (taskUserState), where the
 *  server already weighed a snooze (the task's own start date or an ancestor's). `snoozed`
 *  is the panel's own read of the start date, used only for a task the server has not
 *  derived yet. Nothing else moves a task between sections (tests/web/home-sections-user-status.test.ts). */
export function stateSectionOf(task: Task, snoozed?: (task: Task) => boolean): StateSectionKey {
  return shownState(taskUserState(task, !task.user_status && !!snoozed?.(task)));
}

/** Not started: a waiting status whose kind says nobody started it, not snoozed (a snoozed
 *  task sleeps under Waiting / snoozed, whatever it would do after). A task the server has
 *  not derived yet: a TODO with no session and no start date to come. */
export function isNotStarted(task: Task, snoozed?: (task: Task) => boolean): boolean {
  const us = task.user_status;
  if (us) return us.state === 'waiting' && us.kind === 'not-started' && !us.snoozed;
  return task.phase === 'TODO' && !task.session_id && !snoozed?.(task);
}

/** The section Flat draws a task in by its state: its user status section, with Not started
 *  taken out of Waiting. */
export function drawnSectionOf(task: Task, snoozed?: (task: Task) => boolean): DrawnSectionKey {
  const s = stateSectionOf(task, snoozed);
  return s === 'waiting' && isNotStarted(task, snoozed) ? 'notstarted' : s;
}

/** A Not started row's line: only what the heading does not say already (a start that
 *  failed, a task marked in progress that nothing runs). */
export function notStartedReason(task: Task): string {
  const on = (task.user_status?.waitingOn ?? '').trim();
  return /^not started( yet)?\.?$/i.test(on) ? '' : on;
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

/** The section a task is DRAWN in: a watched task stays on top whatever its state, an open one
 *  in Background stays in Background. */
export function statusSectionOf(task: Task): StatusSectionKey {
  return isWatched(task) ? 'watching' : isBackground(task) ? 'background' : stateSectionOf(task);
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
      // By the time, not the text: an ISO time written without milliseconds sorts by its instant too.
      return rows.sort((a, b) => (watchTime(a) - watchTime(b)) || a.id.localeCompare(b.id));
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
    case 'background':
      // The ones that ask the user first (the heading's dot leads to them), then latest activity.
      return rows.sort((a, b) => (Number(taskUserState(b) === 'needs') - Number(taskUserState(a) === 'needs')) || byDesc(activity(a), activity(b)));
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
  /** Flat's Not started: drawn by Flat only; elsewhere these rows stay in the list or under Waiting. */
  notstarted: Task[];
  /** Open tasks the user put in Background (isBackground), whatever their state. */
  background: Task[];
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
  /** False when the Status filter hides state sections; Watching still follows the view. */
  statesActive?: boolean;
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
  placeOf?: (task: Task) => DrawnSectionKey | undefined;
  /** Flat: Not started is a section of its own; elsewhere those rows stay where their state puts them. */
  splitNotStarted?: boolean;
}

/** Split the view into its sections. Pure; TodoPanel memoizes it. */
export function buildStatusSections(input: StatusSectionsInput): StatusSectionsModel {
  const watching: Task[] = [];
  const needs: Task[] = [];
  const waiting: Task[] = [];
  const notstarted: Task[] = [];
  const background: Task[] = [];
  const done: Task[] = [];
  const working: Task[] = [];
  const seen = new Set<string>();
  for (const t of input.scope) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    if (!input.passes(t)) continue;
    if (isWatched(t)) { watching.push(t); continue; }
    if (input.statesActive === false) continue;
    // Background is no state: its open tasks are drawn there whatever theirs (a grace hold included).
    if (isBackground(t)) { background.push(t); continue; }
    const place = input.placeOf?.(t) ?? (input.splitNotStarted ? drawnSectionOf(t, input.snoozed) : stateSectionOf(t, input.snoozed));
    switch (place) {
      case 'needs': needs.push(t); break;
      case 'waiting': waiting.push(t); break;
      case 'notstarted': notstarted.push(t); break;
      // A Background task completed a moment ago fades out where it was drawn.
      case 'background': background.push(t); break;
      case 'done': done.push(t); break;
      default: working.push(t);
    }
  }
  return {
    watching: sortSectionTasks('watching', watching),
    needs: sortSectionTasks('needs', needs),
    waiting: sortSectionTasks('waiting', waiting),
    notstarted: sortSectionTasks('notstarted', notstarted),
    background: sortSectionTasks('background', background),
    done: sortSectionTasks('done', done),
    working: sortSectionTasks('working', working),
    workingCount: working.length,
    doneUnloaded: input.archiveCounts ? input.archiveHidden ?? 0 : 0,
    archiveLeft: !input.archiveCounts && !!input.archiveOffered && (input.archiveHidden ?? 0) > 0,
  };
}

/**
 * The home task panel's status sections (web/src/components/tasks/status-sections.ts):
 * which section a task is drawn in, the order inside each, the project runs, the
 * archive count and the exit-grace placement (the open state is section-fold-rule.test.ts).
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '../../src/core/types';
import {
  buildStatusSections,
  projectRuns,
  sortSectionTasks,
  stateSectionNoNeeds,
  stateSectionOf,
  statusSectionOf,
} from '../../web/src/components/tasks/status-sections';
import { PANEL_DESIGNS, readPanelDesign } from '../../web/src/components/tasks/panel-design';

let n = 0;
const task = (patch: Partial<Task> = {}): Task => ({
  id: `t${++n}`,
  title: `Task ${n}`,
  status: 'todo',
  phase: 'TODO',
  priority: 'none',
  project: 'Garden',
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
  ...patch,
} as Task);

const ids = (rows: readonly Task[]) => rows.map((t) => t.id);

describe('stateSectionOf / statusSectionOf', () => {
  it('done wins over every other state', () => {
    expect(stateSectionOf(task({ phase: 'COMPLETE', status: 'done', user_status: { state: 'needs' } as Task['user_status'] }))).toBe('done');
  });
  it('the one user status decides Needs you; the phase is the fallback', () => {
    expect(stateSectionOf(task({ phase: 'NEED_ACTION' }))).toBe('needs');
    // A turn that ended with nothing for the user reads Waiting in user_status: not Needs you.
    expect(stateSectionOf(task({ phase: 'NEED_ACTION', user_status: { state: 'waiting', kind: 'lead' } as Task['user_status'] }))).toBe('waiting');
    expect(stateSectionOf(task({ phase: 'WAITING', user_status: { state: 'needs' } as Task['user_status'] }))).toBe('needs');
  });
  it('a task not derived yet: a park, a snooze and a to-do wait; in progress works', () => {
    expect(stateSectionOf(task({ phase: 'WAITING' }))).toBe('waiting');
    const later = task({ phase: 'IN_PROGRESS', start_date: '2099-01-01' });
    expect(stateSectionOf(later, (t) => t.id === later.id)).toBe('working');
    expect(stateSectionOf(task({ phase: 'IN_PROGRESS' }))).toBe('working');
    expect(stateSectionOf(task({ phase: 'TODO' }))).toBe('waiting');
  });
  it('a snoozed task waits even when it needs the user (2026-10-30: snoozed, still under Needs you)', () => {
    // The shared status holds the snooze: its own start date or an ancestor's (no date of its own here).
    const asleep = { state: 'waiting', kind: 'time', waitingOn: 'Snoozed until 2099-01-01', snoozed: { until: '2099-01-01', ask: 'Review it' } } as Task['user_status'];
    expect(stateSectionOf(task({ phase: 'NEED_ACTION', user_status: asleep }))).toBe('waiting');
    // The server is the one owner: the panel's own start-date read never overrides it.
    const needs = task({ phase: 'NEED_ACTION', user_status: { state: 'needs' } as Task['user_status'], start_date: '2099-01-01' });
    expect(stateSectionOf(needs, () => true)).toBe('needs');
    // A task an older server has not derived: the panel's read stands in, and its date come, Needs you.
    const old = task({ phase: 'NEED_ACTION', start_date: '2099-01-01' });
    expect(stateSectionOf(old, (t) => t.id === old.id)).toBe('waiting');
    expect(stateSectionOf(old, () => false)).toBe('needs');
  });
  it('a task nobody started waits, and so does one that stopped (2026-10-31: both read Working)', () => {
    expect(stateSectionOf(task({ user_status: { state: 'waiting', kind: 'not-started' } as Task['user_status'] }))).toBe('waiting');
    expect(stateSectionOf(task({ user_status: { state: 'waiting', kind: 'not-started', snoozed: { until: '2099-01-01' } } as Task['user_status'] }))).toBe('waiting');
    expect(stateSectionOf(task({ phase: 'IN_PROGRESS', user_status: { state: 'waiting', kind: 'stuck' } as Task['user_status'] }))).toBe('waiting');
    expect(stateSectionOf(task({ phase: 'IN_PROGRESS', user_status: { state: 'working', snoozed: { until: '2099-01-01' } } as Task['user_status'] }))).toBe('working');
  });
  it('a watched task is drawn under Watching whatever its state', () => {
    expect(statusSectionOf(task({ phase: 'COMPLETE', status: 'done', watched_at: '2026-10-29T00:00:00Z' }))).toBe('watching');
    expect(statusSectionOf(task({ phase: 'WAITING', watched_at: '2026-10-29T00:00:00Z' }))).toBe('watching');
  });
});

describe('stateSectionNoNeeds (designs with no Needs you section)', () => {
  it('a row that needs the user is open work, unless parked or snoozed', () => {
    expect(stateSectionNoNeeds(task({ phase: 'NEED_ACTION' }))).toBe('working');
    expect(stateSectionNoNeeds(task({ phase: 'WAITING', user_status: { state: 'needs' } as Task['user_status'] }))).toBe('waiting');
    const later = task({ phase: 'NEED_ACTION', start_date: '2099-01-01' });
    expect(stateSectionNoNeeds(later, (t) => t.id === later.id)).toBe('waiting');
    expect(stateSectionNoNeeds(task({ status: 'done', phase: 'COMPLETE' }))).toBe('done');
  });
});

describe('sortSectionTasks', () => {
  it('Watching keeps the order the user added them', () => {
    const a = task({ watched_at: '2026-10-29T02:00:00Z' });
    const b = task({ watched_at: '2026-10-29T01:00:00Z' });
    expect(ids(sortSectionTasks('watching', [a, b]))).toEqual([b.id, a.id]);
  });
  it('Waiting: soonest wake first (clock or start date), then the ones with no clock by activity', () => {
    const noClockOld = task({ phase: 'WAITING', updated_at: '2026-10-02T00:00:00Z' });
    const noClockNew = task({ phase: 'WAITING', updated_at: '2026-10-05T00:00:00Z' });
    const friday = task({ phase: 'WAITING', wait_until: '2026-11-06T09:00:00Z' });
    const monday = task({ start_date: '2026-11-02' });
    expect(ids(sortSectionTasks('waiting', [noClockOld, friday, noClockNew, monday]))).toEqual([monday.id, friday.id, noClockNew.id, noClockOld.id]);
  });

  it('Waiting puts the rows a usage limit holds first, where the Limited summary leads', () => {
    const soon = task({ id: 'soon', phase: 'WAITING', wait_until: '2026-01-05T09:00:00Z' });
    const limited = task({ id: 'limited', phase: 'WAITING', wait_until: '2026-01-09T09:00:00Z', user_status: { state: 'waiting', limit: { auto: true, engine: 'claude', resetsAt: '2026-01-09T09:00:00Z' } } as Task['user_status'] });
    expect(ids(sortSectionTasks('waiting', [soon, limited]))).toEqual([limited.id, soon.id]);
    // Among them, the one Walnut continues soonest first.
    const later = task({ id: 'later', phase: 'WAITING', user_status: { state: 'waiting', limit: { auto: true, engine: 'codex', resetsAt: '2026-01-09T12:00:00Z', dueAt: '2026-01-09T12:01:00Z' } } as Task['user_status'] });
    const sooner = task({ id: 'sooner', phase: 'WAITING', user_status: { state: 'waiting', limit: { auto: true, engine: 'claude', resetsAt: '2026-01-09T08:00:00Z', dueAt: '2026-01-09T08:01:00Z' } } as Task['user_status'] });
    expect(ids(sortSectionTasks('waiting', [later, soon, sooner]))).toEqual([sooner.id, later.id, soon.id]);
  });
  it('Completed: latest completion first; Needs you: latest activity first', () => {
    const early = task({ status: 'done', phase: 'COMPLETE', completed_at: '2026-10-01T00:00:00Z' });
    const late = task({ status: 'done', phase: 'COMPLETE', completed_at: '2026-10-20T00:00:00Z' });
    expect(ids(sortSectionTasks('done', [early, late]))).toEqual([late.id, early.id]);
    const quiet = task({ phase: 'NEED_ACTION', updated_at: '2026-10-01T00:00:00Z' });
    const busy = task({ phase: 'NEED_ACTION', last_session_update: '2026-10-28T00:00:00Z' } as Partial<Task>);
    expect(ids(sortSectionTasks('needs', [quiet, busy]))).toEqual([busy.id, quiet.id]);
  });
});

describe('projectRuns', () => {
  it('gathers rows by project in the order each project first appears', () => {
    const a1 = task({ project: 'A' }), b1 = task({ project: 'B' }), a2 = task({ project: 'A' }), inbox = task({ project: '' });
    const runs = projectRuns([a1, b1, a2, inbox]);
    expect(runs.map((r) => r.project)).toEqual(['A', 'B', '']);
    expect(ids(runs[0].tasks)).toEqual([a1.id, a2.id]);
  });
});

describe('buildStatusSections', () => {
  const all = () => {
    const needs = task({ phase: 'NEED_ACTION' });
    const working = task({ phase: 'IN_PROGRESS' });
    const todo = task();
    const parked = task({ phase: 'WAITING' });
    const done = task({ status: 'done', phase: 'COMPLETE', completed_at: '2026-10-28T00:00:00Z' });
    const watchedDone = task({ status: 'done', phase: 'COMPLETE', watched_at: '2026-10-29T00:00:00Z' });
    const elsewhere = task({ watched_at: '2026-10-29T01:00:00Z', project: 'Other' });
    return { needs, working, todo, parked, done, watchedDone, elsewhere };
  };

  it('splits the view by user status; Working latest activity first (Flat draws it)', () => {
    const t = all();
    const later = task({ phase: 'IN_PROGRESS', updated_at: '2026-10-20T00:00:00.000Z' });
    const scope = [t.needs, t.working, later, t.todo, t.parked, t.done, t.watchedDone];
    const m = buildStatusSections({ scope, passes: () => true });
    expect(ids(m.needs)).toEqual([t.needs.id]);
    // A to-do nobody started waits, beside the parked one (2026-10-31).
    expect(ids(m.waiting).sort()).toEqual([t.parked.id, t.todo.id].sort());
    expect(ids(m.done)).toEqual([t.done.id]);
    expect(ids(m.working)).toEqual([later.id, t.working.id]);
    expect(m.workingCount).toBe(2);
    // Watching follows the same view scope as the other sections.
    expect(ids(m.watching)).toEqual([t.watchedDone.id]);
  });

  it('keeps only the current view’s watched rows when the status filter hides other sections', () => {
    const t = all();
    const m = buildStatusSections({ scope: [t.watchedDone, t.needs], statesActive: false, passes: () => true });
    expect(ids(m.watching)).toEqual([t.watchedDone.id]);
    expect(m.needs).toEqual([]);
    expect(m.workingCount).toBe(0);
  });

  it('deduplicates watched rows and clears Watching when the view is empty', () => {
    const t = all();
    expect(ids(buildStatusSections({ scope: [t.watchedDone, t.watchedDone], passes: () => true }).watching)).toEqual([t.watchedDone.id]);
    expect(buildStatusSections({ scope: [], passes: () => true }).watching).toEqual([]);
  });

  it('the chips narrow every section, Watching too', () => {
    const t = all();
    const scope = [t.needs, t.parked, t.watchedDone, t.elsewhere];
    const m = buildStatusSections({ scope, passes: (x) => x.project === 'Garden' });
    expect(ids(m.watching)).toEqual([t.watchedDone.id]);
    expect(m.needs.length + m.waiting.length).toBe(2);
  });

  it('a duplicate in the scope counts once', () => {
    const t = all();
    const m = buildStatusSections({ scope: [t.working, t.working, t.needs, t.needs], passes: () => true });
    expect(m.workingCount).toBe(1);
    expect(m.working).toHaveLength(1);
    expect(m.needs).toHaveLength(1);
  });

  it('the unloaded archive joins the Completed count only when asked', () => {
    const t = all();
    expect(buildStatusSections({ scope: [t.done], passes: () => true, archiveHidden: 40, archiveCounts: true }).doneUnloaded).toBe(40);
    expect(buildStatusSections({ scope: [t.done], passes: () => true, archiveHidden: 40, archiveCounts: false }).doneUnloaded).toBe(0);
  });

  it('an archive a chip keeps out of the count is still offered (archiveLeft)', () => {
    const t = all();
    expect(buildStatusSections({ scope: [t.done], passes: () => true, archiveHidden: 40, archiveOffered: true }).archiveLeft).toBe(true);
    // A tier view (not the whole board) is not offered the archive.
    expect(buildStatusSections({ scope: [t.done], passes: () => true, archiveHidden: 40, archiveCounts: false }).archiveLeft).toBe(false);
    expect(buildStatusSections({ scope: [t.done], passes: () => true, archiveHidden: 40, archiveCounts: true }).archiveLeft).toBe(false);
    expect(buildStatusSections({ scope: [t.done], passes: () => true, archiveHidden: 0, archiveOffered: true }).archiveLeft).toBe(false);
  });

  it('a row in its exit grace stays where it was drawn', () => {
    // Completed from Needs you: still under Needs you while it fades out.
    const justDone = task({ status: 'done', phase: 'COMPLETE', completed_at: new Date().toISOString() });
    const m = buildStatusSections({ scope: [justDone], passes: () => true, placeOf: () => 'needs' });
    expect(ids(m.needs)).toEqual([justDone.id]);
    expect(m.done).toHaveLength(0);
    // Completed in the list: the list holds it, so no section draws it.
    const inList = buildStatusSections({ scope: [justDone], passes: () => true, placeOf: () => 'working' });
    expect(inList.done).toHaveLength(0);
    expect(inList.workingCount).toBe(1);
  });

  it('a snoozed task sleeps under Waiting / snoozed', () => {
    const later = task({ start_date: '2099-01-01' });
    const m = buildStatusSections({ scope: [later], passes: () => true, snoozed: (x) => x.id === later.id });
    expect(ids(m.waiting)).toEqual([later.id]);
    expect(m.workingCount).toBe(0);
  });
});

describe('panel layout (panel-design.ts)', () => {
  it('two layouts, By project first and the default, Flat experimental', () => {
    // 2026-11-06, the user: "when people first use this please only default to the
    // project, the flat (show experimental, not default)".
    expect(PANEL_DESIGNS.map((d) => [d.id, d.label, !!d.experimental])).toEqual([['project', 'By project', false], ['status', 'Flat', true]]);
    expect(readPanelDesign(null)).toBe('project');
    expect(readPanelDesign('project')).toBe('project');
    // The user's own pick of Flat is kept.
    expect(readPanelDesign('status')).toBe('status');
  });

  it('nothing stored, or a stored layout no longer offered, never reads as Flat', () => {
    // 'shelf' was the third layout on trial (2026-10-29).
    for (const raw of [null, '', 'shelf', 'garbage', 'Status', '"status"']) expect(readPanelDesign(raw)).toBe('project');
  });
});

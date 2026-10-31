/**
 * The home task panel's status sections (web/src/components/tasks/status-sections.ts):
 * which section a task is drawn in, the order inside each, the project runs, the
 * archive count, the exit-grace placement and the stored open state.
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '../../src/core/types';
import {
  STATUS_SECTION_DEFAULT_OPEN,
  buildStatusSections,
  projectRuns,
  readSectionOpen,
  sortSectionTasks,
  stateSectionNoNeeds,
  stateSectionOf,
  statusSectionOf,
  writeSectionOpen,
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
    expect(stateSectionOf(task({ phase: 'NEED_ACTION', user_status: { state: 'waiting' } as Task['user_status'] }))).toBe('working');
    expect(stateSectionOf(task({ phase: 'WAITING', user_status: { state: 'needs' } as Task['user_status'] }))).toBe('needs');
  });
  it('a park and a snooze are Waiting; the rest is Working', () => {
    expect(stateSectionOf(task({ phase: 'WAITING' }))).toBe('waiting');
    const later = task({ start_date: '2099-01-01' });
    expect(stateSectionOf(later, (t) => t.id === later.id)).toBe('waiting');
    expect(stateSectionOf(task({ phase: 'IN_PROGRESS' }))).toBe('working');
    expect(stateSectionOf(task())).toBe('working');
  });
  it('a snoozed task waits even when it needs the user (2026-10-30: snoozed, still under Needs you)', () => {
    const later = task({ phase: 'NEED_ACTION', user_status: { state: 'needs' } as Task['user_status'], start_date: '2099-01-01' });
    expect(stateSectionOf(later, (t) => t.id === later.id)).toBe('waiting');
    // Its date come (the Date rule no longer calls it snoozed): back under Needs you.
    expect(stateSectionOf(later, () => false)).toBe('needs');
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

  it('splits the view; Working holds the open rest, latest activity first (Flat draws it)', () => {
    const t = all();
    t.todo.updated_at = '2026-10-20T00:00:00.000Z';
    const scope = [t.needs, t.working, t.todo, t.parked, t.done, t.watchedDone];
    const m = buildStatusSections({ scope, all: [...scope, t.elsewhere], passes: () => true });
    expect(ids(m.needs)).toEqual([t.needs.id]);
    expect(ids(m.waiting)).toEqual([t.parked.id]);
    expect(ids(m.done)).toEqual([t.done.id]);
    expect(ids(m.working)).toEqual([t.todo.id, t.working.id]);
    expect(m.workingCount).toBe(2);
    // Watching spans every view, the task outside this view's scope included.
    expect(ids(m.watching)).toEqual([t.watchedDone.id, t.elsewhere.id]);
  });

  it('the chips narrow every section, Watching too', () => {
    const t = all();
    const scope = [t.needs, t.parked, t.watchedDone, t.elsewhere];
    const m = buildStatusSections({ scope, all: scope, passes: (x) => x.project === 'Garden' });
    expect(ids(m.watching)).toEqual([t.watchedDone.id]);
    expect(m.needs.length + m.waiting.length).toBe(2);
  });

  it('a duplicate in the scope counts once', () => {
    const t = all();
    const m = buildStatusSections({ scope: [t.todo, t.todo, t.needs, t.needs], all: [], passes: () => true });
    expect(m.workingCount).toBe(1);
    expect(m.working).toHaveLength(1);
    expect(m.needs).toHaveLength(1);
  });

  it('the unloaded archive joins the Completed count only when asked', () => {
    const t = all();
    expect(buildStatusSections({ scope: [t.done], all: [], passes: () => true, archiveHidden: 40, archiveCounts: true }).doneUnloaded).toBe(40);
    expect(buildStatusSections({ scope: [t.done], all: [], passes: () => true, archiveHidden: 40, archiveCounts: false }).doneUnloaded).toBe(0);
  });

  it('an archive a chip keeps out of the count is still offered (archiveLeft)', () => {
    const t = all();
    expect(buildStatusSections({ scope: [t.done], all: [], passes: () => true, archiveHidden: 40, archiveOffered: true }).archiveLeft).toBe(true);
    // A tier view (not the whole board) is not offered the archive.
    expect(buildStatusSections({ scope: [t.done], all: [], passes: () => true, archiveHidden: 40, archiveCounts: false }).archiveLeft).toBe(false);
    expect(buildStatusSections({ scope: [t.done], all: [], passes: () => true, archiveHidden: 40, archiveCounts: true }).archiveLeft).toBe(false);
    expect(buildStatusSections({ scope: [t.done], all: [], passes: () => true, archiveHidden: 0, archiveOffered: true }).archiveLeft).toBe(false);
  });

  it('a row in its exit grace stays where it was drawn', () => {
    // Completed from Needs you: still under Needs you while it fades out.
    const justDone = task({ status: 'done', phase: 'COMPLETE', completed_at: new Date().toISOString() });
    const m = buildStatusSections({ scope: [justDone], all: [], passes: () => true, placeOf: () => 'needs' });
    expect(ids(m.needs)).toEqual([justDone.id]);
    expect(m.done).toHaveLength(0);
    // Completed in the list: the list holds it, so no section draws it.
    const inList = buildStatusSections({ scope: [justDone], all: [], passes: () => true, placeOf: () => 'working' });
    expect(inList.done).toHaveLength(0);
    expect(inList.workingCount).toBe(1);
  });

  it('a snoozed task sleeps under Waiting / snoozed', () => {
    const later = task({ start_date: '2099-01-01' });
    const m = buildStatusSections({ scope: [later], all: [], passes: () => true, snoozed: (x) => x.id === later.id });
    expect(ids(m.waiting)).toEqual([later.id]);
    expect(m.workingCount).toBe(0);
  });
});

describe('readSectionOpen / writeSectionOpen', () => {
  it('defaults: Watching, Needs you and Working open; Waiting and Completed folded', () => {
    expect(readSectionOpen(null)).toEqual(STATUS_SECTION_DEFAULT_OPEN);
    expect(STATUS_SECTION_DEFAULT_OPEN).toEqual({ watching: true, needs: true, working: true, waiting: false, done: false });
  });
  it('stores only what the user flipped, and reads it back', () => {
    const raw = writeSectionOpen({ ...STATUS_SECTION_DEFAULT_OPEN, done: true, needs: false });
    expect(JSON.parse(raw!)).toEqual({ needs: false, done: true });
    expect(readSectionOpen(raw)).toEqual({ ...STATUS_SECTION_DEFAULT_OPEN, done: true, needs: false });
    expect(writeSectionOpen(STATUS_SECTION_DEFAULT_OPEN)).toBeNull();
  });
  it('a corrupt or foreign value reads as the defaults', () => {
    expect(readSectionOpen('{not json')).toEqual(STATUS_SECTION_DEFAULT_OPEN);
    expect(readSectionOpen('{"done":"yes","bogus":true}')).toEqual(STATUS_SECTION_DEFAULT_OPEN);
  });
});

describe('panel layout (panel-design.ts)', () => {
  it('two layouts, Flat first and the default', () => {
    expect(PANEL_DESIGNS.map((d) => [d.id, d.label])).toEqual([['status', 'Flat'], ['project', 'By project']]);
    expect(readPanelDesign(null)).toBe('status');
    expect(readPanelDesign('project')).toBe('project');
  });

  it('a stored layout no longer offered reads as Flat', () => {
    // 'shelf' was the third layout on trial (2026-10-29).
    expect(readPanelDesign('shelf')).toBe('status');
    expect(readPanelDesign('garbage')).toBe('status');
  });
});

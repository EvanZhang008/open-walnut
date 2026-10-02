/**
 * The footer bar under the task list counts the status hides of the CURRENT VIEW
 * (web/src/components/tasks/footer-scope.ts). Pure logic, no React mount.
 *
 * Reported 2026-10-01: the Focus tab said "3 waiting hidden" when Focus held one
 * parked task; the other two were parked elsewhere on the board.
 */
import { describe, it, expect } from 'vitest';
import type { Task } from '../../src/core/types';
import { INBOX_TAB } from '../../web/src/components/tasks/task-tabs';
import { footerStatusScope, RECENT_FEED_SIZE, type FooterScopeInput } from '../../web/src/components/tasks/footer-scope';

function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    status: 'todo',
    phase: 'TODO',
    project: 'alpha',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...patch,
  } as Task;
}

// Board: focus = {f1 parked, f2 open, f3 done}; satellite = {s1 parked}; backlog = {b1 done};
// custom tier ct_x = {c1 parked}; hidden group g = {h1 parked, in focus}; list-only = {l1 parked (beta), l2 done, l3 parked (inbox)}.
const tasks: Task[] = [
  task('f1', { pinned: true, focus_tier: 'focus', phase: 'WAITING' }),
  task('f2', { pinned: true, focus_tier: 'focus' }),
  task('f3', { pinned: true, focus_tier: 'focus', status: 'done', phase: 'COMPLETE' }),
  task('h1', { pinned: true, focus_tier: 'focus', phase: 'WAITING', group_id: 'g' }),
  task('s1', { pinned: true, phase: 'WAITING' }),
  task('b1', { pinned: true, focus_tier: 'backlog', status: 'done', phase: 'COMPLETE' }),
  task('c1', { pinned: true, focus_tier: 'ct_x', phase: 'WAITING' }),
  task('l1', { project: 'beta', phase: 'WAITING' }),
  task('l2', { status: 'done', phase: 'COMPLETE' }),
  task('l3', { project: '', phase: 'WAITING' }),
];
const ids = (...xs: string[]) => new Set(xs);
const base: FooterScopeInput = {
  section: 'all',
  tasks,
  activeProject: '',
  pinnedTaskIds: ids('f1', 'f2', 'f3', 'h1', 's1', 'b1', 'c1'),
  focusTaskIds: ids('f1', 'f2', 'f3', 'h1'),
  backlogTaskIds: ids('b1'),
  waitTaskIds: ids(),
  customTierIds: { ct_x: ids('c1') },
  customMemberIds: ids('c1'),
  hiddenGroups: ids('g'),
  showCompleted: false,
  waitingRevealed: false,
  recentSortMode: 'updated',
};
const counts = (patch: Partial<FooterScopeInput>) => {
  const r = footerStatusScope({ ...base, ...patch });
  return { waiting: r.waiting, completed: r.completed, wholeBoard: r.wholeBoard };
};

describe('footerStatusScope: tier tabs count their own tier', () => {
  it('Focus counts the parked and done pins in Focus, not the board (the reported bug)', () => {
    expect(counts({ section: 'focus' })).toEqual({ waiting: 1, completed: 1, wholeBoard: false });
  });

  it('a pin in a hidden group is not counted: the tier never draws it', () => {
    expect(counts({ section: 'focus', hiddenGroups: undefined }).waiting).toBe(2);
  });

  it('Satellite is pinned minus every other tier', () => {
    expect(counts({ section: 'satellite' })).toEqual({ waiting: 1, completed: 0, wholeBoard: false });
  });

  it('Backlog, a custom tier and the Pinned view', () => {
    expect(counts({ section: 'backlog' })).toEqual({ waiting: 0, completed: 1, wholeBoard: false });
    expect(counts({ section: 'ct_x' })).toEqual({ waiting: 1, completed: 0, wholeBoard: false });
    expect(counts({ section: 'pinned' })).toEqual({ waiting: 3, completed: 2, wholeBoard: false });
  });

  it('an unknown custom tier id counts nothing', () => {
    expect(counts({ section: 'ct_gone' })).toEqual({ waiting: 0, completed: 0, wholeBoard: false });
  });
});

describe('footerStatusScope: the list views follow the project tab', () => {
  it('All with every project is the whole board, archive included (the list draws a hidden group too)', () => {
    expect(counts({ section: 'all' })).toEqual({ waiting: 6, completed: 3, wholeBoard: true });
  });

  it('All on a project tab counts that project plus the cross-project pins above it', () => {
    // beta: l1; pins: f1 s1 c1 parked (h1 hidden), f3 b1 done.
    expect(counts({ section: 'all', activeProject: 'beta' })).toEqual({ waiting: 4, completed: 2, wholeBoard: false });
  });

  it('the Tasks list on a project tab counts only that project; Inbox is the no-project bucket', () => {
    expect(counts({ section: 'tasks', activeProject: 'beta' })).toEqual({ waiting: 1, completed: 0, wholeBoard: false });
    expect(counts({ section: 'tasks', activeProject: INBOX_TAB })).toEqual({ waiting: 1, completed: 0, wholeBoard: false });
    expect(counts({ section: 'tasks', activeProject: '' })).toEqual({ waiting: 6, completed: 3, wholeBoard: true });
  });
});

describe('footerStatusScope: Recent counts inside its capped feed', () => {
  const many: Task[] = [];
  for (let i = 0; i < RECENT_FEED_SIZE + 30; i += 1) {
    // Newest first: r00 is the most recent. Every 5th row is parked, every 7th done;
    // 30 rows past the cap, so some parked and done rows fall outside the feed.
    const stamp = `2026-09-${String(30 - Math.floor(i / 10)).padStart(2, '0')}T${String(23 - (i % 10)).padStart(2, '0')}:00:00.000Z`;
    many.push(task(`r${String(i).padStart(2, '0')}`, {
      updated_at: stamp,
      ...(i % 5 === 0 ? { phase: 'WAITING' } : {}),
      ...(i % 7 === 0 ? { status: 'done', phase: 'COMPLETE', completed_at: stamp } : {}),
    }));
  }
  const recent = (patch: Partial<FooterScopeInput> = {}) => footerStatusScope({ ...base, section: 'recent', tasks: many, ...patch });

  it('the scope is the feed as gated: 50 rows, no done, no parked', () => {
    const r = recent();
    expect(r.scope).toHaveLength(RECENT_FEED_SIZE);
    expect(r.scope.some((t) => t.status === 'done' || t.phase === 'WAITING')).toBe(false);
    expect(r.wholeBoard).toBe(false);
  });

  it('the parked count is what revealing would add to the first 50 rows, not every parked task', () => {
    const r = recent();
    const admitted = many.filter((t) => t.status !== 'done').slice(0, RECENT_FEED_SIZE);
    expect(r.waiting).toBe(admitted.filter((t) => t.phase === 'WAITING').length);
    expect(r.waiting).toBeLessThan(many.filter((t) => t.phase === 'WAITING').length);
  });

  it('the completed count walks the feed with done admitted and parked still hidden', () => {
    const r = recent();
    const admitted = many.filter((t) => t.phase !== 'WAITING').slice(0, RECENT_FEED_SIZE);
    expect(r.completed).toBe(admitted.filter((t) => t.status === 'done').length);
  });

  it('with both reveals on the scope holds the done and parked rows it counted', () => {
    const r = recent({ showCompleted: true, waitingRevealed: true });
    expect(r.scope).toHaveLength(RECENT_FEED_SIZE);
    expect(r.scope.filter((t) => t.phase === 'WAITING')).toHaveLength(r.waiting);
    expect(r.scope.filter((t) => t.status === 'done')).toHaveLength(r.completed);
  });
});

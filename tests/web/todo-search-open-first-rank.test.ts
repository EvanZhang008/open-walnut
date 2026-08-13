/**
 * REGRESSION: "the search in the task doesn't include the future task"
 * (user report 2026-08-09).
 *
 * Two coupled defects, one user-visible symptom:
 *
 *  1. Task search intersected its results with the toolbar filters, and the
 *     Date filter DEFAULTS to "Now" — which hides any task whose start_date is
 *     still in the future. So a deferred task ("Remind wife to check bank
 *     deposit", start_date tomorrow) could not be found by typing its exact
 *     title: the panel answered "No tasks match". Fixed in TodoPanel by
 *     searching the WHOLE task set (`eligibleTasks = tasks`).
 *
 *  2. Dropping the filters also drops the completed-hiding rule, and a mature
 *     install is mostly history (measured on the real store: 3119 done vs 284
 *     open). A broad query then filled the 40-row render cap with finished
 *     work and the live task never mounted. Fixed by `rankOpenTasksFirst`,
 *     which is what this file pins.
 *
 * The invariant: open before done, relevance order preserved inside each bucket.
 */
import { describe, it, expect } from 'vitest';
import { rankOpenTasksFirst } from '@/components/tasks/search-results';

const open = (id: string) => ({ id, status: 'todo' });
const running = (id: string) => ({ id, status: 'in_progress' });
const done = (id: string) => ({ id, status: 'done' });

const ids = (tasks: { id: string }[]) => tasks.map((t) => t.id);

describe('rankOpenTasksFirst', () => {
  it('moves done tasks behind open ones', () => {
    expect(ids(rankOpenTasksFirst([done('d1'), open('o1'), done('d2'), open('o2')])))
      .toEqual(['o1', 'o2', 'd1', 'd2']);
  });

  it('treats in_progress as open, not done', () => {
    expect(ids(rankOpenTasksFirst([done('d1'), running('r1')]))).toEqual(['r1', 'd1']);
  });

  it('is stable: relevance order is preserved inside each bucket', () => {
    // Caller ranks by relevance (metadata-exact first, then semantic). This must
    // only partition — never reshuffle — or the best hit stops being first.
    const input = [open('o1'), open('o2'), open('o3'), done('d1'), done('d2')];
    expect(ids(rankOpenTasksFirst(input))).toEqual(['o1', 'o2', 'o3', 'd1', 'd2']);
  });

  it('leaves an all-open or all-done list untouched', () => {
    expect(ids(rankOpenTasksFirst([open('a'), open('b')]))).toEqual(['a', 'b']);
    expect(ids(rankOpenTasksFirst([done('a'), done('b')]))).toEqual(['a', 'b']);
    expect(rankOpenTasksFirst([])).toEqual([]);
  });

  it('treats a task with no status as open (never buries an unknown task)', () => {
    expect(ids(rankOpenTasksFirst([done('d1'), { id: 'u1' }]))).toEqual(['u1', 'd1']);
  });

  it('surfaces the one open hit past a 40-row cap buried in history', () => {
    // The measured shape of the real bug: query "check" matched 87 tasks, 79 of
    // them done, and the target sat at index 82 — past the render cap.
    const matches = [
      ...Array.from({ length: 60 }, (_, i) => done(`d${i}`)),
      open('deferred-target'),
      ...Array.from({ length: 26 }, (_, i) => done(`d${60 + i}`)),
    ];
    const rendered = rankOpenTasksFirst(matches).slice(0, 40);
    expect(ids(rendered)).toContain('deferred-target');
    expect(rendered[0].id).toBe('deferred-target');
  });

  it('does not drop or duplicate any match', () => {
    const matches = [done('d1'), open('o1'), done('d2'), running('r1'), open('o2')];
    const ranked = rankOpenTasksFirst(matches);
    expect(ranked).toHaveLength(matches.length);
    expect(new Set(ids(ranked))).toEqual(new Set(ids(matches)));
  });
});

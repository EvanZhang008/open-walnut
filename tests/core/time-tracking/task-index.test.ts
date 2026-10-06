/**
 * The per-task time index (src/core/time-tracking/task-index.ts): one task's
 * totals (all / today / 7 days), its days newest first with each session's share,
 * and one session's time across the tasks it was filed under. Pure; no fs.
 */

import { describe, it, expect } from 'vitest';
import {
  addToTaskIndex, agentDates, createTaskIndex, sessionTimeView, taskTimeView,
} from '../../../src/core/time-tracking/task-index.js';
import { shiftDateKey } from '../../../src/core/time-tracking/rollup.js';
import type { TimeRecord } from '../../../src/core/time-tracking/types.js';

const TODAY = '2026-10-05';

function rec(over: Partial<TimeRecord>): TimeRecord {
  return { date: TODAY, ts: `${TODAY}T15:00:00.000Z`, durationMs: 60_000, kind: 'session', taskId: 't_a', ...over };
}

function indexOf(records: TimeRecord[]) {
  const index = createTaskIndex();
  for (const r of records) addToTaskIndex(index, r);
  return index;
}

describe('taskTimeView', () => {
  it('keeps the two lanes apart and splits today, the 7 days and everything', () => {
    const index = indexOf([
      rec({ durationMs: 10 * 60_000, sessionId: 's1' }),                                  // you, today
      rec({ kind: 'agent', durationMs: 30 * 60_000, sessionId: 's1' }),                  // agent, today
      rec({ date: shiftDateKey(TODAY, -6), durationMs: 5 * 60_000, sessionId: 's1' }),   // you, 7th day back
      rec({ date: shiftDateKey(TODAY, -7), kind: 'agent', durationMs: 60 * 60_000, sessionId: 's2' }), // outside the week
    ]);
    const view = taskTimeView(index, 't_a', TODAY);
    expect(view.weekStart).toBe(shiftDateKey(TODAY, -6));
    expect(view.totals.today).toEqual({ humanMs: 10 * 60_000, agentMs: 30 * 60_000 });
    expect(view.totals.week).toEqual({ humanMs: 15 * 60_000, agentMs: 30 * 60_000 });
    expect(view.totals.all).toEqual({ humanMs: 15 * 60_000, agentMs: 90 * 60_000 });
  });

  it('lists days newest first, each session\'s share, and the time outside any session', () => {
    const index = indexOf([
      rec({ date: shiftDateKey(TODAY, -2), durationMs: 1000, sessionId: 's1' }),
      rec({ durationMs: 4000, sessionId: 's1' }),
      rec({ durationMs: 7000, sessionId: 's2' }),
      rec({ kind: 'agent', durationMs: 9000, sessionId: 's2' }),
      rec({ kind: 'triage', durationMs: 2500 }), // the task's row / detail: no session
    ]);
    const view = taskTimeView(index, 't_a', TODAY);
    expect(view.days.map((d) => d.date)).toEqual([TODAY, shiftDateKey(TODAY, -2)]);
    const today = view.days[0]!;
    expect(today).toMatchObject({ humanMs: 13_500, agentMs: 9000, other: { humanMs: 2500, agentMs: 0 } });
    // Your time first: s2 (7s) before s1 (4s).
    expect(today.sessions).toEqual([
      { sessionId: 's2', humanMs: 7000, agentMs: 9000 },
      { sessionId: 's1', humanMs: 4000, agentMs: 0 },
    ]);
    // Sessions across the whole task, with their own totals and last day.
    expect(view.sessions.map((s) => [s.sessionId, s.totals.all, s.lastDate])).toEqual([
      ['s2', { humanMs: 7000, agentMs: 9000 }, TODAY],
      ['s1', { humanMs: 5000, agentMs: 0 }, TODAY],
    ]);
    // Sum of the days == the total: nothing dropped or counted twice.
    const sum = view.days.reduce((acc, d) => ({ h: acc.h + d.humanMs, a: acc.a + d.agentMs }), { h: 0, a: 0 });
    expect(sum).toEqual({ h: view.totals.all.humanMs, a: view.totals.all.agentMs });
  });

  it('answers zeros for a task with no time, and never mixes in another task', () => {
    const index = indexOf([rec({ taskId: 't_other', durationMs: 5000, sessionId: 's9' })]);
    const view = taskTimeView(index, 't_a', TODAY);
    expect(view.totals.all).toEqual({ humanMs: 0, agentMs: 0 });
    expect(view.days).toEqual([]);
    expect(view.sessions).toEqual([]);
  });

  it('skips what the rollup skips: zero or negative time, and a kind that is no lane', () => {
    const index = indexOf([
      rec({ durationMs: 0 }),
      rec({ durationMs: -5 }),
      rec({ durationMs: Number.NaN }),
      rec({ kind: 'bogus' as TimeRecord['kind'], durationMs: 5000 }),
      rec({ durationMs: 1000 }),
    ]);
    expect(taskTimeView(index, 't_a', TODAY).totals.all).toEqual({ humanMs: 1000, agentMs: 0 });
  });

  it('files time with no task under the empty id, not under a task', () => {
    const index = indexOf([rec({ taskId: undefined, kind: 'chat', durationMs: 3000 })]);
    expect(taskTimeView(index, '', TODAY).totals.all.humanMs).toBe(3000);
    expect(taskTimeView(index, 't_a', TODAY).totals.all.humanMs).toBe(0);
  });
});

describe('sessionTimeView', () => {
  it('sums one session across every task it was filed under, day by day', () => {
    const index = indexOf([
      rec({ taskId: 't_a', sessionId: 's1', durationMs: 1000 }),
      rec({ taskId: 't_b', sessionId: 's1', kind: 'agent', durationMs: 4000 }),       // moved to another task
      rec({ taskId: 't_b', sessionId: 's1', date: shiftDateKey(TODAY, -1), durationMs: 2000 }),
      rec({ taskId: 't_a', sessionId: 's2', durationMs: 9000 }),                        // not this session
    ]);
    const view = sessionTimeView(index, 's1', TODAY);
    expect(view.taskIds).toEqual(['t_a', 't_b']);
    expect(view.totals.all).toEqual({ humanMs: 3000, agentMs: 4000 });
    expect(view.totals.today).toEqual({ humanMs: 1000, agentMs: 4000 });
    expect(view.days).toEqual([
      { date: TODAY, humanMs: 1000, agentMs: 4000 },
      { date: shiftDateKey(TODAY, -1), humanMs: 2000, agentMs: 0 },
    ]);
  });

  it('answers zeros for an unknown session', () => {
    const view = sessionTimeView(createTaskIndex(), 'nope', TODAY);
    expect(view).toMatchObject({ taskIds: [], days: [], totals: { all: { humanMs: 0, agentMs: 0 } } });
  });
});

describe('the ledger overlay', () => {
  const OLD = shiftDateKey(TODAY, -60);
  const store = () => indexOf([
    rec({ durationMs: 1000, sessionId: 's1' }),
    rec({ kind: 'agent', durationMs: 4000, sessionId: 's1' }), // the collector saw today
    rec({ date: OLD, durationMs: 2000, sessionId: 's1' }),     // you, on a day it never saw
  ]);
  const ledger = () => indexOf([
    rec({ date: OLD, kind: 'agent', durationMs: 9000, sessionId: 's1' }),
    rec({ date: OLD, kind: 'agent', durationMs: 3000, sessionId: 's2' }),
    rec({ kind: 'agent', durationMs: 99_000, sessionId: 's1' }), // today: observed, so never used
  ]);

  it('fills agent time on the days the collector never observed, and only there', () => {
    const s = store();
    const overlay = { index: ledger(), skip: agentDates(s) };
    expect([...overlay.skip]).toEqual([TODAY]);
    const view = taskTimeView(s, 't_a', TODAY, overlay);
    expect(view.totals.all).toEqual({ humanMs: 3000, agentMs: 16_000 });
    expect(view.totals.today).toEqual({ humanMs: 1000, agentMs: 4000 });
    const old = view.days.find((d) => d.date === OLD)!;
    expect(old).toMatchObject({ humanMs: 2000, agentMs: 12_000 });
    expect(old.sessions).toEqual([
      { sessionId: 's1', humanMs: 2000, agentMs: 9000 },
      { sessionId: 's2', humanMs: 0, agentMs: 3000 },
    ]);
    // A session known only to the ledger is still one of the task's sessions.
    expect(view.sessions.map((x) => x.sessionId)).toEqual(['s1', 's2']);
  });

  it('never changes either index it reads', () => {
    const s = store();
    const l = ledger();
    taskTimeView(s, 't_a', TODAY, { index: l, skip: agentDates(s) });
    expect(taskTimeView(s, 't_a', TODAY).totals.all).toEqual({ humanMs: 3000, agentMs: 4000 });
    expect(taskTimeView(l, 't_a', TODAY).totals.all.agentMs).toBe(111_000);
  });

  it('gives a session its ledger days too, under the tasks it really has time on', () => {
    const s = store();
    const overlay = { index: ledger(), skip: agentDates(s) };
    expect(sessionTimeView(s, 's2', TODAY, overlay)).toMatchObject({
      taskIds: ['t_a'], totals: { all: { humanMs: 0, agentMs: 3000 } },
    });
    // The skipped day's ledger row names t_a for s1, but s1's taskIds come from real shares only.
    expect(sessionTimeView(s, 's1', TODAY, overlay).totals.all).toEqual({ humanMs: 3000, agentMs: 13_000 });
  });
});

/**
 * The Routines page's grouping and its one-line rows (web/src/components/routines/routine-groups.ts):
 * global first, then one group per project in name order; failing routines lead
 * their group and nothing else reorders (a switch flipped by a click never moves
 * its row); the row's timing says how often and when next, or why it is quiet.
 */
import { describe, it, expect } from 'vitest';
import type { Routine } from '../../web/src/api/routines';
import {
  GLOBAL_GROUP_KEY, groupRoutines, healthLabel, keepShownOrder, nameTaskIn, quietReason, routineError, routineHealth, rowTiming, runOutcome,
  runStamp, settledRun, shortNextRun, changedSince, editKey, historyWords, collapseRepeats,
} from '../../web/src/components/routines/routine-groups';

const NOW = new Date(2026, 10, 4, 10, 0, 0).getTime();

function routine(id: string, over: Partial<Routine> = {}): Routine {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: 'every', everyMs: 5 * 60_000 },
    wakeMode: 'now',
    state: {},
    ...over,
  };
}

const owned = (project: string) => ({ owner: { taskId: `t-${project || 'inbox'}`, title: 'A task', project } });

describe('groupRoutines', () => {
  it('puts global first, then projects by name, each routine in its own project', () => {
    const groups = groupRoutines([
      routine('w1', owned('Walnut')),
      routine('a1', owned('acme')),
      routine('g1'),
      routine('inbox', owned('')),
      routine('w2', owned('Walnut')),
      routine('m1', owned('Marina')),
    ]);
    expect(groups.map((g) => [g.key, g.name, g.routines.map((r) => r.id)])).toEqual([
      [GLOBAL_GROUP_KEY, 'Global', ['g1', 'inbox']],
      ['project:acme', 'acme', ['a1']],
      ['project:Marina', 'Marina', ['m1']],
      ['project:Walnut', 'Walnut', ['w1', 'w2']],
    ]);
    expect(groups[0].global).toBe(true);
  });

  it('lifts failing routines to the top of their group and counts them', () => {
    const [group] = groupRoutines([
      routine('b-ok', { ...owned('P'), name: 'b ok' }),
      routine('c-fail', { ...owned('P'), name: 'c fail', state: { lastStatus: 'error', lastError: 'boom' } }),
      routine('a-off', { ...owned('P'), name: 'a off', enabled: false, state: { pausedAtMs: NOW - 60_000 } }),
      routine('d-check', { ...owned('P'), name: 'd check', check: { run: 'x', host: 'h' }, state: { lastCheck: { atMs: NOW, outcome: 'error', error: 'exit 1' } } }),
    ]);
    expect(group.routines.map((r) => r.id)).toEqual(['c-fail', 'd-check', 'a-off', 'b-ok']);
    expect(group.failing).toBe(2);
  });

  it('keeps a row in place when it is switched off or on', () => {
    const on = [routine('a'), routine('b'), routine('c')];
    const off = on.map((r) => (r.id === 'b' ? { ...r, enabled: false, state: { pausedAtMs: NOW } } : r));
    expect(groupRoutines(off)[0].routines.map((r) => r.id)).toEqual(groupRoutines(on)[0].routines.map((r) => r.id));
  });
});

describe('routineHealth', () => {
  it('tells ok, running, error and off apart', () => {
    expect(routineHealth(routine('a'))).toBe('ok');
    expect(routineHealth(routine('a', { state: { runningAtMs: NOW } }))).toBe('running');
    expect(routineHealth(routine('a', { state: { lastStatus: 'error' } }))).toBe('error');
    expect(routineHealth(routine('a', { enabled: false }))).toBe('off');
  });

  it('reads a trigger the server stopped as an error, a paused one as off', () => {
    const stopped = routine('t', { enabled: false, check: { run: 'x', host: 'h' }, state: { consecutiveErrors: 5 } });
    const paused = routine('t', { enabled: false, check: { run: 'x', host: 'h' }, state: { pausedAtMs: NOW } });
    expect(routineHealth(stopped)).toBe('error');
    expect(healthLabel(stopped)).toBe('Stopped');
    expect(routineHealth(paused)).toBe('off');
    expect(healthLabel(paused)).toBe('Paused');
  });
});

describe('rowTiming', () => {
  it('says how often and when next', () => {
    expect(rowTiming(routine('a', { state: { nextRunAtMs: NOW + 3 * 60_000 } }), NOW)).toBe('Every 5 min · next in 3 min');
    expect(rowTiming(routine('a', { check: { run: 'x', host: 'h' }, state: { nextRunAtMs: NOW + 30_000 } }), NOW)).toBe('Checks every 5 min · next in <1 min');
  });

  it('names a cron hour once: the cadence keeps it, the next run says only the day', () => {
    const at = (expr: string, nextMs: number) => routine('c', { schedule: { kind: 'cron', expr }, state: { nextRunAtMs: nextMs } });
    expect(rowTiming(at('0 8 * * 1', NOW + 3 * 24 * 3_600_000), NOW)).toMatch(/^Mondays at 8:00\sAM · in 3 days$/);
    expect(rowTiming(at('0 9 * * 1-5', NOW + 23 * 3_600_000), NOW)).toMatch(/^Weekdays at 9:00\sAM · tomorrow$/);
    expect(rowTiming(at('30 17 * * *', NOW + 7.5 * 3_600_000), NOW)).toMatch(/^Every day at 5:30\sPM · today$/);
    expect(rowTiming(at('30 17 * * *', NOW + 20 * 60_000), NOW)).toMatch(/^Every day at 5:30\sPM · next in 20 min$/);
    expect(rowTiming(at('0 9 1 * *', NOW + 5 * 24 * 3_600_000), NOW)).toMatch(/^Monthly on the 1st at 9:00\sAM · in 5 days$/);
    const once = routine('o', { schedule: { kind: 'at', at: new Date(NOW + 3 * 24 * 3_600_000).toISOString() }, state: { nextRunAtMs: NOW + 3 * 24 * 3_600_000 } });
    expect(rowTiming(once, NOW)).toMatch(/^Once at [^·]+$/);
    // No hour in the cadence: the next run says the clock.
    expect(rowTiming(at('15 * * * *', NOW + 2 * 3_600_000), NOW)).toMatch(/^Hourly at :15 · next at \d/);
  });

  it('says a routine is quiet without the when: that is in the opened row', () => {
    const paused = routine('a', { enabled: false, state: { pausedAtMs: NOW - 2 * 3_600_000, nextRunAtMs: NOW } });
    expect(rowTiming(paused, NOW)).toBe('Paused · Every 5 min');
    expect(quietReason(paused, NOW)).toBe('Paused 2h ago');
    expect(rowTiming(routine('a', { enabled: false, schedule: { kind: 'at', at: new Date(NOW).toISOString() } }), NOW)).toMatch(/^Off · Once at /);
    const stopped = routine('t', { enabled: false, check: { run: 'x', host: 'h' }, state: { consecutiveErrors: 5 } });
    // The row's red flag says Stopped; the line keeps only the cadence.
    expect(rowTiming(stopped, NOW)).toBe('Checks every 5 min');
    expect(quietReason(stopped, NOW)).toBe('Stopped after 5 failed checks');
    expect(quietReason(routine('on'), NOW)).toBeNull();
  });
});

describe('routineError', () => {
  it('names the task instead of its id, and says the way out of a finished task', () => {
    const r = routine('e', {
      owner: { taskId: 'mw20xlw0-fcd9', title: 'Router watch', project: 'Home' },
      state: { lastStatus: 'error', lastError: 'target task mw20xlw0-fcd9 is complete; the trigger will not resurrect it' },
    });
    expect(routineError(r)).toEqual({
      text: 'Its task "Router watch" is complete, so its last run went nowhere.',
      next: 'Point it at an open task with Edit, or turn it off.',
    });
    expect(routineError(routine('x', { state: { lastError: 'exit 1' } }))).toEqual({ text: 'exit 1', next: null });
    expect(routineError(routine('ok'))).toBeNull();
  });

  it('once pointed at another task, says the old failure is behind it', () => {
    const r = routine('e', {
      executor: { type: 'session', config: { target: 'mw-new', prompt: 'p' } },
      owner: { taskId: 'mw-new', title: 'Router v2', project: 'Home' },
      state: { lastStatus: 'error', lastError: 'target task mw-old is complete; the trigger will not resurrect it' },
    } as Partial<Routine>);
    expect(routineError(r)).toEqual({
      text: 'Its last run failed: the task it ran in then was complete.',
      next: 'It runs in "Router v2" from its next run.',
      past: true,
    });
    // Fixed: no longer counted as failing.
    expect(routineHealth(r)).toBe('ok');
  });

  it('a trigger those failures stopped runs again only once resumed', () => {
    const r = routine('t', {
      enabled: false,
      check: { run: 'sh c.sh' },
      executor: { type: 'session', config: { target: 'mw-new', prompt: 'p' } },
      owner: { taskId: 'mw-new', title: 'Router v2', project: 'Home' },
      state: { consecutiveErrors: 5, lastStatus: 'error', lastError: 'target task mw-old is complete; the trigger will not resurrect it' },
    } as Partial<Routine>);
    expect(routineError(r)?.next).toBe('It runs in "Router v2" once you Resume it.');
    expect(routineHealth(r)).toBe('error');
  });
});

describe('keepShownOrder', () => {
  it('keeps the shown rows where they were while one is open; newcomers go after', () => {
    const shown = new Map([['project:P', ['b', 'a']]]);
    const fresh = groupRoutines([
      routine('a', { ...owned('P'), name: 'a', state: { lastStatus: 'error' } }),
      routine('b', { ...owned('P'), name: 'b' }),
      routine('c', { ...owned('P'), name: 'c' }),
    ]);
    expect(fresh[0].routines.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(keepShownOrder(fresh, shown)[0].routines.map((r) => r.id)).toEqual(['b', 'a', 'c']);
  });

  it('puts a newcomer that is failing at the top, where the header counts it', () => {
    const shown = new Map([['project:P', ['a', 'b']]]);
    const fresh = groupRoutines([
      routine('a', { ...owned('P'), name: 'a' }),
      routine('b', { ...owned('P'), name: 'b' }),
      routine('z', { ...owned('P'), name: 'z', state: { lastStatus: 'error' } }),
      routine('c', { ...owned('P'), name: 'c' }),
    ]);
    expect(keepShownOrder(fresh, shown)[0].routines.map((r) => r.id)).toEqual(['z', 'a', 'b', 'c']);
  });

  it('puts a newcomer that is not failing where a reload would, among the kept rows', () => {
    const shown = new Map([['project:P', ['a', 'c']]]);
    const fresh = groupRoutines([
      routine('a', { ...owned('P'), name: 'a' }),
      routine('b', { ...owned('P'), name: 'b' }),
      routine('c', { ...owned('P'), name: 'c' }),
    ]);
    expect(keepShownOrder(fresh, shown)[0].routines.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('tells a project named Global apart from the global group', () => {
    const groups = groupRoutines([routine('g'), routine('p', owned('Global'))]);
    expect(groups.map((g) => g.name)).toEqual(['Global', 'Global (project)']);
  });
});

describe('shortNextRun', () => {
  it('stays short from minutes to next week', () => {
    expect(shortNextRun(undefined, NOW)).toBeNull();
    expect(shortNextRun(NOW + 10 * 60_000, NOW)).toBe('next in 10 min');
    expect(shortNextRun(NOW + 5 * 3_600_000, NOW)).toMatch(/^next at \d/);
    expect(shortNextRun(NOW + 24 * 3_600_000, NOW)).toMatch(/^tomorrow at \d/);
    expect(shortNextRun(NOW + 3 * 24 * 3_600_000, NOW)).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) at \d/);
    expect(shortNextRun(NOW + 9 * 24 * 3_600_000, NOW)).toMatch(/^on [A-Z][a-z]{2} \d+$/);
    expect(shortNextRun(NOW + 24 * 3_600_000, NOW, true)).toBe('tomorrow');
  });

  it('says the clock time for a run a few hours away past midnight', () => {
    const late = new Date(2026, 10, 4, 23, 0).getTime();
    expect(shortNextRun(late + 2 * 3_600_000, late)).toMatch(/^next at 1:00\sAM$/);
  });
});

describe('runOutcome', () => {
  it('reads a refused run as not started, with the reason', () => {
    expect(runOutcome({ status: 'error', error: 'triggers.run: unknown trigger: t1' })).toEqual({ ok: false, text: 'triggers.run: unknown trigger: t1' });
    expect(runOutcome({ ok: false })).toEqual({ ok: false, text: 'It did not start.' });
    expect(runOutcome({ status: 'ok' })).toEqual({ ok: true, text: 'Started' });
    expect(runOutcome(undefined)).toEqual({ ok: true, text: 'Started' });
  });
});

// Run now answers "started" before the run delivers; how it ended is read off the
// routine once its last run (or its check) moves (2026-11-04, a review: a green
// "Started" beside a delivery that had just failed).
describe('settledRun', () => {
  it('waits while the routine has not moved since Run now', () => {
    const r = routine('a', { state: { lastRunAtMs: 1000, lastStatus: 'ok' } as Routine['state'] })
    expect(settledRun(runStamp(r), r)).toBeNull()
  })
  it('says a run that failed failed, pointing at the error above', () => {
    const before = runStamp(routine('a', { state: { lastRunAtMs: 1000, lastStatus: 'ok' } as Routine['state'] }))
    const after = routine('a', { state: { lastRunAtMs: 2000, lastStatus: 'error', lastError: 'boom' } as Routine['state'] })
    expect(settledRun(before, after)).toEqual({ ok: false, text: 'It ran and failed: the reason is above.' })
  })
  it('says a run that went through ran', () => {
    const before = runStamp(routine('a', { state: {} as Routine['state'] }))
    const after = routine('a', { state: { lastRunAtMs: 2000, lastStatus: 'ok' } as Routine['state'] })
    expect(settledRun(before, after)).toEqual({ ok: true, text: 'Ran just now' })
  })
  it("reads a trigger's check, not its last delivery", () => {
    const check = { run: 'sh c.sh' } as Routine['check']
    const before = runStamp(routine('t', { check, state: { lastCheck: { atMs: 1, outcome: 'quiet' } } as Routine['state'] }))
    const failed = routine('t', { check, state: { lastStatus: 'ok', lastCheck: { atMs: 2, outcome: 'error', error: 'exit 2' } } as Routine['state'] })
    expect(settledRun(before, failed)?.ok).toBe(false)
    const quiet = routine('t', { check, state: { lastCheck: { atMs: 3, outcome: 'quiet' } } as Routine['state'] })
    expect(settledRun(before, quiet)).toEqual({ ok: true, text: 'Checked just now' })
  })
})

describe('nameTaskIn', () => {
  it("names the routine's task by its title wherever its id appears", () => {
    const r = routine('a', { owner: { taskId: 'mw1-abc', title: 'Home Ops watcher', project: 'Home Ops' } } as Partial<Routine>)
    expect(nameTaskIn('delivery failed: target task mw1-abc is complete', r)).toBe('delivery failed: target task "Home Ops watcher" is complete')
  })
  it('leaves a line alone when the routine has no task', () => {
    expect(nameTaskIn('target task mw1-abc is complete', routine('a'))).toBe('target task mw1-abc is complete')
  })
})

describe('changedSince', () => {
  const base = (over: Partial<Routine> = {}): Routine => ({
    id: 'r1', name: 'Digest', description: 'd', enabled: true,
    schedule: { kind: 'every', everyMs: 3_600_000 },
    executor: { type: 'session', config: { target: 't1', prompt: 'p' } },
    state: {}, ...over,
  } as unknown as Routine);

  it('names only what the form sends: a pause or a run is no conflict', () => {
    expect(changedSince(base(), base({ enabled: false, state: { lastRunAtMs: 5 } } as Partial<Routine>))).toEqual([])
    expect(changedSince(base(), base({ name: 'Other' }))).toEqual(['name'])
    expect(changedSince(base(), base({ executor: { type: 'session', config: { target: 't1', prompt: 'q' } } } as Partial<Routine>))).toEqual(['what it runs'])
    expect(changedSince(base(), base({ schedule: { kind: 'every', everyMs: 60_000 } } as Partial<Routine>))).toEqual(['when it runs'])
  })

  it('editKey changes with the saved routine, not with its runs', () => {
    expect(editKey(base())).toBe(editKey(base({ state: { lastRunAtMs: 9 } } as Partial<Routine>)))
    expect(editKey(base())).not.toBe(editKey(base({ description: 'new' })))
  })
})

describe('history lines', () => {
  const r = { id: 'r', name: 'n', enabled: true, owner: { taskId: 'mw1-abcd', title: 'Marina finished work' }, state: {} } as unknown as Routine;
  it('names the task and says what happened in plain words', () => {
    expect(historyWords('run now → not delivered: target task mw1-abcd is complete; the trigger will not resurrect it', r))
      .toBe('Run now: not delivered, its task "Marina finished work" was complete');
    expect(historyWords('run now → resumed session Home Ops watcher [76e97158]', r)).toBe('Run now: delivered to Home Ops watcher');
    expect(historyWords('quiet — the script said no', r)).toBe('Checked: nothing to do');
    expect(historyWords('fired, 2 new items → resumed session X [abcdef12]', r)).toBe('Ran with 2 new items: delivered to X');
  });
  it('says consecutive identical lines once with a count', () => {
    expect(collapseRepeats(['a', 'a', 'b', 'a'], (x) => x)).toEqual([
      { item: 'a', count: 2 }, { item: 'b', count: 1 }, { item: 'a', count: 1 },
    ]);
  });
});

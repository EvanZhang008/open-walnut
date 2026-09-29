/**
 * Which routines count as a task's armed triggers (the TRIGGER pill's source),
 * and the pill's hover text. Pure functions over the routines store's list.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Routine } from '../../web/src/api/routines';
import { isTriggerForTask, triggersForTask } from '../../web/src/hooks/useTaskTriggers';
import { triggerPillLabel, triggerPillTitle } from '../../web/src/components/routines/TriggerPill';
import { waitingBackBy } from '../../web/src/components/tasks/TaskStatusControl';

const NOW = Date.parse('2026-09-16T12:00:00Z');

function routine(over: Partial<Routine> & { id: string }): Routine {
  return {
    name: over.id,
    enabled: true,
    createdAtMs: NOW,
    updatedAtMs: NOW,
    schedule: { kind: 'every', everyMs: 30_000 },
    wakeMode: 'now',
    executor: { type: 'session', config: { target: 'task-1', prompt: 'p' } },
    check: { run: 'bash ~/.open-walnut/triggers/pr/check.sh', host: '__local__' },
    state: {},
    ...over,
  } as Routine;
}

describe('isTriggerForTask', () => {
  it('needs an enabled routine with a check whose session executor targets the task', () => {
    expect(isTriggerForTask(routine({ id: 'a' }), 'task-1')).toBe(true);
    expect(isTriggerForTask(routine({ id: 'a' }), 'task-2')).toBe(false);
    expect(isTriggerForTask(routine({ id: 'disabled', enabled: false }), 'task-1')).toBe(false);
    expect(isTriggerForTask(routine({ id: 'no-check', check: undefined }), 'task-1')).toBe(false);
    // A plain scheduled session routine on the task is not a trigger.
    expect(isTriggerForTask(routine({ id: 'other-exec', executor: { type: 'claude-code', config: { target: 'task-1' } } }), 'task-1')).toBe(false);
    expect(isTriggerForTask(routine({ id: 'no-exec', executor: undefined }), 'task-1')).toBe(false);
  });

  it('lists a task\'s triggers only, and nothing for a missing task id', () => {
    const list = [routine({ id: 'a' }), routine({ id: 'b', executor: { type: 'session', config: { target: 'task-2', prompt: 'p' } } }), routine({ id: 'c', enabled: false })];
    expect(triggersForTask(list, 'task-1').map((r) => r.id)).toEqual(['a']);
    expect(triggersForTask(list, 'task-2').map((r) => r.id)).toEqual(['b']);
    expect(triggersForTask(list, undefined)).toEqual([]);
    expect(triggersForTask(list, null)).toEqual([]);
  });
});

describe('triggerPillTitle', () => {
  it('names each trigger with its cadence, command, host, fire tally and last check', () => {
    const title = triggerPillTitle([
      routine({
        id: 'a',
        name: 'PR comments',
        state: {
          fireCount: 2,
          fireLog: [{ atMs: NOW - 600_000, outcome: 'fired' }],
          lastCheck: { atMs: NOW - 120_000, outcome: 'quiet', reason: 'all-seen' },
        },
      }),
      routine({ id: 'b', name: 'CI red', schedule: { kind: 'every', everyMs: 300_000 }, check: { run: 'gh run list', host: 'devbox' } }),
    ], NOW);
    expect(title.split('\n')).toEqual([
      'PR comments: Every 30s, $ bash ~/.open-walnut/triggers/pr/check.sh @ local, fired 2×, last 10m ago, last check quiet, 2m ago',
      // Never fired says so on the hover text too: an armed trigger that has
      // never produced anything is the case the user cannot otherwise tell apart.
      'CI red: Every 5 min, $ gh run list @ devbox, never fired yet, last check not checked yet',
    ]);
  });

  it('puts the description the author wrote right after the name', () => {
    const title = triggerPillTitle([
      routine({ id: 'a', name: 'PR comments', description: 'Checks PR 123 for new review comments; the session replies.' }),
      routine({ id: 'b', name: 'CI red' }),
    ], NOW);
    expect(title.split('\n')).toEqual([
      'PR comments: Checks PR 123 for new review comments; the session replies. · Every 30s, $ bash ~/.open-walnut/triggers/pr/check.sh @ local, never fired yet, last check not checked yet',
      // A trigger created before descriptions were required reads as before.
      'CI red: Every 30s, $ bash ~/.open-walnut/triggers/pr/check.sh @ local, never fired yet, last check not checked yet',
    ]);
  });
});

describe('triggerPillLabel', () => {
  it('reads TRIGGER, with a count past one', () => {
    expect(triggerPillLabel(1)).toBe('TRIGGER');
    expect(triggerPillLabel(3)).toBe('TRIGGER ×3');
  });

  it('reads SNOOZED on a snoozed task, the trigger it waits on folded in', () => {
    expect(triggerPillLabel(1, 'r-wait', ['r-wait'])).toBe('SNOOZED');
    // Before the routines store has loaded: the task alone says it is snoozed.
    expect(triggerPillLabel(0, 'r-wait', [])).toBe('SNOOZED');
    expect(triggerPillLabel(2, 'r-wait', ['r-wait', 'r-pr'])).toBe('SNOOZED · TRIGGER');
    expect(triggerPillLabel(3, 'r-wait', ['r-pr', 'r-wait', 'r-ci'])).toBe('SNOOZED · TRIGGER ×2');
  });
});

describe('waitingBackBy', () => {
  afterEach(() => { vi.useRealTimers(); });

  // The default backstop is exactly a week out: a weekday alone would read as today.
  it('a week out reads M/D, not today\'s weekday; nearer days keep the day words', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 29, 10, 0));
    const at = (d: Date) => waitingBackBy({ waiting: { until: d.toISOString() } } as never);
    expect(at(new Date(2026, 9, 6, 10, 54))).toBe('10/6 10:54');
    expect(at(new Date(2026, 8, 30, 9, 5))).toBe('Tomorrow 9:05');
    expect(at(new Date(2026, 9, 2, 18, 0))).toBe('Fri 18:00');
    expect(waitingBackBy({ waiting: { condition: 'x' } } as never)).toBe('');
  });
});

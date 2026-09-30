/**
 * Which routines count as a task's triggers (the TRIGGER pill's source), how a
 * paused or stopped one reads, and the pill's hover text. Pure functions over
 * the routines store's list.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Routine } from '../../web/src/api/routines';
import { isTriggerForTask, triggersForTask } from '../../web/src/hooks/useTaskTriggers';
import { triggerPillLabel, triggerPillTitle, visibleTaskTriggers } from '../../web/src/components/routines/TriggerPill';
import { waitingBackBy } from '../../web/src/components/tasks/TaskStatusControl';
import { describeTriggerOff, triggerRunState } from '../../web/src/utils/routine-format';
import { TRIGGER_STOP_AFTER_ERRORS } from '../../src/core/cron/trigger-run-state';
import { MAX_CONSECUTIVE_CHECK_ERRORS } from '../../src/providers/trigger-check-core';

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
  it('needs a routine with a check whose session executor targets the task', () => {
    expect(isTriggerForTask(routine({ id: 'a' }), 'task-1')).toBe(true);
    expect(isTriggerForTask(routine({ id: 'a' }), 'task-2')).toBe(false);
    // A paused trigger stays on its task: switching it off is not a delete.
    expect(isTriggerForTask(routine({ id: 'paused', enabled: false, state: { pausedAtMs: NOW } }), 'task-1')).toBe(true);
    expect(isTriggerForTask(routine({ id: 'no-check', check: undefined }), 'task-1')).toBe(false);
    // A plain scheduled session routine on the task is not a trigger.
    expect(isTriggerForTask(routine({ id: 'other-exec', executor: { type: 'claude-code', config: { target: 'task-1' } } }), 'task-1')).toBe(false);
    expect(isTriggerForTask(routine({ id: 'no-exec', executor: undefined }), 'task-1')).toBe(false);
  });

  it('lists a task\'s triggers only, and nothing for a missing task id', () => {
    const list = [routine({ id: 'a' }), routine({ id: 'b', executor: { type: 'session', config: { target: 'task-2', prompt: 'p' } } }), routine({ id: 'c', enabled: false })];
    expect(triggersForTask(list, 'task-1').map((r) => r.id)).toEqual(['a', 'c']);
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

  it('marks a paused or stopped trigger right after its name', () => {
    const title = triggerPillTitle([
      routine({ id: 'a', name: 'PR comments', enabled: false, state: { pausedAtMs: NOW - 7_200_000 } }),
      routine({ id: 'b', name: 'CI red', enabled: false, state: { consecutiveErrors: MAX_CONSECUTIVE_CHECK_ERRORS } }),
    ], NOW);
    expect(title.split('\n')).toEqual([
      'PR comments (paused 2h ago): Every 30s, $ bash ~/.open-walnut/triggers/pr/check.sh @ local, never fired yet, last check not checked yet',
      'CI red (stopped after 5 failed checks): Every 30s, $ bash ~/.open-walnut/triggers/pr/check.sh @ local, never fired yet, last check not checked yet',
    ]);
  });
});

const on = (id: string) => ({ id, enabled: true, state: {} });
const paused = (id: string) => ({ id, enabled: false, state: { pausedAtMs: NOW - 3_600_000 } });
const stopped = (id: string) => ({ id, enabled: false, state: { consecutiveErrors: MAX_CONSECUTIVE_CHECK_ERRORS } });

describe('triggerPillLabel', () => {
  it('reads TRIGGER, with a count past one', () => {
    expect(triggerPillLabel([on('a')])).toBe('TRIGGER');
    expect(triggerPillLabel([on('a'), on('b'), on('c')])).toBe('TRIGGER ×3');
  });

  it('says PAUSED or STOPPED instead of going away, and counts the off ones beside armed ones', () => {
    expect(triggerPillLabel([paused('a')])).toBe('TRIGGER · PAUSED');
    expect(triggerPillLabel([paused('a'), paused('b')])).toBe('TRIGGER ×2 · PAUSED');
    expect(triggerPillLabel([stopped('a')])).toBe('TRIGGER · STOPPED');
    expect(triggerPillLabel([paused('a'), stopped('b')])).toBe('TRIGGER ×2 · OFF');
    expect(triggerPillLabel([on('a'), paused('b'), on('c')])).toBe('TRIGGER ×3 · 1 PAUSED');
    expect(triggerPillLabel([on('a'), stopped('b')])).toBe('TRIGGER ×2 · 1 STOPPED');
  });

  it('reads SNOOZED on a snoozed task, the trigger it waits on folded in', () => {
    expect(triggerPillLabel([on('r-wait')], 'r-wait')).toBe('SNOOZED');
    // Before the routines store has loaded: the task alone says it is snoozed.
    expect(triggerPillLabel([], 'r-wait')).toBe('SNOOZED');
    expect(triggerPillLabel([on('r-wait'), on('r-pr')], 'r-wait')).toBe('SNOOZED · TRIGGER');
    expect(triggerPillLabel([on('r-pr'), on('r-wait'), on('r-ci')], 'r-wait')).toBe('SNOOZED · TRIGGER ×2');
    // Its own trigger paused: the snooze can no longer end by itself (only its backstop).
    expect(triggerPillLabel([paused('r-wait')], 'r-wait')).toBe('SNOOZED · PAUSED');
    expect(triggerPillLabel([on('r-wait'), paused('r-pr')], 'r-wait')).toBe('SNOOZED · TRIGGER · PAUSED');
  });
});

describe('triggerRunState / describeTriggerOff', () => {
  it('mirrors the server\'s stop limit (the web cannot import trigger-check-core)', () => {
    expect(TRIGGER_STOP_AFTER_ERRORS).toBe(MAX_CONSECUTIVE_CHECK_ERRORS);
  });

  it('tells a pause from a stop, and a legacy switched-off trigger reads as paused', () => {
    expect(triggerRunState(on('a'))).toBe('armed');
    expect(triggerRunState(paused('a'))).toBe('paused');
    expect(triggerRunState(stopped('a'))).toBe('stopped');
    // A pause wins over the error count: a late failing check never turns it into a stop.
    expect(triggerRunState({ enabled: false, state: { pausedAtMs: NOW, consecutiveErrors: 9 } })).toBe('paused');
    expect(triggerRunState({ enabled: false, state: {} })).toBe('paused');
    expect(triggerRunState({ enabled: false, state: { consecutiveErrors: MAX_CONSECUTIVE_CHECK_ERRORS - 1 } })).toBe('paused');
    // The trigger behind an ended snooze wait is its own case, not a pause.
    expect(triggerRunState({ enabled: false, state: { waitEndedAtMs: NOW } })).toBe('wait-ended');
    expect(triggerRunState({ enabled: true, state: { waitEndedAtMs: NOW } })).toBe('armed');
  });

  it('says how long ago it was paused, or why it stopped; nothing while it polls', () => {
    expect(describeTriggerOff(on('a'), NOW)).toBeNull();
    expect(describeTriggerOff(paused('a'), NOW)).toBe('Paused 1h ago');
    expect(describeTriggerOff({ enabled: false, state: {} }, NOW)).toBe('Paused');
    expect(describeTriggerOff(stopped('a'), NOW)).toBe(`Stopped after ${MAX_CONSECUTIVE_CHECK_ERRORS} failed checks`);
    expect(describeTriggerOff({ enabled: false, state: { waitEndedAtMs: NOW - 120_000 } }, NOW)).toBe('Wait ended 2m ago');
  });
});

describe('visibleTaskTriggers', () => {
  const wait = routine({ id: 'r-wait', enabled: false, state: { pausedAtMs: NOW } });
  const other = routine({ id: 'r-pr', enabled: false, state: { pausedAtMs: NOW } });
  const task = (waiting: Record<string, unknown> | undefined) => ({ id: 'task-1', waiting } as never);

  it('hides the switched-off routine behind an ENDED snooze wait, and only that one', () => {
    const ended = task({ condition: 'CR approved', routine_id: 'r-wait', since: '2026-09-16T10:00:00Z', woke_at: '2026-09-16T11:00:00Z', woke_reason: 'fired' });
    expect(visibleTaskTriggers([wait, other], ended, 'task-1').map((r) => r.id)).toEqual(['r-pr']);
    // Still waiting: its trigger, paused or not, is the snooze's own and shows.
    const waitingNow = task({ condition: 'CR approved', routine_id: 'r-wait', since: '2026-09-16T10:00:00Z' });
    expect(visibleTaskTriggers([wait, other], waitingNow, 'task-1').map((r) => r.id)).toEqual(['r-wait', 'r-pr']);
    // No wait: everything shows.
    expect(visibleTaskTriggers([wait, other], task(undefined), 'task-1')).toHaveLength(2);
    // Re-armed after the wait ended (enabled again): it is a live trigger again.
    expect(visibleTaskTriggers([{ ...wait, enabled: true }, other], ended, 'task-1')).toHaveLength(2);
  });

  it('hides a trigger stamped wait-ended even when the task no longer names it', () => {
    const settled = routine({ id: 'r-old-wait', enabled: false, state: { waitEndedAtMs: NOW } });
    expect(visibleTaskTriggers([settled, other], task(undefined), 'task-1').map((r) => r.id)).toEqual(['r-pr']);
  });

  it('shows only armed triggers until the task is known, so nothing flashes as Paused', () => {
    const armed = routine({ id: 'r-on' });
    expect(visibleTaskTriggers([armed, wait, other], null, 'task-1').map((r) => r.id)).toEqual(['r-on']);
    expect(visibleTaskTriggers([armed, wait, other], undefined, 'task-1').map((r) => r.id)).toEqual(['r-on']);
    // A task object for another id is not this task.
    expect(visibleTaskTriggers([armed, other], task(undefined), 'task-2').map((r) => r.id)).toEqual(['r-on']);
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

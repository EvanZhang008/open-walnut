/**
 * Which routines count as a task's triggers (the TRIGGER pill's source), how a
 * paused or stopped one reads, and the pill's hover text. Pure functions over
 * the routines store's list.
 */
import { describe, it, expect } from 'vitest';
import type { Routine } from '../../web/src/api/routines';
import { isTriggerForTask, triggersForTask } from '../../web/src/hooks/useTaskTriggers';
import { triggerPillLabel, triggerPillTitle } from '../../web/src/components/routines/TriggerPill';
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
  it('is the word TRIGGER alone: no count, no PAUSED or STOPPED (the look and the hover text carry them)', () => {
    expect(triggerPillLabel([on('a')])).toBe('TRIGGER');
    expect(triggerPillLabel([on('a'), on('b'), on('c')])).toBe('TRIGGER');
    expect(triggerPillLabel([paused('a')])).toBe('TRIGGER');
    expect(triggerPillLabel([paused('a'), paused('b')])).toBe('TRIGGER');
    expect(triggerPillLabel([stopped('a')])).toBe('TRIGGER');
    expect(triggerPillLabel([on('a'), paused('b'), stopped('c')])).toBe('TRIGGER');
  });

  it('is empty with no trigger (the pill does not render then)', () => {
    expect(triggerPillLabel([])).toBe('');
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
  });

  it('says how long ago it was paused, or why it stopped; nothing while it polls', () => {
    expect(describeTriggerOff(on('a'), NOW)).toBeNull();
    expect(describeTriggerOff(paused('a'), NOW)).toBe('Paused 1h ago');
    expect(describeTriggerOff({ enabled: false, state: {} }, NOW)).toBe('Paused');
    expect(describeTriggerOff(stopped('a'), NOW)).toBe(`Stopped after ${MAX_CONSECUTIVE_CHECK_ERRORS} failed checks`);
  });
});

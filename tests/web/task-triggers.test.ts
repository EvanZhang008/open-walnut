/**
 * Which routines count as a task's armed triggers (the TRIGGER pill's source),
 * and the pill's hover text. Pure functions over the routines store's list.
 */
import { describe, it, expect } from 'vitest';
import type { Routine } from '../../web/src/api/routines';
import { isTriggerForTask, triggersForTask } from '../../web/src/hooks/useTaskTriggers';
import { triggerPillTitle } from '../../web/src/components/routines/TriggerPill';

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
  it('names each trigger with its cadence, command, host and last check', () => {
    const title = triggerPillTitle([
      routine({ id: 'a', name: 'PR comments', state: { lastCheck: { atMs: NOW - 120_000, outcome: 'quiet', reason: 'all-seen' } } }),
      routine({ id: 'b', name: 'CI red', schedule: { kind: 'every', everyMs: 300_000 }, check: { run: 'gh run list', host: 'devbox' } }),
    ], NOW);
    expect(title.split('\n')).toEqual([
      'PR comments: Every 30s, $ bash ~/.open-walnut/triggers/pr/check.sh @ local, last check quiet, 2m ago',
      'CI red: Every 5 min, $ gh run list @ devbox, last check not checked yet',
    ]);
  });
});

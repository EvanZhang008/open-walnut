/**
 * The parent and child dots on the task page (web/src/pages/task-family-dot.ts): the task's one
 * user status (from the reference, else the store's row), the phase only when neither has one.
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '@open-walnut/core';
import { familyDotColor } from '../../web/src/pages/task-family-dot';

const SNOOZED = { state: 'waiting', kind: 'time', waitingOn: 'Snoozed until 2026-11-13', snoozed: { until: '2026-11-13' } } as Task['user_status'];
const RED = 'var(--error)';
const BLUE = '#007aff';
const GREY = 'var(--text-secondary)';

describe('familyDotColor', () => {
  it('falls back to the phase with no user status anywhere', () => {
    expect(familyDotColor({ phase: 'NEED_ACTION', status: 'todo' })).toBe(RED);
    expect(familyDotColor({ phase: 'IN_PROGRESS', status: 'todo' })).toBe(BLUE);
    expect(familyDotColor({ phase: 'TODO', status: 'todo' })).toBe(GREY);
    expect(familyDotColor({ phase: 'COMPLETE', status: 'done' })).toBe('#34c759');
  });

  it('a snoozed NEED_ACTION task is not red, from the reference or from the store row', () => {
    expect(familyDotColor({ phase: 'NEED_ACTION', status: 'todo', user_status: SNOOZED })).toBe(GREY);
    expect(familyDotColor({ phase: 'NEED_ACTION', status: 'todo' }, { user_status: SNOOZED })).toBe(GREY);
  });

  it('the user status wins over the phase both ways', () => {
    const needs = { state: 'needs', source: 'letter', ask: 'Pick a date' } as Task['user_status'];
    expect(familyDotColor({ phase: 'WAITING', status: 'todo' }, { user_status: needs })).toBe(RED);
    // An IN_PROGRESS task with nothing running reads Waiting, not blue.
    expect(familyDotColor({ phase: 'IN_PROGRESS', status: 'todo' }, { user_status: { state: 'waiting', kind: 'stuck' } as Task['user_status'] })).toBe(GREY);
  });
});

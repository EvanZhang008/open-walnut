/**
 * The AI search result rows' red "needs you" tint (web/src/components/tasks/AgentSearchResultRows.tsx):
 * the task's one user status when the store has its row, the phase only without one.
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '@open-walnut/core';
import { rowNeedsYou } from '../../web/src/components/tasks/AgentSearchResultRows';

const SNOOZED = { state: 'waiting', kind: 'time', waitingOn: 'Snoozed until 2026-11-13', snoozed: { until: '2026-11-13' } } as Task['user_status'];

describe('rowNeedsYou', () => {
  it('a snoozed NEED_ACTION task is not tinted', () => {
    expect(rowNeedsYou({ phase: 'NEED_ACTION', user_status: SNOOZED })).toBe(false);
  });

  it('with no user status the phase decides', () => {
    expect(rowNeedsYou({ phase: 'NEED_ACTION' })).toBe(true);
    expect(rowNeedsYou({ phase: 'IN_PROGRESS' })).toBe(false);
    expect(rowNeedsYou({})).toBe(false);
  });

  it('a status that needs the user tints whatever the phase, and a completed task never does', () => {
    expect(rowNeedsYou({ phase: 'WAITING', user_status: { state: 'needs', source: 'letter', ask: 'Pick a date' } as Task['user_status'] })).toBe(true);
    expect(rowNeedsYou({ phase: 'COMPLETE', user_status: { state: 'needs' } as Task['user_status'] })).toBe(false);
  });
});

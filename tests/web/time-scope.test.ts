/**
 * The Overview's scope arithmetic. Three rules are pinned here because each one is a
 * way the page could quietly lie: a week scope must not invent days the summary never
 * spoke for, a per-day average must divide by CALENDAR days (an average that skips
 * your days off is a number nobody sustained), and the trend must keep an empty day in
 * the list so the seven bars stay a calendar.
 */

import { describe, it, expect } from 'vitest';
// The Time UI lives only in the walnut-time Plugin App, so these are its own folds.
import {
  TREND_DAYS, averageLanes, dayLanes, daysInScope, scopeDates, scopeHint, scopeLabel,
} from '../../examples/plugins/walnut-time/src/web/time-scope';
import type { DayTime, TaskDayTime, TimeSummary } from '../../examples/plugins/walnut-time/src/web/api';

const MIN = 60_000;

function task(taskId: string, humanMin: number, agentMin = 0, focus = false): TaskDayTime {
  return {
    taskId,
    humanMs: humanMin * MIN,
    byKind: { session: humanMin * MIN, triage: 0, chat: 0 },
    agentMs: agentMin * MIN,
    focus,
  };
}

function day(date: string, tasks: TaskDayTime[]): DayTime {
  return {
    date,
    humanMs: tasks.reduce((sum, t) => sum + t.humanMs, 0),
    agentMs: tasks.reduce((sum, t) => sum + t.agentMs, 0),
    tasks,
  };
}

/** Ten consecutive days, work on the last three only. */
function summary(): TimeSummary {
  const days: DayTime[] = [];
  for (let i = 0; i < 10; i += 1) {
    const date = `2026-08-${String(20 + i).padStart(2, '0')}`;
    days.push(day(date, i >= 7 ? [task('t-a', 60, 30, true), task('t-b', 30)] : []));
  }
  return {
    days,
    today: '2026-08-29',
    focusTaskIds: ['t-a'],
    focusShare: 0.5,
    totalHumanMs: 0,
    totalAgentMs: 0,
  };
}

const keepAll = () => true;
const humanOf = (t: TaskDayTime) => t.humanMs;

describe('scopeDates', () => {
  it('a day scope is exactly its own day', () => {
    expect(scopeDates({ mode: 'day', date: '2026-08-29' })).toEqual(['2026-08-29']);
  });

  it('a week scope is the seven days ENDING on the selected one, ascending', () => {
    const dates = scopeDates({ mode: 'week', date: '2026-08-29' });
    expect(dates).toHaveLength(TREND_DAYS);
    expect(dates[0]).toBe('2026-08-23');
    expect(dates[dates.length - 1]).toBe('2026-08-29');
  });
});

describe('daysInScope', () => {
  it('picks the one selected day out of the window', () => {
    const days = daysInScope(summary(), { mode: 'day', date: '2026-08-28' });
    expect(days.map((d) => d.date)).toEqual(['2026-08-28']);
  });

  it('a week near the oldest fetched day answers with the days that EXIST', () => {
    // Nothing before 08-20 was fetched, so a week ending 08-22 is three days, never
    // seven with four invented empties the server never spoke for.
    const days = daysInScope(summary(), { mode: 'week', date: '2026-08-22' });
    expect(days.map((d) => d.date)).toEqual(['2026-08-20', '2026-08-21', '2026-08-22']);
  });

  it('a day outside the window is no days at all, not the nearest one', () => {
    expect(daysInScope(summary(), { mode: 'day', date: '2026-07-01' })).toEqual([]);
    expect(daysInScope(null, { mode: 'day', date: '2026-08-29' })).toEqual([]);
  });
});

describe('scope labels', () => {
  it('a week reads as a range, a day as itself', () => {
    expect(scopeLabel({ mode: 'week', date: '2026-08-29' })).toBe('Aug 23 to Aug 29');
    expect(scopeLabel({ mode: 'day', date: '2026-08-29' })).toContain('Aug 29');
  });

  it('the selected day is called "today" only when it is', () => {
    expect(scopeHint({ mode: 'day', date: '2026-08-29' }, '2026-08-29')).toBe('today');
    expect(scopeHint({ mode: 'day', date: '2026-08-28' }, '2026-08-29')).toContain('Aug 28');
    expect(scopeHint({ mode: 'week', date: '2026-08-29' }, '2026-08-29')).toBe('7 days to Aug 29');
  });
});

describe('dayLanes', () => {
  it('carries both lanes per day and keeps an empty day in the list', () => {
    const lanes = dayLanes(summary().days, keepAll, humanOf);
    expect(lanes).toHaveLength(10);
    expect(lanes[0]).toEqual({ date: '2026-08-20', humanMs: 0, agentMs: 0 });
    expect(lanes[9]).toEqual({ date: '2026-08-29', humanMs: 90 * MIN, agentMs: 30 * MIN });
  });

  it('applies the project filter to both lanes and the kind filter to the human one', () => {
    const onlyB = (taskId: string) => taskId === 't-b';
    const lanes = dayLanes(summary().days, onlyB, humanOf);
    // t-b has no agent time, so filtering to it empties the agent lane as well.
    expect(lanes[9]).toEqual({ date: '2026-08-29', humanMs: 30 * MIN, agentMs: 0 });

    const chatOnly = dayLanes(summary().days, keepAll, (t) => t.byKind.chat);
    expect(chatOnly[9]).toEqual({ date: '2026-08-29', humanMs: 0, agentMs: 30 * MIN });
  });
});

describe('averageLanes', () => {
  it('divides by calendar days, so the days off pull the average down', () => {
    const lanes = dayLanes(summary().days.slice(-TREND_DAYS), keepAll, humanOf);
    // Three worked days of 90m inside a seven-day window: 270m / 7, not 90.
    expect(averageLanes(lanes).humanMs).toBeCloseTo((3 * 90 * MIN) / 7, 6);
    expect(averageLanes(lanes).agentMs).toBeCloseTo((3 * 30 * MIN) / 7, 6);
  });

  it('an empty window averages to zero rather than dividing by zero', () => {
    expect(averageLanes([])).toEqual({ humanMs: 0, agentMs: 0 });
  });
});

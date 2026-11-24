/**
 * A task query resolved against the clock (safeNormalizeTaskQuery), for a view that filters a task
 * list with it: the Dashboard and the task views share this.
 *
 * `now` is read again when the query changes, when the task list changes, and when the minute clock
 * moves a task across a relative window's edge (timeWindowKey), never once a minute for the whole
 * view (minute-clock.ts). The task list counts: a task updated after the clock's last tick is inside
 * "the last 24 hours" only for a window that ends now, not at that tick (2026-11-24 review of task
 * 9bceb9f2: with the list left out, such a task dropped out of the view until another task crossed
 * the window's edge).
 */
import { useMemo } from 'react';
import type { Task } from '@open-walnut/core';
import type { NormalizedTaskQuery, TaskQuery } from '@open-walnut/task-query';
import { useMinuteValue } from '@/utils/minute-clock';
import { movesWithClock, safeNormalizeTaskQuery, timeWindowKey } from './task-query-state';

export function useNormalizedTaskQuery(tasks: readonly Task[], query: TaskQuery): NormalizedTaskQuery | null {
  const timeTick = useMinuteValue((now) => timeWindowKey(tasks, query.time, now), movesWithClock(query.time));
  return useMemo(
    () => safeNormalizeTaskQuery(query, new Date()),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tasks and timeTick re-read `now`
    [query, tasks, timeTick],
  );
}

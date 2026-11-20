/**
 * The rows of the tasks a thread card names (its node, its chips, its deadline), for a card that
 * must not read the whole task list: that list changes on every task write anywhere
 * (tests/web/tasks-context-readers-ratchet.test.ts). Read by the card above a chat (TopThread).
 */
import { useRef } from 'react';
import type { Task } from '@open-walnut/core';
import { useTaskListSelect } from '@/contexts/TasksContext';

const NO_IDS: readonly string[] = [];
const NO_TASKS: readonly Task[] = [];

/** Re-renders only when one of the named rows changes (the same array is kept otherwise). */
export function useNamedTasks(ids: readonly string[] | undefined): readonly Task[] {
  const want = ids ?? NO_IDS;
  const kept = useRef<readonly Task[]>(NO_TASKS);
  return useTaskListSelect(({ tasks }) => {
    const next = want.length ? tasks.filter((x) => want.includes(x.id)) : NO_TASKS;
    const prev = kept.current;
    if (prev.length === next.length && prev.every((x, j) => x === next[j])) return prev;
    kept.current = next;
    return next;
  }) ?? NO_TASKS;
}

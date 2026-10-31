/**
 * The dot beside a parent or child task on the task page: the task's one user status
 * (src/core/user-status.ts), so a snoozed task is never red. The detail route's family
 * references carry only the phase, so the store's row lends its `user_status` when it has
 * one; without either, taskUserState falls back to the phase.
 */
import type { Task } from '@open-walnut/core';
import { taskUserState } from '@/utils/session-status';

export type FamilyDotRef = Pick<Task, 'phase' | 'status'> & { user_status?: Task['user_status'] };

export function familyDotColor(ref: FamilyDotRef, live?: Pick<Task, 'user_status'> | null): string {
  if (ref.status === 'done') return '#34c759';
  const state = taskUserState({ ...ref, user_status: ref.user_status ?? live?.user_status });
  return state === 'working' ? '#007aff' : state === 'needs' ? 'var(--error)' : 'var(--text-secondary)';
}

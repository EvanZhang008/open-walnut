/**
 * Task-domain event → hook point derivation.
 *
 * Enrichment is deliberately ZERO-IO: every task: bus event already carries
 * the full Task (task:updated fires on every sync tick and session-touch —
 * a getTask() here would add a DB read to each of those).
 */

import { EventNames } from '../../event-bus.js';
import type { BusEvent } from '../../event-bus.js';
import type { Task, TaskPhase } from '../../types.js';
import type { TaskHookContext } from '../types.js';
import type { DerivedHookPoint } from './session.js';

export function deriveTaskHookPoints(event: BusEvent): DerivedHookPoint[] {
  const data = event.data as Record<string, unknown>;
  const task = data.task as Task | null | undefined;
  // Bulk mutations (task: null on task:updated) carry no single task — skip
  // entirely; they are project renames / refetch signals, not per-task hooks.
  if (!task) return [];

  switch (event.name) {
    case EventNames.TASK_CREATED:
      return [{ hookPoint: 'onTaskCreated', extraPayload: {} }];
    case EventNames.TASK_COMPLETED:
      return [{ hookPoint: 'onTaskCompleted', extraPayload: {} }];
    case EventNames.TASK_PHASE_CHANGED:
      return [{
        hookPoint: 'onTaskPhaseChanged',
        extraPayload: {
          oldPhase: data.oldPhase as TaskPhase | undefined,
          newPhase: data.newPhase as TaskPhase | undefined,
        },
      }];
    case EventNames.TASK_UPDATED:
      return [{ hookPoint: 'onTaskUpdated', extraPayload: {} }];
    default:
      return [];
  }
}

/** Build a TaskHookContext straight from the bus event — no IO. */
export function buildTaskContext(event: BusEvent, traceId: string): TaskHookContext | null {
  const data = event.data as Record<string, unknown>;
  const task = data.task as Task | null | undefined;
  if (!task) return null;
  return {
    domain: 'task',
    taskId: task.id,
    task,
    sessionId: (data.sessionId as string | undefined) ?? task.session_id ?? undefined,
    eventSource: event.source,
    timestamp: new Date().toISOString(),
    traceId,
    event: event.name,
  };
}

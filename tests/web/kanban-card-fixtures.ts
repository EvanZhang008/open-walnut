/**
 * Shared fixtures of the kanban card view model tests (tests/web/kanban-model.test.ts,
 * tests/web/kanban-model-sources.test.ts): a fixed clock, task rows and buildCardVM with
 * the triage lanes.
 */
import type { Task } from '@open-walnut/core';
import { templateLanes } from '../../src/core/boards/board-lanes';
import { buildCardVM, type KanbanCardInput, type KanbanLive } from '../../web/src/components/board/kanban/kanban-card-model';

export const NOW = Date.parse('2026-10-03T15:30:00Z');
export const ago = (ms: number) => new Date(NOW - ms).toISOString();
export const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
export const LANES = templateLanes('triage');

let seq = 0;
export function mkTask(p: Partial<Task> = {}): Task {
  seq++;
  return {
    id: p.id ?? `t${String(seq).padStart(4, '0')}-0000-4000-8000-000000000000`,
    title: `Ticket ${seq}`, status: 'in_progress', priority: 'none', category: '', session_ids: [], description: '',
    summary: '', note: '', phase: 'IN_PROGRESS', source: 'local', created_at: ago(5 * DAY), updated_at: ago(HOUR),
    phase_changed_at: ago(HOUR), ...p,
  } as Task;
}

export const withSession = (p: Partial<Task> = {}) => mkTask({ session_id: `s-${seq + 1}-full-session-id`, session_ids: [`s-${seq + 1}-full-session-id`], ...p });

export function vm(task: Task | null, live: KanbanLive | null = null, extra: Partial<KanbanCardInput> = {}) {
  return buildCardVM({
    taskId: task?.id ?? 'missing-task-id', task, lanes: LANES, live, ownerId: 'owner-task-id',
    titleOf: (id) => (id === 'owner-task-id' ? 'Payments queue triage' : `Task ${id.slice(0, 4)}`),
    hasBaseline: false, now: NOW, formatWaitUntil: () => 'Fri 9:00', ...extra,
  });
}

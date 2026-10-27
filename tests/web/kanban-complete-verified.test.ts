/**
 * A completed task is verified (2026-10-27, the user: "If the task is closed, mostly close by me
 * means I already verified"): its kanban card never reads as needing the user, whatever it still
 * carries (an unanswered choice, a live prompt, the last open user_status), and it rolls up no
 * need to its parent.
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '@open-walnut/core';
import { templateLanes } from '../../src/core/boards/board-lanes';
import { buildCardVM, type KanbanCardInput, type KanbanLive } from '../../web/src/components/board/kanban/kanban-card-model';

const NOW = Date.parse('2026-10-27T15:30:00Z');
const LANES = templateLanes('triage');

function mkTask(p: Partial<Task> = {}): Task {
  return {
    id: 'c0000000-0000-4000-8000-000000000000', title: 'Phone video', status: 'done', priority: 'none', category: '',
    session_ids: ['s-done-full-session-id'], session_id: 's-done-full-session-id', description: '', summary: '', note: '',
    phase: 'COMPLETE', source: 'local', created_at: '2026-10-20T00:00:00Z', updated_at: '2026-10-27T10:00:00Z',
    completed_at: '2026-10-27T10:00:00Z', phase_changed_at: '2026-10-27T10:00:00Z', ...p,
  } as Task;
}

function vm(task: Task, live: KanbanLive | null = null, extra: Partial<KanbanCardInput> = {}) {
  return buildCardVM({
    taskId: task.id, task, lanes: LANES, live, ownerId: 'owner-task-id', titleOf: () => 'Owner',
    hasBaseline: false, now: NOW, formatWaitUntil: () => 'Fri 9:00', ...extra,
  });
}

describe('a completed task on the kanban', () => {
  it('reads Done, never Needs you', () => {
    const stale = mkTask({ user_status: { state: 'needs', ask: 'Install TestFlight 127 and check the video' } } as Partial<Task>);
    const cases = [
      vm(stale),
      vm(stale, { process_status: 'idle', pendingPermissionTool: 'Bash' }),
      vm(stale, null, { signals: [{ kind: 'choice', id: 'c1', title: 'Looks right?', taskId: stale.id, count: 1 }] }),
      vm(stale, { process_status: 'error', errorMessage: 'boom' }),
    ];
    for (const c of cases) {
      expect(c.needsYou).toBe(false);
      expect(c.status.text).not.toMatch(/Needs you|Error/);
    }
  });
});

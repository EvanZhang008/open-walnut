/**
 * A kanban card's red line for a choice on its Board opens the Page at that choice
 * (web/src/components/board/kanban/kanban-card-model.ts, C95). 2026-11-03, CI: once the derived
 * "Decide: <title>" replaced the signal's own line, the click opened nothing. Kept apart from
 * kanban-model.test.ts, which holds the 500-line cap of tests/web/kanban-hygiene.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '@open-walnut/core';
import { templateLanes } from '../../src/core/boards/board-lanes';
import { buildCardVM, type KanbanCardInput, type KanbanLive } from '../../web/src/components/board/kanban/kanban-card-model';

const NOW = Date.parse('2026-10-03T15:30:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const HOUR = 3_600_000;

function task(p: Partial<Task> = {}): Task {
  return {
    id: 't0095-0000-4000-8000-000000000000', title: 'Ticket 95', status: 'in_progress', priority: 'none', category: '',
    session_id: 's-95-full-session-id', session_ids: ['s-95-full-session-id'], description: '', summary: '', note: '',
    phase: 'IN_PROGRESS', source: 'local', created_at: ago(5 * 24 * HOUR), updated_at: ago(HOUR), phase_changed_at: ago(HOUR), ...p,
  } as Task;
}

function vm(t: Task, live: KanbanLive | null, extra: Partial<KanbanCardInput> = {}) {
  return buildCardVM({
    taskId: t.id, task: t, lanes: templateLanes('triage'), live, ownerId: 'owner-task-id',
    titleOf: (id) => `Task ${id.slice(0, 4)}`, hasBaseline: false, now: NOW, formatWaitUntil: () => 'Fri 9:00', ...extra,
  });
}

describe('a card for a Board choice (C95)', () => {
  it('opens the Page at it, before and after the status sync names it', () => {
    const t = task({ phase: 'NEED_ACTION' });
    const signals = [{ kind: 'choice' as const, id: 'c95', title: 'Ship the retry fix', taskId: t.id, count: 1 }];
    const asked = { state: 'needs', source: 'choice', ask: 'Ship the retry fix', choice: { board: 'owner-task-id', id: 'c95' } } as Task['user_status'];
    expect(vm(t, { process_status: 'idle' }, { signals }).status.signalTarget).toEqual({ kind: 'choice', id: 'c95' });
    const derived = vm({ ...t, user_status: asked }, { process_status: 'idle' }, { signals }).status;
    expect(derived).toMatchObject({ text: 'Decide: Ship the retry fix', tone: 'red', signalTarget: { kind: 'choice', id: 'c95' } });
    // A choice this Board does not show (another team's page) is no place this click can open.
    expect(vm({ ...t, user_status: asked }, { process_status: 'idle' }).status.signalTarget).toBeUndefined();
  });
});

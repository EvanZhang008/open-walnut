/**
 * Kanban reloads of the Board pane (web/src/components/board/board-kanban-reload.ts):
 * which events reload only the kanban fields, the merge that leaves html and
 * threads alone (so the Page iframe never rebuilds, C96), newest-started wins
 * when a full read and a kanban read cross (G32, C92), and single flight with
 * coalescing (G36).
 */
import { describe, expect, it } from 'vitest';
import {
  applyFullPayload, applyKanbanFields, createKanbanReloader, isKanbanReloadEvent, mergeKanbanFields, normalizeKanbanFields,
} from '../../web/src/components/board/board-kanban-reload';
import type { BoardPayload } from '../../web/src/components/board/board-model';
import { templateLanes } from '../../src/core/boards/board-lanes';

function payload(p: Partial<BoardPayload> = {}): BoardPayload {
  return {
    board: { html: '<p>page</p>', version: 3, updated_at: '2026-10-03T09:00:00Z', updated_by: 'task:owner' },
    threads: { t1: [{ id: 'm1', author: 'user', text: 'hello', ts: '2026-10-03T09:00:00Z' }] }, marks: {}, refs: [], projects: {},
    checks: {}, choices: {}, reminders: {}, section_seen: {},
    lanes: null, lanes_effective: templateLanes('triage'), lanes_template: 'triage', cards: {}, team: [], kanban_seen: null, ...p,
  };
}

describe('events', () => {
  it('card and lanes writes, and a kanban seen write, reload the kanban fields only', () => {
    expect(isKanbanReloadEvent({ kind: 'card' })).toBe(true);
    expect(isKanbanReloadEvent({ kind: 'lanes' })).toBe(true);
    expect(isKanbanReloadEvent({ kind: 'seen', kanban: true })).toBe(true);
    expect(isKanbanReloadEvent({ kind: 'seen' })).toBe(false);
    expect(isKanbanReloadEvent({ kind: 'html' })).toBe(false);
    expect(isKanbanReloadEvent(null)).toBe(false);
  });
});

describe('normalize and merge', () => {
  it('fills what an older server left out', () => {
    const f = normalizeKanbanFields({ board_task_id: 'owner' });
    expect(f.lanes).toBeNull();
    expect(f.lanes_effective.map((l) => l.id)).toEqual(['todo', 'in-progress', 'waiting', 'review', 'done']);
    expect(f.cards).toEqual({});
    expect(f.team).toEqual([]);
    expect(f.kanban_seen).toBeNull();
    expect(f.board_task_id).toBe('owner');
  });

  it('keeps the server lanes and template as sent', () => {
    const f = normalizeKanbanFields({ lanes: null, lanes_effective: templateLanes('triage'), lanes_template: 'triage',
      cards: { a: { lane: 'new' } }, team: [{ id: 'a', phase: 'TODO' }], board_version: 3 });
    expect(f.lanes_template).toBe('triage');
    expect(f.lanes_effective[0].id).toBe('new');
    expect(f.cards).toEqual({ a: { lane: 'new' } });
    expect(f.board_version).toBe(3);
  });

  it('a kanban answer merges without touching html, threads or the board object', () => {
    const cur = payload();
    const next = mergeKanbanFields(cur, normalizeKanbanFields({ lanes_effective: templateLanes('triage'), lanes_template: 'triage',
      cards: { a: { lane: 'mitigating' } }, team: [{ id: 'a', phase: 'IN_PROGRESS' }] }));
    expect(next.board).toBe(cur.board);
    expect(next.threads).toBe(cur.threads);
    expect(next.cards).toEqual({ a: { lane: 'mitigating' } });
    expect(next.team).toHaveLength(1);
  });
});

describe('newest started wins (G32)', () => {
  it('a slow full read that started before the shown kanban read keeps the newer kanban part', () => {
    const shown = payload({ cards: { a: { lane: 'mitigating' } } });
    const slow = payload({ cards: { a: { lane: 'new' } }, board: { html: '<p>v4</p>', version: 4, updated_at: '', updated_by: 'human' } });
    const r = applyFullPayload(shown, slow, 100, 200);
    expect(r.payload.cards).toEqual({ a: { lane: 'mitigating' } });
    expect(r.payload.board?.version).toBe(4);
    expect(r.kanbanStartedAt).toBe(200);
    const fresh = applyFullPayload(shown, slow, 300, 200);
    expect(fresh.payload.cards).toEqual({ a: { lane: 'new' } });
    expect(fresh.kanbanStartedAt).toBe(300);
  });

  it('a kanban answer older than the shown one is dropped', () => {
    const shown = payload();
    expect(applyKanbanFields(shown, normalizeKanbanFields({}), 100, 200)).toBeNull();
    expect(applyKanbanFields(null, normalizeKanbanFields({}), 300, 200)).toBeNull();
    expect(applyKanbanFields(shown, normalizeKanbanFields({}), 300, 200)?.kanbanStartedAt).toBe(300);
  });
});

describe('single flight', () => {
  function harness() {
    const pending: Array<{ resolve: (v: number) => void; reject: (e: unknown) => void }> = [];
    const applied: Array<{ data: number; startedAt: number; why: string }> = [];
    const errors: string[] = [];
    let clock = 0;
    const r = createKanbanReloader<number>({
      fetch: () => new Promise<number>((resolve, reject) => pending.push({ resolve, reject })),
      apply: (data, startedAt, why) => applied.push({ data, startedAt, why }),
      onError: (_e, why) => errors.push(why),
      now: () => ++clock,
    });
    return { r, pending, applied, errors };
  }
  const tick = () => new Promise((res) => setTimeout(res, 0));

  it('one read in flight; any number of events meanwhile become exactly one more read', async () => {
    const h = harness();
    h.r.request('ws:card');
    expect(h.pending).toHaveLength(1);
    h.r.request('ws:card'); h.r.request('ws:lanes'); h.r.request('ws:seen');
    expect(h.pending).toHaveLength(1);
    expect(h.r.inFlight()).toBe(true);
    h.pending[0].resolve(1);
    await tick();
    expect(h.applied).toEqual([{ data: 1, startedAt: 1, why: 'ws:card' }]);
    expect(h.pending).toHaveLength(2);
    h.pending[1].resolve(2);
    await tick();
    expect(h.applied.map((a) => a.data)).toEqual([1, 2]);
    expect(h.pending).toHaveLength(2);
    expect(h.r.inFlight()).toBe(false);
  });

  it('a failed read still runs the queued one; dispose drops both', async () => {
    const h = harness();
    h.r.request('a'); h.r.request('b');
    h.pending[0].reject(new Error('offline'));
    await tick();
    expect(h.errors).toEqual(['a']);
    expect(h.pending).toHaveLength(2);
    h.r.dispose();
    h.pending[1].resolve(5);
    await tick();
    expect(h.applied).toEqual([]);
    h.r.request('c');
    expect(h.pending).toHaveLength(2);
  });
});

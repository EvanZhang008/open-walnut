import { describe, expect, it } from 'vitest';
import { aggregateEngineCompare, modelFamily, type CompareInput, type TaskSpend } from '../../../src/core/usage/engine-compare.js';
import type { Task } from '../../../src/core/types.js';

function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: `Task ${over.id}`, status: 'todo', phase: 'TODO', priority: 'none', project: 'Walnut', session_ids: [],
    created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z', note: '', summary: '', description: '',
    ...over,
  } as Task;
}

const done = (id: string, hours: number, over: Partial<Task> = {}) => task({
  id, session_id: `s-${id}`, phase: 'COMPLETE', completed_at: new Date(Date.parse('2026-11-02T00:00:00Z') + hours * 3600_000).toISOString(), ...over,
});

function input(tasks: Task[], spend: Record<string, Partial<TaskSpend>>, over: Partial<CompareInput> = {}): CompareInput {
  const sessions = new Map(tasks.filter((t) => t.session_id).map((t) => [t.session_id!, { startedAt: '2026-11-02T00:00:00.000Z' }]));
  return {
    tasks, sessions,
    spend: new Map(Object.entries(spend).map(([id, s]) => [id, { costUsd: 0, tokens: 0, outputTokens: 0, engine: 'claude', model: 'claude-opus-5-5', ...s }])),
    followUps: () => 0, range: {}, dayOf: (iso) => iso.slice(0, 10), ...over,
  };
}

describe('modelFamily', () => {
  it('names the company of a model id', () => {
    expect(modelFamily('claude-opus-5-5')).toBe('Claude');
    expect(modelFamily('global.anthropic.claude-sonnet-5-5')).toBe('Claude');
    expect(modelFamily('gpt-6.1-sol')).toBe('GPT');
    expect(modelFamily('openai.gpt-6-1-sol')).toBe('GPT');
    expect(modelFamily('gemini-3-pro')).toBe('Gemini');
    expect(modelFamily('qwen3-coder')).toBe('Other');
    expect(modelFamily('')).toBeNull();
  });
});

describe('aggregateEngineCompare', () => {
  it('groups finished work by engine and model family with medians and rework', () => {
    const tasks = [
      done('a', 2), done('b', 4), done('c', 9, { reopens: 1 }),
      done('x', 1, { engine_pick: { key: 'codex', engine: 'codex', at: '2026-11-02T00:00:00Z' } }),
      task({ id: 'y', session_id: 's-y', phase: 'IN_PROGRESS', engine_pick: { key: 'codex', engine: 'codex', at: '2026-11-02T00:00:00Z' } }),
      // Claude Code running a GPT model is its own row.
      done('g', 3),
      // Two reviewer subtasks of "a", one of "x": counted as reviews, not as rows.
      task({ id: 'r1', parent_task_id: 'a', title: 'Review round 1', session_id: 's-r1', phase: 'COMPLETE', completed_at: '2026-11-02T01:00:00Z' }),
      task({ id: 'r2', parent_task_id: 'a', title: 'UI reviewer', session_id: 's-r2', phase: 'COMPLETE', completed_at: '2026-11-02T01:00:00Z' }),
      task({ id: 'r3', parent_task_id: 'x', title: 'Code review', session_id: 's-r3' }),
    ];
    const out = aggregateEngineCompare(input(tasks, {
      a: { costUsd: 10, tokens: 100 }, b: { costUsd: 20, tokens: 200 }, c: { costUsd: 60, tokens: 600 },
      x: { costUsd: 5, tokens: 50, engine: 'codex', model: 'gpt-6.1-sol' }, y: { costUsd: 1, tokens: 10, engine: 'codex', model: 'gpt-6.1-sol' },
      g: { costUsd: 7, tokens: 70, engine: 'claude', model: 'gpt-6.1-sol' },
    }, { followUps: (id) => (id === 'b' ? 3 : 0) }));
    const row = (key: string) => out.rows.find((r) => r.key === key)!;
    expect(out.rows.map((r) => r.key)).toEqual(['claude|Claude', 'codex|GPT', 'claude|GPT']);
    expect(row('claude|Claude')).toMatchObject({ label: 'Claude Code · Claude', done: 3, open: 0, medianHours: 4, costUsd: 90, medianCostUsd: 20,
      reviewsPerTask: 2 / 3, followUpsPerTask: 1, reopens: 1, split: 0 });
    expect(row('codex|GPT')).toMatchObject({ label: 'Codex · GPT', done: 1, open: 1, split: 2, medianHours: 1, costUsd: 6, reviewsPerTask: 1 });
    expect(row('claude|GPT')).toMatchObject({ label: 'Claude Code · GPT', done: 1 });
    expect(out.tasks.map((t) => t.taskId)).not.toContain('r1');
  });

  it('leaves out org nodes, asks, routine runs, plugin tasks and tasks with no session', () => {
    const tasks = [
      done('ok', 1), done('lead', 1, { org_role: 'lead' }), done('ask', 1, { project: 'Ask Walnut' }),
      done('routine', 1, { routine_start: {} as Task['routine_start'] }), done('plugin', 1, { plugin_only: '@test-run' }),
      task({ id: 'nosession', phase: 'COMPLETE', completed_at: '2026-11-02T01:00:00Z' }),
    ];
    const out = aggregateEngineCompare(input(tasks, {}));
    expect(out.tasks.map((t) => t.taskId)).toEqual(['ok']);
  });

  it('counts a finished task by the day it finished and an open one by the day it started, and filters by project', () => {
    const tasks = [done('in', 1), done('late', 200), done('other', 1, { project: 'Notes' })];
    const out = aggregateEngineCompare(input(tasks, {}, { range: { start: '2026-11-02', end: '2026-11-03' } }));
    expect(out.tasks.map((t) => t.taskId).sort()).toEqual(['in', 'other']);
    expect(out.projects).toEqual([{ project: 'Walnut', tasks: 1 }, { project: 'Notes', tasks: 1 }]);
    const walnut = aggregateEngineCompare(input(tasks, {}, { project: 'Walnut', range: { start: '2026-11-02', end: '2026-11-03' } }));
    expect(walnut.tasks.map((t) => t.taskId)).toEqual(['in']);
  });

  it('falls back to the session record when a task has no recorded spend, and flags errors', () => {
    const tasks = [done('e', 1)];
    const inp = input(tasks, {});
    (inp.sessions as Map<string, object>).set('s-e', { startedAt: '2026-11-02T00:00:00.000Z', engine: 'codex', acpModel: 'gpt-6.1-sol', status_history: [{ process_status: 'error' }] });
    const out = aggregateEngineCompare(inp);
    expect(out.rows[0]).toMatchObject({ key: 'codex|GPT', errored: 1, costUsd: 0 });
  });

  it('reads a stored row whose session is only in the older exec slot or the session list', () => {
    const tasks = [done('slot', 1, { session_id: undefined, exec_session_id: 's-slot' }), done('list', 2, { session_id: undefined, session_ids: ['s-old', 's-list'] })];
    const inp = input(tasks, {});
    (inp.sessions as Map<string, object>).set('s-slot', { startedAt: '2026-11-02T00:00:00.000Z' });
    (inp.sessions as Map<string, object>).set('s-list', { startedAt: '2026-11-02T00:00:00.000Z' });
    expect(aggregateEngineCompare(inp).rows[0]).toMatchObject({ done: 2, medianHours: 1.5 });
  });

  it('reports the split as configured', () => {
    expect(aggregateEngineCompare(input([], {})).split).toEqual({ on: false, entries: [] });
    const on = aggregateEngineCompare(input([], {}, { config: { defaults: { engine_split: ['claude', { engine: 'codex', weight: 2 }] } } }));
    expect(on.split).toEqual({ on: true, entries: [{ key: 'claude', label: 'Claude Code', weight: 1 }, { key: 'codex', label: 'Codex', weight: 2 }] });
  });
});

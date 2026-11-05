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
    spend: new Map(Object.entries(spend).map(([id, s]) => [id, { costUsd: 0, tokens: 0, outputTokens: 0, unpriced: 0, unknown: 0, engine: 'claude', model: 'claude-opus-5-5', ...s }])),
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

  it('times work from its first session to its first completion, and rates reopens and errors', () => {
    const tasks = [
      // Restarted: the latest session started 5 h in; the first one counts.
      done('restarted', 8, { session_ids: ['s-first', 's-restarted'] }),
      // Reopened: finished first at 2 h, again at 30 h.
      done('reopened', 30, { reopens: 1, first_completed_at: '2026-11-02T02:00:00.000Z' }),
      done('clean', 4), done('c2', 4), done('c3', 4),
    ];
    const inp = input(tasks, {});
    const sessions = inp.sessions as Map<string, { startedAt: string }>;
    sessions.set('s-restarted', { startedAt: '2026-11-02T05:00:00.000Z' });
    sessions.set('s-first', { startedAt: '2026-11-02T00:00:00.000Z' });
    const out = aggregateEngineCompare(inp);
    expect(out.tasks.find((t) => t.taskId === 'restarted')?.hours).toBe(8);
    expect(out.tasks.find((t) => t.taskId === 'reopened')?.hours).toBe(2);
    expect(out.rows[0]).toMatchObject({ done: 5, reopenedShare: 0.2, erroredShare: 0 });
  });

  it('knows reviewer subtasks by their title only, and adds their cost per task', () => {
    const tasks = [
      done('p', 1), task({ id: 'fix', parent_task_id: 'p', title: 'Fix review comments', session_id: 's-fix' }),
      task({ id: 'rv', parent_task_id: 'p', title: '[UI] Review: settings row', session_id: 's-rv' }),
    ];
    const out = aggregateEngineCompare(input(tasks, { rv: { costUsd: 4 } }));
    expect(out.tasks.map((t) => t.taskId).sort()).toEqual(['fix', 'p']);
    expect(out.tasks.find((t) => t.taskId === 'p')).toMatchObject({ reviews: 1, reviewCostUsd: 4 });
  });

  it('counts an error in any session the task held, and marks a cost that leaves out unpriced requests', () => {
    const tasks = [done('sw', 1, { session_ids: ['s-failed', 's-sw'] })];
    const inp = input(tasks, { sw: { costUsd: 3, unpriced: 2 } });
    (inp.sessions as Map<string, object>).set('s-failed', { startedAt: '2026-11-01T20:00:00.000Z', process_status: 'error' });
    const out = aggregateEngineCompare(inp);
    expect(out.tasks[0]).toMatchObject({ errored: true, partialCost: true, hours: 5 });
    expect(out.rows[0]).toMatchObject({ errored: 1, partialCost: 1 });
  });

  it('counts only the tasks the split assigned when asked, and gives no time to a task with no known start', () => {
    const tasks = [done('picked', 2, { engine_pick: { key: 'claude', engine: 'claude', at: '2026-11-02T00:00:00.000Z' } }), done('byhand', 3),
      done('old', 4, { session_id: 's-gone' })];
    const inp = input(tasks, {});
    (inp.sessions as Map<string, object>).delete('s-gone');
    const all = aggregateEngineCompare(inp);
    expect(all.taskCount).toBe(3);
    expect(all.tasks.find((t) => t.taskId === 'old')?.hours).toBeNull();
    const fair = aggregateEngineCompare({ ...inp, splitOnly: true });
    expect(fair).toMatchObject({ splitOnly: true, taskCount: 1 });
    expect(fair.tasks.map((t) => t.taskId)).toEqual(['picked']);
  });

  it('marks a review cost that leaves out unpriced reviewer requests, and remembers an error past the last ten moves', () => {
    const tasks = [done('p2', 1), task({ id: 'rv2', parent_task_id: 'p2', title: 'Review the fix', session_id: 's-rv2' })];
    const inp = input(tasks, { p2: { costUsd: 2 }, rv2: { costUsd: 0, tokens: 1e6, unpriced: 10 } });
    (inp.sessions as Map<string, object>).set('s-p2', { startedAt: '2026-11-02T00:00:00.000Z', errorCount: 1, status_history: [{ process_status: 'idle' }] });
    const out = aggregateEngineCompare(inp);
    expect(out.tasks[0]).toMatchObject({ reviewPartialCost: true, partialCost: false, errored: true });
    expect(out.rows[0]).toMatchObject({ reviewPartialCost: 1, partialCost: 0, errored: 1 });
  });

  it('gives an engine its usual model family when nothing names one', () => {
    const inp = input([done('cx', 1)], {});
    (inp.sessions as Map<string, object>).set('s-cx', { startedAt: '2026-11-02T00:00:00.000Z', engine: 'codex' });
    expect(aggregateEngineCompare(inp).rows[0].key).toBe('codex|GPT');
  });

  it("'auto' counts the split's own tasks only while it is on and assigned enough, and lists projects of what it counts", () => {
    const pick = { key: 'claude', engine: 'claude' as const, at: '2026-11-02T00:00:00.000Z' };
    const tasks = [
      ...Array.from({ length: 10 }, (_, i) => done(`p${i}`, 1, { engine_pick: pick })),
      done('hand1', 1, { project: 'Idea' }), done('hand2', 1, { project: 'Idea' }),
    ];
    const on = { config: { defaults: { engine_split: ['claude', 'codex'] } } };
    const auto = aggregateEngineCompare(input(tasks, {}, { ...on, splitOnly: 'auto' }));
    expect(auto).toMatchObject({ splitOnly: true, taskCount: 10, splitTasks: 10 });
    // The project list counts what the rows count: no "Idea (2)" that would show nothing.
    expect(auto.projects).toEqual([{ project: 'Walnut', tasks: 10 }]);
    // Turned off: 'auto' counts every task, while asking for the split's own still works.
    expect(aggregateEngineCompare(input(tasks, {}, { splitOnly: 'auto' }))).toMatchObject({ splitOnly: false, taskCount: 12, splitTasks: 10 });
    expect(aggregateEngineCompare(input(tasks, {}, { splitOnly: true }))).toMatchObject({ splitOnly: true, taskCount: 10 });
    // Too few assigned yet: every task.
    expect(aggregateEngineCompare(input(tasks.slice(5), {}, { ...on, splitOnly: 'auto' }))).toMatchObject({ splitOnly: false, taskCount: 7, splitTasks: 5 });
  });

  it('a top-level task titled "Review ..." is work of its own, not a reviewer', () => {
    const out = aggregateEngineCompare(input([done('own', 1, { title: 'Review the onboarding flow end to end' })], {}));
    expect(out.tasks.map((t) => t.taskId)).toEqual(['own']);
  });

  it('a task with no usage recorded has an unknown cost and tokens, never a zero that wins', () => {
    const tasks = [done('pi', 1), task({ id: 'rvpi', parent_task_id: 'pi', title: 'Review the change', session_id: 's-rvpi' })];
    const out = aggregateEngineCompare(input(tasks, {}));
    expect(out.tasks[0]).toMatchObject({ noUsage: true, partialCost: true, reviewPartialCost: true });
    expect(out.rows[0]).toMatchObject({ noUsage: 1, partialCost: 1, reviewPartialCost: 1 });
  });

  it("counting only the split's tasks keeps a rescued task in the column it was assigned, and counts the move", () => {
    const pick = { key: 'codex', engine: 'codex' as const, at: '2026-11-02T00:00:00.000Z' };
    const tasks = [done('rescued', 2, { engine_pick: pick }), done('stayed', 1, { engine_pick: { ...pick, key: 'claude', engine: 'claude' as const } })];
    const inp = input(tasks, { rescued: { costUsd: 9, engine: 'claude' }, stayed: { costUsd: 3 } });
    const all = aggregateEngineCompare(inp);
    // All tasks: both under Claude, where the cost went; the move counts under Codex, the column the split assigned (none here).
    expect(all.rows.map((r) => [r.key, r.done, r.switched])).toEqual([['claude|Claude', 2, 0]]);
    const fair = aggregateEngineCompare({ ...inp, splitOnly: true });
    expect(Object.fromEntries(fair.rows.map((r) => [r.key, [r.done, r.switched]]))).toEqual({ 'split:codex': [1, 1], 'split:claude': [1, 0] });
    expect(fair.tasks.find((t) => t.taskId === 'rescued')).toMatchObject({ key: 'split:codex', switched: true });
  });

  it('a start that failed before its engine named a session still counts, as an error, under the engine it was given', () => {
    const at = '2026-11-02T00:00:00.000Z';
    const failed = task({ id: 'acpfail', engine_pick: { key: 'codex', engine: 'codex', at }, last_start: { id: 'ls', at, state: 'failed', engine: 'codex', error: 'boom' } });
    const out = aggregateEngineCompare(input([failed], {}));
    expect(out.rows.map((r) => [r.key, r.open, r.errored])).toEqual([['codex|GPT', 1, 1]]);
  });

  it('counts a move under the column the split assigned in either view, and medians only known usage', () => {
    const pick = { key: 'codex', engine: 'codex' as const, at: '2026-11-02T00:00:00.000Z' };
    const tasks = [done('mv', 1, { engine_pick: pick }), ...Array.from({ length: 2 }, (_, i) => done(`cx${i}`, 1, { engine_pick: pick }))];
    const inp = input(tasks, { mv: { costUsd: 9, engine: 'claude' }, cx0: { costUsd: 4, engine: 'codex', model: 'gpt-6.1-sol' } });
    const all = aggregateEngineCompare(inp);
    const byKey = Object.fromEntries(all.rows.map((r) => [r.key, r]));
    expect(byKey['codex|GPT']).toMatchObject({ switched: 1, noUsage: 1, medianCostUsd: 4 });
    expect(byKey['claude|Claude'].switched).toBe(0);
    // No usage known at all: no median, never a zero.
    const none = aggregateEngineCompare(input([done('u1', 1), done('u2', 1)], {}));
    expect(none.rows[0]).toMatchObject({ medianCostUsd: null, medianTokens: null, noUsage: 2 });
  });

  it("'auto' is decided on the whole period, so a project filter never flips it", () => {
    const pick = { key: 'claude', engine: 'claude' as const, at: '2026-11-02T00:00:00.000Z' };
    const tasks = Array.from({ length: 10 }, (_, i) => done(`a${i}`, 1, { engine_pick: pick, project: i < 3 ? 'Idea' : 'Walnut' }));
    const on = { config: { defaults: { engine_split: ['claude', 'codex'] } }, splitOnly: 'auto' as const };
    expect(aggregateEngineCompare(input(tasks, {}, { ...on, project: 'Idea' }))).toMatchObject({ auto: true, splitOnly: true, taskCount: 3, splitTasks: 3 });
  });

  it('names split entries like the columns they land in', () => {
    const on = aggregateEngineCompare(input([], {}, { config: { defaults: { engine_split: ['claude', { engine: 'claude', model: 'gpt-6.1-sol' }] } } }));
    expect(on.split.entries.map((e) => e.label)).toEqual(['Claude Code · Claude', 'Claude Code · GPT (gpt-6.1-sol)']);
  });

  it('requests with no token counts make cost and tokens unknown, never a zero that wins', () => {
    const tasks = Array.from({ length: 5 }, (_, i) => done(`z${i}`, 1));
    const out = aggregateEngineCompare(input(tasks, Object.fromEntries(tasks.map((t) => [t.id, { unknown: 12 }]))));
    expect(out.rows[0]).toMatchObject({ noUsage: 5, partialCost: 5, partialTokens: 5, medianCostUsd: null, medianTokens: null });
    const some = aggregateEngineCompare(input([done('k', 1)], { k: { costUsd: 3, tokens: 1000, unknown: 2 } }));
    expect(some.rows[0]).toMatchObject({ noUsage: 0, partialCost: 1, partialTokens: 1, medianCostUsd: 3 });
  });

  it('a plain Claude Code pick is the Claude column even when a later model in it carried the cost', () => {
    const pick = { key: 'claude', engine: 'claude' as const, at: '2026-11-02T00:00:00.000Z' };
    const inp = input([done('later', 1, { engine_pick: pick })], { later: { costUsd: 8, engine: 'claude', model: 'gpt-6.1-sol' } });
    const fair = aggregateEngineCompare({ ...inp, splitOnly: true });
    expect(fair.rows.map((r) => [r.key, r.switched])).toEqual([['split:claude', 1]]);
    expect(fair.tasks[0]).toMatchObject({ key: 'split:claude', switched: true });
  });

  it('reports the split as configured', () => {
    expect(aggregateEngineCompare(input([], {})).split).toEqual({ on: false, entries: [] });
    const on = aggregateEngineCompare(input([], {}, { config: { defaults: { engine_split: ['claude', { engine: 'codex', weight: 2 }] } } }));
    expect(on.split).toEqual({ on: true, entries: [{ key: 'claude', label: 'Claude Code · Claude', weight: 1 }, { key: 'codex', label: 'Codex · GPT', weight: 2 }] });
  });
});

describe('round-6 counting', () => {
  it('an open task with no usage yet leaves the medians of finished work exact (and ranked)', () => {
    const tasks = [...Array.from({ length: 6 }, (_, i) => done(`f${i}`, 1)), task({ id: 'fresh', session_id: 's-fresh' })];
    const spend = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}`, { costUsd: 2, tokens: 100 }]));
    const row = aggregateEngineCompare(input(tasks, spend)).rows[0];
    expect(row).toMatchObject({ partialCost: 1, partialCostDone: 0, partialTokensDone: 0, medianCostUsd: 2 });
  });

  it('a title that only mentions a reviewer is work; one that starts with "Reviewer" is a reviewer', () => {
    const tasks = [done('p', 1), task({ id: 'fix', parent_task_id: 'p', title: 'Fix the reviewer assignment bug', session_id: 's-fix' }),
      task({ id: 'rv', parent_task_id: 'p', title: 'Independent reviewer: engine split', session_id: 's-rv' })];
    const out = aggregateEngineCompare(input(tasks, {}));
    expect(out.tasks.map((t) => t.taskId).sort()).toEqual(['fix', 'p']);
    expect(out.tasks.find((t) => t.taskId === 'p')?.reviews).toBe(1);
  });

  it('a task started long ago, finished in the period and reopened stays in the period (by its first completion)', () => {
    const tasks = [done('kept', 1), task({ id: 'reo', session_id: 's-reo', phase: 'IN_PROGRESS', reopens: 1, created_at: '2026-09-20T00:00:00.000Z', first_completed_at: '2026-11-02T05:00:00.000Z' })];
    const inp = input(tasks, {}, { range: { start: '2026-11-01', end: '2026-11-07' } });
    (inp.sessions as Map<string, object>).set('s-reo', { startedAt: '2026-09-20T00:00:00.000Z' });
    const row = aggregateEngineCompare(inp).rows[0];
    expect(row).toMatchObject({ done: 1, open: 1, reopenedShare: 0.5 });
  });

  it('a task reopened and being worked on again still counts as reopened', () => {
    const tasks = [done('a', 1), task({ id: 'again', session_id: 's-again', phase: 'IN_PROGRESS', reopens: 1, first_completed_at: '2026-11-02T03:00:00.000Z' })];
    expect(aggregateEngineCompare(input(tasks, {})).rows[0].reopenedShare).toBe(0.5);
  });
});

describe('placeholder model ids', () => {
  it('"unknown" usage names no family: the session model decides, and it is no move', () => {
    expect(modelFamily('unknown')).toBeNull();
    expect(modelFamily('<synthetic>')).toBeNull();
    const pick = { key: 'claude', engine: 'claude' as const, at: '2026-11-02T00:00:00.000Z' };
    const inp = input([done('ph', 1, { engine_pick: pick })], { ph: { model: 'unknown', unknown: 4, tokens: 10 } });
    (inp.sessions as Map<string, object>).set('s-ph', { startedAt: '2026-11-02T00:00:00.000Z', cliModel: 'claude-opus-5-5' });
    const out = aggregateEngineCompare({ ...inp, splitOnly: true });
    expect(out.tasks[0]).toMatchObject({ key: 'split:claude', switched: false });
  });
});

describe('round-7 counting', () => {
  it('two split entries of one engine and family are two columns in the fair view, one in All', () => {
    const cfg = { config: { defaults: { engine_split: ['claude', { engine: 'claude', model: 'sonnet' }] } } };
    const at = '2026-11-02T00:00:00.000Z';
    const tasks = [done('o', 1, { engine_pick: { key: 'claude', engine: 'claude', at } }),
      done('s', 1, { engine_pick: { key: 'claude:sonnet', engine: 'claude', model: 'sonnet', at } })];
    const inp = input(tasks, { o: { costUsd: 1 }, s: { costUsd: 2, model: 'claude-sonnet-5-5' } }, cfg);
    const fair = aggregateEngineCompare({ ...inp, splitOnly: true });
    expect(fair.rows.map((r) => [r.key, r.label, r.done]).sort()).toEqual([
      ['split:claude', 'Claude Code · Claude', 1], ['split:claude:sonnet', 'Claude Code · Claude (sonnet)', 1]]);
    expect(fair.rows.every((r) => r.switched === 0)).toBe(true);
    expect(aggregateEngineCompare(inp).rows.map((r) => [r.key, r.done])).toEqual([['claude|Claude', 2]]);
  });

  it('a task closed after a start that never ran a session is not finished work, has no time, and is an error', () => {
    const at = '2026-11-02T00:00:00.000Z';
    const closed = task({ id: 'nr', phase: 'COMPLETE', completed_at: '2026-11-02T00:01:00.000Z', start_failures: 1,
      engine_pick: { key: 'codex', engine: 'codex', at }, last_start: { id: 'x', at, state: 'failed', engine: 'codex' } });
    const row = aggregateEngineCompare(input([closed], {})).rows[0];
    expect(row).toMatchObject({ done: 0, open: 0, notStarted: 1, errored: 1, medianHours: null });
  });

  it('a finished task with no usage is left out of the median, which stays ranked (not a floor)', () => {
    const tasks = [...Array.from({ length: 5 }, (_, i) => done(`k${i}`, 1)), done('nu', 1)];
    const spend = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`k${i}`, { costUsd: 3, tokens: 50 }]));
    const row = aggregateEngineCompare(input(tasks, spend)).rows[0];
    expect(row).toMatchObject({ noUsageDone: 1, partialCostDone: 0, partialTokensDone: 0, medianCostUsd: 3 });
  });
});

describe('errors that a later start hides', () => {
  it('a start that failed before a session counts as an error even after a later start succeeded', () => {
    const at = '2026-11-02T00:00:00.000Z';
    const t = done('retried', 1, { start_failures: 1, last_start: { id: 'ok', at, state: 'started', engine: 'codex' } });
    expect(aggregateEngineCompare(input([t], {})).tasks[0].errored).toBe(true);
  });
});

describe('taskSpend', () => {
  it('gives a task to the engine and model family that carried most of it, models of one family summed', async () => {
    const { taskSpend } = await import('../../../src/core/usage/engine-compare.js');
    const row = (engine: string, model: string, input: number, unknown = 0) => ({
      date: '2026-11-02', host: '', source: 'session', engine, sessionId: 's1', taskId: 't1', model, agent: '', band: '',
      calls: 1, input, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, unknown,
    });
    // Models with no price, so the weights are the tokens: two Claude models of 300 each beat one GPT of 400.
    const rows = [row('claude', 'claude-nopriced-a', 300), row('claude', 'claude-nopriced-b', 300), row('codex', 'gpt-nopriced', 400, 3)];
    const rollup = { setThresholds: () => {}, query: () => rows } as unknown as Parameters<typeof taskSpend>[0];
    const spend = (await taskSpend(rollup, undefined, () => undefined)).get('t1')!;
    expect(spend.engine).toBe('claude');
    expect(modelFamily(spend.model)).toBe('Claude');
    expect(spend).toMatchObject({ tokens: 1000, unknown: 3 });
  });

  it('dollars decide before tokens: a cheaper model with many tokens loses to a dearer one with few', async () => {
    const { taskSpend } = await import('../../../src/core/usage/engine-compare.js');
    const row = (engine: string, model: string, input: number) => ({
      date: '2026-11-02', host: '', source: 'session', engine, sessionId: 's1', taskId: 't1', model, agent: '', band: '',
      calls: 1, input, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, unknown: 0,
    });
    const priced = async (rows: ReturnType<typeof row>[]) => {
      const rollup = { setThresholds: () => {}, query: () => rows } as unknown as Parameters<typeof taskSpend>[0];
      return (await taskSpend(rollup, undefined, () => undefined)).get('t1')!;
    };
    // A cheap model with many tokens against a dear one with a hair more dollars and far fewer tokens
    // (the old cost * 1e9 + tokens weight gave it to the cheap one).
    const cheap = await priced([row('codex', 'claude-haiku-4-5', 2_000_000)]);
    const perToken = (await priced([row('claude', 'claude-opus-4-1', 1_000_000)])).costUsd / 1_000_000;
    expect(cheap.costUsd).toBeGreaterThan(0);
    expect(perToken).toBeGreaterThan(0);
    const dearTokens = Math.ceil((cheap.costUsd + 0.0005) / perToken);
    expect(dearTokens).toBeLessThan(1_000_000);
    const spend = await priced([row('codex', 'claude-haiku-4-5', 2_000_000), row('claude', 'claude-opus-4-1', dearTokens)]);
    expect(spend.engine).toBe('claude');
  });
});

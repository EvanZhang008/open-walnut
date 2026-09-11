/**
 * The watcher executor end to end with the model turn stubbed: config
 * validation, the tool belt it hands the engine, and the four run outcomes
 * (clean, no-op, engine failure, background-AI gate).
 */
import { describe, it, expect, vi } from 'vitest';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-watcher-exec'));

import { createWatcherExecutor } from '../../../src/core/routines/executors/watcher.js';
import { loadTriggerState } from '../../../src/core/routines/trigger-state.js';
import type { CronJob } from '../../../src/core/cron/types.js';
import type { ToolDefinition } from '../../../src/model/tools.js';

const T0 = Date.UTC(2026, 8, 10, 12, 0, 0);
let seq = 0;

function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: `we-${++seq}-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Mail triage',
    enabled: true,
    createdAtMs: T0,
    updatedAtMs: T0,
    schedule: { kind: 'every', everyMs: 600_000 },
    sessionTarget: 'isolated',
    wakeMode: 'next-cycle',
    payload: { kind: 'agentTurn', message: 'x' },
    state: {},
    ...overrides,
  } as CronJob;
}

function fakeTool(name: string): ToolDefinition {
  return { name, description: name, input_schema: { type: 'object' }, execute: async () => 'ok' };
}

/** An executor whose model turn is a script over the tool belt. */
function make(opts: {
  script?: (tools: Map<string, ToolDefinition>) => Promise<string>;
  engineThrows?: string;
  plugins?: string[];
  readOnly?: string[];
  backgroundDisabled?: boolean;
  aborted?: boolean;
} = {}) {
  const seen: { tools: string[]; userMessage: string; model?: string; timeoutMs: number } = {
    tools: [], userMessage: '', timeoutMs: 0,
  };
  const toolDeps = {
    createTask: vi.fn(async (i: { title: string }) => ({ id: 'task-1', title: i.title })),
    notify: vi.fn(async () => {}),
    sendToSingleton: vi.fn(async () => ({ taskId: 'task-s', startedSession: true })),
  };
  const executor = createWatcherExecutor({
    nowMs: () => T0,
    backgroundDisabled: () => opts.backgroundDisabled ?? false,
    readOnlyTools: () => (opts.readOnly ?? ['task_query', 'file_read']).map(fakeTool),
    pluginTools: () => (opts.plugins ?? ['mail_list', 'mail_read', 'mail_draft']).map(fakeTool),
    toolDeps,
    engine: async (e) => {
      seen.tools = e.tools.map((t) => t.name);
      seen.userMessage = e.userMessage;
      seen.model = e.model;
      seen.timeoutMs = e.timeoutMs;
      if (opts.engineThrows) throw new Error(opts.engineThrows);
      const byName = new Map(e.tools.map((t) => [t.name, t]));
      const response = opts.script ? await opts.script(byName) : 'nothing new';
      return { response, aborted: opts.aborted ?? false };
    },
  });
  return { executor, seen, toolDeps };
}

const cfg = (over: Record<string, unknown> = {}) => ({
  type: 'watcher',
  config: { instructions: 'Check unread mail.', ...over },
});

describe('validate', () => {
  const { executor } = make();

  it('requires instructions', () => {
    expect(executor.validate({})).toEqual({ ok: false, error: 'instructions is required' });
    expect(executor.validate({ instructions: '   ' }).ok).toBe(false);
    expect(executor.validate(null).ok).toBe(false);
  });

  it('normalizes the comma-separated tool list', () => {
    const res = executor.validate({ instructions: 'x', tools: ' mail_list ,, mail_read ' });
    expect(res.ok && res.config.tools).toBe('mail_list, mail_read');
  });

  it('rejects a data tool that would shadow a built-in outcome tool', () => {
    const res = executor.validate({ instructions: 'x', tools: 'mail_list, trigger_task' });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/built-in watcher tool/);
  });

  it('clamps the safety numbers into range instead of trusting them', () => {
    const res = executor.validate({
      instructions: 'x', maxOutcomesPerRun: 999, maxSessionsPerDay: -4, timeoutSeconds: 1,
    });
    expect(res.ok && res.config).toMatchObject({
      maxOutcomesPerRun: 20, maxSessionsPerDay: 0, timeoutSeconds: 10,
    });
  });

  it('drops empty optional fields rather than storing blanks', () => {
    const res = executor.validate({
      instructions: 'x', tools: '', model: '  ', project: '', maxOutcomesPerRun: '',
    });
    expect(res.ok && Object.keys(res.config)).toEqual(['instructions']);
  });

  it('requires an absolute session cwd, and drops the local host sentinel', () => {
    expect(executor.validate({ instructions: 'x', sessionCwd: 'relative/path' }).ok).toBe(false);
    const res = executor.validate({ instructions: 'x', sessionCwd: '/repo', sessionHost: '__local__' });
    expect(res.ok && res.config).toEqual({ instructions: 'x', sessionCwd: '/repo' });
  });
});

describe('tool belt handed to the engine', () => {
  it('carries only the named data tools plus the five outcome tools', async () => {
    const { executor, seen } = make();
    await executor.run(job(), cfg({ tools: 'mail_list, mail_read' }) as never, 'Check unread mail.');
    expect(seen.tools).toEqual([
      'mail_list', 'mail_read',
      'trigger_seen', 'trigger_note', 'trigger_task', 'trigger_notify', 'trigger_session',
    ]);
  });

  it('names read-only walnut tools out of the SAME pool as plugin tools', async () => {
    const { executor, seen } = make();
    await executor.run(job(), cfg({ tools: 'task_query, mail_list' }) as never, 'x');
    expect(seen.tools).toEqual([
      'task_query', 'mail_list',
      'trigger_seen', 'trigger_note', 'trigger_task', 'trigger_notify', 'trigger_session',
    ]);
  });

  it('gives NOTHING for free — an unnamed read tool is simply absent', async () => {
    // Measured: handing over the whole read-only set cost 2,835 tokens on EVERY
    // round, ~144 rounds a day, for tools nobody asked for.
    const { executor, seen } = make();
    await executor.run(job(), cfg() as never, 'Check unread mail.');
    expect(seen.tools).toEqual([
      'trigger_seen', 'trigger_note', 'trigger_task', 'trigger_notify', 'trigger_session',
    ]);
    expect(seen.userMessage).toMatch(/Data tools available: \(none/);
  });

  it('withholds a plugin tool that was NOT allowlisted', async () => {
    const { executor, seen } = make();
    await executor.run(job(), cfg({ tools: 'mail_list' }) as never, 'Check unread mail.');
    expect(seen.tools).not.toContain('mail_draft');
  });

  it('a repeated name is carried once, so it cannot be paid for twice', async () => {
    const { executor, seen } = make();
    await executor.run(job(), cfg({ tools: 'mail_list, mail_list' }) as never, 'x');
    expect(seen.tools.filter((n) => n === 'mail_list')).toHaveLength(1);
  });

  it('fails loud and names what IS available for an unknown data tool', async () => {
    const { executor } = make();
    const res = await executor.run(job(), cfg({ tools: 'slack_list' }) as never, 'x');
    expect(res.status).toBe('error');
    expect(res.error).toContain('unknown data tool(s): slack_list');
    expect(res.error).toContain('mail_list');
    // Walnut's own read tools are in the same pool, so they are listed too.
    expect(res.error).toContain('task_query');
  });

  it('names the empty case rather than printing a bare list', async () => {
    const { executor } = make({ plugins: [], readOnly: [] });
    const res = await executor.run(job(), cfg({ tools: 'mail_list' }) as never, 'x');
    expect(res.error).toContain('available: (none)');
  });

  it('passes the configured model and timeout through', async () => {
    const { executor, seen } = make();
    await executor.run(job(), cfg({ model: 'sonnet-x', timeoutSeconds: 45 }) as never, 'x');
    expect(seen.model).toBe('sonnet-x');
    expect(seen.timeoutMs).toBe(45_000);
  });
});

describe('run outcomes', () => {
  it('a quiet run reports no outcomes and creates nothing', async () => {
    const { executor, toolDeps } = make();
    const res = await executor.run(job(), cfg() as never, 'Check unread mail.');
    expect(res.status).toBe('ok');
    expect(res.summary).toMatch(/^no outcomes/);
    expect(toolDeps.createTask).not.toHaveBeenCalled();
  });

  it('summarizes what the tools did, ignoring the model\'s own claim', async () => {
    const { executor, toolDeps } = make({
      script: async (tools) => {
        await tools.get('trigger_seen')!.execute({ ids: ['m1', 'm2'] });
        await tools.get('trigger_task')!.execute({ key: 'm1', title: 'Reply to Dana' });
        return 'I created three tasks and sent five emails.';
      },
    });
    const res = await executor.run(job(), cfg({ tools: 'mail_list' }) as never, 'x');
    expect(res.summary).toContain('1× task');
    expect(toolDeps.createTask).toHaveBeenCalledTimes(1);
  });

  it('the SAME item on a second run produces nothing', async () => {
    const script = async (tools: Map<string, ToolDefinition>) => {
      const seenRes = await tools.get('trigger_seen')!.execute({ ids: ['m1'] });
      if (String(seenRes).includes('new: m1')) {
        await tools.get('trigger_task')!.execute({ key: 'm1', title: 'Reply' });
      }
      return 'done';
    };
    const { executor, toolDeps } = make({ script });
    const j = job();
    const first = await executor.run(j, cfg() as never, 'x');
    const second = await executor.run(j, cfg() as never, 'x');
    expect(first.summary).toContain('1× task');
    expect(second.summary).toMatch(/^no outcomes/);
    expect(toolDeps.createTask).toHaveBeenCalledTimes(1);
  });

  it('three consecutive polls: acts once, stays quiet, then acts on the NEW item', async () => {
    // The actual shape of a poll. Testing only two runs would miss the case that
    // matters most: a quiet run must not poison the run after it.
    let inbox = ['m1'];
    const script = async (tools: Map<string, ToolDefinition>) => {
      const res = String(await tools.get('trigger_seen')!.execute({ ids: inbox }));
      const fresh = inbox.filter((id) => res.includes(id) && res.startsWith('new:'));
      for (const id of fresh) {
        await tools.get('trigger_task')!.execute({ key: id, title: `Reply ${id}` });
      }
      return `${fresh.length} new`;
    };
    const { executor, toolDeps } = make({ script });
    const j = job();
    const r1 = await executor.run(j, cfg() as never, 'x');
    const r2 = await executor.run(j, cfg() as never, 'x');
    inbox = ['m1', 'm2'];
    const r3 = await executor.run(j, cfg() as never, 'x');
    expect(r1.summary).toContain('1× task');
    expect(r2.summary).toMatch(/^no outcomes/);
    expect(r3.summary).toContain('1× task');
    expect(toolDeps.createTask).toHaveBeenCalledTimes(2);
    expect(toolDeps.createTask.mock.calls.map((c) => c[0].title)).toEqual(['Reply m1', 'Reply m2']);
  });

  it('holds the line even when the model ignores trigger_seen and re-acts', async () => {
    // The advisory layer is bypassed on purpose here — the acted-key check is
    // what has to catch it.
    const script = async (tools: Map<string, ToolDefinition>) =>
      String(await tools.get('trigger_task')!.execute({ key: 'm1', title: 'Reply' }));
    const { executor, toolDeps } = make({ script });
    const j = job();
    await executor.run(j, cfg() as never, 'x');
    const second = await executor.run(j, cfg() as never, 'x');
    expect(second.summary).toMatch(/^no outcomes/);
    expect(toolDeps.createTask).toHaveBeenCalledTimes(1);
  });

  it('a timeout that produced nothing is an error, so backoff engages', async () => {
    // Reporting ok would reset consecutiveErrors, and a watcher timing out on
    // every tick would poll forever while looking healthy.
    const { executor } = make({ aborted: true });
    const res = await executor.run(job(), cfg() as never, 'x');
    expect(res.status).toBe('error');
    expect(res.error).toMatch(/timed out/);
    expect(res.summary).toContain('(timed out)');
  });

  it('a timeout that DID act stays ok — the work landed', async () => {
    const { executor } = make({
      aborted: true,
      script: async (tools) => {
        await tools.get('trigger_task')!.execute({ key: 'm1', title: 'Reply' });
        return 'partial'
      },
    });
    const res = await executor.run(job(), cfg() as never, 'x');
    expect(res.status).toBe('ok');
    expect(res.summary).toContain('1× task');
    expect(res.summary).toContain('(timed out)');
  });

  it('does not forward the watcher\'s cheap model to a session it starts', async () => {
    const { executor, toolDeps } = make({
      script: async (tools) => {
        await tools.get('trigger_session')!.execute({ key: 'a', name: 'triage', message: 'go' });
        return 'sent'
      },
    });
    await executor.run(job(), cfg({ model: 'haiku-x' }) as never, 'x');
    expect(toolDeps.sendToSingleton.mock.calls[0][0].model).toBeUndefined();
  });

  it('an engine failure is an error, but outcomes already applied are kept', async () => {
    const { executor } = make({ engineThrows: 'model unreachable' });
    const res = await executor.run(job(), cfg() as never, 'x');
    expect(res.status).toBe('error');
    expect(res.error).toBe('model unreachable');
    expect(res.summary).toMatch(/no outcomes/);
  });

  it('records when it last looked, even after a failed turn', async () => {
    const { executor } = make({ engineThrows: 'boom' });
    const j = job();
    await executor.run(j, cfg() as never, 'x');
    expect((await loadTriggerState(j.id, T0)).lastRunAtMs).toBe(T0);
  });

  it('carries the previous run\'s note into the next prompt', async () => {
    const { executor, seen } = make({
      script: async (tools) => {
        await tools.get('trigger_note')!.execute({ text: 'waiting on the invoice' });
        return 'noted';
      },
    });
    const j = job();
    await executor.run(j, cfg() as never, 'x');
    await executor.run(j, cfg() as never, 'x');
    expect(seen.userMessage).toContain('waiting on the invoice');
    expect(seen.userMessage).toContain('Previous run: ');
  });

  it('skips without calling the model when background AI is disabled', async () => {
    const { executor, seen } = make({ backgroundDisabled: true });
    const res = await executor.run(job(), cfg() as never, 'x');
    expect(res.status).toBe('ok');
    expect(res.summary).toMatch(/^skipped/);
    expect(seen.userMessage).toBe('');
  });

  it('uses the engine-supplied message, so init-processor output reaches the model', async () => {
    const { executor, seen } = make();
    await executor.run(job(), cfg() as never, '[action output]\n\nCheck unread mail.');
    expect(seen.userMessage).toContain('[action output]');
  });

  it('reports the per-run budget it is actually running under', async () => {
    const { executor, seen } = make();
    await executor.run(job(), cfg({ maxOutcomesPerRun: 1, maxSessionsPerDay: 0 }) as never, 'x');
    expect(seen.userMessage).toContain('1 outcome this run');
    expect(seen.userMessage).toContain('0 new sessions left today');
  });
});

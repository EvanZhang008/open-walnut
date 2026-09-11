/**
 * The watcher's outcome tools — where every limit that matters is enforced.
 *
 * These cases exist because the model is NOT the safety mechanism: each one
 * drives a tool the way a confused or adversarial model would (no key, a fresh
 * key for the same item, one more outcome than allowed, a fourth session in a
 * day) and asserts the tool refused without throwing, and without doing the
 * side effect.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-watcher-tools'));

import { createWatcherTools, WATCHER_TOOL_NAMES } from '../../../src/core/routines/watcher-tools.js';
import {
  emptyTriggerState, loadTriggerState, type TriggerState,
} from '../../../src/core/routines/trigger-state.js';

const T0 = Date.UTC(2026, 8, 10, 12, 0, 0);
let seq = 0;

function setup(opts?: {
  state?: Partial<TriggerState>;
  maxOutcomesPerRun?: number;
  maxSessionsPerDay?: number;
}) {
  const jobId = `wt-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
  const state = { ...emptyTriggerState(T0), ...opts?.state };
  const deps = {
    createTask: vi.fn(async (i: { title: string }) => ({ id: 'task-1', title: i.title })),
    notify: vi.fn(async () => {}),
    sendToSingleton: vi.fn(async (i: { taskId?: string }) => ({
      taskId: i.taskId ?? 'task-new', startedSession: !i.taskId,
    })),
  };
  const belt = createWatcherTools({
    jobId,
    jobName: 'Mail triage',
    state,
    maxOutcomesPerRun: opts?.maxOutcomesPerRun ?? 3,
    maxSessionsPerDay: opts?.maxSessionsPerDay ?? 2,
    project: 'Inbox',
    nowMs: () => T0,
  }, deps);
  const tool = (name: string) => belt.tools.find((t) => t.name === name)!;
  return { jobId, state, deps, belt, tool };
}

describe('tool belt shape', () => {
  it('exposes exactly the five trigger tools, and the name set matches', () => {
    const { belt } = setup();
    const names = belt.tools.map((t) => t.name).sort();
    expect(names).toEqual(['trigger_note', 'trigger_notify', 'trigger_seen', 'trigger_session', 'trigger_task']);
    expect([...WATCHER_TOOL_NAMES].sort()).toEqual(names);
  });
});

describe('trigger_seen', () => {
  it('returns only new ids and persists them', async () => {
    const { jobId, tool } = setup();
    const first = await tool('trigger_seen').execute({ ids: ['a', 'b'] });
    expect(first).toContain('new: a, b');
    const second = await tool('trigger_seen').execute({ ids: ['b', 'c'] });
    expect(second).toContain('new: c');
    expect(second).toContain('1 already seen');
    const persisted = await loadTriggerState(jobId, T0);
    expect(Object.keys(persisted.seen).sort()).toEqual(['a', 'b', 'c']);
  });

  it('says so plainly when everything was already seen', async () => {
    const { tool } = setup();
    await tool('trigger_seen').execute({ ids: ['a'] });
    expect(await tool('trigger_seen').execute({ ids: ['a'] })).toContain('new: (none)');
  });

  it('handles an empty or non-array input without throwing', async () => {
    const { tool } = setup();
    expect(await tool('trigger_seen').execute({ ids: [] })).toContain('(none)');
    expect(await tool('trigger_seen').execute({})).toContain('(none)');
  });

  it('caps a huge batch so one call cannot blow up the state file', async () => {
    const { jobId, tool } = setup();
    const ids = Array.from({ length: 500 }, (_, i) => `id-${i}`);
    await tool('trigger_seen').execute({ ids });
    const persisted = await loadTriggerState(jobId, T0);
    expect(Object.keys(persisted.seen)).toHaveLength(200);
  });
});

describe('trigger_note', () => {
  it('saves and clears the note for the next run', async () => {
    const { jobId, tool } = setup();
    await tool('trigger_note').execute({ text: 'chasing the invoice' });
    expect((await loadTriggerState(jobId, T0)).notes).toBe('chasing the invoice');
    expect(await tool('trigger_note').execute({ text: '' })).toContain('cleared');
    expect((await loadTriggerState(jobId, T0)).notes).toBe('');
  });
});

describe('outcome dedup', () => {
  it('refuses a second outcome under a key already acted on', async () => {
    const { deps, tool } = setup();
    expect(await tool('trigger_task').execute({ key: 'm1', title: 'Reply to Dana' }))
      .toContain('Created task');
    const second = await tool('trigger_task').execute({ key: 'm1', title: 'Reply to Dana' });
    expect(second).toMatch(/^Refused: key "m1" was already acted on/);
    expect(deps.createTask).toHaveBeenCalledTimes(1);
  });

  it('carries dedup across runs through persisted state', async () => {
    const { jobId, tool } = setup();
    await tool('trigger_task').execute({ key: 'm1', title: 'Reply' });
    // A fresh belt over the reloaded state = the next scheduled run.
    const reloaded = await loadTriggerState(jobId, T0);
    const next = createWatcherTools({
      jobId, jobName: 'Mail triage', state: reloaded,
      maxOutcomesPerRun: 3, maxSessionsPerDay: 2, project: '', nowMs: () => T0,
    }, {
      createTask: vi.fn(async () => ({ id: 'x', title: 'x' })),
      notify: vi.fn(async () => {}),
      sendToSingleton: vi.fn(async () => ({ taskId: 't', startedSession: true })),
    });
    const res = await next.tools.find((t) => t.name === 'trigger_task')!
      .execute({ key: 'm1', title: 'Reply' });
    expect(res).toMatch(/already acted on/);
  });

  it('dedups across tool KINDS — a notify cannot re-do a key a task used', async () => {
    const { deps, tool } = setup();
    await tool('trigger_task').execute({ key: 'm1', title: 'Reply' });
    const res = await tool('trigger_notify').execute({ key: 'm1', title: 'FYI' });
    expect(res).toMatch(/already acted on/);
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it('refuses an outcome with no key at all', async () => {
    const { deps, tool } = setup();
    expect(await tool('trigger_task').execute({ title: 'Something' }))
      .toMatch(/needs a stable "key"/);
    expect(await tool('trigger_notify').execute({ key: '   ', title: 'Something' }))
      .toMatch(/needs a stable "key"/);
    expect(deps.createTask).not.toHaveBeenCalled();
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it('refuses a task with no title, without consuming the key', async () => {
    const { deps, tool } = setup();
    expect(await tool('trigger_task').execute({ key: 'm1', title: '  ' }))
      .toMatch(/title is required/);
    expect(deps.createTask).not.toHaveBeenCalled();
    // The key stayed unused, so a corrected retry works.
    expect(await tool('trigger_task').execute({ key: 'm1', title: 'Fixed' })).toContain('Created task');
  });
});

describe('per-run outcome budget', () => {
  it('allows exactly N outcomes and then refuses with a summarize instruction', async () => {
    const { deps, belt, tool } = setup({ maxOutcomesPerRun: 2 });
    await tool('trigger_task').execute({ key: 'a', title: 'A' });
    await tool('trigger_notify').execute({ key: 'b', title: 'B' });
    const third = await tool('trigger_task').execute({ key: 'c', title: 'C' });
    expect(third).toMatch(/outcome budget \(2\) is used up/);
    expect(third).toMatch(/stays new for the next run/);
    expect(deps.createTask).toHaveBeenCalledTimes(1);
    expect(belt.outcomes).toHaveLength(2);
  });

  it('counts every outcome kind against the same budget', async () => {
    const { tool } = setup({ maxOutcomesPerRun: 1 });
    await tool('trigger_session').execute({ key: 'a', name: 'triage', message: 'look' });
    expect(await tool('trigger_notify').execute({ key: 'b', title: 'B' }))
      .toMatch(/budget \(1\) is used up/);
  });

  it('does not let a refusal consume budget', async () => {
    const { belt, tool } = setup({ maxOutcomesPerRun: 1 });
    await tool('trigger_task').execute({ key: '', title: 'no key' });
    await tool('trigger_task').execute({ key: 'a', title: '' });
    expect(await tool('trigger_task').execute({ key: 'a', title: 'A' })).toContain('Created task');
    expect(belt.outcomes).toHaveLength(1);
  });

  it('leaves seen/note calls outside the budget', async () => {
    const { tool } = setup({ maxOutcomesPerRun: 1 });
    for (let i = 0; i < 5; i++) await tool('trigger_seen').execute({ ids: [`i${i}`] });
    await tool('trigger_note').execute({ text: 'note' });
    expect(await tool('trigger_task').execute({ key: 'a', title: 'A' })).toContain('Created task');
  });
});

describe('trigger_session', () => {
  it('starts the singleton once, then sends into the SAME task', async () => {
    const { jobId, deps, tool } = setup({ maxOutcomesPerRun: 5 });
    const first = await tool('trigger_session').execute({ key: 'a', name: 'triage', message: 'first' });
    expect(first).toMatch(/^Started session "triage"/);
    const second = await tool('trigger_session').execute({ key: 'b', name: 'triage', message: 'second' });
    expect(second).toMatch(/^Sent the prompt into session "triage"/);
    expect(deps.sendToSingleton.mock.calls[1][0].taskId).toBe('task-new');
    expect((await loadTriggerState(jobId, T0)).singletons.triage).toBe('task-new');
  });

  it('counts only STARTS against the daily session cap, not sends', async () => {
    const { jobId, tool } = setup({ maxOutcomesPerRun: 9, maxSessionsPerDay: 1 });
    await tool('trigger_session').execute({ key: 'a', name: 'triage', message: '1' });
    // Sending into the existing one is free.
    await tool('trigger_session').execute({ key: 'b', name: 'triage', message: '2' });
    expect((await loadTriggerState(jobId, T0)).day.sessions).toBe(1);
    // A DIFFERENT singleton would be a second start → refused.
    const res = await tool('trigger_session').execute({ key: 'c', name: 'reviews', message: '3' });
    expect(res).toMatch(/already started 1 session\(s\) today/);
  });

  it('honours a session count carried in from earlier runs today', async () => {
    const { deps, tool } = setup({
      maxSessionsPerDay: 2,
      state: { day: { key: '', sessions: 2 } as never },
    });
    const res = await tool('trigger_session').execute({ key: 'a', name: 'triage', message: 'x' });
    expect(res).toMatch(/its limit/);
    expect(deps.sendToSingleton).not.toHaveBeenCalled();
  });

  it('refuses an empty message rather than starting an empty session', async () => {
    const { deps, tool } = setup();
    expect(await tool('trigger_session').execute({ key: 'a', name: 'triage', message: ' ' }))
      .toMatch(/message is required/);
    expect(deps.sendToSingleton).not.toHaveBeenCalled();
  });

  it('falls back to a default singleton name when none is given', async () => {
    const { jobId, tool } = setup();
    await tool('trigger_session').execute({ key: 'a', name: '', message: 'go' });
    expect((await loadTriggerState(jobId, T0)).singletons.default).toBe('task-new');
  });
});

describe('real-world id and content shapes', () => {
  it('dedups a CJK / emoji / punctuation-heavy key like any other', async () => {
    const { deps, tool } = setup({ maxOutcomesPerRun: 9 });
    const keys = ['邮件-发票-2026', 'msg🎉<id@host>', 'AAMkAD/9+Qw==', 'ちょっと待って'];
    for (const key of keys) {
      expect(await tool('trigger_task').execute({ key, title: `处理 ${key}` })).toContain('Created task');
    }
    for (const key of keys) {
      expect(await tool('trigger_task').execute({ key, title: 'again' })).toMatch(/already acted on/);
    }
    expect(deps.createTask).toHaveBeenCalledTimes(keys.length);
  });

  it('keeps CJK titles and bodies intact through the outcome', async () => {
    const { deps, tool } = setup({ maxOutcomesPerRun: 9 });
    await tool('trigger_task').execute({
      key: 'm1', title: '回复 Dana 关于发票的邮件', description: '内容：需要在周五前确认金额。',
    });
    expect(deps.createTask.mock.calls[0][0]).toMatchObject({
      title: '回复 Dana 关于发票的邮件', description: '内容：需要在周五前确认金额。',
    });
    await tool('trigger_notify').execute({ key: 'm2', title: '有 3 封需要处理', body: '详情在任务里' });
    expect(deps.notify.mock.calls[0][0]).toMatchObject({ title: '有 3 封需要处理' });
  });

  it('treats a key that only differs by surrounding whitespace as the same key', async () => {
    const { deps, tool } = setup({ maxOutcomesPerRun: 9 });
    await tool('trigger_task').execute({ key: 'msg-1', title: 'A' });
    expect(await tool('trigger_task').execute({ key: '  msg-1  ', title: 'A' }))
      .toMatch(/already acted on/);
    expect(deps.createTask).toHaveBeenCalledTimes(1);
  });

  it('does not choke on a key or note carrying newlines', async () => {
    const { jobId, tool } = setup({ maxOutcomesPerRun: 9 });
    expect(await tool('trigger_task').execute({ key: 'a\nb', title: 'A' })).toContain('Created task');
    await tool('trigger_note').execute({ text: 'line one\nline two\n\nline four' });
    const persisted = await loadTriggerState(jobId, T0);
    expect(persisted.notes).toContain('line four');
    expect(Object.keys(persisted.acted)).toContain('a\nb');
  });
});

describe('outcome wiring', () => {
  it('passes the pin tier through only when asked', async () => {
    const { deps, tool } = setup();
    await tool('trigger_task').execute({ key: 'a', title: 'A' });
    expect(deps.createTask.mock.calls[0][0]).not.toHaveProperty('pinned');
    await tool('trigger_task').execute({ key: 'b', title: 'B', pin: 'focus' });
    expect(deps.createTask.mock.calls[1][0]).toMatchObject({ pinned: true, pinTier: 'focus' });
  });

  it('namespaces the notification dedup key by routine', async () => {
    const { jobId, deps, tool } = setup();
    await tool('trigger_notify').execute({ key: 'm1', title: 'T', severity: 'warning' });
    expect(deps.notify.mock.calls[0][0]).toMatchObject({
      dedupKey: `routine:${jobId}:m1`, severity: 'warning',
    });
  });

  it('falls back to info for an unknown severity', async () => {
    const { deps, tool } = setup();
    await tool('trigger_notify').execute({ key: 'm1', title: 'T', severity: 'catastrophe' });
    expect(deps.notify.mock.calls[0][0].severity).toBe('info');
  });

  it('records the outcome only AFTER the side effect succeeded', async () => {
    const { jobId, tool, deps } = setup();
    deps.createTask.mockRejectedValueOnce(new Error('store is down'));
    await expect(tool('trigger_task').execute({ key: 'm1', title: 'A' })).rejects.toThrow('store is down');
    // The key stayed free: the task was never created, so the next run retries.
    const persisted = await loadTriggerState(jobId, T0);
    expect(persisted.acted.m1).toBeUndefined();
  });
});

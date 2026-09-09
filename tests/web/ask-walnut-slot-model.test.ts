/**
 * The Ask Walnut slot's selection model.
 *
 * Three decisions, all invisible from the DOM until they regress:
 *  - WHICH tasks are an agent's asks: born one (`walnut_agent` + that agent's
 *    `agent_id` stamp, no stamp = Walnut, wherever it was filed since) OR filed
 *    under the agent's project now (user, 2026-09-07: "one list — the ones
 *    under the project, and the ones that were moved out"), one list PER agent;
 *  - WHICH agent a task belongs to (the stamp, then the project);
 *  - WHICH row survives a task-list change (the persisted pick while it exists,
 *    else the newest, else nothing).
 *
 * (WHICH session a task's panel mounts is `resolveTaskSessionId` in
 * web/src/utils/session-status.ts — one precedence for every surface. This module
 * used to carry a second copy of it plus a session-list fallback nobody fed.)
 *
 * The ordering assertions are the ones a browser spec cannot make: a streaming
 * ask must not slide out from under the cursor, and two tasks stamped in the same
 * millisecond must not swap places between refetches.
 */

import { describe, it, expect } from 'vitest';
import type { Task } from '@open-walnut/core';
import {
  GENERAL_ASK_AGENT, agentOfTask, askProjectFor, resolveSelection, selectAgentTasks, toAskAgent,
} from '@/components/chat/ask-walnut-slot-model';

function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: `task ${over.id}`,
    status: 'todo',
    priority: 'none',
    phase: 'TODO',
    session_ids: [],
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    source: 'local',
    note: '',
    summary: '',
    description: '',
    ...over,
  } as unknown as Task;
}

const walnut = (id: string, over: Partial<Task> = {}) =>
  task({ id, walnut_agent: true, ...over });

const MENTOR = toAskAgent({ id: 'mentor', name: 'Mentor', description: 'Reflection and planning.' });
const selectAskWalnutTasks = (tasks: Task[]) => selectAgentTasks(tasks, GENERAL_ASK_AGENT);

describe('askProjectFor / toAskAgent', () => {
  it("files the Personal AI under 'Ask Walnut' and any other agent under 'Ask <name>' (server twin: ask-agent.ts)", () => {
    expect(askProjectFor({ id: 'general', name: 'whatever the registry says' })).toBe('Ask Walnut');
    expect(askProjectFor({ id: 'mentor', name: 'Mentor' })).toBe('Ask Mentor');
    expect(askProjectFor({ id: 'note-agent', name: ' Note Assistant ' })).toBe('Ask Note Assistant');
    expect(askProjectFor({ id: 'x', name: '' })).toBe('Ask x');
  });

  it('folds a free-text agent name into a legal project name (no separators, no .., capped), same as the server', () => {
    expect(askProjectFor({ id: 'ops', name: 'Ops/SRE' })).toBe('Ask Ops-SRE');
    expect(askProjectFor({ id: 'ideas', name: 'Ideas.. drafts' })).toBe('Ask Ideas. drafts');
    expect(askProjectFor({ id: 'long', name: 'x'.repeat(200) })).toBe(`Ask ${'x'.repeat(60)}`);
    expect(askProjectFor({ id: 'slashes', name: '///' })).toBe('Ask ---');
  });

  it('names the general agent Walnut regardless of its registry name, and keeps a description only when there is one', () => {
    expect(toAskAgent({ id: 'general', name: 'General' })).toEqual({ id: 'general', name: 'Walnut', project: 'Ask Walnut' });
    expect(MENTOR).toEqual({ id: 'mentor', name: 'Mentor', description: 'Reflection and planning.', project: 'Ask Mentor' });
  });
});

describe('selectAgentTasks — another agent', () => {
  it("lists Mentor's asks: stamped agent_id OR filed under Ask Mentor, and NOT Walnut's", () => {
    const tasks = [
      walnut('w'),
      walnut('m', { agent_id: 'mentor' }),
      walnut('m-moved', { agent_id: 'mentor', project: 'Dev work' }),
      task({ id: 'm-filed', project: 'ask mentor' }),
      walnut('w-in-mentor-project', { project: 'Ask Mentor' }),
      task({ id: 'plain' }),
    ];
    expect(selectAgentTasks(tasks, MENTOR).map((t) => t.id).sort())
      .toEqual(['m', 'm-filed', 'm-moved', 'w-in-mentor-project']);
    // Walnut's list excludes the stamped Mentor asks — the stamp is what keeps
    // the two lists apart when both live under one project by hand.
    expect(selectAskWalnutTasks(tasks).map((t) => t.id).sort()).toEqual(['w', 'w-in-mentor-project']);
  });
});

describe('agentOfTask', () => {
  const agents = [GENERAL_ASK_AGENT, MENTOR];
  it('the stamp wins over the project; an unstamped ask is Walnut\'s', () => {
    expect(agentOfTask(walnut('a', { agent_id: 'mentor', project: 'Ask Walnut' }), agents)?.id).toBe('mentor');
    expect(agentOfTask(walnut('b', { project: 'Ask Mentor' }), agents)?.id).toBe('general');
  });
  it('falls back to the project for a plain task, and to null for nobody\'s task', () => {
    expect(agentOfTask(task({ id: 'c', project: ' ask mentor ' }), agents)?.id).toBe('mentor');
    expect(agentOfTask(task({ id: 'd', project: 'Dev work' }), agents)).toBeNull();
  });
  it('an ask stamped with an agent nobody knows any more falls back to its project, then null', () => {
    expect(agentOfTask(walnut('e', { agent_id: 'gone', project: 'Ask Mentor' }), agents)?.id).toBe('mentor');
    expect(agentOfTask(walnut('f', { agent_id: 'gone', project: 'Ask Gone' }), agents)).toBeNull();
  });
});

describe('selectAgentTasks — Walnut', () => {
  it('keeps tasks born as asks AND tasks filed under the Ask Walnut project', () => {
    const tasks = [
      walnut('a'),
      task({ id: 'b' }),
      task({ id: 'c', walnut_agent: false }),
      task({ id: 'd', project: 'Ask Walnut' }),
      task({ id: 'e', project: 'Other' }),
    ];
    expect(selectAskWalnutTasks(tasks).map((t) => t.id).sort()).toEqual(['a', 'd']);
  });

  it('keeps an ask that was moved to another project (the conversation must not vanish)', () => {
    const tasks = [walnut('moved', { project: 'Dev work' }), task({ id: 'plain', project: 'Dev work' })];
    expect(selectAskWalnutTasks(tasks).map((t) => t.id)).toEqual(['moved']);
  });

  it('matches the project name case-insensitively and ignores surrounding whitespace', () => {
    const tasks = [
      task({ id: 'lower', project: 'ask walnut' }),
      task({ id: 'padded', project: ' Ask Walnut ' }),
      task({ id: 'prefix', project: 'Ask Walnut 2' }),
      task({ id: 'inbox', project: '' }),
    ];
    expect(selectAskWalnutTasks(tasks).map((t) => t.id).sort()).toEqual(['lower', 'padded']);
  });

  it('sorts by created_at descending', () => {
    const tasks = [
      walnut('old', { created_at: '2026-09-01T00:00:00.000Z' }),
      walnut('new', { created_at: '2026-09-03T00:00:00.000Z' }),
      walnut('mid', { created_at: '2026-09-02T00:00:00.000Z' }),
    ];
    expect(selectAskWalnutTasks(tasks).map((t) => t.id)).toEqual(['new', 'mid', 'old']);
  });

  // THE REGRESSION THIS ORDER EXISTS FOR: `updated_at` moves on every streamed
  // turn, so ordering on it slid the answering ask toward the front while the
  // user was aiming at a row — the click landed on whatever took its place. Row
  // position is birth order, which nothing can change after the fact.
  it('does NOT reorder when an older ask is updated (a streaming turn)', () => {
    const tasks = [
      walnut('born-first', { created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-09T00:00:00.000Z' }),
      walnut('born-second', { created_at: '2026-09-02T00:00:00.000Z', updated_at: '2026-09-02T00:00:00.000Z' }),
    ];
    expect(selectAskWalnutTasks(tasks).map((t) => t.id)).toEqual(['born-second', 'born-first']);
  });

  it('breaks a created_at tie on updated_at, then on the id — deterministically', () => {
    const same = '2026-09-02T00:00:00.000Z';
    const tasks = [
      walnut('zz', { created_at: same, updated_at: same }),
      walnut('aa', { created_at: same, updated_at: same }),
      walnut('newer-touch', { created_at: same, updated_at: '2026-09-02T09:00:00.000Z' }),
    ];
    const first = selectAskWalnutTasks(tasks).map((t) => t.id);
    // Reversing the input must not change the answer — that is the whole point.
    const second = selectAskWalnutTasks([...tasks].reverse()).map((t) => t.id);
    expect(first).toEqual(['newer-touch', 'aa', 'zz']);
    expect(second).toEqual(first);
  });

  it('sorts a task with no usable stamps last instead of scrambling the list', () => {
    const tasks = [
      walnut('broken', { updated_at: '', created_at: '' } as Partial<Task>),
      walnut('good', { created_at: '2026-09-02T00:00:00.000Z' }),
    ];
    expect(selectAskWalnutTasks(tasks).map((t) => t.id)).toEqual(['good', 'broken']);
  });

  it('does not mutate the input array', () => {
    const tasks = [walnut('b', { created_at: '2026-09-01T00:00:00.000Z' }), walnut('a', { created_at: '2026-09-05T00:00:00.000Z' })];
    const order = tasks.map((t) => t.id);
    selectAskWalnutTasks(tasks);
    expect(tasks.map((t) => t.id)).toEqual(order);
  });
});

describe('resolveSelection', () => {
  const tasks = [
    walnut('new', { created_at: '2026-09-03T00:00:00.000Z' }),
    walnut('old', { created_at: '2026-09-01T00:00:00.000Z' }),
  ];

  it('keeps the persisted selection while its task exists', () => {
    expect(resolveSelection('old', tasks)).toBe('old');
  });

  it('falls back to the newest task when the selection is gone', () => {
    expect(resolveSelection('deleted', tasks)).toBe('new');
    expect(resolveSelection(null, tasks)).toBe('new');
    expect(resolveSelection(undefined, tasks)).toBe('new');
  });

  it('finds the newest task regardless of the input order', () => {
    expect(resolveSelection(null, [...tasks].reverse())).toBe('new');
  });

  // The reload regression: the task store is EMPTY at first paint and fills a
  // tick later, so an empty list must not be read as "the task is gone". Clearing
  // the pick there erased the persisted id too, and the selected row never came
  // back after a reload (caught by tests/e2e/browser/ask-walnut-slot.spec.ts).
  it('keeps the persisted pick when there are no candidates yet', () => {
    expect(resolveSelection('anything', [])).toBe('anything');
  });

  it('resolves to null with no tasks and nothing persisted', () => {
    expect(resolveSelection(null, [])).toBeNull();
    expect(resolveSelection(undefined, [])).toBeNull();
  });

  // The project rule admits a plain todo dragged into "Ask Walnut". A fresh
  // window (no persisted pick) must still open on the last CONVERSATION, not on
  // that todo's "no session yet" card — while the todo stays pickable by hand.
  describe('the default pick prefers a task that has a session', () => {
    const withSession = new Set(['old-ask']);
    const has = (t: Task) => withSession.has(t.id);
    const mixed = [
      task({ id: 'newer-todo', project: 'Ask Walnut', created_at: '2026-09-05T00:00:00.000Z' }),
      walnut('old-ask', { created_at: '2026-09-01T00:00:00.000Z' }),
    ];

    it('skips a newer session-less task for the newest one with a session', () => {
      expect(resolveSelection(null, mixed, has)).toBe('old-ask');
    });

    it('still honours a persisted pick of the session-less task', () => {
      expect(resolveSelection('newer-todo', mixed, has)).toBe('newer-todo');
    });

    it('falls back to the newest bare task when nothing has a session', () => {
      expect(resolveSelection(null, mixed, () => false)).toBe('newer-todo');
    });
  });
});

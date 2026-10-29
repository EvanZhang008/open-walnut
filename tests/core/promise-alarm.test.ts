/**
 * Every promise gets an alarm (src/core/sessions/promise-alarm.ts): a lead's or Main's turn that
 * says it waits on someone or will follow up, with nothing set to bring it back, gets a follow-up a
 * day out; at that time its session gets one note naming what it said.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Task } from '../../src/core/types.js';

const tasks = new Map<string, Task>();
const sends: { sid: string; text: string; opts: Record<string, unknown> }[] = [];
let armedTriggers: { state: string }[] = [];

vi.mock('../../src/core/task-manager.js', () => ({
  getTask: async (id: string) => { const t = tasks.get(id); if (!t) throw new Error('missing'); return t; },
  listTasks: async () => [...tasks.values()],
  updateTaskRaw: async (id: string, patch: Partial<Task>, opts?: { shouldUpdate?: (t: Task) => boolean }) => {
    const t = tasks.get(id);
    if (!t || (opts?.shouldUpdate && !opts.shouldUpdate(t))) return { changed: false };
    const next = { ...t, ...patch } as Task;
    tasks.set(id, next);
    return { changed: true, task: next };
  },
}));
vi.mock('../../src/core/task-wait-until.js', () => ({
  triggersWatching: async () => armedTriggers,
  WAIT_UNTIL_SEND_SOURCE: 'wait-until',
}));
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionsForTask: async (id: string) => (tasks.get(id)?.session_id ? [{ claudeSessionId: tasks.get(id)!.session_id }] : []),
}));
vi.mock('../../src/core/routines/session-target.js', () => ({
  pickDeliverySession: (rows: { claudeSessionId: string }[]) => rows[0] ?? null,
}));
vi.mock('../../src/core/session-message-queue.js', () => ({
  sendMessageToSession: async (sid: string, text: string, opts: Record<string, unknown>) => { sends.push({ sid, text, opts }); },
}));

import {
  PROMISE_ALARM_MS, firePromiseAlarms, notePromise, promiseOf, startPromiseAlarms, stopPromiseAlarms, trackedPromiseAlarms,
} from '../../src/core/sessions/promise-alarm.js';
import { bus, EventNames } from '../../src/core/event-bus.js';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const report = (r: Record<string, unknown>) => ({ at: new Date(NOW).toISOString(), ...r }) as never;

function lead(extra: Partial<Task> = {}): Task {
  return { id: 'lead', title: 'Lead', phase: 'NEED_ACTION', status: 'in_progress', org_role: 'lead', session_id: 'lead-sid', ...extra } as Task;
}

beforeEach(() => {
  tasks.clear();
  sends.length = 0;
  armedTriggers = [];
  stopPromiseAlarms();
});

describe('promiseOf', () => {
  it('a wait on someone else, or a follow-up said in words, is a promise; the user\'s move and done are not', () => {
    expect(promiseOf(report({ state: 'waiting', waiting_kind: 'task', waiting_on: 'The Bun lead to send its commit' }))).toBe('The Bun lead to send its commit');
    expect(promiseOf(report({ state: 'waiting', waiting_kind: 'you', waiting_on: 'Your pick' }))).toBeNull();
    expect(promiseOf(report({ state: 'working', next: 'I will check the CI run in an hour.' }))).toBe('I will check the CI run in an hour.');
    expect(promiseOf(report({ state: 'working', next: '明天跟进测试结果' }))).toBe('明天跟进测试结果');
    expect(promiseOf(report({ state: 'working', next: 'Run the tests.' }))).toBeNull();
    expect(promiseOf(report({ state: 'done', next: 'I will follow up' }))).toBeNull();
    expect(promiseOf(report({ state: 'needs', ask: 'Approve?', next: 'follow up after' }))).toBeNull();
  });
});

describe('notePromise', () => {
  it('sets a follow-up a day out for a lead with nothing to bring it back, and keeps its time on the next promise', async () => {
    tasks.set('lead', lead());
    const a = await notePromise('lead', report({ state: 'waiting', waiting_kind: 'task', waiting_on: 'The review' }), NOW);
    expect(a).toMatchObject({ at: new Date(NOW + PROMISE_ALARM_MS).toISOString(), words: 'The review' });
    const b = await notePromise('lead', report({ state: 'working', next: 'I will check back on the review' }), NOW + 3_600_000);
    expect(b?.at).toBe(a?.at);
    expect(tasks.get('lead')?.promise_alarm?.words).toBe('I will check back on the review');
    // A report that promises nothing clears it.
    expect(await notePromise('lead', report({ state: 'needs', ask: 'Pick one' }), NOW)).toBeNull();
    expect(tasks.get('lead')?.promise_alarm).toBeNull();
  });

  it('none when something already brings it back, or the task is a plain worker or finished', async () => {
    tasks.set('lead', lead({ phase: 'WAITING', wait_until: new Date(NOW + 3_600_000).toISOString() }));
    expect(await notePromise('lead', report({ state: 'waiting', waiting_kind: 'task', waiting_on: 'x' }), NOW)).toBeNull();
    tasks.set('lead', lead());
    armedTriggers = [{ state: 'armed' }];
    expect(await notePromise('lead', report({ state: 'waiting', waiting_kind: 'task', waiting_on: 'x' }), NOW)).toBeNull();
    armedTriggers = [];
    tasks.set('w', { ...lead(), id: 'w', org_role: undefined } as Task);
    expect(await notePromise('w', report({ state: 'waiting', waiting_kind: 'task', waiting_on: 'x' }), NOW)).toBeNull();
    tasks.set('done', { ...lead(), id: 'done', phase: 'COMPLETE' } as Task);
    expect(await notePromise('done', report({ state: 'waiting', waiting_kind: 'task', waiting_on: 'x' }), NOW)).toBeNull();
    expect(tasks.get('lead')?.promise_alarm).toBeUndefined();
  });
});

describe('the clock', () => {
  it('fires once when due: clears the alarm, wakes the session with a note naming the promise', async () => {
    const at = new Date(NOW - 1000).toISOString();
    tasks.set('lead', lead({ promise_alarm: { at, words: 'the review of the docs', set_at: new Date(NOW - PROMISE_ALARM_MS).toISOString() } }));
    tasks.set('later', lead({ id: 'later', session_id: 'later-sid', promise_alarm: { at: new Date(NOW + 60_000).toISOString(), words: 'x', set_at: new Date(NOW).toISOString() } }));
    startPromiseAlarms();
    await vi.waitFor(() => expect(trackedPromiseAlarms().size).toBe(2));
    expect(await firePromiseAlarms(NOW)).toEqual(['lead']);
    expect(tasks.get('lead')?.promise_alarm).toBeNull();
    expect(sends).toHaveLength(1);
    expect(sends[0].sid).toBe('lead-sid');
    expect(sends[0].text).toContain('"the review of the docs"');
    expect(sends[0].text).toContain('This note comes once.');
    expect(sends[0].opts.source).toBe('wait-until');
    // Once.
    expect(await firePromiseAlarms(NOW + 1)).toEqual([]);
    expect(trackedPromiseAlarms().has('later')).toBe(true);
  });

  it('an ephemeral server never fires an alarm it copied from the real Walnut, and follows task events', async () => {
    tasks.set('lead', lead({ promise_alarm: { at: new Date(NOW - 1000).toISOString(), words: 'copied', set_at: new Date(NOW - PROMISE_ALARM_MS).toISOString() } }));
    startPromiseAlarms({ ephemeral: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(trackedPromiseAlarms().size).toBe(0);
    // One set here (after the start) is its own.
    const own = lead({ promise_alarm: { at: new Date(Date.now() + 60_000).toISOString(), words: 'own', set_at: new Date(Date.now() + 1).toISOString() } });
    tasks.set('lead', own);
    bus.emit(EventNames.TASK_UPDATED, { task: own }, ['*']);
    expect(trackedPromiseAlarms().has('lead')).toBe(true);
    const done = { ...own, phase: 'COMPLETE' } as Task;
    bus.emit(EventNames.TASK_COMPLETED, { task: done }, ['*']);
    expect(trackedPromiseAlarms().has('lead')).toBe(false);
  });
});

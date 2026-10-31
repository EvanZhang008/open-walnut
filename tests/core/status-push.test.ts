/**
 * Status changes told to everyone they concern (src/core/sessions/status-push.ts): one line of
 * Walnut's own fact per change (who, from what to what, when), only once the change settled; a
 * session holding a request to the task always hears (queued when it is not running), its leader,
 * its project's VP and Main only while their turn runs; a change that settles where it began, the
 * first status seen, and the task's own sessions hear nothing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionRecord, Task } from '../../src/core/types.js';

const tasks = new Map<string, Task>();
let sessions: SessionRecord[] = [];
let requests: { fromSessionId: string; toTaskId: string }[] = [];
const delivered: { sid: string; text: string }[] = [];
const queued: { sid: string; text: string }[] = [];

vi.mock('../../src/core/task-manager.js', () => ({
  listTasks: async () => [...tasks.values()],
}));
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionsForTask: async (id: string) => sessions.filter((s) => s.taskId === id),
  getSessionByClaudeId: async (sid: string) => sessions.find((s) => s.claudeSessionId === sid) ?? null,
  isListableSession: () => true,
}));
vi.mock('../../src/core/session-requests.js', () => ({
  pendingRequestsForTarget: async ({ taskId }: { taskId: string }) => requests.filter((r) => r.toTaskId === taskId),
}));
vi.mock('../../src/core/sessions/session-send-core.js', () => ({
  deliverToSession: async (rec: SessionRecord, o: { enqueueText: string }) => { delivered.push({ sid: rec.claudeSessionId, text: o.enqueueText }); return { delivery: 'queued' }; },
}));
vi.mock('../../src/core/session-message-queue.js', () => ({
  enqueueMessage: async (sid: string, text: string) => { queued.push({ sid, text }); return { id: 'qm-x' }; },
}));

import { SETTLE_MS, changeLine, flushStatusPush, pendingStatusNote, seenOf, startStatusPush, stopStatusPush, _pendingStatusPush } from '../../src/core/sessions/status-push.js';
import { bus, EventNames } from '../../src/core/event-bus.js';

const task = (id: string, extra: Partial<Task> = {}): Task =>
  ({ id, title: `T ${id}`, phase: 'NEED_ACTION', status: 'in_progress', project: 'Acme', ...extra }) as Task;
const sess = (sid: string, taskId: string, status = 'idle'): SessionRecord =>
  ({ claudeSessionId: sid, taskId, process_status: status, lastActiveAt: '2026-10-28T00:00:00Z' }) as SessionRecord;
const needs = (ask: string) => ({ state: 'needs' as const, source: 'session' as const, ask });

const T0 = Date.parse('2026-10-28T17:00:00Z');

beforeEach(async () => {
  stopStatusPush();
  tasks.clear();
  delivered.length = 0;
  queued.length = 0;
  requests = [];
  for (const t of [
    task('main', { org_role: 'main', phase: 'IN_PROGRESS', project: 'Org' }),
    task('vp', { org_role: 'lead', phase: 'IN_PROGRESS' }),
    task('lead', { phase: 'IN_PROGRESS' }),
    task('w', { parent_task_id: 'lead', user_status: needs('Sign in on the Mac') }),
    task('asker', { phase: 'IN_PROGRESS', project: 'Other' }),
  ]) tasks.set(t.id, t);
  sessions = [sess('s-main', 'main', 'running'), sess('s-vp', 'vp', 'idle'), sess('s-lead', 'lead', 'running'), sess('s-w', 'w'), sess('s-asker', 'asker', 'idle')];
  await startStatusPush({ quietMs: 0 });
});

const emit = (t: Task) => bus.emit(EventNames.TASK_UPDATED, { task: t }, ['*']);
/** The followers whose next message carries a status line (it never goes in by itself). */
const followers = () => ['s-lead', 's-main', 's-vp'].filter((sid) => pendingStatusNote(sid))
const ride = (sid = 's-lead') => pendingStatusNote(sid)?.text ?? ''

describe('the line', () => {
  it('says who, from what to what, when, and what the user was asked', () => {
    const from = seenOf(task('w', { user_status: needs('Sign in on the Mac') }));
    const to = seenOf(task('w', { phase: 'IN_PROGRESS', user_status: { state: 'working' } }));
    expect(changeLine({ taskId: 'w', title: 'Ship "it"', from, to, at: T0 }))
      .toBe('- "Ship \'it\'" (w): Needs you → Working at 17:00 UTC. It no longer asks the user: "Sign in on the Mac".');
  });
});

describe('who hears it', () => {
  it('a settled change goes to the asker (riding its next message, no queue row) and to the running leader and Main; an idle VP waits for its team note', async () => {
    requests = [{ fromSessionId: 's-asker', toTaskId: 'w' }, { fromSessionId: 's-w', toTaskId: 'w' }];
    const now = Date.now();
    emit(task('w', { parent_task_id: 'lead', phase: 'IN_PROGRESS', user_status: { state: 'working' } }));
    expect(_pendingStatusPush()).toHaveLength(1);
    // Not settled yet: nothing goes.
    expect(await flushStatusPush(now + 1000)).toBe(0);
    const sent = await flushStatusPush(Date.now() + SETTLE_MS + 1);
    expect(sent).toBe(3);
    expect(followers()).toEqual(['s-lead', 's-main']);
    // Never into a session by itself, never a queue row (a pending row is re-sent on a restart or
    // reconnect): a line written into a running turn often landed as a turn of its own.
    expect(delivered).toEqual([]);
    expect(queued).toEqual([]);
    const note = pendingStatusNote('s-asker')!;
    expect(note.text).toContain('Needs you → Working');
    note.markTold();
    expect(pendingStatusNote('s-asker')).toBeNull();
    expect(ride()).toContain('Needs you → Working');
    expect(ride()).toContain('Walnut\'s record, not a report');
    // The task's own session never hears about itself.
    expect(pendingStatusNote('s-w')).toBeNull();
  });

  it('a snoozed task: its leader still hears (team work goes on); its VP and Main, who tell the user, do not', async () => {
    sessions.find((s) => s.claudeSessionId === 's-vp')!.process_status = 'running';
    emit(task('w', { parent_task_id: 'lead', phase: 'WAITING', user_status: { state: 'waiting', kind: 'time', waitingOn: 'Snoozed until 2026-11-13', snoozed: { until: '2026-11-13' } } }));
    expect(await flushStatusPush(Date.now() + SETTLE_MS + 1)).toBe(1);
    expect(followers()).toEqual(['s-lead']);
    expect(ride()).toContain('Snoozed');
  });

  it('a running VP hears it too; a change that settles where it began is no news', async () => {
    sessions.find((s) => s.claudeSessionId === 's-vp')!.process_status = 'running';
    const now = Date.now();
    emit(task('w', { parent_task_id: 'lead', phase: 'IN_PROGRESS', user_status: { state: 'working' } }));
    emit(task('w', { parent_task_id: 'lead', user_status: needs('Sign in on the Mac') }));
    expect(await flushStatusPush(Date.now() + SETTLE_MS + 1)).toBe(0);
    emit(task('w', { parent_task_id: 'lead', phase: 'WAITING', user_status: { state: 'waiting', kind: 'task', waitingOn: 'The review' } }));
    expect(await flushStatusPush(Date.now() + SETTLE_MS + 1)).toBe(3);
    expect(followers()).toEqual(['s-lead', 's-main', 's-vp']);
    expect(ride()).toContain('Waiting (on another task)');
  });

  it("a re-check turn's Working is held until the turn ends, and a re-check that ends asking again is no news", async () => {
    const recheck = { at: new Date().toISOString(), count: 1, ask: 'Sign in on the Mac' };
    emit(task('w', { parent_task_id: 'lead', phase: 'IN_PROGRESS', user_status: { state: 'working' }, needs_recheck: recheck }));
    expect(await flushStatusPush(Date.now() + SETTLE_MS + 1)).toBe(0);
    expect(_pendingStatusPush()).toHaveLength(1);
    emit(task('w', { parent_task_id: 'lead', user_status: needs('Sign in on the Mac, still needed'), needs_recheck: recheck }));
    expect(await flushStatusPush(Date.now() + SETTLE_MS + 1)).toBe(0);
    expect(_pendingStatusPush()).toHaveLength(0);
    // The re-check found it done: that is news.
    emit(task('w', { parent_task_id: 'lead', phase: 'IN_PROGRESS', user_status: { state: 'working' }, needs_recheck: recheck }));
    emit(task('w', { parent_task_id: 'lead', phase: 'WAITING', user_status: { state: 'waiting', kind: 'task', waitingOn: 'The review' }, needs_recheck: recheck }));
    expect(await flushStatusPush(Date.now() + SETTLE_MS + 1)).toBe(2);
    expect(ride()).toContain('Needs you → Waiting (on another task)');
  });

  it("the moment between a turn's end and its report is no news, and a plugin's own task is followed by no one", async () => {
    emit(task('w', { parent_task_id: 'lead', user_status: { state: 'waiting', kind: 'other', waitingOn: 'Its report on the turn that just ended', transient: true } }));
    expect(_pendingStatusPush()).toHaveLength(0);
    tasks.set('p', task('p', { parent_task_id: 'lead', plugin_only: '@test-run', user_status: needs('x') }));
    emit(task('p', { parent_task_id: 'lead', plugin_only: '@test-run', phase: 'IN_PROGRESS', user_status: { state: 'working' } }));
    expect(_pendingStatusPush()).toHaveLength(0);
  });

  it('a wait only reworded is no news; a new kind of wait is', async () => {
    tasks.set('r', task('r', { parent_task_id: 'lead', phase: 'WAITING', user_status: { state: 'waiting', kind: 'task', waitingOn: 'The review' } }));
    emit(tasks.get('r')!);
    emit(task('r', { parent_task_id: 'lead', phase: 'WAITING', user_status: { state: 'waiting', kind: 'task', waitingOn: 'The review of the second draft' } }));
    expect(await flushStatusPush(Date.now() + SETTLE_MS + 1)).toBe(0);
    emit(task('r', { parent_task_id: 'lead', phase: 'WAITING', user_status: { state: 'waiting', kind: 'time', waitingOn: 'Tomorrow 9 AM' } }));
    expect(await flushStatusPush(Date.now() + 2 * SETTLE_MS + 2)).toBe(2);
  });

  it('a turn that only started is no news; its end is', async () => {
    tasks.set('q', task('q', { parent_task_id: 'lead', phase: 'WAITING', user_status: { state: 'waiting', kind: 'task', waitingOn: 'The review' } }));
    emit(tasks.get('q')!);
    emit(task('q', { parent_task_id: 'lead', phase: 'IN_PROGRESS', user_status: { state: 'working' } }));
    expect(await flushStatusPush(Date.now() + SETTLE_MS + 1)).toBe(0);
    emit(task('q', { parent_task_id: 'lead', phase: 'COMPLETE', status: 'done' }));
    expect(await flushStatusPush(Date.now() + 2 * SETTLE_MS + 2)).toBe(2);
    expect(ride()).toContain('Working → Completed');
  });

  it('right after a start the baseline follows silently (a restart catching up)', async () => {
    stopStatusPush();
    await startStatusPush({ quietMs: 60_000 });
    emit(task('w', { parent_task_id: 'lead', phase: 'IN_PROGRESS', user_status: { state: 'working' } }));
    expect(_pendingStatusPush()).toHaveLength(0);
  });

  it('two changes of one task ride as its newest line only', async () => {
    requests = [{ fromSessionId: 's-asker', toTaskId: 'w' }];
    emit(task('w', { parent_task_id: 'lead', phase: 'IN_PROGRESS', user_status: { state: 'working' } }));
    await flushStatusPush(Date.now() + SETTLE_MS + 1);
    emit(task('w', { parent_task_id: 'lead', phase: 'COMPLETE', status: 'done' }));
    await flushStatusPush(Date.now() + 2 * SETTLE_MS + 2);
    const text = pendingStatusNote('s-asker')!.text;
    expect(text).toContain('Working → Completed');
    expect(text).not.toContain('Needs you → Working');
  });

  it('the first status seen of a task is the baseline, not news; a completion is', async () => {
    const fresh = task('new', { parent_task_id: 'lead', user_status: needs('Pick a name') });
    emit(fresh);
    expect(_pendingStatusPush()).toHaveLength(0);
    tasks.set('new', fresh);
    emit({ ...fresh, phase: 'COMPLETE', status: 'done' } as Task);
    expect(await flushStatusPush(Date.now() + SETTLE_MS + 1)).toBe(2);
    expect(ride()).toContain('Needs you → Completed');
  });
});

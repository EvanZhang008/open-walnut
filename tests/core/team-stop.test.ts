/**
 * Team stop (src/core/sessions/team-stop.ts): one step stops every open task under a task, its
 * own too unless left out: their live sessions (never the caller's), their armed triggers, their
 * wake clocks; a running turn may finish first; resume turns exactly those triggers and clocks
 * back on, and leaves a closed task alone.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionRecord, Task } from '../../src/core/types.js';

const tasks = new Map<string, Task>();
let sessions: SessionRecord[] = [];
let triggers: { id: string; target: string; state: string }[] = [];
const terminated: string[] = [];
const patched: { id: string; enabled: boolean }[] = [];
let cronOwner = new Set<string>();

vi.mock('../../src/core/task-manager.js', () => ({
  getTask: async (id: string) => { const t = tasks.get(id); if (!t) throw new Error(`No task found matching "${id}"`); return t; },
  listTasks: async () => [...tasks.values()],
  listTasksByIds: async (ids: string[]) => ids.map((id) => tasks.get(id)).filter(Boolean),
  updateTaskRaw: async (id: string, upd: Partial<Task> | ((cur: Task) => Partial<Task> | null)) => {
    const t = tasks.get(id);
    if (!t) return { changed: false };
    const patch = typeof upd === 'function' ? upd(t) : upd;
    if (!patch) return { changed: false };
    // null clears a payload field, as the store does.
    const next = Object.fromEntries(Object.entries({ ...t, ...patch }).filter(([k, v]) => v !== null || k === 'team_stop' || k === 'promise_alarm')) as Task;
    tasks.set(id, next);
    return { changed: true, task: next };
  },
}));
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionsForTask: async (id: string) => sessions.filter((s) => s.taskId === id),
  getSessionByClaudeId: async (sid: string) => sessions.find((s) => s.claudeSessionId === sid) ?? null,
}));
let asks: { id: string; fromSessionId: string; toTaskId: string; status: string }[] = [];
vi.mock('../../src/core/session-requests.js', () => ({
  pendingRequestsFromSession: async (sid: string) => asks.filter((a) => a.fromSessionId === sid && a.status === 'pending'),
  withdrawRequest: async (id: string) => { const a = asks.find((x) => x.id === id); if (!a) return null; a.status = 'withdrawn'; return a; },
  restoreRequest: async (id: string) => { const a = asks.find((x) => x.id === id && x.status === 'withdrawn'); if (!a) return null; a.status = 'pending'; return a; },
}));
vi.mock('../../src/core/session-message-queue.js', () => ({
  getQueue: async () => [],
  deleteMessage: async () => true,
}));
vi.mock('../../src/core/routines/routines-core.js', () => ({
  // Triggers and plain clocks alike: any routine whose session executor targets the task.
  listRoutines: async () => ({ jobs: triggers.map((t) => ({ id: t.id, enabled: t.state === 'armed', executor: { type: 'session', config: { target: t.target } } })) }),
  patchRoutine: async (id: string, body: { enabled: boolean }) => {
    patched.push({ id, enabled: body.enabled });
    const t = triggers.find((x) => x.id === id);
    if (t) t.state = body.enabled ? 'armed' : 'paused';
    return { job: {} };
  },
}));
vi.mock('../../src/core/sessions/session-lifecycle.js', () => ({
  terminateSession: async (sid: string) => {
    if (cronOwner.has(sid)) throw Object.assign(new Error('owns crons'), { extra: { code: 'cron_owner' } });
    terminated.push(sid);
    const s = sessions.find((x) => x.claudeSessionId === sid);
    if (s) s.process_status = 'stopped';
    return { status: 'terminated' };
  },
}));

import { _resetTeamStopForTest, _turnEndStopsForTest, resumeTeam, stopTeam, stoppedByTeam, teamOf } from '../../src/core/sessions/team-stop.js';
import { bus, EventNames } from '../../src/core/event-bus.js';

const task = (id: string, extra: Partial<Task> = {}): Task =>
  ({ id, title: `T ${id}`, phase: 'IN_PROGRESS', status: 'in_progress', ...extra }) as Task;
const sess = (sid: string, taskId: string, status = 'idle'): SessionRecord =>
  ({ claudeSessionId: sid, taskId, process_status: status }) as SessionRecord;

beforeEach(() => {
  tasks.clear();
  sessions = [];
  triggers = [];
  terminated.length = 0;
  patched.length = 0;
  cronOwner = new Set();
  asks = [];
  _resetTeamStopForTest();
  // lead → a, b; a → a1 (two levels); done is closed; other is not in the team.
  for (const t of [
    task('lead'), task('a', { parent_task_id: 'lead' }), task('b', { parent_task_id: 'lead', phase: 'WAITING', wait_until: '2026-11-01T00:00:00.000Z' }),
    task('a1', { parent_task_id: 'a' }), task('done', { parent_task_id: 'lead', phase: 'COMPLETE', status: 'done' }), task('other'),
  ]) tasks.set(t.id, t);
});

describe('teamOf', () => {
  it('every open task under it, every level, root first; closed ones and strangers left out', () => {
    expect(teamOf(tasks.get('lead')!, [...tasks.values()]).map((t) => t.id)).toEqual(['lead', 'a', 'a1', 'b']);
    expect(teamOf(tasks.get('lead')!, [...tasks.values()], false).map((t) => t.id)).toEqual(['a', 'a1', 'b']);
  });
});

describe('stopTeam / resumeTeam', () => {
  it('stops every live session but the caller\'s, pauses armed triggers, takes clocks off; resume restores exactly those', async () => {
    sessions = [sess('s-lead', 'lead', 'running'), sess('s-a', 'a', 'running'), sess('s-a1', 'a1'), sess('s-b-old', 'b', 'stopped'), sess('s-other', 'other')];
    triggers = [{ id: 'tr-b', target: 'b', state: 'armed' }, { id: 'tr-a1', target: 'a1', state: 'paused' }, { id: 'tr-o', target: 'other', state: 'armed' }];
    tasks.set('lead', { ...tasks.get('lead')!, promise_alarm: { at: '2026-10-29T00:00:00.000Z', words: 'the review', set_at: '2026-10-28T00:00:00.000Z' } });
    asks = [{ id: 'rq-lead-a', fromSessionId: 's-lead', toTaskId: 'a', status: 'pending' }, { id: 'rq-lead-x', fromSessionId: 's-lead', toTaskId: 'other', status: 'pending' }];

    const out = await stopTeam('lead', { by: 'task:lead', callerSid: 's-lead' });
    expect(out.tasks).toBe(4);
    expect(terminated.sort()).toEqual(['s-a', 's-a1']);
    expect(out.kept).toEqual([expect.objectContaining({ sessionId: 's-lead', why: expect.stringContaining('asked for the stop') })]);
    expect(patched).toEqual([{ id: 'tr-b', enabled: false }]);
    expect(out.pausedTriggers).toBe(1);
    expect(tasks.get('b')!.wait_until).toBeUndefined();
    expect(tasks.get('lead')!.promise_alarm).toBeNull();
    expect(out.clocksOff).toBe(2);
    expect(tasks.get('lead')!.team_stop?.members.map((m) => m.id).sort()).toEqual(['b', 'lead']);
    // An ask between members is withdrawn (its fallback would resume the stopped asker); one outside stays.
    expect(asks.map((a) => a.status)).toEqual(['withdrawn', 'pending']);
    // Their parent hears no "stopped" for a while; others are not quieted.
    expect(stoppedByTeam('a')).toBe(true);
    expect(stoppedByTeam('other')).toBe(false);
    expect(terminated).not.toContain('s-other');

    const back = await resumeTeam('lead', { by: 'human' });
    expect(back).toMatchObject({ resumedTriggers: 1, clocksOn: 2, skipped: 0 });
    expect(patched.at(-1)).toEqual({ id: 'tr-b', enabled: true });
    expect(triggers.find((t) => t.id === 'tr-a1')!.state).toBe('paused'); // it was paused before: left as it was
    expect(tasks.get('b')!.wait_until).toBe('2026-11-01T00:00:00.000Z');
    expect(tasks.get('lead')!.promise_alarm?.words).toBe('the review');
    expect(tasks.get('lead')!.team_stop).toBeNull();
    expect(asks.map((a) => a.status)).toEqual(['pending', 'pending']);
  });

  it('a second stop before a resume keeps what the first one turned off', async () => {
    triggers = [{ id: 'tr-b', target: 'b', state: 'armed' }];
    await stopTeam('lead', { by: 'human' });
    tasks.set('a1', { ...tasks.get('a1')!, phase: 'WAITING', wait_until: '2026-11-02T00:00:00.000Z' });
    await stopTeam('lead', { by: 'human' });
    const members = tasks.get('lead')!.team_stop!.members;
    expect(members.find((m) => m.id === 'b')).toMatchObject({ triggers: ['tr-b'], wait_until: '2026-11-01T00:00:00.000Z' });
    expect(members.find((m) => m.id === 'a1')?.wait_until).toBe('2026-11-02T00:00:00.000Z');
    const back = await resumeTeam('lead', { by: 'human' });
    expect(back.resumedTriggers).toBe(1);
    expect(tasks.get('a1')!.wait_until).toBe('2026-11-02T00:00:00.000Z');
  });

  it('a session owning scheduled jobs is kept and said so; a member closed by resume time is left alone', async () => {
    sessions = [sess('s-a', 'a')];
    cronOwner.add('s-a');
    triggers = [{ id: 'tr-a1', target: 'a1', state: 'armed' }];
    const out = await stopTeam('lead', { by: 'human' });
    expect(out.kept).toEqual([expect.objectContaining({ sessionId: 's-a', why: expect.stringContaining('scheduled jobs') })]);
    tasks.set('a1', { ...tasks.get('a1')!, phase: 'COMPLETE', status: 'done' });
    const back = await resumeTeam('lead', { by: 'human' });
    // a1 closed since: its trigger stays off. b still waits: its clock comes back.
    expect(back).toMatchObject({ skipped: 1, resumedTriggers: 0, clocksOn: 1 });
  });

  it('when turn_end: a running turn finishes first, then that session stops; a resume before then cancels it', async () => {
    // A module first imported under fake timers never resolves: load the stop's imports first.
    await import('../../src/core/sessions/session-lifecycle.js');
    await import('../../src/core/session-tracker.js');
    await import('../../src/core/task-manager.js');
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      sessions = [sess('s-a', 'a', 'running'), sess('s-a1', 'a1', 'running')];
      const out = await stopTeam('lead', { by: 'human', when: 'turn_end', includeRoot: false });
      expect(out.atTurnEnd.map((r) => r.sessionId).sort()).toEqual(['s-a', 's-a1']);
      expect(terminated).toEqual([]);
      await vi.waitFor(() => expect(_turnEndStopsForTest().length).toBe(2));
      sessions[0].process_status = 'idle';
      bus.emit(EventNames.SESSION_STATUS_CHANGED, { sessionId: 's-a', process_status: 'idle' }, ['*']);
      await vi.advanceTimersByTimeAsync(3_100);
      await vi.waitFor(() => expect(terminated).toEqual(['s-a']));
      await resumeTeam('lead', { by: 'human' });
      sessions[1].process_status = 'idle';
      bus.emit(EventNames.SESSION_STATUS_CHANGED, { sessionId: 's-a1', process_status: 'idle' }, ['*']);
      await vi.advanceTimersByTimeAsync(3_100);
      expect(terminated).toEqual(['s-a']);
    } finally {
      vi.useRealTimers();
    }
  });
});

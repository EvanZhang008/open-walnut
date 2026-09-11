/**
 * Where a reply lands (core/sessions/reply-routing.ts).
 *
 * The address on a request row is the session that REGISTERED it, and that is
 * not the same thing as the session the human is reading. 2026-09-11:
 * `rq-8e37b02f` was registered by `c6ce9199`, the human forked it and carried on
 * in the fork (a new task), and the answer six minutes later was filed in the
 * idle original. These tests pin the ladder that closes that gap AND the rung
 * that must never change: a live asker resolves to itself, silently.
 *
 * The session registry is mocked at its module seam — this is pure routing
 * arithmetic over records, no store and no delivery.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const listSessions = vi.fn();
const getSessionByClaudeId = vi.fn();
const getSessionsForTask = vi.fn();
vi.mock('../../src/core/session-tracker.js', () => ({
  listSessions: (...args: unknown[]) => listSessions(...args),
  getSessionByClaudeId: (...args: unknown[]) => getSessionByClaudeId(...args),
  getSessionsForTask: (...args: unknown[]) => getSessionsForTask(...args),
  // Same two exclusions the real predicate makes (lane-bound + environment).
  isListableSession: (s: { lane?: string; type?: string; provider?: string }) =>
    !s.lane && s.type !== 'triage' && s.type !== 'hook' && s.type !== 'cron'
    && !(s.type === 'subagent' && s.provider === 'embedded'),
}));

import { resolveReplyDestination } from '../../src/core/sessions/reply-routing.js';
import type { SessionRecord } from '../../src/core/types.js';

/** Distinct, ordered timestamps so "newest" is unambiguous. */
const T = (n: number) => `2026-09-11T02:${String(n).padStart(2, '0')}:00.000Z`;

function rec(claudeSessionId: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    claudeSessionId,
    taskId: '',
    project: '',
    process_status: 'idle',
    mode: 'default',
    provider: 'cli',
    startedAt: T(0),
    lastActiveAt: T(0),
    messageCount: 1,
    ...overrides,
  } as SessionRecord;
}

let sessions: SessionRecord[] = [];

beforeEach(() => {
  sessions = [];
  listSessions.mockReset();
  getSessionByClaudeId.mockReset();
  getSessionsForTask.mockReset();
  listSessions.mockImplementation(async () => sessions);
  getSessionByClaudeId.mockImplementation(async (sid: string) =>
    sessions.find((s) => s.claudeSessionId === sid) ?? null);
  getSessionsForTask.mockImplementation(async (taskId: string) =>
    sessions.filter((s) => s.taskId === taskId));
});

describe('resolveReplyDestination — the unchanged common case', () => {
  it('returns the registering session itself, with no re-route reason', async () => {
    sessions = [rec('asker', { taskId: 'task-a', process_status: 'idle' })];

    const dest = await resolveReplyDestination('asker');

    expect(dest?.session.claudeSessionId).toBe('asker');
    expect(dest?.reason).toBeUndefined();
    // A live asker must cost nothing beyond its own lookup.
    expect(listSessions).not.toHaveBeenCalled();
    expect(getSessionsForTask).not.toHaveBeenCalled();
  });

  it('a running asker is just as live as an idle one', async () => {
    sessions = [rec('asker', { process_status: 'running' })];
    expect((await resolveReplyDestination('asker'))?.reason).toBeUndefined();
  });

  it('keeps a stopped asker when nothing better exists (today’s behavior)', async () => {
    sessions = [rec('asker', { taskId: 'task-a', process_status: 'stopped' })];

    const dest = await resolveReplyDestination('asker');

    expect(dest?.session.claudeSessionId).toBe('asker');
    expect(dest?.reason).toBeUndefined();
  });

  it('is null when the asker row is gone or archived', async () => {
    expect(await resolveReplyDestination('vanished')).toBeNull();

    sessions = [rec('asker', { archived: true })];
    expect(await resolveReplyDestination('asker')).toBeNull();
  });
});

describe('resolveReplyDestination — the requester task moved on', () => {
  it('lands in the task’s newer live session, not the stopped one that asked', async () => {
    sessions = [
      rec('asker', { taskId: 'task-a', process_status: 'stopped', lastActiveAt: T(1) }),
      rec('newer', { taskId: 'task-a', process_status: 'idle', lastActiveAt: T(9) }),
    ];

    const dest = await resolveReplyDestination('asker');

    expect(dest?.session.claudeSessionId).toBe('newer');
    expect(dest?.reason).toBe('task-current-session');
  });

  it('skips archived and lane-bound rows of the same task', async () => {
    sessions = [
      rec('asker', { taskId: 'task-a', process_status: 'error' }),
      rec('archived', { taskId: 'task-a', process_status: 'idle', archived: true, lastActiveAt: T(9) }),
      rec('side', { taskId: 'task-a', process_status: 'idle', lane: 'side:asker:sth-1', lastActiveAt: T(8) }),
      rec('real', { taskId: 'task-a', process_status: 'idle', lastActiveAt: T(2) }),
    ];

    const dest = await resolveReplyDestination('asker');

    expect(dest?.session.claudeSessionId).toBe('real');
    expect(dest?.reason).toBe('task-current-session');
  });

  it('never re-routes into an environment session that shares the task', async () => {
    sessions = [
      rec('asker', { taskId: 'task-a', process_status: 'stopped' }),
      rec('triage', { taskId: 'task-a', process_status: 'running', type: 'triage', lastActiveAt: T(9) }),
    ];

    const dest = await resolveReplyDestination('asker');

    expect(dest?.session.claudeSessionId).toBe('asker');
    expect(dest?.reason).toBeUndefined();
  });

  it('does not re-route to a second DEAD row of the same task', async () => {
    sessions = [
      rec('asker', { taskId: 'task-a', process_status: 'stopped', lastActiveAt: T(1) }),
      rec('alsoDead', { taskId: 'task-a', process_status: 'stopped', lastActiveAt: T(9) }),
    ];

    const dest = await resolveReplyDestination('asker');

    expect(dest?.session.claudeSessionId).toBe('asker');
    expect(dest?.reason).toBeUndefined();
  });
});

describe('resolveReplyDestination — a live fork of the asker', () => {
  it('delivers to the fork even though the fork carries a DIFFERENT task', async () => {
    // The 2026-09-11 shape exactly.
    sessions = [
      rec('c6ce9199', { taskId: 'msgetfbj', process_status: 'stopped', lastActiveAt: T(1) }),
      rec('db7ba385', {
        taskId: 'mtwcbm2m', process_status: 'idle',
        forkedFromSessionId: 'c6ce9199', lastActiveAt: T(5),
      }),
    ];

    const dest = await resolveReplyDestination('c6ce9199');

    expect(dest?.session.claudeSessionId).toBe('db7ba385');
    expect(dest?.reason).toBe('live-fork');
  });

  it('walks a fork of a fork and picks the NEWEST live descendant', async () => {
    sessions = [
      rec('root', { taskId: 't0', process_status: 'stopped' }),
      rec('gen1', { taskId: 't1', process_status: 'stopped', forkedFromSessionId: 'root', lastActiveAt: T(3) }),
      rec('gen2', { taskId: 't2', process_status: 'idle', forkedFromSessionId: 'gen1', lastActiveAt: T(4) }),
      rec('gen2b', { taskId: 't3', process_status: 'idle', forkedFromSessionId: 'gen1', lastActiveAt: T(7) }),
    ];

    const dest = await resolveReplyDestination('root');

    expect(dest?.session.claudeSessionId).toBe('gen2b');
    expect(dest?.reason).toBe('live-fork');
  });

  it('never delivers into a hidden side-thread fork', async () => {
    sessions = [
      rec('asker', { taskId: 't0', process_status: 'stopped' }),
      rec('sidefork', {
        taskId: '', process_status: 'idle',
        lane: 'side:asker:sth-9', forkedFromSessionId: 'asker',
      }),
    ];

    const dest = await resolveReplyDestination('asker');

    expect(dest?.session.claudeSessionId).toBe('asker');
    expect(dest?.reason).toBeUndefined();
  });

  it('finds a live fork even when the asker row itself is gone', async () => {
    sessions = [
      rec('fork', { taskId: 't1', process_status: 'running', forkedFromSessionId: 'ghost' }),
    ];

    const dest = await resolveReplyDestination('ghost');

    expect(dest?.session.claudeSessionId).toBe('fork');
    expect(dest?.reason).toBe('live-fork');
  });

  it('a self-referential forkedFromSessionId cannot loop', async () => {
    sessions = [rec('loop', { taskId: 't0', process_status: 'stopped', forkedFromSessionId: 'loop' })];
    const dest = await resolveReplyDestination('loop');
    expect(dest?.session.claudeSessionId).toBe('loop');
    expect(dest?.reason).toBeUndefined();
  });
});

describe('resolveReplyDestination — exclusions', () => {
  it('never routes an answer back into the session that is answering', async () => {
    sessions = [
      rec('asker', { taskId: 'task-a', process_status: 'idle' }),
    ];

    expect(await resolveReplyDestination('asker', { exclude: ['asker'] })).toBeNull();
  });

  it('skips an excluded fork and falls back to the asker', async () => {
    sessions = [
      rec('asker', { taskId: 't0', process_status: 'stopped' }),
      rec('replier', { taskId: 't1', process_status: 'running', forkedFromSessionId: 'asker' }),
    ];

    const dest = await resolveReplyDestination('asker', { exclude: ['replier'] });

    expect(dest?.session.claudeSessionId).toBe('asker');
    expect(dest?.reason).toBeUndefined();
  });
});

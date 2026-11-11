/**
 * The kanban card's words keep the session that wrote them (2026-11-07): the summary,
 * the waiting on and the status line each carry their writer's source, never the task's
 * current session. Split from tests/web/kanban-model.test.ts (500-line hygiene cap).
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '@open-walnut/core';
import { summaryHash, type BoardCard } from '../../src/core/boards/board-lanes';
import { MIN, ago, vm, withSession } from './kanban-card-fixtures';

describe('summary and waiting on: links keep their writer (2026-11-07)', () => {
  const REMOTE_WRITER = 'sess-old-writer-on-devbox-0000';

  it('raw Markdown keeps its links and task refs; the plain text is still the hash', () => {
    const md = 'See [the log](/home/me/run.log) and <task-ref id="abcd1234" label="the fix"/> for `retry`';
    const t = withSession({ summary: md });
    const c = vm(t, null, { card: { worker_summary_at: ago(MIN) } });
    expect(c.summary?.text).toBe(md);
    expect(c.summary?.plain).not.toContain('](');
    expect(c.snapshot.summaryHash).toBe(summaryHash(c.summary!.plain));
  });

  it('a task summary takes the session stored with it, never the task\'s current session', () => {
    const t = withSession({ summary: 'Open /home/me/a.ts', summary_session_id: REMOTE_WRITER } as Partial<Task>);
    const c = vm(t);
    expect(c.summary?.textSource).toEqual({ sessionId: REMOTE_WRITER });
    expect(c.summary?.textSource.sessionId).not.toBe(c.sessionId);
    // An older payload with no writer reads unknown: the machine chooser, not the current session.
    expect(vm(withSession({ summary: 'Open /home/me/a.ts' })).summary?.textSource).toEqual({ unknownSource: true });
  });

  it('a card summary and waiting on each take their own saved writer', () => {
    const t = withSession();
    const card: BoardCard = {
      lane: 'waiting-cr', lane_at: ago(MIN), lane_by: 'human',
      summary: 'Leader: [diff](/srv/x.diff)', summary_at: ago(MIN), summary_by: 'task:owner-task-id', summary_session_id: REMOTE_WRITER,
      waiting_on: 'CR in /home/me/cr.txt', waiting_on_at: ago(MIN), waiting_on_by: 'human',
    };
    const c = vm(t, null, { card });
    expect(c.summary?.source).toBe('card');
    expect(c.summary?.text).toBe('Leader: [diff](/srv/x.diff)');
    expect(c.summary?.textSource).toEqual({ sessionId: REMOTE_WRITER });
    expect(c.waiting?.textSource).toEqual({ host: '__local__' });
    // The task's session moved to another host: the card's words keep the session that wrote them.
    const moved = vm({ ...t, session_id: 'sess-new-on-other-host', session_ids: ['sess-new-on-other-host'] }, null, { card });
    expect(moved.summary?.textSource).toEqual({ sessionId: REMOTE_WRITER });
    // An agent's words Walnut could not verify (no session stamped) are unknown, never the current session.
    const agent = vm(t, null, { card: { ...card, summary_session_id: undefined, waiting_on_by: 'agent' } });
    expect(agent.summary?.textSource).toEqual({ unknownSource: true });
    expect(agent.waiting?.textSource).toEqual({ unknownSource: true });
    expect(c.cardWords).toEqual({ summary: card.summary, waiting_on: card.waiting_on });
  });

  it('the status line names the writer of the words it quotes (ask, now, waiting on), never the current session', () => {
    const ended = { phase: 'NEED_ACTION' as const };
    type US = NonNullable<Task['user_status']>;
    const st = (us: US, p: Partial<Task> = ended) => vm(withSession({ ...p, user_status: us })).status;
    // A session's ask: the writer stored with the ask.
    const ask = st({ state: 'needs', source: 'session', ask: 'Read /home/me/a.log', askBy: 'self', askSessionId: REMOTE_WRITER } as US);
    expect(ask.textSource).toEqual({ sessionId: REMOTE_WRITER });
    // A person's ask: the primary. No writer recorded: unknown, never the task's session.
    expect(st({ state: 'needs', source: 'session', ask: 'x', askBy: 'human' } as US).textSource).toEqual({ host: '__local__' });
    expect(st({ state: 'needs', ask: 'Approve the real iPhone test?' } as US).textSource).toEqual({ unknownSource: true });
    // A turn to read quotes its last words: their session.
    const turn = vm(withSession({ ...ended, user_status: { state: 'read', toRead: 'turn', waitingOn: 'See /srv/out.txt' } as US,
      last_words: { text: 'See /srv/out.txt', session_id: REMOTE_WRITER } } as Partial<Task>)).status;
    expect(turn.textSource).toEqual({ sessionId: REMOTE_WRITER });
    // Working on its own: the report's now.
    const now = st({ state: 'working', carriesOn: 'process', now: 'Tail /tmp/run.log', reportSessionId: REMOTE_WRITER } as US, { phase: 'IN_PROGRESS' });
    expect([now.kind, now.textSource]).toEqual(['carries-on', { sessionId: REMOTE_WRITER }]);
    expect(st({ state: 'working', carriesOn: 'process' } as US, { phase: 'IN_PROGRESS' }).textSource).toBeUndefined();
    // A wait: the writer stored with the wait, for waiting and stuck alike.
    const wait = st({ state: 'waiting', kind: 'outside', waitingOn: 'CR in /home/me/cr.txt', waitingSessionId: REMOTE_WRITER } as US);
    expect([wait.kind, wait.textSource]).toEqual(['waiting', { sessionId: REMOTE_WRITER }]);
    expect(st({ state: 'waiting', kind: 'stuck', waitingOn: 'It stopped', waitingBy: 'human' } as US).textSource).toEqual({ host: '__local__' });
    expect(st({ state: 'waiting', kind: 'lead', waitingOn: 'Its lead' } as US).textSource).toEqual({ unknownSource: true });
    // Walnut's own lines carry no writer at all.
    expect(st({ state: 'waiting', kind: 'time', until: '2026-10-04T09:00:00Z' } as US).textSource).toBeUndefined();
    expect(vm(withSession(), { process_status: 'running', activity: 'reading files' }).status.textSource).toBeUndefined();
    expect(vm(withSession(), { process_status: 'error', errorMessage: 'boom' }).status.textSource).toBeUndefined();
    expect(vm(withSession(), { process_status: 'running', pendingPermissionTool: 'Bash' }).status.textSource).toBeUndefined();
    // The task's current session is never the stand-in.
    const c = vm(withSession({ ...ended, user_status: { state: 'needs', source: 'session', ask: 'Read /home/me/a.log', askSessionId: REMOTE_WRITER } as US }));
    expect(c.sessionId).toBeTruthy();
    expect(c.status.textSource?.sessionId).toBe(REMOTE_WRITER);
    expect(c.status.textSource?.sessionId).not.toBe(c.sessionId);
  });
});

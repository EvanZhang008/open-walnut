/**
 * A sent message sits in history where Claude Code TOOK it, over every send path.
 *
 * 2026-10-31 (the user: "my own input jumped above the answer"): a mid-turn send
 * was placed at its `enqueue`, so the words the model wrote between the send and
 * the take (written before it saw the message) read as its answer, and a line
 * still waiting in the queue sat above the reply streaming under it. Now:
 *
 *  - idle send / queued until the turn ends: the CLI's own user line, after the
 *    turn it waited behind (unchanged);
 *  - mid-turn take: at its `queued_command` attachment;
 *  - still waiting (a read before the take): at the end, `queued`, unsettled;
 *  - an orphan a dead process left (a later line was taken first): where it was
 *    sent, settled (it must never block the incremental parse, nor make every
 *    delta a rebuild);
 *  - an older CLI that never logged its takes: where it was sent.
 *
 * Line shapes are the CLI 2.1.280 transcript's, neutral text.
 */
import { describe, it, expect } from 'vitest';
import { parseSessionMessages, floatQueuedRows, type SessionHistoryMessage } from '../../src/core/session-history.js';
import { collectRequestedRevisions } from '../../src/core/history-delta.js';

const T = (s: number) => new Date(Date.UTC(2026, 9, 31, 4, 12, s)).toISOString();
const enqueue = (content: string, s: number) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: T(s), sessionId: 's', content });
const remove = (content: string, s: number) => ({ type: 'queue-operation', operation: 'remove', timestamp: T(s), sessionId: 's', content });
const dequeue = (s: number) => ({ type: 'queue-operation', operation: 'dequeue', timestamp: T(s), sessionId: 's' });
const user = (uuid: string, parent: string | null, content: unknown, s: number) =>
  ({ type: 'user', uuid, parentUuid: parent, timestamp: T(s), message: { role: 'user', content } });
const assistant = (uuid: string, parent: string, id: string, content: unknown[], s: number) =>
  ({ type: 'assistant', uuid, parentUuid: parent, timestamp: T(s), message: { id, role: 'assistant', content } });
const said = (uuid: string, parent: string, text: string, s: number) => assistant(uuid, parent, `msg_${uuid}`, [{ type: 'text', text }], s);
const tool = (uuid: string, parent: string, id: string, s: number) =>
  assistant(uuid, parent, `msg_${uuid}`, [{ type: 'tool_use', id, name: 'Bash', input: { command: 'sleep 9' } }], s);
const result = (uuid: string, parent: string, id: string, s: number) =>
  user(uuid, parent, [{ type: 'tool_result', tool_use_id: id, content: 'ok' }], s);
const taken = (uuid: string, parent: string, prompt: string, s: number) => ({
  type: 'attachment', uuid, parentUuid: parent, timestamp: T(s),
  attachment: { type: 'queued_command', prompt, commandMode: 'prompt', source_uuid: `src-${uuid}` },
});

const parse = (lines: unknown[]) => parseSessionMessages(lines.map((l) => JSON.stringify(l)).join('\n'));
const order = (rows: SessionHistoryMessage[]) => rows.filter((m) => !m.injected && (m.role === 'user' ? !!m.text : !!m.text)).map((m) => `${m.role}:${m.text}`);

const Q = 'How does the cookie domain scoping work?';
const F = 'And what about subdomains?';
const A1 = 'Cookies are scoped to the host unless a Domain attribute widens them.';
const A2 = 'A subdomain sees a cookie only when Domain names its parent.';
const START = [enqueue(Q, 0), dequeue(0), user('uQ', null, Q, 0)];

describe('a sent message sits where Claude Code took it', () => {
  it('mid-turn take: at its queued_command attachment, after the words written before it', () => {
    const rows = parse([
      ...START,
      tool('t1', 'uQ', 'tu1', 1),
      enqueue(F, 2),
      said('a1', 't1', A1, 3), // written before the model saw F
      result('r1', 'a1', 'tu1', 4),
      taken('q1', 'r1', F, 4),
      remove(F, 4),
      said('a2', 'q1', A2, 5),
    ]);
    expect(order(rows)).toEqual([`user:${Q}`, `assistant:${A1}`, `user:${F}`, `assistant:${A2}`]);
    const f = rows.find((m) => m.text === F)!;
    expect(f.sourceUuid).toBe('src-q1');
    expect(f.queued).toBeUndefined();
    expect(f.unsettled).toBeUndefined();
  });

  it('a long turn (background work) taking several lines: each at its own take', () => {
    const G = 'One more: does SameSite matter here?';
    const A3 = 'SameSite decides cross-site sends, not which host sees it.';
    const rows = parse([
      ...START,
      tool('t1', 'uQ', 'tu1', 1),
      enqueue(F, 2), enqueue(G, 3),
      said('a1', 't1', A1, 4),
      result('r1', 'a1', 'tu1', 5),
      taken('q1', 'r1', F, 5), remove(F, 5),
      tool('t2', 'q1', 'tu2', 6),
      said('a2', 't2', A2, 7),
      result('r2', 'a2', 'tu2', 8),
      taken('q2', 'r2', G, 8), remove(G, 8),
      said('a3', 'q2', A3, 9),
    ]);
    expect(order(rows)).toEqual([`user:${Q}`, `assistant:${A1}`, `user:${F}`, `assistant:${A2}`, `user:${G}`, `assistant:${A3}`]);
  });

  it('queued until the turn ends: the CLI\'s own line after the reply it waited behind', () => {
    const rows = parse([
      ...START,
      enqueue(F, 1),
      said('a1', 'uQ', A1, 2),
      dequeue(3),
      user('uF', 'a1', F, 3),
      said('a2', 'uF', A2, 4),
    ]);
    expect(order(rows)).toEqual([`user:${Q}`, `assistant:${A1}`, `user:${F}`, `assistant:${A2}`]);
    expect(rows.filter((m) => m.text === F)).toHaveLength(1);
  });

  it('still waiting (a read before the take, a reload mid-turn): at the end, queued and unsettled', () => {
    const rows = parse([
      ...START,
      tool('t1', 'uQ', 'tu1', 1),
      enqueue(F, 2),
      said('a1', 't1', A1, 3),
    ]);
    expect(order(rows)).toEqual([`user:${Q}`, `assistant:${A1}`, `user:${F}`]);
    const f = rows[rows.length - 1];
    expect(f).toMatchObject({ role: 'user', text: F, queued: true, unsettled: true });
    // Its place changes when the CLI takes it: a re-ask for it is a rebuild, never a
    // revision in place (history-delta.ts).
    expect(collectRequestedRevisions(rows, [f.msgId!]).ambiguous).toBe(true);
  });

  it('an orphan a dead process left stays where it was sent and is not queued', () => {
    const rows = parse([
      ...START,
      enqueue(F, 1), // never taken: the process died
      said('a1', 'uQ', A1, 2),
      enqueue('Next question', 3), dequeue(3),
      user('uN', 'a1', 'Next question', 3),
      said('a2', 'uN', 'Next answer.', 4),
    ]);
    expect(order(rows)).toEqual([`user:${Q}`, `user:${F}`, `assistant:${A1}`, 'user:Next question', 'assistant:Next answer.']);
    const f = rows.find((m) => m.text === F)!;
    expect(f.queued).toBeUndefined();
    // Settled: a re-ask for it would rebuild the history on every delta.
    expect(f.unsettled).toBeUndefined();
  });

  it('a CLI that logs dequeues but left an earlier send untaken: the last turn\'s waiting row stays where it was sent', () => {
    // The shape of a CLI that never logged its mid-turn takes: a send in an earlier
    // turn was never logged as taken (it ran), so a later one cannot be trusted either.
    const rows = parse([
      ...START,
      enqueue('ran mid-turn, never logged', 1),
      said('a1', 'uQ', A1, 2),
      enqueue('Next question', 3), dequeue(3),
      user('uN', 'a1', 'Next question', 3),
      enqueue(F, 4),
      said('a2', 'uN', A2, 5),
    ]);
    expect(order(rows).slice(-2)).toEqual([`user:${F}`, `assistant:${A2}`]);
    expect(rows.some((m) => m.queued)).toBe(false);
  });

  it('an older CLI that never logged its takes keeps every send where it was sent', () => {
    const rows = parse([
      user('uQ', null, Q, 0),
      said('a1', 'uQ', A1, 1),
      enqueue(F, 2),
      said('a2', 'a1', A2, 3),
    ]);
    expect(order(rows)).toEqual([`user:${Q}`, `assistant:${A1}`, `user:${F}`, `assistant:${A2}`]);
    expect(rows.find((m) => m.text === F)!.queued).toBeUndefined();
  });

  it('floatQueuedRows moves the last turn\'s waiting rows to the end, with their parent ids, in order', () => {
    const rows: SessionHistoryMessage[] = [
      { role: 'user', text: 'u', timestamp: T(0) },
      { role: 'user', text: 'w1', timestamp: T(1), queued: true },
      { role: 'assistant', text: 'x', timestamp: T(2) },
      { role: 'user', text: 'w2', timestamp: T(3), queued: true },
      { role: 'assistant', text: 'y', timestamp: T(4) },
    ];
    const parents = [undefined, 'p1', undefined, 'p2', 'py'];
    floatQueuedRows(rows, parents);
    expect(rows.map((r) => r.text)).toEqual(['u', 'x', 'y', 'w1', 'w2']);
    expect(parents).toEqual([undefined, undefined, 'py', 'p1', 'p2']);
  });
});

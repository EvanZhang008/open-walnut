/**
 * A line queued in a CLI process that then ends is never taken: the CLI's queue
 * lives in its process. Walnut writes it again to the next process, so the
 * transcript reads: enqueue (old process) → the old turn's interrupt → enqueue
 * (new process) → dequeue → ONE user line. Pattern A gave that line to the first
 * enqueue and left the resend to render as a second copy (2026-10-29 real-CLI
 * acceptance run). Line shapes are Claude Code 2.1.284's transcript, neutral text.
 */
import { describe, it, expect } from 'vitest';
import { parseSessionMessages } from '../../src/core/session-history.js';

const T = (s: number) => new Date(Date.UTC(2026, 9, 29, 0, 21, s)).toISOString();
const enqueue = (content: string, s: number) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: T(s), sessionId: 's', content });
const dequeue = (s: number) => ({ type: 'queue-operation', operation: 'dequeue', timestamp: T(s), sessionId: 's' });
function user(uuid: string, parent: string | null, content: unknown, s: number) {
  return { type: 'user', uuid, parentUuid: parent, timestamp: T(s), message: { role: 'user', content } };
}
function assistant(uuid: string, parent: string, id: string, content: unknown[], s: number) {
  return { type: 'assistant', uuid, parentUuid: parent, timestamp: T(s), message: { id, role: 'assistant', content } };
}

const FIRST = 'Run sleep 30 with the Bash tool.';
const SENT = 'Reply with the word PLUM.';

const parse = (lines: unknown[]) => parseSessionMessages(lines.map((l) => JSON.stringify(l)).join('\n'));
const sentRows = (lines: unknown[]) => parse(lines).filter((m) => m.role === 'user' && m.text === SENT);

const HEAD = [
  enqueue(FIRST, 0), dequeue(0),
  user('u1', null, FIRST, 0),
  assistant('a1', 'u1', 'msg_bash', [{ type: 'tool_use', id: 'tb', name: 'Bash', input: { command: 'sleep 30' } }], 1),
  enqueue(SENT, 12), // queued in the process that is about to end
];
const RESTART = [
  user('r1', 'a1', [{ type: 'tool_result', tool_use_id: 'tb', content: 'Interrupted', is_error: true }], 16),
  user('i1', 'r1', '[Request interrupted by user for tool use]', 16),
  enqueue(SENT, 18), dequeue(18), // the next process gets it again
  assistant('a2', 'i1', 'msg_none', [{ type: 'text', text: 'No response requested.' }], 18),
  user('u2', 'a2', SENT, 18),
  assistant('a3', 'u2', 'msg_plum', [{ type: 'text', text: 'PLUM' }], 19),
];

describe('a message resent to the next CLI process', () => {
  it('is one row, the real user line, once the new process ran it', () => {
    const rows = sentRows([...HEAD, ...RESTART]);
    expect(rows).toHaveLength(1);
    expect(rows[0].msgId).toBe('u2');
  });

  it('is one pending row while the old process still holds it', () => {
    const rows = sentRows(HEAD);
    expect(rows).toHaveLength(1);
    expect(rows[0].msgId).toMatch(/^queue-/);
  });

  it('a message sent twice on purpose still shows twice', () => {
    // One process: each send is taken and logged before the next one is queued.
    const lines = [
      enqueue(SENT, 0), dequeue(0), user('u1', null, SENT, 0),
      assistant('a1', 'u1', 'msg_1', [{ type: 'text', text: 'PLUM' }], 1),
      enqueue(SENT, 2), dequeue(2), user('u2', 'a1', SENT, 2),
      assistant('a2', 'u2', 'msg_2', [{ type: 'text', text: 'PLUM again' }], 3),
    ];
    expect(sentRows(lines).map((m) => m.msgId)).toEqual(['u1', 'u2']);
  });

  it('a second send still waiting behind a running turn keeps its pending row', () => {
    const lines = [
      enqueue(SENT, 0), dequeue(0), user('u1', null, SENT, 0),
      assistant('a1', 'u1', 'msg_1', [{ type: 'tool_use', id: 'tb', name: 'Bash', input: { command: 'sleep 30' } }], 1),
      enqueue(SENT, 2),
    ];
    const rows = sentRows(lines);
    expect(rows).toHaveLength(2);
    expect(rows[1].msgId).toMatch(/^queue-/);
  });

  it('a second identical send after the first was taken still shows, before its line is written', () => {
    // The first was dequeued; its user line comes after the prompt hooks ran, and
    // the user sent the same words again in between.
    const lines = [
      enqueue(SENT, 0), dequeue(0), enqueue(SENT, 1),
      user('u1', null, SENT, 2),
    ];
    const rows = sentRows(lines);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.msgId?.startsWith('queue-') ? 'pending' : r.msgId).sort()).toEqual(['pending', 'u1']);
  });
});

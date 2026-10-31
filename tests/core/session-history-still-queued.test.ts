/**
 * A message the user sends over a pending permission card denies the card, and
 * the CLI queues the line behind the turn that answers the deny. Its transcript
 * then reads: enqueue → the deny's reply → dequeue → the user line → its answer.
 * A history read between the reply and the dequeue sees only the enqueue, so the
 * message is a Pattern B row at the enqueue, above the reply; the next read finds
 * the real user line below the reply and the row moves.
 *
 * Regression pinned here (2026-10-25): the client's anchored delta appended the
 * real line and kept the queue row it already held, so the message showed twice.
 * A row the CLI has not taken from its queue is unsettled: the client re-asks for
 * it, the id is gone, and the route rebuilds instead of appending.
 * Line shapes are Claude Code 2.1.284's transcript, neutral text.
 */
import { describe, it, expect } from 'vitest';
import { parseSessionMessages } from '../../src/core/session-history.js';
import { collectRequestedRevisions, isUnsettledRow, resolveDeltaStart } from '../../src/core/history-delta.js';
import { collectUnsettledIds, computeHistoryAnchor } from '../../web/src/hooks/history-anchor.js';

const T = (s: number) => new Date(Date.UTC(2026, 9, 25, 5, 27, s)).toISOString();

const enqueue = (content: string, s: number) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: T(s), sessionId: 's', content });
const dequeue = (s: number) => ({ type: 'queue-operation', operation: 'dequeue', timestamp: T(s), sessionId: 's' });
const remove = (content: string, s: number) => ({ type: 'queue-operation', operation: 'remove', timestamp: T(s), sessionId: 's', content });
function user(uuid: string, parent: string | null, content: unknown, s: number) {
  return { type: 'user', uuid, parentUuid: parent, timestamp: T(s), message: { role: 'user', content } };
}
function assistant(uuid: string, parent: string, id: string, content: unknown[], s: number) {
  return { type: 'assistant', uuid, parentUuid: parent, timestamp: T(s), message: { id, role: 'assistant', content } };
}

const FIRST = 'Write the word hi into notes.txt, then reply DONE.';
const TYPED = 'Never mind the file, just reply with the word PLUM.';

/** The transcript in the order the CLI writes it. */
const LINES = [
  enqueue(FIRST, 0), dequeue(0),
  user('u1', null, FIRST, 0),
  assistant('a1', 'u1', 'msg_write', [{ type: 'tool_use', id: 'tw', name: 'Write', input: { file_path: 'notes.txt', content: 'hi' } }], 2),
  user('r1', 'a1', [{ type: 'tool_result', tool_use_id: 'tw', content: 'User sent a new message — permission auto-denied', is_error: true }], 3),
  enqueue(TYPED, 3),
  assistant('a2', 'r1', 'msg_deny', [{ type: 'text', text: 'The write was denied, so notes.txt was not created.' }], 6),
  dequeue(8),
  user('u2', 'a2', TYPED, 8),
  assistant('a3', 'u2', 'msg_plum', [{ type: 'text', text: 'PLUM' }], 10),
];
const parse = (n: number) => parseSessionMessages(LINES.slice(0, n).map((l) => JSON.stringify(l)).join('\n'));
const typedRows = (rows: ReturnType<typeof parse>) => rows.filter((m) => m.role === 'user' && m.text === TYPED);

describe('a message the CLI still holds in its queue', () => {
  it('is an unsettled row after the reply it waits behind while the CLI has not taken it', () => {
    const racy = parse(7) // the deny's reply is written, the dequeue is not
    const rows = typedRows(racy)
    expect(rows).toHaveLength(1)
    expect(rows[0].msgId).toMatch(/^queue-/)
    expect(rows[0].unsettled).toBe(true)
    expect(rows[0].queued).toBe(true)
    expect(isUnsettledRow(rows[0])).toBe(true)
    // Written before the model saw it, the deny's reply is not its answer (2026-10-31).
    const order = racy.map((m) => m.text)
    expect(order.indexOf(TYPED)).toBeGreaterThan(order.indexOf('The write was denied, so notes.txt was not created.'))
  })

  it('stays unsettled after its dequeue until the CLI writes its user line', () => {
    // The CLI logs the dequeue, runs the prompt's hooks, then writes the line.
    const read = parse(8) // up to the dequeue
    const rows = typedRows(read)
    expect(rows).toHaveLength(1)
    expect(rows[0].unsettled).toBe(true)
    expect(collectRequestedRevisions(parse(LINES.length), collectUnsettledIds(read)).ambiguous).toBe(true)
  })

  it('once taken, is one settled row below the reply it waited behind', () => {
    const full = parse(LINES.length)
    const rows = typedRows(full)
    expect(rows).toHaveLength(1)
    expect(rows[0].msgId).toBe('u2')
    expect(rows[0].unsettled).toBeUndefined()
    const order = full.map((m) => m.text)
    expect(order.indexOf(TYPED)).toBeGreaterThan(order.indexOf('The write was denied, so notes.txt was not created.'))
  })

  it('the next delta after the racy read rebuilds instead of appending a second copy', () => {
    const served = parse(7)
    const full = parse(LINES.length)
    const revise = collectUnsettledIds(served)
    expect(revise).toEqual([typedRows(served)[0].msgId])
    // The waiting row sat at the end of the racy read (it has no place until the
    // CLI takes it), so the anchor names it and no longer resolves: a rebuild.
    expect(served[served.length - 1].queued).toBe(true)
    expect(resolveDeltaStart(full, { since: served.length, ...computeHistoryAnchor(served) }).kind).toBe('rebuild')
    // The re-asked id is gone from the new parse: ambiguous, the route serves the full history.
    expect(collectRequestedRevisions(full, revise).ambiguous).toBe(true)
  })

  it('a written or removed enqueue is settled', () => {
    expect(parse(LINES.length).every((m) => !m.unsettled)).toBe(true)
    const dropped = parseSessionMessages([
      user('u1', null, FIRST, 0),
      enqueue(TYPED, 1),
      remove(TYPED, 2),
      assistant('a1', 'u1', 'msg_after', [{ type: 'text', text: 'Done.' }], 3),
    ].map((l) => JSON.stringify(l)).join('\n'))
    expect(dropped.some((m) => m.unsettled)).toBe(false)
  })
})

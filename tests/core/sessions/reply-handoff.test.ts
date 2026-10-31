/**
 * The chain an answer to a handed-on request also answers (reply-handoff.ts answerChain), and
 * the line an asker it went past reads. The delivery itself is pinned in
 * tests/core/session-send-core.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { MAX_CHAIN, answerChain, directCarriers, wentPastLine } from '../../../src/core/sessions/reply-handoff.js';
import type { SessionRequest } from '../../../src/core/session-requests.js';

const row = (id: string, o: Partial<SessionRequest> = {}): SessionRequest => ({
  id, fromSessionId: `from-${id}`, toSessionId: `to-${id}`, status: 'pending',
  createdAt: '2026-10-30T00:00:00Z', deadlineAt: Date.parse('2026-10-30T01:00:00Z'), ...o,
} as SessionRequest);

describe('answerChain', () => {
  it('follows one open carried request at each step, nearest first', () => {
    const a = row('a', { carriedBy: [{ id: 'b' }] });
    const b = row('b', { carries: ['a'], carriedBy: [{ id: 'c' }] });
    const c = row('c', { carries: ['b'] });
    expect(answerChain(c, [a, b, c]).map((r) => r.id)).toEqual(['b', 'a']);
    expect(answerChain(a, [a, b, c])).toEqual([]);
  });

  it('stops at a step that carries two, one already answered, or one another ask also carries', () => {
    const a = row('a', { carriedBy: [{ id: 'b' }, { id: 'x' }] });
    const x = row('x', { carries: ['a'] });
    const b = row('b', { carries: ['a'] });
    expect(answerChain(b, [a, b, x])).toEqual([]);
    // The other carrier answered first, to the lead: this answer is the other half, still the lead's to combine.
    expect(answerChain(b, [a, b, { ...x, status: 'replied' }])).toEqual([]);
    expect(answerChain(b, [a, b, { ...x, status: 'expired' }])).toEqual([]);
    // A hand-off the lead took back, or a row long gone, is no part of the answer.
    expect(answerChain(b, [a, b, { ...x, status: 'withdrawn' }]).map((r) => r.id)).toEqual(['a']);
    expect(answerChain(b, [a, b]).map((r) => r.id)).toEqual(['a']);
    const two = row('t', { carries: ['a', 'z'] });
    expect(answerChain(two, [row('a'), row('z'), two])).toEqual([]);
    expect(answerChain(b, [{ ...a, carriedBy: [{ id: 'b' }], status: 'replied' }, b])).toEqual([]);
    expect(answerChain(b, [{ ...a, carriedBy: [{ id: 'b' }], status: 'notified' }, b])).toEqual([]);
    expect(answerChain(b, [{ ...a, carriedBy: [{ id: 'b' }], status: 'expired' }, b]).map((r) => r.id)).toEqual(['a']);
  });

  it('is bounded and never loops', () => {
    const rows: SessionRequest[] = [];
    for (let i = 0; i < 10; i++) rows.push(row(`r${i}`, { carries: i < 9 ? [`r${i + 1}`] : [], carriedBy: i > 0 ? [{ id: `r${i - 1}` }] : [] }));
    expect(answerChain(rows[0]!, rows)).toHaveLength(MAX_CHAIN);
    const p = row('p', { carries: ['q'], carriedBy: [{ id: 'q' }] });
    const q = row('q', { carries: ['p'], carriedBy: [{ id: 'p' }] });
    expect(answerChain(p, [p, q]).map((r) => r.id)).toEqual(['q']);
  });
});

describe('wentPastLine', () => {
  it('names who answered, what, and where it went, with nothing to relay', () => {
    const line = wentPastLine({ replier: { title: 'Worker', taskId: 'task-w' }, yours: 'rq-b', final: row('rq-a'), finalAsker: { title: 'Main', taskId: 'task-m' } });
    expect(line).toBe('"Worker" (task-w) answered your rq-b, which carried rq-a: Walnut gave the answer straight to "Main" as the answer to rq-a, and both are settled. Nothing to relay; task_history task-w shows it.');
  });
});

describe('directCarriers', () => {
  it('names the open asks of the answering task that carry the request it answers', () => {
    const a = row('a', { carriedBy: [{ id: 'b', taskId: 'tw' }, { id: 'c', taskId: 'other' }] });
    const b = row('b', { carries: ['a'], toTaskId: 'tw' });
    const c = row('c', { carries: ['a'], toTaskId: 'other' });
    expect(directCarriers(a, 'tw', [a, b, c]).map((r) => r.id)).toEqual(['b']);
    expect(directCarriers(a, 'tw', [a, { ...b, status: 'replied' }, c])).toEqual([]);
    expect(directCarriers(a, undefined, [a, b, c])).toEqual([]);
    expect(directCarriers(a, 'nobody', [a, b, c])).toEqual([]);
  });
});

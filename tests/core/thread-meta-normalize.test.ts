/**
 * `thread_meta` validation and upsert merge (src/core/sessions/thread-meta.ts).
 *
 * The merge is per-entry UPSERT because two writers share one entry: the client
 * (Done, Rename, Not yet) and the background AI (title, verdict, takeaway). A
 * whole-list replace would let a stale client list erase a fresh AI title (C16).
 */
import { describe, it, expect } from 'vitest';
import { mergeThreadMeta, normalizeThreadMeta } from '../../src/core/sessions/thread-meta.js';
import type { SessionThreadMeta } from '../../src/core/types.js';

const T0 = '2026-09-26T10:00:00.000Z';
const T1 = '2026-09-26T10:05:00.000Z';
const client = { writer: 'client' as const, aiAvailable: true };
const ai = { writer: 'ai' as const, aiAvailable: true };
const entry = (over: Partial<SessionThreadMeta> = {}): SessionThreadMeta => ({
  headId: 'head-a', status: 'open', updatedAt: T0, ...over,
});

describe('normalizeThreadMeta', () => {
  it('accepts a well-formed list and keeps null as clear', () => {
    const out = normalizeThreadMeta([
      { headId: 'head-a', status: 'open', title: 'Cache warmup', titleSource: 'ai', titleState: 'done' },
      { headId: 'head-b', status: 'resolved', takeaway: null, hidden: true, updatedAt: 'ignored' },
    ]);
    expect(out[0]).toEqual({ headId: 'head-a', status: 'open', title: 'Cache warmup', titleSource: 'ai', titleState: 'done' });
    expect(out[1]).toEqual({ headId: 'head-b', status: 'resolved', takeaway: null, hidden: true });
  });

  it.each([
    [[{ headId: 'h', status: 'closed' }], /status must be one of/],
    [[{ headId: 'h', title: 'x'.repeat(121) }], /title must be a string \(max 120/],
    [[{ headId: 'h', takeaway: 'x'.repeat(281) }], /takeaway must be a string \(max 280/],
    [[{ headId: '' }], /headId must be a non-empty string/],
    [[{ headId: 'h'.repeat(129) }], /headId must be a non-empty string/],
    [[{ headId: 'h', titleState: 'naming' }], /titleState must be one of/],
    [[{ headId: 'h', hidden: 'yes' }], /hidden must be a boolean/],
    [[{ headId: 'h', status: null }], /status cannot be cleared/],
    [[{ headId: 'h', seq: 0 }], /seq must be an integer from 1 to 100000/],
    [[{ headId: 'h', seq: 1.5 }], /seq must be an integer from 1 to 100000/],
    [[{ headId: 'h', seq: '3' }], /seq must be an integer from 1 to 100000/],
    [[{ headId: 'h', seq: 100001 }], /seq must be an integer from 1 to 100000/],
    [['not-an-object'], /each thread_meta entry must be an object/],
    [{ headId: 'h' }, /thread_meta must be an array/],
  ])('rejects %j with 400', (body, message) => {
    let caught: unknown;
    try { normalizeThreadMeta(body); } catch (err) { caught = err; }
    expect((caught as { statusCode?: number }).statusCode).toBe(400);
    expect(String((caught as Error).message)).toMatch(message);
  });

  it('rejects more than 500 entries, accepts exactly 500', () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => ({ headId: `h${i}` }));
    expect(normalizeThreadMeta(list(500))).toHaveLength(500);
    expect(() => normalizeThreadMeta(list(501))).toThrow(/at most 500/);
  });

  it('accepts a question number in range', () => {
    expect(normalizeThreadMeta([{ headId: 'h', seq: 1 }, { headId: 'i', seq: 100000 }]).map((e) => e.seq)).toEqual([1, 100000]);
  });

  it('truncates a long question to 400 chars without an error', () => {
    const [out] = normalizeThreadMeta([{ headId: 'h', question: 'q'.repeat(900) }]);
    expect(out.question).toHaveLength(400);
  });
});

describe('mergeThreadMeta: upsert by headId', () => {
  it('overwrites listed fields, clears nulls, leaves the rest alone', () => {
    const current = [
      entry({ title: 'Old name', titleSource: 'ai', titleState: 'done', takeaway: 'Keep me' }),
      entry({ headId: 'head-b', status: 'resolved' }),
    ];
    const { meta, touched } = mergeThreadMeta(current, [{ headId: 'head-a', status: 'resolved', takeaway: null }], T1, client);
    expect(touched).toEqual(['head-a']);
    expect(meta[0]).toEqual({ headId: 'head-a', status: 'resolved', title: 'Old name', titleSource: 'ai', titleState: 'done', updatedAt: T1 });
    expect(meta[1]).toEqual(current[1]);
  });

  it('creates a new entry as open and stamps updatedAt; a no-op write stamps nothing', () => {
    const created = mergeThreadMeta([], [{ headId: 'head-n', question: 'why?' }], T1, client);
    expect(created.meta).toEqual([{ headId: 'head-n', status: 'open', question: 'why?', updatedAt: T1 }]);
    const again = mergeThreadMeta(created.meta, [{ headId: 'head-n', question: 'why?' }], '2026-09-26T11:00:00.000Z', client);
    expect(again.touched).toEqual([]);
    expect(again.meta[0].updatedAt).toBe(T1);
  });

  it('stores pending as unavailable (title) and drops pending (takeaway) when the AI gate is closed', () => {
    const { meta } = mergeThreadMeta([], [{ headId: 'h', titleState: 'pending', status: 'resolved', takeawayState: 'pending', takeaway: 'fb', takeawaySource: 'fallback' }], T1, { writer: 'client', aiAvailable: false });
    expect(meta[0].titleState).toBe('unavailable');
    expect(meta[0].takeawayState).toBeUndefined();
    expect(meta[0].takeaway).toBe('fb');
  });
});

describe('mergeThreadMeta: the question number is written once', () => {
  it('a client sets seq when the question is asked; later writes cannot move or clear it', () => {
    const asked = mergeThreadMeta([], [{ headId: 'head-q', question: 'why?', seq: 4 }], T1, client);
    expect(asked.meta[0].seq).toBe(4);
    const moved = mergeThreadMeta(asked.meta, [{ headId: 'head-q', seq: 9, status: 'resolved' }], T1, client);
    expect(moved.meta[0]).toMatchObject({ seq: 4, status: 'resolved' });
    const cleared = mergeThreadMeta(asked.meta, [{ headId: 'head-q', seq: null }], T1, client);
    expect(cleared.meta[0].seq).toBe(4);
    expect(cleared.touched).toEqual([]);
  });

  it('the AI never writes a number: its replies carry the one the client gave', () => {
    const base = [entry({ headId: 'head-q' })];
    const out = mergeThreadMeta(base, [{ headId: 'head-q', seq: 2, title: 'Named' }], T1, ai);
    expect(out.meta[0].seq).toBeUndefined();
    expect(out.meta[0].title).toBe('Named');
  });
});

describe('mergeThreadMeta: two writers on one entry (C16, C47)', () => {
  it('an AI write never overwrites a user title or a user takeaway', () => {
    const current = [entry({ title: 'My name', titleSource: 'user', takeaway: 'My words', takeawaySource: 'user' })];
    const { meta, touched } = mergeThreadMeta(current, [{
      headId: 'head-a', title: 'AI name', titleSource: 'ai', titleState: 'done',
      takeaway: 'AI words', takeawaySource: 'ai', takeawayState: 'done',
    }], T1, ai);
    expect(touched).toEqual([]);
    expect(meta[0]).toEqual(current[0]);
  });

  it('a stale client PATCH that does not list the title keeps the AI title', () => {
    // The client read the list before the AI name landed, then marks Done.
    const afterAi = mergeThreadMeta([entry({ titleState: 'pending' })], [{ headId: 'head-a', title: 'Cache warmup', titleSource: 'ai', titleState: 'done' }], T1, ai).meta;
    const { meta } = mergeThreadMeta(afterAi, [{ headId: 'head-a', status: 'resolved', takeaway: 'It warms on boot.', takeawaySource: 'fallback' }], '2026-09-26T10:06:00.000Z', client);
    expect(meta[0]).toMatchObject({ title: 'Cache warmup', titleSource: 'ai', titleState: 'done', status: 'resolved' });
  });

  it('a replayed client pending over a finished title is ignored', () => {
    const current = [entry({ title: 'Cache warmup', titleSource: 'ai', titleState: 'done' })];
    const { meta } = mergeThreadMeta(current, [{ headId: 'head-a', titleState: 'pending', question: 'q' }], T1, client);
    expect(meta[0].titleState).toBe('done');
    expect(meta[0].question).toBe('q');
  });

  it('an AI answered verdict is stored as suggested, never resolved', () => {
    const suggested = mergeThreadMeta([entry()], [{ headId: 'head-a', status: 'suggested' }], T1, ai).meta;
    expect(suggested[0].status).toBe('suggested');
    const resolved = mergeThreadMeta([entry()], [{ headId: 'head-a', status: 'resolved' }], T1, ai).meta;
    expect(resolved[0].status).toBe('open');
  });

  it('no suggestion after Not yet, and none on a question that is no longer open', () => {
    const dismissed = mergeThreadMeta([entry({ suggestDismissed: true })], [{ headId: 'head-a', status: 'suggested' }], T1, ai).meta;
    expect(dismissed[0].status).toBe('open');
    const done = mergeThreadMeta([entry({ status: 'resolved' })], [{ headId: 'head-a', status: 'suggested' }], T1, ai).meta;
    expect(done[0].status).toBe('resolved');
  });

  it('an AI failure never downgrades a finished title, and an AI write never creates an entry', () => {
    const current = [entry({ title: 'Cache warmup', titleSource: 'ai', titleState: 'done' })];
    expect(mergeThreadMeta(current, [{ headId: 'head-a', titleState: 'failed' }], T1, ai).meta[0].titleState).toBe('done');
    expect(mergeThreadMeta(current, [{ headId: 'gone', title: 'x', titleState: 'done' }], T1, ai).meta).toHaveLength(1);
  });
});

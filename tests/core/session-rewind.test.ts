/**
 * Unit tests for the pure halves of session rewind + pinned-message validation.
 *
 * Deliberately NOT covered here (they need a live CLI / spawn): the
 * `rewind_files` control round-trip and the `--resume-session-at` fork spawn.
 * What IS covered is every rule that decides whether a rewind is even offered,
 * plus the acceptance behaviour of a committed rewind cut — the piece whose
 * failure mode is silent ("the messages I rewound away came back").
 *
 * The last describe replaces the deleted `applyInPlaceRewindCuts` offset-slicer
 * block, re-expressed against the recorded-cut filter
 * (computeRewindDeadSet, src/core/transcript-chain.ts). The fine-grained region
 * rules (index math, duplicate uuids, per-cut degrade, queue dead keys) and the
 * CLI-chain machinery (leaf rule, walk termination, parallel-tool DAG) live in
 * tests/core/transcript-chain.test.ts; the end-to-end read is
 * tests/core/session-history-chain-walk.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isRewindableMessageId,
  cutAncestorHistoryAtRewindPoint,
} from '../../src/core/sessions/session-rewind.js';
import { normalizePinnedMessages } from '../../src/core/sessions/session-lifecycle.js';
import { computeRewindDeadSet } from '../../src/core/transcript-chain.js';
import { transcript, survivingUuids, cutHere } from '../helpers/transcript-fixtures.js';

describe('isRewindableMessageId', () => {
  it('accepts a CLI transcript uuid', () => {
    expect(isRewindableMessageId('0199f8b1-4c2a-4f77-9b31-2c8de5a91f04')).toBe(true);
    // Case-insensitive: some transcripts carry upper-case uuids.
    expect(isRewindableMessageId('0199F8B1-4C2A-4F77-9B31-2C8DE5A91F04')).toBe(true);
  });

  it('rejects the id shapes the CLI cannot resolve', () => {
    // API assistant message id — real, but not a transcript line uuid.
    expect(isRewindableMessageId('msg_01ABCdefGHIjklMNOpqrst')).toBe(false);
    // Walnut's synthetic ids for lines that carried no uuid.
    expect(isRewindableMessageId('queue-2026-08-28T10:00:00.000Z')).toBe(false);
    expect(isRewindableMessageId('2026-08-28T10:00:00.000Z-4')).toBe(false);
    expect(isRewindableMessageId(undefined)).toBe(false);
    expect(isRewindableMessageId('')).toBe(false);
    // Nearly-a-uuid shapes must not slip through (a spawn with one exits 1).
    expect(isRewindableMessageId('0199f8b1-4c2a-4f77-9b31-2c8de5a91f0')).toBe(false);
    expect(isRewindableMessageId('0199f8b14c2a4f779b312c8de5a91f04')).toBe(false);
  });
});

describe('cutAncestorHistoryAtRewindPoint', () => {
  const msgs = (...ids: string[]) => ids.map((msgId) => ({ msgId }));

  it('keeps the rewind point and drops everything after it', () => {
    const cut = cutAncestorHistoryAtRewindPoint(msgs('a', 'b', 'c', 'd'), 'b');
    expect(cut.found).toBe(true);
    expect(cut.messages.map((m) => m.msgId)).toEqual(['a', 'b']);
    expect(cut.dropped).toBe(2);
  });

  it('cuts at the LAST occurrence — the immediate parent is the array tail', () => {
    // A re-forked chain concatenates root…parent, so the same uuid can appear
    // once per ancestor. Cutting at the first would throw away the parent's copy
    // of the whole conversation.
    const cut = cutAncestorHistoryAtRewindPoint(msgs('a', 'b', 'c', 'a', 'b', 'c'), 'b');
    expect(cut.messages.map((m) => m.msgId)).toEqual(['a', 'b', 'c', 'a', 'b']);
    expect(cut.dropped).toBe(1);
  });

  it('is a no-op when the anchor is gone, and says so', () => {
    const input = msgs('a', 'b');
    const cut = cutAncestorHistoryAtRewindPoint(input, 'zz');
    expect(cut.found).toBe(false);
    expect(cut.dropped).toBe(0);
    expect(cut.messages).toBe(input);
  });

  it('is a no-op for an ordinary (non-rewound) fork', () => {
    const input = msgs('a', 'b');
    expect(cutAncestorHistoryAtRewindPoint(input, undefined).messages).toBe(input);
  });

  it('drops nothing when the rewind point is the last message', () => {
    const cut = cutAncestorHistoryAtRewindPoint(msgs('a', 'b'), 'b');
    expect(cut.found).toBe(true);
    expect(cut.dropped).toBe(0);
    expect(cut.messages.map((m) => m.msgId)).toEqual(['a', 'b']);
  });
});

describe('normalizePinnedMessages', () => {
  const pin = (over: Record<string, unknown> = {}) => ({
    msgId: 'm1', label: 'Ship the release', role: 'user',
    timestamp: '2026-08-28T10:00:00.000Z', pinnedAt: '2026-08-28T10:01:00.000Z',
    ...over,
  });

  it('round-trips a well-formed list', () => {
    const out = normalizePinnedMessages([pin(), pin({ msgId: 'm2', role: 'assistant' })]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      msgId: 'm1', label: 'Ship the release', role: 'user',
      timestamp: '2026-08-28T10:00:00.000Z', pinnedAt: '2026-08-28T10:01:00.000Z',
    });
    expect(out[1].role).toBe('assistant');
  });

  it('collapses duplicate msgIds to the first entry', () => {
    // A double-clicked pin button must not produce two outline rows for one message.
    const out = normalizePinnedMessages([pin({ label: 'first' }), pin({ label: 'second' })]);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe('first');
  });

  it('trims and caps the label, and tolerates a missing one', () => {
    const out = normalizePinnedMessages([
      pin({ label: `  ${'x'.repeat(400)}  ` }),
      pin({ msgId: 'm2', label: undefined }),
    ]);
    expect(out[0].label).toHaveLength(300);
    expect(out[1].label).toBe('');
  });

  it('defaults an unknown role to assistant and stamps a missing pinnedAt', () => {
    const out = normalizePinnedMessages([pin({ role: 'robot', pinnedAt: undefined })]);
    expect(out[0].role).toBe('assistant');
    expect(Number.isNaN(Date.parse(out[0].pinnedAt))).toBe(false);
  });

  it('rejects the whole patch on a bad entry rather than dropping it silently', () => {
    // A pin the user believes they saved, that vanished on reload, is worse than
    // a visible error.
    expect(() => normalizePinnedMessages('nope')).toThrow(/must be an array/);
    expect(() => normalizePinnedMessages([null])).toThrow(/must be an object/);
    expect(() => normalizePinnedMessages([pin({ msgId: '' })])).toThrow(/msgId/);
    expect(() => normalizePinnedMessages([pin({ msgId: 42 })])).toThrow(/msgId/);
    expect(() => normalizePinnedMessages([pin({ msgId: 'x'.repeat(201) })])).toThrow(/msgId/);
  });

  it('caps the list length', () => {
    const many = Array.from({ length: 201 }, (_, i) => pin({ msgId: `m${i}` }));
    expect(() => normalizePinnedMessages(many)).toThrow(/at most 200/);
    expect(normalizePinnedMessages(many.slice(0, 200))).toHaveLength(200);
  });
});

afterEach(() => { vi.restoreAllMocks(); });

describe('in-place rewind cut (recorded, replayed against the file)', () => {
  /** Uuids the recorded cuts keep, in file order. */
  const live = (t: ReturnType<typeof transcript>, cuts: Parameters<typeof computeRewindDeadSet>[1] = []) => {
    const res = computeRewindDeadSet(t.lines, cuts);
    return { res, uuids: survivingUuids(t.lines, res.deadUuids) };
  };

  it('drops nothing while the rewind point is still the file tip (nothing appended yet)', () => {
    // The death window: the human pressed rewind, the CLI was respawned with
    // --resume-session-at, and nobody has spoken since. lastUuidAtCommit IS the
    // rewind point, so the region is empty and the file is served whole.
    const t = transcript().user('u1', 'first').assistant('a1', 'reply one').user('u2', 'second');
    const { res, uuids } = live(t, [cutHere(t, 'u2')]);
    expect(res.deadUuids).toBeNull();       // identity fast path — no filtering at all
    expect(res.droppedCount).toBe(0);
    expect(uuids).toEqual(['u1', 'a1', 'u2']);
  });

  it('excises the abandoned branch once the new turn is appended after the rewind', () => {
    // U1 A1 U2 A2 U3 A3, rewound to U2; the CLI then appended U2' A2' hung off U2
    // (live-verified: the first post-rewind line's parentUuid IS the rewind point).
    // The commit-time anchor is A3, so the new branch sits past it and is safe.
    const t = transcript()
      .user('u1', 'first').assistant('a1', 'reply one').user('u2', 'second')
      .assistant('a2', 'ABANDONED reply two').user('u3', 'ABANDONED third')
      .assistant('a3', 'ABANDONED reply three');
    const cut = cutHere(t, 'u2');
    t.from('u2').user('u2b', 'second take').assistant('a2b', 'new reply two');

    const { res, uuids } = live(t, [cut]);
    expect(uuids).toEqual(['u1', 'a1', 'u2', 'u2b', 'a2b']);
    expect(res.droppedCount).toBe(3);       // a2 u3 a3
    expect([...res.deadUuids!]).toEqual(['a2', 'u3', 'a3']);
  });

  it('takes a sidechain branch that sits INSIDE the region, and leaves one outside alone', () => {
    // Region membership is positional, so a legacy inline sidechain written as
    // part of the abandoned turn dies with it. The deliberate difference from the
    // reverted chain walk: a sidechain hanging off a LIVE uuid is off the
    // conversation chain but was never rewound away, so it stays.
    const t = transcript()
      .user('u1', 'first').assistant('a1', 'reply one').user('u2', 'second')
      .assistant('a2', 'ABANDONED reply two')
      .user('s1', 'sidechain of the abandoned turn', { isSidechain: true });
    const cut = cutHere(t, 'u2');
    t.from('u2').user('sl1', 'sidechain off a live uuid', { isSidechain: true })
      .from('u2').user('u2b', 'second take');

    const { res, uuids } = live(t, [cut]);
    expect([...res.deadUuids!].sort()).toEqual(['a2', 's1']);
    expect(uuids).toEqual(['u1', 'a1', 'u2', 'sl1', 'u2b']);
  });

  it('composes two rewinds — the newest branch survives, neither abandoned one leaks back', () => {
    // Rewind to u2, the CLI writes a branch, then rewind again to u1. The second
    // cut's region swallows the first cut's region AND its replacement.
    const t = transcript()
      .user('u1', 'first').assistant('a1', 'reply one').user('u2', 'second')
      .assistant('a2', 'reply two').user('u3', 'third');
    const cut1 = cutHere(t, 'u2');
    t.from('u2').user('u2b', 'second take').assistant('a2b', 'new two');
    const cut2 = cutHere(t, 'u1');
    t.from('u1').user('u1c', 'first again');

    expect(live(t, [cut1, cut2]).uuids).toEqual(['u1', 'u1c']);
  });

  it('serves the file UNFILTERED when a cut can no longer be located', () => {
    // The named failure mode that replaces the fingerprint check: the file was
    // rewritten between commit and read, so the cut refuses to guess and the whole
    // transcript is served (the caller logs the degrade rather than 404ing a
    // history route, which is what the CLI does at print.ts:5110-5116).
    const t = transcript()
      .user('u1', 'first').assistant('a1', 'reply one').user('u2', 'second')
      .assistant('a2', 'reply two')
      .from('u2').user('u2b', 'second take');
    const { res, uuids } = live(t, [{ uuid: 'not-in-this-file', lastUuidAtCommit: 'a2', at: '2026-08-30T00:00:00.000Z' }]);
    expect(res.deadUuids).toBeNull();
    expect(res.droppedCount).toBe(0);
    // Reported for the caller to warn about — the filter itself has no logger.
    expect(res.skippedCuts).toHaveLength(1);
    expect(uuids).toEqual(['u1', 'a1', 'u2', 'a2', 'u2b']);  // a2 kept, unfiltered
  });

  it('never throws on an empty, malformed or cut-less transcript', () => {
    // The offset slicer needed a bounds check (afterLine past a shrunken file).
    // The uuid-anchored replay has no index math to get wrong, but it must still
    // survive junk: blank input, non-objects, tree lines with no uuid at all.
    expect(computeRewindDeadSet([], []).deadUuids).toBeNull();
    expect(computeRewindDeadSet([], [{ uuid: 'x', lastUuidAtCommit: 'y', at: 'z' }]).deadUuids).toBeNull();
    expect(computeRewindDeadSet([
      null as never, 42 as never, { foo: 'bar' } as never,
      { type: 'user', message: { content: 'no uuid' } },
    ], []).deadUuids).toBeNull();
    // A never-rewound session is byte-identical service, whatever the topology.
    const flat = transcript().user('x1', 'a', { parent: null }).assistant('x2', 'b', { parent: null });
    expect(computeRewindDeadSet(flat.lines, []).deadUuids).toBeNull();
  });
});

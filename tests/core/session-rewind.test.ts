/**
 * Unit tests for the pure halves of session rewind + pinned-message validation.
 *
 * Deliberately NOT covered here (they need a live CLI / spawn): the
 * `rewind_files` control round-trip and the `--resume-session-at` fork spawn.
 * What IS covered is every rule that decides whether a rewind is even offered,
 * and the ancestor-history cut — the piece whose failure mode is silent
 * ("the messages I rewound away came back").
 */
import { describe, it, expect } from 'vitest';
import {
  isRewindableMessageId,
  cutAncestorHistoryAtRewindPoint,
} from '../../src/core/sessions/session-rewind.js';
import { normalizePinnedMessages } from '../../src/core/sessions/session-lifecycle.js';
import {
  applyInPlaceRewindCuts,
  splitTranscriptLines,
  historyLineCheckOf,
} from '../../src/core/session-history.js';
import type { InPlaceRewindCut } from '../../src/core/types.js';

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

describe('applyInPlaceRewindCuts', () => {
  // A realistic transcript: user/assistant JSONL lines carrying a uuid, plus a
  // sidechain line the abandoned branch would drag along.
  const line = (uuid: string, role: string, text: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: role, uuid, message: { role, content: text }, ...extra });

  // Build a cut for the rewind point at `targetLine`, capturing the file's
  // current line count and fingerprints exactly like session-rewind does.
  const cutFor = (lines: string[], targetLine: number, uuid: string): InPlaceRewindCut => ({
    uuid,
    targetLine,
    afterLine: lines.length,
    targetCheck: historyLineCheckOf(lines[targetLine]),
    lastCheck: historyLineCheckOf(lines[lines.length - 1]),
    at: '2026-08-30T00:00:00.000Z',
  });

  it('drops nothing when the rewind point is still the last line (no new turn yet)', () => {
    // Rewound to U2, and nobody has spoken since — targetLine === afterLine-1,
    // so the abandoned range (targetLine, afterLine) is empty.
    const lines = [
      line('u1', 'user', 'first'),
      line('a1', 'assistant', 'reply one'),
      line('u2', 'user', 'second'),
    ];
    const cut = cutFor(lines, 2, 'u2');
    const res = applyInPlaceRewindCuts(lines, [cut]);
    expect(res.stale).toBe(false);
    expect(res.dropped).toBe(0);
    expect(res.lines).toEqual(lines);
  });

  it('excises the abandoned branch when new turns were appended after the rewind', () => {
    // Original conversation U1 A1 U2 A2 U3 A3; rewound to U2 (targetLine 2,
    // afterLine 6). Then a NEW branch U2' A2' was appended at lines 6-7.
    const original = [
      line('u1', 'user', 'first'),
      line('a1', 'assistant', 'reply one'),
      line('u2', 'user', 'second'),
      line('a2', 'assistant', 'reply two'),
      line('u3', 'user', 'third'),
      line('a3', 'assistant', 'reply three'),
    ];
    const cut = cutFor(original, 2, 'u2');
    const withNewBranch = [
      ...original,
      line('u2b', 'user', 'second take'),
      line('a2b', 'assistant', 'new reply two'),
    ];
    const res = applyInPlaceRewindCuts(withNewBranch, [cut]);
    expect(res.stale).toBe(false);
    // Kept: U1 A1 U2 (up to & including the rewind point) + the new branch.
    expect(res.dropped).toBe(3); // A2 U3 A3
    expect(res.lines.map((l) => JSON.parse(l).uuid)).toEqual(['u1', 'a1', 'u2', 'u2b', 'a2b']);
  });

  it('takes sidechain/queue-op lines inside the range with it (position, not uuid)', () => {
    const lines = [
      line('u1', 'user', 'first'),
      line('a1', 'assistant', 'reply one'),
      line('u2', 'user', 'second'),
      line('a2', 'assistant', 'reply two'),
      // a sidechain line that belongs to the abandoned branch
      line('s1', 'user', 'sidechain', { isSidechain: true }),
      line('u3', 'user', 'third'),
    ];
    const cut = cutFor(lines, 2, 'u2');
    const withNew = [...lines, line('u2b', 'user', 'second take')];
    const res = applyInPlaceRewindCuts(withNew, [cut]);
    expect(res.stale).toBe(false);
    expect(res.lines.map((l) => JSON.parse(l).uuid)).toEqual(['u1', 'a1', 'u2', 'u2b']);
  });

  it('composes two rewinds — the earlier cut swallows the first branch and its cut', () => {
    // U1 A1 U2 A2 U3 → rewind#1 to U2 (afterLine 5) → append U2b A2b (lines 5-6)
    // → rewind#2 to U1 (afterLine 7) → append U1c (line 7).
    const base = [
      line('u1', 'user', 'first'),
      line('a1', 'assistant', 'reply one'),
      line('u2', 'user', 'second'),
      line('a2', 'assistant', 'reply two'),
      line('u3', 'user', 'third'),
    ];
    const cut1 = cutFor(base, 2, 'u2');
    const afterR1 = [...base, line('u2b', 'user', 'second take'), line('a2b', 'assistant', 'new two')];
    const cut2 = cutFor(afterR1, 0, 'u1');
    const afterR2 = [...afterR1, line('u1c', 'user', 'first again')];
    const res = applyInPlaceRewindCuts(afterR2, [cut1, cut2]);
    expect(res.stale).toBe(false);
    // Only U1 (the second rewind point) and the final branch U1c survive.
    expect(res.lines.map((l) => JSON.parse(l).uuid)).toEqual(['u1', 'u1c']);
  });

  it('serves the file UNFILTERED when a fingerprint no longer matches (rewrite/compact)', () => {
    const lines = [
      line('u1', 'user', 'first'),
      line('a1', 'assistant', 'reply one'),
      line('u2', 'user', 'second'),
      line('a2', 'assistant', 'reply two'),
    ];
    const cut = cutFor(lines, 2, 'u2');
    // /compact rewrote the file: same length, different content at targetLine.
    const rewritten = [...lines];
    rewritten[2] = line('u2', 'user', 'second (edited by compact summary)');
    const res = applyInPlaceRewindCuts(rewritten, [cut]);
    expect(res.stale).toBe(true);
    expect(res.dropped).toBe(0);
    expect(res.lines).toEqual(rewritten);
  });

  it('is stale (not a crash) when afterLine runs past a shrunken file', () => {
    const lines = [line('u1', 'user', 'first'), line('u2', 'user', 'second')];
    const cut: InPlaceRewindCut = {
      uuid: 'u1', targetLine: 0, afterLine: 99,
      targetCheck: historyLineCheckOf(lines[0]),
      lastCheck: { len: 1, head: 'x', tail: 'x' },
      at: '2026-08-30T00:00:00.000Z',
    };
    const res = applyInPlaceRewindCuts(lines, [cut]);
    expect(res.stale).toBe(true);
    expect(res.lines).toEqual(lines);
  });

  it('splitTranscriptLines drops blank lines so indices match the recorder', () => {
    expect(splitTranscriptLines('a\n\nb\n')).toEqual(['a', 'b']);
  });
});

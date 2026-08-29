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

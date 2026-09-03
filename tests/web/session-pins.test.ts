/**
 * Pinned-message outline: label derivation + the transcript-order sort the
 * outline is built with.
 *
 * The sort lives in SessionChatHistory (it needs the loaded messages array), so
 * the ordering rule is re-stated here against the same algorithm. What it pins:
 * the outline reads in CONVERSATION order, and a pin whose message isn't loaded
 * yet is still listed (last) rather than dropped — a pin the user made must never
 * silently disappear from the outline.
 */
import { describe, it, expect } from 'vitest';
import { pinKeyOf, pinLabelFor, shouldAdoptServerPins } from '@/hooks/useSessionPins';
import type { SessionPinnedMessage } from '@/types/session';

/** The same ordering SessionChatHistory's tocEntries memo applies. */
function orderPins(
  pins: SessionPinnedMessage[],
  messages: Array<{ msgId?: string; walnutMessageId?: string }>,
): string[] {
  const indexOf = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const id = messages[i].msgId ?? messages[i].walnutMessageId;
    if (id && !indexOf.has(id)) indexOf.set(id, i);
  }
  return pins
    .map((pin) => ({ pin, at: indexOf.get(pin.msgId) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => (a.at !== b.at ? a.at - b.at : a.pin.pinnedAt.localeCompare(b.pin.pinnedAt)))
    .map(({ pin }) => pin.msgId);
}

const pin = (msgId: string, pinnedAt: string): SessionPinnedMessage =>
  ({ msgId, label: msgId, role: 'user', pinnedAt });

describe('pinLabelFor', () => {
  it('uses the first non-empty line', () => {
    expect(pinLabelFor('\n\nSubscribe to PR CI\nthen report back', 'x')).toBe('Subscribe to PR CI');
  });

  it('strips the markdown that would render as literal punctuation', () => {
    expect(pinLabelFor('## Plan for the release', 'x')).toBe('Plan for the release');
    expect(pinLabelFor('- **ship** the `dist`', 'x')).toBe('ship the dist');
    expect(pinLabelFor('> quoted ask', 'x')).toBe('quoted ask');
  });

  it('falls back when there is no text at all', () => {
    expect(pinLabelFor(undefined, 'Your message')).toBe('Your message');
    expect(pinLabelFor('   \n  ', 'Reply')).toBe('Reply');
    // Markdown-only line: stripping leaves nothing, so the fallback still wins.
    expect(pinLabelFor('**__**', 'Reply')).toBe('Reply');
  });

  it('caps the length with an ellipsis', () => {
    const label = pinLabelFor('y'.repeat(200), 'x');
    expect(label).toHaveLength(91); // 90 chars + the ellipsis
    expect(label.endsWith('…')).toBe(true);
  });
});

describe('shouldAdoptServerPins', () => {
  const a = pin('a', '2026-08-28T10:00:00Z');
  const b = pin('b', '2026-08-28T10:00:01Z');

  it('adopts the record outright before any local write', () => {
    expect(shouldAdoptServerPins([a], [], false)).toBe(true);
    expect(shouldAdoptServerPins([], [a, b], false)).toBe(true);
  });

  it('ignores a record read that is missing a pin we confirmed', () => {
    // The live failure: a GET issued before the pin resolved after it, and the
    // outline emptied itself while the pins sat safely on disk.
    expect(shouldAdoptServerPins([], [a], true)).toBe(false);
    expect(shouldAdoptServerPins([a], [a, b], true)).toBe(false);
  });

  it('still adopts a record that ADDS pins (another tab, another device)', () => {
    expect(shouldAdoptServerPins([a, b], [a], true)).toBe(true);
    expect(shouldAdoptServerPins([a], [a], true)).toBe(true);
  });
});

describe('pinKeyOf', () => {
  it('uses the msgId for a whole-message pin and the id for a quote pin', () => {
    expect(pinKeyOf(pin('m1', '2026-08-28T10:00:00Z'))).toBe('m1');
    expect(pinKeyOf({
      ...pin('m1', '2026-08-28T10:00:00Z'),
      id: 'q-1',
      quote: { exact: 'a passage' },
    })).toBe('q-1');
  });

  it('separates several pins on ONE message', () => {
    // The reason the key exists: msgId no longer identifies an outline row, so an
    // unpin keyed on it would take the wrong passage (or all of them).
    const msg = pin('m1', '2026-08-28T10:00:00Z');
    const keys = [
      msg,
      { ...msg, id: 'q-1', quote: { exact: 'first' } },
      { ...msg, id: 'q-2', quote: { exact: 'second' } },
    ].map(pinKeyOf);
    expect(new Set(keys).size).toBe(3);
  });

  it('still separates them when the quote pins carry NO id', () => {
    // `pinned_messages` is a plain PATCH field, so a script/plugin/other client can
    // store a passage without an id and the server accepts it. Falling back to the
    // msgId there gave all three pins ONE key — measured on the fixture session:
    // duplicate React keys in the outline, only one of two passages painted, and
    // removing either outline row deleted every pin on that message.
    const msg = pin('m1', '2026-08-28T10:00:00Z');
    const first = { ...msg, quote: { exact: 'first' } };
    const second = { ...msg, quote: { exact: 'second' } };
    expect(new Set([msg, first, second].map(pinKeyOf)).size).toBe(3);
    // Derived from the pin, not from render order, so it survives a reload.
    expect(pinKeyOf({ ...first })).toBe(pinKeyOf(first));
    // Same passage, different context = different pin (the server dedups on the
    // same four fields).
    expect(pinKeyOf({ ...first, quote: { exact: 'first', prefix: 'a ' } }))
      .not.toBe(pinKeyOf(first));
  });
});

describe('shouldAdoptServerPins with quote pins', () => {
  const msg = pin('m1', '2026-08-28T10:00:00Z');
  const quoteA: SessionPinnedMessage = { ...msg, id: 'q-1', quote: { exact: 'first' } };
  const quoteB: SessionPinnedMessage = { ...msg, id: 'q-2', quote: { exact: 'second' } };

  it('ignores a record read that dropped one of two passages on the same message', () => {
    // Keyed on msgId this list would look complete (m1 is present) and the pin the
    // user just made would vanish from the outline.
    expect(shouldAdoptServerPins([quoteA], [quoteA, quoteB], true)).toBe(false);
    expect(shouldAdoptServerPins([quoteA, quoteB], [quoteA, quoteB], true)).toBe(true);
  });
});

describe('outline ordering', () => {
  it('reads in transcript order, not pin order', () => {
    const pins = [pin('c', '2026-08-28T10:00:00Z'), pin('a', '2026-08-28T11:00:00Z')];
    const messages = [{ msgId: 'a' }, { msgId: 'b' }, { msgId: 'c' }];
    expect(orderPins(pins, messages)).toEqual(['a', 'c']);
  });

  it('keeps a pin whose message is not loaded, sorted last by pin time', () => {
    const pins = [
      pin('ghost-2', '2026-08-28T12:00:00Z'),
      pin('b', '2026-08-28T09:00:00Z'),
      pin('ghost-1', '2026-08-28T11:00:00Z'),
    ];
    const messages = [{ msgId: 'a' }, { msgId: 'b' }];
    expect(orderPins(pins, messages)).toEqual(['b', 'ghost-1', 'ghost-2']);
  });

  it('matches optimistic rows by walnutMessageId too', () => {
    const pins = [pin('wm-1', '2026-08-28T10:00:00Z'), pin('a', '2026-08-28T10:00:01Z')];
    const messages = [{ msgId: 'a' }, { walnutMessageId: 'wm-1' }];
    expect(orderPins(pins, messages)).toEqual(['a', 'wm-1']);
  });
});

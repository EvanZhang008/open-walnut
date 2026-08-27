/**
 * REGRESSION: the session-chat render window must follow CONTENT, not an index.
 *
 * Reported symptom (2026-08-27): "when I first open a session and scroll up it
 * flickers, then recovers; happens to many sessions".
 *
 * Measured on the real UI with a fault-injected short Phase-1 payload: the
 * window start was pinned at index 131 (seeded from a 161-row streams payload),
 * then Phase 2 replaced the array with the archive's 400-row tail of a 543-row
 * session. Index 131 in the NEW array is 239 rows older, so 269 messages
 * rendered instead of 30 — scrollHeight 35,505px instead of 2,907px. That whole
 * DOM lands and lays out (images, tool cards, markdown) while the user is
 * scrolling, which is the flicker; and the effect that re-based the index ran
 * one frame too late, arming a 240-row eviction for the next array change (the
 * teleport class).
 *
 * The window is now derived from a msgId anchor on every render pass, so a
 * prepend, a head drop, and a whole window swap all keep the SAME rows on
 * screen.
 */
import { describe, it, expect } from 'vitest';
import { computeRenderWindow, type RenderWindowState } from '@/components/sessions/render-window';

const LIMIT = 30; // INITIAL_RENDER_LIMIT

/** A conversation of `n` rows, each with a stable msgId (`m<absolute index>`). */
const conv = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ msgId: `m${from + i}` }));

const fresh: RenderWindowState = { start: null, anchor: null };

/** The msgId the window starts at — the only thing the user can actually see. */
const startId = (msgs: { msgId?: string }[], s: RenderWindowState) => msgs[s.start ?? 0]?.msgId;

describe('computeRenderWindow', () => {
  it('fresh view renders only the tail', () => {
    const msgs = conv(400, 143); // archive tail of a 543-row session
    const w = computeRenderWindow(msgs, LIMIT, fresh);
    expect(w.start).toBe(370);
    expect(w.anchor).toEqual({ msgId: 'm513', offset: 0 });
  });

  it('growth keeps already-rendered rows (ratchets down only)', () => {
    const msgs = conv(400, 143);
    let w = computeRenderWindow(msgs, LIMIT, fresh);
    expect(startId(msgs, w)).toBe('m513');
    // 5 new messages append: the natural tail moves forward, the window must not.
    const grown = conv(405, 143);
    w = computeRenderWindow(grown, LIMIT, w);
    expect(startId(grown, w)).toBe('m513');
  });

  it('WINDOW SWAP (the reported bug): a short Phase 1 then the full tail keeps 30 rows', () => {
    const p1 = conv(161, 382); // streams read: last 161 of the conversation
    let w = computeRenderWindow(p1, LIMIT, fresh);
    expect(w.start).toBe(131);
    expect(startId(p1, w)).toBe('m513');

    const p2 = conv(400, 143); // archive read: last 400 — same content, 239 rows earlier
    w = computeRenderWindow(p2, LIMIT, w);
    // Before the fix: start stayed 131 → 269 rows rendered (35,505px of DOM).
    expect(w.start).toBe(370);
    expect(startId(p2, w)).toBe('m513'); // the reader's first row is unchanged
  });

  it('HEAD DROP: a 400-row refetch under a 425-row held array evicts nothing', () => {
    const held = conv(425, 152); // 400-row tail + 25 delta appends
    let w = computeRenderWindow(held, LIMIT, fresh);
    expect(startId(held, w)).toBe('m547');
    const refetched = conv(400, 177); // fixed 400-row tail: 25 rows gone off the head
    w = computeRenderWindow(refetched, LIMIT, w);
    expect(startId(refetched, w)).toBe('m547');
  });

  it('"Load earlier" backfill: prepended rows shift the window, not the reader', () => {
    const tail = conv(400, 143);
    let w = computeRenderWindow(tail, LIMIT, fresh);
    expect(startId(tail, w)).toBe('m513');
    const full = conv(543, 0); // 143 older rows prepended
    w = computeRenderWindow(full, LIMIT, w);
    expect(w.start).toBe(513);
    expect(startId(full, w)).toBe('m513');
  });

  it('expanding the limit ("Show earlier") widens the window and re-anchors', () => {
    const msgs = conv(400, 143);
    let w = computeRenderWindow(msgs, LIMIT, fresh);
    w = computeRenderWindow(msgs, LIMIT + 200, w);
    expect(w.start).toBe(170);
    expect(startId(msgs, w)).toBe('m313');
    // …and the widened window is itself sticky against a later swap.
    const swapped = conv(543, 0);
    w = computeRenderWindow(swapped, LIMIT + 200, w);
    expect(startId(swapped, w)).toBe('m313');
  });

  it('/compact rewrite: the anchored rows are GONE, so fall back to the tail', () => {
    const before = conv(400, 143);
    let w = computeRenderWindow(before, LIMIT, fresh);
    const compacted = conv(157, 1000); // whole transcript rewritten, no msgId survives
    w = computeRenderWindow(compacted, LIMIT, w);
    expect(w.start).toBe(127); // natural tail — nothing stale pinned above it
    expect(startId(compacted, w)).toBe('m1127');
  });

  it('shorter-than-limit conversation renders from the top', () => {
    const msgs = conv(12);
    const w = computeRenderWindow(msgs, LIMIT, fresh);
    expect(w.start).toBe(0);
  });

  it('rows without msgIds anchor to the first identified row after the start', () => {
    const msgs = [...conv(35)].map((m, i) => (i === 5 ? {} : m));
    const w = computeRenderWindow(msgs, LIMIT, fresh);
    expect(w.start).toBe(5);
    expect(w.anchor).toEqual({ msgId: 'm6', offset: 1 });
    // A prepend still lands the reader on the same content.
    const grown = [...conv(3, 100), ...msgs];
    const w2 = computeRenderWindow(grown, LIMIT, w);
    expect(w2.start).toBe(8);
    expect(grown[w2.start]).toBe(msgs[5]);
  });

  it('an all-anonymous array degrades to the old numeric ratchet', () => {
    const msgs = Array.from({ length: 50 }, () => ({}));
    let w = computeRenderWindow(msgs, LIMIT, fresh);
    expect(w.start).toBe(20);
    expect(w.anchor).toBeNull();
    w = computeRenderWindow(Array.from({ length: 60 }, () => ({})), LIMIT, w);
    expect(w.start).toBe(20); // still monotonic-down, nothing evicted
  });
});

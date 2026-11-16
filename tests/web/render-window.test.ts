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
import { historyTurnWindowLimit, INITIAL_HISTORY_TURNS, EARLIER_HISTORY_TURNS } from '../../src/lib/history-turn-window';

describe('historyTurnWindowLimit', () => {
  const turns = (count: number, activity = 0) => Array.from({ length: count }, (_, turn) => [
    { role: 'user', text: `Question ${turn}` },
    ...Array.from({ length: activity }, () => ({ role: 'assistant', text: '' })),
    { role: 'assistant', text: `Answer ${turn}` },
  ]).flat();

  it('opens ten full turns even when each contains one hundred activity rows', () => {
    const rows = turns(45, 100);
    expect(historyTurnWindowLimit(rows, INITIAL_HISTORY_TURNS)).toBe(1020);
    const start = rows.length - 1020;
    expect(historyTurnWindowLimit(rows.slice(0, start), EARLIER_HISTORY_TURNS)).toBe(2040);
  });

  it('does not count injected rows or peer notices as human turns', () => {
    const rows = turns(11).flatMap((m) => [m,
      { role: 'user', text: 'Skill contents', injected: true },
      { role: 'user', text: '[Request interrupted by user]' },
      { role: 'user', text: '[Request interrupted by user for tool use]' },
      { role: 'user', text: '[Task context]\nMachine context\n[/Task context]\n<walnut-message kind="notification">\nDone\n</walnut-message>' },
      { role: 'user', text: '<walnut-message kind="notification">\nA background job finished.\n</walnut-message>' },
      { role: 'user', text: '[Task context]\nMachine context\n[/Task context]' },
    ]);
    expect(historyTurnWindowLimit(rows, 10)).toBe(rows.length - 14);
  });

  it('windows the root page over its own human turns', () => {
    const rows = turns(12);
    expect(historyTurnWindowLimit(rows, 10, (i) => i < 4 || i >= 8)).toBe(rows.length);
  });

  it('uses a 75-row fallback when a tail has no human turns', () => {
    const rows = Array.from({ length: 200 }, () => ({ role: 'assistant', text: 'Activity' }));
    expect(historyTurnWindowLimit(rows, 10)).toBe(75);
    expect(historyTurnWindowLimit(rows, 20)).toBe(75);
    expect(historyTurnWindowLimit([], 10)).toBe(0);
  });

  it('keeps every row of a short or unfinished conversation', () => {
    const rows = [...turns(4, 5), { role: 'user', text: '\u4f60\u597d' }]; // Unicode user text still starts a turn.
    expect(historyTurnWindowLimit(rows, 10)).toBe(rows.length);
  });
});

const LIMIT = 30;

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

  it('expands a requested row window without moving its anchor on backfill', () => {
    const msgs = conv(1050, 143);
    let w = computeRenderWindow(msgs, LIMIT, fresh);
    for (const [limit, start] of [[530, 520], [1030, 20], [1530, 0]]) {
      w = computeRenderWindow(msgs, limit, w);
      expect(w.start).toBe(start);
      expect(startId(msgs, w)).toBe(`m${start + 143}`);
    }
    const swapped = conv(2000, 0);
    w = computeRenderWindow(swapped, 1530, w);
    expect(startId(swapped, w)).toBe('m143');
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

/**
 * A column left open on a live session kept every row it ever drew (2026-11-10:
 * 630 rows and 23,000 DOM nodes after three hours, about 40 KB of JS heap a row).
 * A reader following the bottom sees none of the older rows, so the window may
 * cut back to the default tail once it holds `slack` rows more.
 */
describe('computeRenderWindow: a reader following the bottom', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ msgId: `m${i}` }));
  const follow = { tailLimit: 30, slack: 15 };

  it('keeps growing until the slack is used, then cuts back to the tail in one step', () => {
    let w = computeRenderWindow(rows(40), 30, { start: null, anchor: null }, follow);
    expect(w.start).toBe(10);
    expect(w.trimmed).toBeFalsy();
    w = computeRenderWindow(rows(55), 30, w, follow);
    expect(w.start).toBe(10); // 15 rows past the tail: still inside the slack
    expect(w.trimmed).toBeFalsy();
    w = computeRenderWindow(rows(56), 30, w, follow);
    expect(w).toEqual({ start: 26, anchor: { msgId: 'm26', offset: 0 }, trimmed: true, held: 0 });
  });

  it('rows stay bounded however long the session runs', () => {
    let w = computeRenderWindow(rows(30), 30, { start: null, anchor: null }, follow);
    let most = 0;
    for (let n = 31; n <= 2000; n++) {
      w = computeRenderWindow(rows(n), 30, w, follow);
      most = Math.max(most, n - w.start);
    }
    expect(most).toBeLessThanOrEqual(follow.tailLimit + follow.slack);
  });

  it('a widened window (Load earlier turns) is cut too while the reader follows', () => {
    const w = computeRenderWindow(rows(200), 150, { start: null, anchor: null }, follow);
    expect(w.start).toBe(170);
    expect(w.trimmed).toBe(true);
  });

  it('a reader who is not following never loses a row', () => {
    let w = computeRenderWindow(rows(40), 30, { start: null, anchor: null });
    for (let n = 41; n <= 500; n++) w = computeRenderWindow(rows(n), 30, w);
    expect(w.start).toBe(10);
    expect(w.trimmed).toBeFalsy();
  });
  it('rows the reader still sees above the tail are never cut (ten short turns in a tall column)', () => {
    const asked: number[] = []
    const keep = { ...follow, canCut: (t: number) => { asked.push(t); return false } }
    const w = computeRenderWindow(rows(200), 150, { start: null, anchor: null }, keep)
    expect(w.start).toBe(50)
    expect(w.trimmed).toBeFalsy()
    expect(asked).toEqual([170])
    const cut = computeRenderWindow(rows(200), 150, { start: null, anchor: null }, { ...follow, canCut: () => true })
    expect(cut.trimmed).toBe(true)
  })
});

/**
 * The window opens rows nobody asked for a step a pass (2026-11-16, task 9bceb9f2): the turn
 * window of an agent's session is its whole 400-row tail, the server's first screen is 40 rows,
 * and the full read landing after that screen drew some 360 rows in one task (1.8 s in the Mac
 * app beside the Org page). Each check fails on the window before: it drew them all at once.
 */
describe('computeRenderWindow: growth a step a pass', () => {
  const rows = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ msgId: `m${from + i}` }));
  const step = (rows: number, mustShow = 0) => ({ rows, first: 40, mustShow });

  it('a fresh view draws its first step of rows, and owes the rest', () => {
    const w = computeRenderWindow(rows(400), 400, { start: null, anchor: null }, undefined, step(40));
    expect(w.start).toBe(360);
    expect(w.held).toBe(360);
  });

  it('the full read landing under a 40-row first screen draws no row above it in its own pass', () => {
    let w = computeRenderWindow(rows(40, 360), 40, { start: null, anchor: null }, undefined, step(40));
    expect(w).toMatchObject({ start: 0, held: 0 });
    w = computeRenderWindow(rows(400), 400, w, undefined, step(0));
    expect(w.start).toBe(360); // the same 40 rows, re-based onto the full read
    expect(w.held).toBe(360);
    // Then a step a pass, down to the turn window.
    for (const at of [320, 280, 240]) {
      w = computeRenderWindow(rows(400), 400, w, undefined, step(40));
      expect(w.start).toBe(at);
    }
    while (w.held > 0) w = computeRenderWindow(rows(400), 400, w, undefined, step(40));
    expect(w.start).toBe(0);
  });

  it('what the reader asked for opens at once', () => {
    let w = computeRenderWindow(rows(400), 30, { start: null, anchor: null }, undefined, step(40));
    expect(w.start).toBe(370);
    w = computeRenderWindow(rows(400), 300, w, undefined, step(0, 300)); // "Load earlier turns"
    expect(w).toMatchObject({ start: 100, held: 0 });
  });

  it('a live row at the end opens nothing above, and leaves the step owed where it was', () => {
    let w = computeRenderWindow(rows(400), 400, { start: null, anchor: null }, undefined, step(40));
    w = computeRenderWindow(rows(401), 401, w, undefined, step(0));
    expect(w).toMatchObject({ start: 360, held: 360 });
  });

  it('a rewritten transcript (its drawn rows gone) draws a first step again, never nothing', () => {
    let w = computeRenderWindow(rows(400), 400, { start: null, anchor: null }, undefined, step(40));
    w = computeRenderWindow(rows(100, 5000), 100, w, undefined, step(0));
    expect(w).toMatchObject({ start: 60, held: 60 });
  });
});

describe('computeRenderWindow: growth keeps what it drew', () => {
  const rows = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ msgId: `m${from + i}` }));
  it('a window that slid past its anchor keeps as many rows as it drew, never back to a first step', () => {
    // 400 rows drawn from the top, then a read that dropped the anchored head row.
    const drawn = computeRenderWindow(rows(400), 400, { start: 0, anchor: { msgId: 'm0', offset: 0 } }, undefined, { rows: 0, first: 40, mustShow: 0 });
    expect(drawn.start).toBe(0);
    const slid = computeRenderWindow(rows(398, 2), 398, { ...drawn, drawn: { rows: 400, tailId: 'm399' } }, undefined, { rows: 0, first: 40, mustShow: 0 });
    expect(slid).toMatchObject({ start: 0, held: 0 });
  });
  it('a rewritten transcript (every id new) starts again from a first step, whatever it drew', () => {
    const w = computeRenderWindow(rows(400, 9000), 400, { start: 0, anchor: { msgId: 'm0', offset: 0 }, drawn: { rows: 400, tailId: 'm399' } }, undefined, { rows: 0, first: 40, mustShow: 0 });
    expect(w).toMatchObject({ start: 360, held: 360 });
  });
});

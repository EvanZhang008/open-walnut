/**
 * Outline row order (web/src/components/sessions/outline-order.ts).
 *
 * The outline is a table of contents of the transcript, so it reads in transcript
 * order. The case that was wrong (2026-09-18): the panel holds a TAIL window of the
 * history, and a pin on a message OLDER than the window sorted LAST, under a pin
 * made an hour ago on a loaded row ("the activator one is really the later one").
 * Placement by the message's timestamp puts it where the conversation has it.
 */
import { describe, it, expect } from 'vitest';
import { outlineTimeLabel, placePins, unloadedSlot } from '@/components/sessions/outline-order';
import type { SessionPinnedMessage } from '@/types/session';

const T0 = Date.parse('2026-09-17T08:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

const row = (msgId: string, minutes: number) => ({ msgId, timestamp: at(minutes) });

const pin = (
  msgId: string, minutes: number | undefined, extra: Partial<SessionPinnedMessage> = {},
): SessionPinnedMessage => ({
  msgId, role: 'assistant', label: msgId, pinnedAt: at(1000),
  ...(minutes === undefined ? {} : { timestamp: at(minutes) }),
  ...extra,
});

/** A loaded tail window: rows 10..19, one per minute, 100 minutes after T0. */
const WINDOW = Array.from({ length: 10 }, (_, i) => row(`m${10 + i}`, 100 + i));

describe('unloadedSlot', () => {
  const stamps = WINDOW.map((m) => Date.parse(m.timestamp));

  it('places a message older than every loaded row BEFORE the first one', () => {
    expect(unloadedSlot(stamps, at(5))).toBe(-0.5);
  });

  it('places a message between two loaded rows between their positions', () => {
    // Stamped between m13 (103) and m14 (104): after index 3, before index 4.
    expect(unloadedSlot(stamps, at(103.5))).toBe(3.5);
  });

  it('places a message newer than every loaded row after the last one', () => {
    expect(unloadedSlot(stamps, at(500))).toBe(9.5);
  });

  it('skips loaded rows that have no timestamp instead of stopping at them', () => {
    const withGaps = [NaN, stamps[0], NaN, stamps[1], NaN];
    // Older than m10 (index 1): right before it. The unstamped row at index 0 is
    // not a boundary either way — nothing is known about its time, so the pin does
    // not leap over it.
    expect(unloadedSlot(withGaps, at(5))).toBe(0.5);
    // Between m10 and m11: after m10 (index 1); the NaN at index 2 is NOT a
    // boundary, so the slot is right before m11 at index 3.
    expect(unloadedSlot(withGaps, at(100.5))).toBe(2.5);
  });

  it('cannot place a pin with no timestamp, so it sorts last', () => {
    expect(unloadedSlot(stamps, undefined)).toBe(Number.MAX_SAFE_INTEGER);
    expect(unloadedSlot(stamps, 'not a date')).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('placePins', () => {
  it('reads loaded pins in transcript order, whatever order they were pinned in', () => {
    const placed = placePins([
      pin('m17', 107, { pinnedAt: at(1000) }),
      pin('m12', 102, { pinnedAt: at(2000) }),
    ], WINDOW);
    expect(placed.map((p) => p.pin.msgId)).toEqual(['m12', 'm17']);
    expect(placed.map((p) => p.at)).toEqual([2, 7]);
    expect(placed.every((p) => p.loaded)).toBe(true);
  });

  it('the report: a pin OLDER than the loaded window sorts first, not last', () => {
    // "activator" is the last loaded row of the tail (m19); "Q2" was pinned two
    // days earlier on a message the tail window does not hold.
    const placed = placePins([
      pin('m19', 109, { pinnedAt: at(3000), quote: { exact: 'activator' } }),
      pin('q2', -2880, { pinnedAt: at(-2800), quote: { exact: 'Q2' } }),
    ], WINDOW);
    expect(placed.map((p) => p.pin.quote?.exact)).toEqual(['Q2', 'activator']);
    expect(placed[0].loaded).toBe(false);
    expect(placed[0].at).toBe(-0.5);
    expect(placed[1]).toMatchObject({ at: 9, loaded: true });
  });

  it('two unloaded pins in the same gap read in their messages\' time order', () => {
    const placed = placePins([
      pin('old-b', 8, { pinnedAt: at(1000) }),
      pin('old-a', 3, { pinnedAt: at(2000) }),
    ], WINDOW);
    expect(placed.map((p) => p.pin.msgId)).toEqual(['old-a', 'old-b']);
  });

  it('an unloaded pin stamped between two loaded rows lands between them', () => {
    const placed = placePins([
      pin('m15', 105),
      pin('rewritten', 104.5),
      pin('m14', 104),
    ], WINDOW);
    expect(placed.map((p) => p.pin.msgId)).toEqual(['m14', 'rewritten', 'm15']);
  });

  it('a pin with no timestamp and no loaded row still shows, at the end', () => {
    const placed = placePins([pin('ghost', undefined), pin('m11', 101)], WINDOW);
    expect(placed.map((p) => p.pin.msgId)).toEqual(['m11', 'ghost']);
  });

  it('within one message the whole-message pin heads its passages, in pin order', () => {
    const placed = placePins([
      pin('m13', 103, { pinnedAt: at(3000), quote: { exact: 'second' } }),
      pin('m13', 103, { pinnedAt: at(2000), quote: { exact: 'first' } }),
      pin('m13', 103, { pinnedAt: at(4000) }),
    ], WINDOW);
    expect(placed.map((p) => p.pin.quote?.exact ?? 'whole')).toEqual(['whole', 'first', 'second']);
  });

  it('matches a row by walnutMessageId when it has no msgId', () => {
    const rows = [{ walnutMessageId: 'w1', timestamp: at(1) }, ...WINDOW];
    const placed = placePins([pin('w1', 1)], rows);
    expect(placed[0]).toMatchObject({ at: 0, loaded: true });
  });
});

describe('outlineTimeLabel', () => {
  const now = new Date('2026-09-18T18:30:00');

  it('shows only the clock for a row from today', () => {
    const label = outlineTimeLabel('2026-09-18T13:08:00', now);
    expect(label).toMatch(/1:08/);
    expect(label).not.toMatch(/Sep/);
  });

  it('adds the date for a row from another day (a bare clock read as today)', () => {
    const label = outlineTimeLabel('2026-09-16T15:08:00', now);
    expect(label).toMatch(/Sep/);
    expect(label).toMatch(/16/);
    expect(label).toMatch(/3:08/);
  });

  it('is empty for a missing or unparsable stamp', () => {
    expect(outlineTimeLabel(undefined, now)).toBe('');
    expect(outlineTimeLabel('nope', now)).toBe('');
  });
});

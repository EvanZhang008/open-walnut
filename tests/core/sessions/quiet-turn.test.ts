/**
 * A quiet turn (src/core/sessions/quiet-turn.ts) lasts exactly as long as Walnut's own upkeep turn:
 * it ends at once when anything else is sent or another turn starts after it, and a little after
 * its result so late readers still see it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  beginQuietTurn, isQuietTurn, noteQuietTurnDelivery, noteQuietTurnSettled, noteSessionSend, noteTurnStart, onQuietTurnEnd,
  quietTurnKind, resetQuietTurnsForTest, QUIET_TURN_GRACE_MS, QUIET_TURN_MAX_MS, type QuietTurnEnd,
} from '../../../src/core/sessions/quiet-turn.js';
import { lastWorkTurnEnd } from '../../../src/core/sessions/status-reconcile.js';
import { frameForSource } from '../../../src/core/sessions/send-frame.js';

beforeEach(() => { resetQuietTurnsForTest(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); onQuietTurnEnd(null); resetQuietTurnsForTest(); });

describe('how long a quiet turn lasts', () => {
  it('from its send to a grace after its result', () => {
    beginQuietTurn('s1', 'idle-compact', 'idle-compact');
    expect(isQuietTurn('s1')).toBe(true);
    expect(quietTurnKind('s1')).toBe('idle-compact');
    // Its own send and its own turn start keep it.
    noteSessionSend('s1', 'idle-compact');
    noteTurnStart('s1');
    expect(isQuietTurn('s1')).toBe(true);
    noteQuietTurnSettled('s1');
    vi.advanceTimersByTime(QUIET_TURN_GRACE_MS - 1);
    expect(isQuietTurn('s1')).toBe(true);
    vi.advanceTimersByTime(2);
    expect(isQuietTurn('s1')).toBe(false);
  });

  it('a message from anyone else ends it at once, mid-compaction too', () => {
    beginQuietTurn('s1', 'idle-compact', 'idle-compact');
    noteSessionSend('s1', 'ui');
    expect(isQuietTurn('s1')).toBe(false);
  });

  it('a turn that starts after its result is not quiet', () => {
    beginQuietTurn('s1', 'idle-compact', 'idle-compact');
    noteQuietTurnSettled('s1');
    noteTurnStart('s1');
    expect(isQuietTurn('s1')).toBe(false);
  });

  it('a lost turn stops being quiet after the cap', () => {
    beginQuietTurn('s1', 'idle-compact', 'idle-compact');
    vi.advanceTimersByTime(QUIET_TURN_MAX_MS + 1);
    expect(isQuietTurn('s1')).toBe(false);
  });

  it('a quiet turn begun before a restart keeps only the time it had left', () => {
    beginQuietTurn('s1', 'idle-compact', 'idle-compact', Date.now() - (QUIET_TURN_MAX_MS - 5_000), 'row-1');
    vi.advanceTimersByTime(5_001);
    expect(isQuietTurn('s1')).toBe(false);
  });

  it('is per session', () => {
    beginQuietTurn('s1', 'idle-compact', 'idle-compact');
    expect(isQuietTurn('s2')).toBe(false);
    expect(isQuietTurn(undefined)).toBe(false);
  });
});

describe('a quiet turn is bound to its own row', () => {
  const ends: QuietTurnEnd[] = [];
  beforeEach(() => { ends.length = 0; onQuietTurnEnd((e) => ends.push(e)); });

  it('its row going out alone keeps it, and its turn start too', () => {
    beginQuietTurn('s1', 'idle-compact', 'idle-compact', Date.now(), 'row-1');
    noteQuietTurnDelivery('s1', ['row-1']);
    noteTurnStart('s1');
    noteTurnStart('s1'); // the CLI's own {running} echo of the same turn
    expect(isQuietTurn('s1')).toBe(true);
    noteQuietTurnSettled('s1');
    vi.advanceTimersByTime(QUIET_TURN_GRACE_MS + 1);
    expect(ends).toEqual([{ sessionId: 's1', kind: 'idle-compact', why: 'settled', rowId: 'row-1', delivered: true }]);
  });

  it('another line going out first is a real turn: the quiet one ends, its row not sent', () => {
    beginQuietTurn('s1', 'idle-compact', 'idle-compact', Date.now(), 'row-1');
    noteQuietTurnDelivery('s1', ['qm-person']);
    expect(isQuietTurn('s1')).toBe(false);
    expect(ends).toEqual([{ sessionId: 's1', kind: 'idle-compact', why: 'other-line', rowId: 'row-1', delivered: false }]);
  });

  it('its row batched with anything is not quiet either', () => {
    beginQuietTurn('s1', 'idle-compact', 'idle-compact', Date.now(), 'row-1');
    noteQuietTurnDelivery('s1', ['row-1', 'qm-person']);
    expect(isQuietTurn('s1')).toBe(false);
  });

  it('a turn the CLI starts by itself before the row went out (a wakeup) is not quiet', () => {
    beginQuietTurn('s1', 'idle-compact', 'idle-compact', Date.now(), 'row-1');
    noteTurnStart('s1');
    expect(isQuietTurn('s1')).toBe(false);
    expect(ends[0]).toMatchObject({ why: 'turn-before-delivery', delivered: false });
  });

  it('a person writing before the row went out ends it with the row unsent', () => {
    beginQuietTurn('s1', 'idle-compact', 'idle-compact', Date.now(), 'row-1');
    noteSessionSend('s1', 'ui');
    expect(ends[0]).toMatchObject({ why: 'other-send', rowId: 'row-1', delivered: false });
  });
});

describe('a result names its turn: late readers still know', () => {
  it('the quiet turn\'s generation reads quiet through the grace, even after a person wrote', () => {
    beginQuietTurn('s1', 'idle-compact', 'idle-compact', Date.now(), 'row-1');
    noteQuietTurnDelivery('s1', ['row-1']);
    noteTurnStart('s1', 7);
    noteTurnStart('s1', 8); // a second edge of the same turn
    noteQuietTurnSettled('s1');
    noteSessionSend('s1', 'ui'); // the person writes right after the result
    expect(isQuietTurn('s1')).toBe(false);
    expect(isQuietTurn('s1', 8)).toBe(true); // a late reader of the compaction's result
    noteTurnStart('s1', 9);
    expect(isQuietTurn('s1', 9)).toBe(false); // the person's own turn
    vi.advanceTimersByTime(QUIET_TURN_GRACE_MS + 1);
    expect(isQuietTurn('s1', 8)).toBe(false); // a respawned runner's 8 is another turn
  });

  it('a result of a real turn never reads quiet, and an unseen start falls back to the live answer', () => {
    beginQuietTurn('s1', 'idle-compact', 'idle-compact', Date.now(), 'row-1');
    noteQuietTurnDelivery('s1', ['row-1']);
    expect(isQuietTurn('s1', 3)).toBe(true); // no start reported yet
    noteTurnStart('s1', 4);
    expect(isQuietTurn('s1', 3)).toBe(false);
    expect(isQuietTurn('s1', 4)).toBe(true);
  });
});

describe('the status loop reads the turn before a quiet one', () => {
  const ic = { sentAt: '2026-11-04T10:57:00.000Z', priorTurnEnd: '2026-11-04T10:00:30.000Z', endedAt: '2026-11-04T10:58:30.000Z' };
  it('the compaction\'s own status change reads as the task\'s last real turn end', () => {
    expect(lastWorkTurnEnd({ last_status_change: '2026-11-04T10:58:31.000Z', idleCompaction: ic })).toBe(Date.parse(ic.priorTurnEnd));
    // Still running: the same.
    expect(lastWorkTurnEnd({ last_status_change: '2026-11-04T10:57:01.000Z', idleCompaction: { ...ic, endedAt: undefined } })).toBe(Date.parse(ic.priorTurnEnd));
  });
  it('with no end stored, the quiet turn lasted at most its cap: a later real turn reads as itself', () => {
    const open = { ...ic, endedAt: undefined };
    const capEnd = Date.parse(ic.sentAt) + QUIET_TURN_MAX_MS;
    expect(lastWorkTurnEnd({ last_status_change: new Date(capEnd + 60_000).toISOString(), idleCompaction: open })).toBe(capEnd + 60_000);
  });
  it('a later real turn reads as itself, and a session never compacted is unchanged', () => {
    expect(lastWorkTurnEnd({ last_status_change: '2026-11-04T11:20:00.000Z', idleCompaction: ic })).toBe(Date.parse('2026-11-04T11:20:00.000Z'));
    expect(lastWorkTurnEnd({ last_status_change: '2026-11-04T10:00:30.000Z' })).toBe(Date.parse('2026-11-04T10:00:30.000Z'));
  });
});

describe('the command reaches the CLI as a command', () => {
  it('the idle compaction\'s bare /compact is not framed; anything else from it is', () => {
    expect(frameForSource('/compact', 'idle-compact')).toBe('/compact');
    expect(frameForSource('/compact now please', 'idle-compact')).not.toBe('/compact now please');
    expect(frameForSource('/compact', 'peer')).not.toBe('/compact');
  });
});

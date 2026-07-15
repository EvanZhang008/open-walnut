import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  openTurn, settleTurn, abortTurn, getOpenTurnId, getOpenTurnPromise,
  _resetTurnLedgerForTest,
} from '../../src/providers/turn-ledger.js';

beforeEach(() => {
  _resetTurnLedgerForTest();
});
afterEach(() => {
  _resetTurnLedgerForTest();
  vi.useRealTimers();
});

describe('turn-ledger — happy path', () => {
  it('opens a turn and settles it with the given outcome', async () => {
    const { turnId, promise } = openTurn('s1');
    expect(typeof turnId).toBe('string');
    expect(turnId.length).toBeGreaterThan(0);
    expect(getOpenTurnId('s1')).toBe(turnId);

    const settled = settleTurn('s1', { kind: 'result', isError: false });
    expect(settled).toBe(true);

    const outcome = await promise;
    expect(outcome).toEqual({ kind: 'result', isError: false });
    // Once settled, it's no longer "open".
    expect(getOpenTurnId('s1')).toBeUndefined();
    expect(getOpenTurnPromise('s1')).toBeUndefined();
  });

  it('settling twice is a no-op the second time (idempotent, mirrors resultEmitted guard)', () => {
    openTurn('s1');
    expect(settleTurn('s1', { kind: 'idle' })).toBe(true);
    expect(settleTurn('s1', { kind: 'idle' })).toBe(false);
  });

  it('settling a session with no open turn is a no-op, never throws', () => {
    expect(settleTurn('never-opened', { kind: 'idle' })).toBe(false);
  });

  it('abortTurn rejects the promise instead of resolving it', async () => {
    const { promise } = openTurn('s1');
    expect(abortTurn('s1', 'session-killed')).toBe(true);
    await expect(promise).rejects.toThrow('session-killed');
  });

  it('abortTurn on an already-settled turn is a no-op', () => {
    openTurn('s1');
    settleTurn('s1', { kind: 'idle' });
    expect(abortTurn('s1', 'too-late')).toBe(false);
  });
});

describe('turn-ledger — per-session isolation', () => {
  it('two sessions have independent turns', async () => {
    const a = openTurn('sess-a');
    const b = openTurn('sess-b');
    expect(a.turnId).not.toBe(b.turnId);

    settleTurn('sess-a', { kind: 'result', isError: false });
    expect(getOpenTurnId('sess-a')).toBeUndefined();
    expect(getOpenTurnId('sess-b')).toBe(b.turnId);   // untouched

    settleTurn('sess-b', { kind: 'stopped' });
    await expect(a.promise).resolves.toEqual({ kind: 'result', isError: false });
    await expect(b.promise).resolves.toEqual({ kind: 'stopped' });
  });
});

describe('turn-ledger — reopen semantics', () => {
  it('opening a turn for a session with an already-open turn reuses it (does not clobber)', () => {
    const first = openTurn('s1');
    const second = openTurn('s1');
    expect(second.turnId).toBe(first.turnId);
    expect(second.promise).toBe(first.promise);
  });

  it('opening after a settle mints a genuinely new turn', async () => {
    const first = openTurn('s1');
    settleTurn('s1', { kind: 'idle' });
    const second = openTurn('s1');
    expect(second.turnId).not.toBe(first.turnId);
    settleTurn('s1', { kind: 'stopped' });
    await expect(second.promise).resolves.toEqual({ kind: 'stopped' });
  });
});

describe('turn-ledger — timeout fast-fail (no_result)', () => {
  it('rejects with no_result if never settled within the timeout window', async () => {
    vi.useFakeTimers();
    const { promise } = openTurn('s1');
    const assertion = expect(promise).rejects.toThrow('no_result');
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    await assertion;
    expect(getOpenTurnId('s1')).toBeUndefined();
  });

  it('does not fire the timeout if the turn settles first', async () => {
    vi.useFakeTimers();
    const { promise } = openTurn('s1');
    settleTurn('s1', { kind: 'idle' });
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    await expect(promise).resolves.toEqual({ kind: 'idle' });
  });
});

/**
 * The speed readout's numbers and the store behind it.
 *
 *   computeReadout: what each slot of the row says for a live frame, a final
 *   frame, an interrupted turn and a cold record, and where the "~" estimate
 *   marker appears (in-flight tokens only) and disappears (the final).
 *   turnSpeedStore: the live frame outranks the record while a turn runs, the
 *   record fills in on a cold load, a late live frame cannot undo a final.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionTurnSpeed } from '../../src/core/types.js';

const onEvent = vi.fn();
vi.mock('../../web/src/api/ws', () => ({ wsClient: { onEvent: (...args: unknown[]) => onEvent(...args) } }));

const { computeReadout, formatSeconds, formatCost, formatTokens } = await import('../../web/src/components/sessions/turn-speed-format');
const { turnSpeedStore, initTurnSpeedStore } = await import('../../web/src/stores/turn-speed-store');

const T0 = 1_700_000_000_000;

function live(over: Partial<SessionTurnSpeed> = {}): SessionTurnSpeed {
  return {
    startedAt: T0, ttftMs: null, generationMs: 0, outputTokens: 0, messages: 0,
    model: 'claude-sonnet-5-5', inFlight: false, inFlightChars: 0, inFlightMs: 0, inFlightVisibleMs: 0, final: false,
    ...over,
  };
}

function final(over: Partial<SessionTurnSpeed> = {}): SessionTurnSpeed {
  return {
    startedAt: T0, ttftMs: 1200, generationMs: 22_000, outputTokens: 840, turnOutputTokens: 840,
    messages: 3, model: 'claude-opus-5-5', inFlight: false, inFlightChars: 0, inFlightMs: 0, inFlightVisibleMs: 0,
    costUsd: 1.71, durationMs: 24_300, final: true, endedAt: T0 + 24_300,
    ...over,
  };
}

describe('formatting helpers', () => {
  it('formats seconds with one decimal under 10s, whole seconds under a minute, then m/ss', () => {
    expect(formatSeconds(0)).toBe('0.0s');
    expect(formatSeconds(1234)).toBe('1.2s');
    expect(formatSeconds(24_300)).toBe('24s');
    expect(formatSeconds(65_000)).toBe('1m 05s');
    expect(formatSeconds(-5)).toBe('0.0s');
  });
  it('formats cost to cents, with a third digit only under a cent', () => {
    expect(formatCost(1.71)).toBe('$1.71');
    expect(formatCost(0.0123)).toBe('$0.01');
    expect(formatCost(0.004)).toBe('$0.004');
    expect(formatCost(0.0003)).toBe('<$0.001');
  });
  it('formats tokens with thousands separators', () => {
    expect(formatTokens(840)).toBe('840');
    expect(formatTokens(12_345)).toBe('12,345');
  });
});

describe('computeReadout: live turn', () => {
  it('before the first token: elapsed ticks in the first-token slot, no tokens, no rate', () => {
    const r = computeReadout(live(), T0 + 800);
    expect(r.live).toBe(true);
    expect(r.tokens).toBe('0 tok');
    expect(r.tokensEstimated).toBe(false);
    expect(r.ttft).toBe('0.8s…');
    expect(r.ttftPending).toBe(true);
    expect(r.tps).toBeNull();
    expect(r.duration).toBe('0.8s');
    expect(r.cost).toBe('');
  });

  it('first message streaming: ~ estimate from characters, ~ rate only after a second of visible output', () => {
    const early = computeReadout(live({ ttftMs: 900, inFlight: true, inFlightChars: 200, inFlightMs: 700, inFlightVisibleMs: 500 }), T0 + 1500);
    expect(early.tokens).toBe('~50 tok');
    expect(early.tokensEstimated).toBe(true);
    expect(early.ttft).toBe('0.9s');
    expect(early.ttftPending).toBe(false);
    expect(early.tps).toBeNull();

    // Hidden thinking: the message opened 9s before its first visible delta. The
    // interim rate is over the 4s of visible output, not the 13s since message_start.
    const later = computeReadout(live({ ttftMs: 9900, inFlight: true, inFlightChars: 800, inFlightMs: 13_000, inFlightVisibleMs: 4000 }), T0 + 14_000);
    expect(later.tokens).toBe('~200 tok');
    expect(later.tps).toBe('~50 tok/s');
    expect(later.tpsEstimated).toBe(true);
    expect(later.duration).toBe('14s');

    // Too few characters for a rate: the slot stays empty instead of "~0 tok/s".
    const tiny = computeReadout(live({ ttftMs: 900, inFlight: true, inFlightChars: 4, inFlightMs: 3000, inFlightVisibleMs: 2000 }), T0 + 4000);
    expect(tiny.tokens).toBe('~1 tok');
    expect(tiny.tps).toBeNull();
  });

  it('after a message boundary: real tokens plus the open message estimate, real rate, estimated cost', () => {
    const r = computeReadout(live({
      ttftMs: 900, generationMs: 2000, outputTokens: 100, messages: 1,
      inFlight: true, inFlightChars: 40, inFlightMs: 300, inFlightVisibleMs: 100, costUsd: 0.03, costEstimated: true,
    }), T0 + 6000);
    expect(r.tokens).toBe('~110 tok');
    expect(r.tps).toBe('50 tok/s');
    expect(r.tpsEstimated).toBe(false);
    expect(r.cost).toBe('~$0.03');
    expect(r.costEstimated).toBe(true);
  });

  it('between messages (tool running): no ~ on tokens, rate stays real', () => {
    const r = computeReadout(live({ ttftMs: 900, generationMs: 2000, outputTokens: 100, messages: 1 }), T0 + 9000);
    expect(r.tokens).toBe('100 tok');
    expect(r.tokensEstimated).toBe(false);
    expect(r.tps).toBe('50 tok/s');
  });
});

describe('computeReadout: final turn', () => {
  it('uses the CLI turn total, real rate, CLI wall time and CLI cost, no ~ anywhere', () => {
    const r = computeReadout(final(), T0 + 999_999);
    expect(r.live).toBe(false);
    expect(r.tokens).toBe('840 tok');
    expect(r.tokensEstimated).toBe(false);
    expect(r.ttft).toBe('1.2s');
    expect(r.tps).toBe('38 tok/s');
    expect(r.duration).toBe('24s');
    expect(r.cost).toBe('$1.71');
    expect(r.costEstimated).toBe(false);
    expect(r.interrupted).toBe(false);
    expect(r.partial).toBe(false);
  });

  it('a stopped turn keeps what it measured and flags it', () => {
    const r = computeReadout(final({ interrupted: true, partial: true, outputTokens: 120, turnOutputTokens: 120, generationMs: 3000 }), T0 + 999_999);
    expect(r.interrupted).toBe(true);
    expect(r.tokens).toBe('120 tok');
    expect(r.tps).toBe('40 tok/s');
  });

  it('a stopped turn with no CLI count shows its character estimate with ~ and no rate', () => {
    // A Stop mid-stream: the message closed before its usage arrived, so the
    // meter kept chars ÷ 4 (111 tokens here) and the CLI sent no turn total.
    const r = computeReadout(final({
      interrupted: true, partial: true, outputTokens: 0, turnOutputTokens: 0, estimatedTokens: 111,
      generationMs: 12_210, durationMs: 14_946, costUsd: 0.0096, costEstimated: true,
    }), T0 + 999_999);
    expect(r.tokens).toBe('~111 tok');
    expect(computeReadout(final({ interrupted: true, partial: true, outputTokens: 0, turnOutputTokens: undefined, estimatedTokens: 111 }), T0).tokens).toBe('~111 tok');
    expect(r.tokensEstimated).toBe(true);
    expect(r.tps).toBeNull();
    expect(r.interrupted).toBe(true);
    expect(r.cost).toBe('~$0.010');
  });

  it('a stopped multi-message turn adds the estimate on top of the CLI total (which stops at the last message_stop)', () => {
    const r = computeReadout(final({ interrupted: true, partial: true, outputTokens: 30, turnOutputTokens: 45, estimatedTokens: 3 }), T0);
    expect(r.tokens).toBe('~48 tok');
    expect(r.tokensEstimated).toBe(true);
    // The rate still divides only the counted tokens.
    expect(r.tps).toBe('1 tok/s');
  });

  it('a rate over a window shorter than half a second is not shown', () => {
    const r = computeReadout(final({ outputTokens: 4, turnOutputTokens: 4, generationMs: 2 }), T0 + 1);
    expect(r.tokens).toBe('4 tok');
    expect(r.tps).toBeNull();
  });

  it('a turn observed without stream events (no messages) has tokens and time but no first-token or rate', () => {
    const r = computeReadout(final({ ttftMs: null, generationMs: 0, outputTokens: 0, turnOutputTokens: 55, messages: 0 }), T0 + 1);
    expect(r.tokens).toBe('55 tok');
    expect(r.ttft).toBeNull();
    expect(r.tps).toBeNull();
    expect(r.duration).toBe('24s');
  });

  it('a final without the CLI wall time falls back to its own start/end; without either, no duration', () => {
    expect(computeReadout(final({ durationMs: undefined }), T0).duration).toBe('24s');
    expect(computeReadout(final({ durationMs: undefined, startedAt: undefined }), T0).duration).toBeNull();
  });

  it('an estimated cost on a final (legacy payload without the CLI increment) keeps its ~', () => {
    expect(computeReadout(final({ costUsd: 0.5, costEstimated: true }), T0).cost).toBe('~$0.50');
  });
});

describe('turnSpeedStore', () => {
  beforeEach(() => turnSpeedStore.reset());

  it('boot wires exactly one WS subscription', () => {
    onEvent.mockClear();
    initTurnSpeedStore();
    initTurnSpeedStore();
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][0]).toBe('session:turn-speed');
  });

  it('cold load: the record fills in; a live frame for a later turn outranks it', () => {
    const record = final({ endedAt: T0 + 24_300 });
    expect(turnSpeedStore.resolve('s1', record)).toBe(record);
    const frame = live({ startedAt: T0 + 60_000, inFlight: true, inFlightChars: 12 });
    turnSpeedStore.ingestEvent({ sessionId: 's1', speed: frame });
    expect(turnSpeedStore.resolve('s1', record)).toBe(frame);
    // Another session is untouched.
    expect(turnSpeedStore.resolve('s2', record)).toBe(record);
  });

  it('the final frame wins over an older record and ties with a refetched copy of itself', () => {
    const older = final({ endedAt: T0 + 100 });
    const fin = final({ startedAt: T0 + 60_000, endedAt: T0 + 90_000 });
    turnSpeedStore.ingestEvent({ sessionId: 's1', speed: fin });
    expect(turnSpeedStore.resolve('s1', older)).toBe(fin);
    const refetched = { ...fin };
    expect(turnSpeedStore.resolve('s1', refetched)).toEqual(fin);
    // A record of a NEWER turn (page reloaded while the next turn ran) wins.
    const newer = final({ startedAt: T0 + 120_000, endedAt: T0 + 150_000 });
    expect(turnSpeedStore.resolve('s1', newer)).toBe(newer);
  });

  it('a late live frame of the same turn cannot undo its final', () => {
    const fin = final({ startedAt: T0 + 60_000, endedAt: T0 + 90_000 });
    turnSpeedStore.ingestEvent({ sessionId: 's1', speed: fin });
    turnSpeedStore.ingestEvent({ sessionId: 's1', speed: live({ startedAt: T0 + 60_000, inFlight: true, inFlightChars: 3 }) });
    expect(turnSpeedStore.resolve('s1', undefined)).toBe(fin);
    // But the NEXT turn's first live frame does replace it.
    const next = live({ startedAt: T0 + 100_000 });
    turnSpeedStore.ingestEvent({ sessionId: 's1', speed: next });
    expect(turnSpeedStore.resolve('s1', undefined)).toBe(next);
  });

  it('ignores malformed payloads', () => {
    turnSpeedStore.ingestEvent(null);
    turnSpeedStore.ingestEvent({ sessionId: 's1' });
    turnSpeedStore.ingestEvent({ sessionId: 's1', speed: { outputTokens: 3 } });
    expect(turnSpeedStore.resolve('s1', undefined)).toBeUndefined();
  });
});

/**
 * TurnSpeedMeter: pure arithmetic over a fake clock. Every `now` is an explicit
 * number so the expected windows can be read straight off the event list.
 *
 * A message's generation window runs from message_start to message_stop (or
 * from the first delta when message_start was not seen); the gap between one
 * message_stop and the next message_start is tool time and is excluded.
 */
import { describe, it, expect } from 'vitest';
import { TurnSpeedMeter, tokensPerSecond } from '../../../src/core/sessions/turn-speed.js';
import { computeCost } from '../../../src/core/usage/pricing.js';

const MODEL = 'claude-sonnet-5-5';

describe('TurnSpeedMeter', () => {
  describe('single message turn', () => {
    // Turn start 1000, message_start 1500, first delta 1800, message_stop 2800.
    function runSingleMessage(): TurnSpeedMeter {
      const m = new TurnSpeedMeter();
      m.startTurn(1000);
      m.messageStart(1500, MODEL, { input_tokens: 2, cache_read_input_tokens: 100 });
      m.delta(1800, 5);
      m.delta(2000, 10);
      m.delta(2400, 7);
      m.messageUsage({ output_tokens: 40 });
      m.messageStop(2800);
      return m;
    }

    it('live snapshot after message_stop measures ttft, generation, tokens and an estimated cost', () => {
      const m = runSingleMessage();
      const snap = m.snapshot(2850);
      expect(snap.startedAt).toBe(1000);
      // Turn start to first delta.
      expect(snap.ttftMs).toBe(800);
      // message_start to message_stop; the 500ms before message_start is not generation.
      expect(snap.generationMs).toBe(1300);
      expect(snap.outputTokens).toBe(40);
      expect(snap.messages).toBe(1);
      expect(snap.model).toBe(MODEL);
      expect(snap.inFlight).toBe(false);
      expect(snap.inFlightChars).toBe(0);
      expect(snap.inFlightMs).toBe(0);
      expect(snap.final).toBe(false);
      expect(snap.partial).toBeUndefined();
      expect(snap.costEstimated).toBe(true);
      expect(snap.costUsd).toBeGreaterThan(0);
      // message_start's input-side counts survive the message_delta merge.
      expect(snap.costUsd).toBeCloseTo(computeCost({
        model: MODEL,
        input_tokens: 2,
        output_tokens: 40,
        cache_read_input_tokens: 100,
      }), 12);
    });

    it('finish adopts the CLI cost, duration and turn tokens, with no costEstimated flag', () => {
      const m = runSingleMessage();
      const final = m.finish(2900, { turnOutputTokens: 40, durationMs: 1900, costUsd: 0.5 });
      expect(final.final).toBe(true);
      expect(final.costUsd).toBe(0.5);
      expect(final.costEstimated).toBeUndefined();
      expect(final.durationMs).toBe(1900);
      expect(final.turnOutputTokens).toBe(40);
      expect(final.partial).toBeUndefined();
      expect(final.interrupted).toBeUndefined();
      expect(final.endedAt).toBe(2900);
      expect(final.ttftMs).toBe(800);
      expect(final.generationMs).toBe(1300);
      expect(final.outputTokens).toBe(40);
      expect(final.inFlight).toBe(false);
      expect(tokensPerSecond(final)).toBeCloseTo(40 / 1.3, 9);
    });
  });

  it('multi message turn includes each message time-to-first-delta but excludes the tool gap', () => {
    const m = new TurnSpeedMeter();
    m.startTurn(0);
    // Message 1: start 100, first delta 300, stop 1100 → window 1000 (200 before the delta included).
    m.messageStart(100, MODEL, { input_tokens: 10 });
    m.delta(300, 20);
    m.delta(800, 20);
    m.messageUsage({ output_tokens: 50 });
    m.messageStop(1100);
    // 5s of tool execution: 1100 → 6100, excluded.
    // Message 2: start 6100, first delta 6600, stop 7100 → window 1000 (500 before the delta included).
    m.messageStart(6100, MODEL, { input_tokens: 12 });
    m.delta(6600, 8);
    m.delta(6900, 8);
    m.messageUsage({ output_tokens: 30 });
    m.messageStop(7100);

    const snap = m.snapshot(7150);
    expect(snap.ttftMs).toBe(300);
    expect(snap.generationMs).toBe(2000);
    expect(snap.outputTokens).toBe(80);
    expect(snap.messages).toBe(2);
    expect(snap.partial).toBeUndefined();

    const final = m.finish(7200, { turnOutputTokens: 80, durationMs: 7200 });
    expect(final.generationMs).toBe(2000);
    expect(final.outputTokens).toBe(80);
    expect(final.partial).toBeUndefined();
    expect(tokensPerSecond(final)).toBe(40);
  });

  it('hidden thinking before the first visible delta counts in the window', () => {
    // Shape of the live measurement: 1,066 tokens, first visible delta 7.8s after
    // message_start, stop 12s after it. The visible-only window would read ~253 tok/s.
    const m = new TurnSpeedMeter();
    m.startTurn(0);
    m.messageStart(500, 'claude-opus-5-5', { input_tokens: 3 });
    m.delta(8300, 40);
    m.delta(10_000, 400);
    m.messageUsage({ output_tokens: 1066 });
    m.messageStop(12_500);

    const final = m.finish(12_600, { turnOutputTokens: 1066 });
    expect(final.ttftMs).toBe(8300);
    expect(final.generationMs).toBe(12_000);
    expect(tokensPerSecond(final)).toBeCloseTo(1066 / 12, 9);
    expect(tokensPerSecond(final)!).toBeLessThan(100);
  });

  it('a message with message_start and message_stop but no delta still contributes its window', () => {
    const m = new TurnSpeedMeter();
    m.startTurn(0);
    m.messageStart(100, MODEL, { input_tokens: 5 });
    m.messageUsage({ output_tokens: 15 });
    m.messageStop(600);

    const snap = m.snapshot(700);
    expect(snap.generationMs).toBe(500);
    expect(snap.outputTokens).toBe(15);
    expect(snap.messages).toBe(1);
    // No delta anywhere in the turn: nothing visible yet.
    expect(snap.ttftMs).toBeNull();
    expect(tokensPerSecond(snap)).toBe(30);
  });

  describe('live snapshot mid-message', () => {
    it('reports the open message as in flight with its chars and time since message_start', () => {
      const m = new TurnSpeedMeter();
      m.startTurn(0);
      m.messageStart(100, MODEL, { input_tokens: 5 });
      m.delta(200, 3);
      m.delta(400, 4);
      m.delta(700, 5);

      const snap = m.snapshot(1000);
      expect(snap.inFlight).toBe(true);
      expect(snap.inFlightChars).toBe(12);
      expect(snap.inFlightMs).toBe(900);
      expect(snap.outputTokens).toBe(0);
      expect(snap.generationMs).toBe(0);
      expect(snap.messages).toBe(0);
      expect(snap.ttftMs).toBe(200);
      // No finished message yet, so no cost estimate either.
      expect(snap.costUsd).toBeUndefined();
      expect(snap.costEstimated).toBeUndefined();
    });

    it('counts only finished messages in outputTokens while the next one streams', () => {
      const m = new TurnSpeedMeter();
      m.startTurn(0);
      m.messageStart(100, MODEL, { input_tokens: 5 });
      m.delta(200, 50);
      m.messageUsage({ output_tokens: 20 });
      m.messageStop(700); // window 600

      m.messageStart(2000, MODEL, { input_tokens: 5 });
      m.delta(2100, 6);
      m.delta(2300, 9);
      // message_delta arrived but message_stop did not: still not counted.
      m.messageUsage({ output_tokens: 99 });

      const snap = m.snapshot(2600);
      expect(snap.inFlight).toBe(true);
      expect(snap.inFlightChars).toBe(15);
      expect(snap.inFlightMs).toBe(600);
      expect(snap.outputTokens).toBe(20);
      expect(snap.generationMs).toBe(600);
      expect(snap.messages).toBe(1);
      expect(snap.costEstimated).toBe(true);
    });

    it('an open message with no delta yet counts in-flight time from message_start', () => {
      const m = new TurnSpeedMeter();
      m.startTurn(0);
      m.messageStart(100, MODEL, undefined);
      const snap = m.snapshot(900);
      expect(snap.inFlight).toBe(true);
      expect(snap.inFlightMs).toBe(800);
      expect(snap.inFlightChars).toBe(0);
      expect(snap.ttftMs).toBeNull();
    });

    it('inFlightMs is 0 when nothing is open', () => {
      const m = new TurnSpeedMeter();
      m.startTurn(0);
      expect(m.snapshot(5000).inFlightMs).toBe(0);
      m.messageStart(100, MODEL, undefined);
      m.messageUsage({ output_tokens: 1 });
      m.messageStop(300);
      expect(m.snapshot(5000).inFlightMs).toBe(0);
    });
  });

  it('a thinking first delta anchors ttft and its chars count the same as text', () => {
    const m = new TurnSpeedMeter();
    m.startTurn(0);
    m.messageStart(50, MODEL, { input_tokens: 1 });
    m.delta(400, 120); // thinking_delta
    m.delta(900, 30); // text_delta

    const live = m.snapshot(1000);
    expect(live.ttftMs).toBe(400);
    expect(live.inFlightChars).toBe(150);
    expect(live.inFlightMs).toBe(950);

    m.messageUsage({ output_tokens: 60 });
    m.messageStop(1400);
    const snap = m.snapshot(1500);
    expect(snap.ttftMs).toBe(400);
    expect(snap.generationMs).toBe(1350);
    expect(snap.outputTokens).toBe(60);
  });

  describe('interrupted mid-message', () => {
    it('closes the open window at finish time and marks the turn partial', () => {
      const m = new TurnSpeedMeter();
      m.startTurn(0);
      m.messageStart(100, MODEL, { input_tokens: 5 });
      m.delta(300, 10);
      m.delta(600, 10);

      const final = m.finish(1000, { interrupted: true });
      expect(final.final).toBe(true);
      expect(final.generationMs).toBe(900);
      expect(final.outputTokens).toBe(0);
      expect(final.messages).toBe(1);
      expect(final.partial).toBe(true);
      expect(final.interrupted).toBe(true);
      expect(final.inFlight).toBe(false);
      expect(final.inFlightChars).toBe(0);
      expect(final.inFlightMs).toBe(0);
      expect(final.endedAt).toBe(1000);
      expect(tokensPerSecond(final)).toBeNull();
      // The 20 characters it did stream survive as an estimate (÷4), and the
      // live cost estimate prices those tokens rather than zero output.
      expect(final.estimatedTokens).toBe(5);
      expect(final.costUsd).toBeCloseTo(computeCost({
        model: MODEL, input_tokens: 5, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      }), 10);
      expect(final.costEstimated).toBe(true);
    });

    it('a counted turn has no estimatedTokens field at all', () => {
      const m = new TurnSpeedMeter();
      m.startTurn(0);
      m.messageStart(100, MODEL, { input_tokens: 5 });
      m.delta(200, 40);
      m.messageUsage({ output_tokens: 30 });
      m.messageStop(700);
      expect(m.snapshot(800)).not.toHaveProperty('estimatedTokens');
      expect(m.finish(900, { turnOutputTokens: 30 })).not.toHaveProperty('estimatedTokens');
    });

    it('keeps tokens of finished messages and excludes the token-less open one', () => {
      const m = new TurnSpeedMeter();
      m.startTurn(0);
      m.messageStart(100, MODEL, { input_tokens: 5 });
      m.delta(200, 40);
      m.messageUsage({ output_tokens: 30 });
      m.messageStop(700); // window 600
      m.messageStart(3000, MODEL, { input_tokens: 5 });
      m.delta(3200, 10); // open window 3000 → 3600 at finish

      const final = m.finish(3600, { interrupted: true, turnOutputTokens: 45 });
      expect(final.generationMs).toBe(1200);
      expect(final.outputTokens).toBe(30);
      expect(final.messages).toBe(2);
      expect(final.turnOutputTokens).toBe(45);
      expect(final.partial).toBe(true);
      expect(final.interrupted).toBe(true);
      // Only the token-less message contributes an estimate (10 chars → 3).
      expect(final.estimatedTokens).toBe(3);
    });
  });

  it('attach mid-turn (no startTurn) has no ttft, is partial, and still counts', () => {
    const m = new TurnSpeedMeter();
    m.messageStart(500, MODEL, { input_tokens: 3 });
    expect(m.active).toBe(true);
    m.delta(700, 5);
    m.messageUsage({ output_tokens: 10 });
    m.messageStop(1000);

    const snap = m.snapshot(1100);
    expect(snap.startedAt).toBeUndefined();
    expect(snap.ttftMs).toBeNull();
    expect(snap.partial).toBe(true);
    expect(snap.outputTokens).toBe(10);
    expect(snap.generationMs).toBe(500);
    expect(snap.messages).toBe(1);

    const final = m.finish(1100, { turnOutputTokens: 10 });
    expect(final.ttftMs).toBeNull();
    expect(final.partial).toBe(true);
    expect(tokensPerSecond(final)).toBe(20);
  });

  it('a delta before any messageStart opens a window at that delta and marks partial', () => {
    const m = new TurnSpeedMeter();
    m.startTurn(0);
    m.delta(200, 5);

    const live = m.snapshot(300);
    expect(live.inFlight).toBe(true);
    expect(live.inFlightChars).toBe(5);
    // The implicit window starts at the delta, not at the turn start.
    expect(live.inFlightMs).toBe(100);
    expect(live.ttftMs).toBe(200);
    expect(live.partial).toBe(true);

    m.messageUsage({ output_tokens: 8 });
    m.messageStop(700);
    const snap = m.snapshot(800);
    expect(snap.generationMs).toBe(500);
    expect(snap.outputTokens).toBe(8);
    expect(snap.messages).toBe(1);
    expect(snap.model).toBeUndefined();
    expect(snap.partial).toBe(true);
  });

  it('a second messageStart without a stop closes the first at the second start', () => {
    const m = new TurnSpeedMeter();
    m.startTurn(0);
    m.messageStart(100, MODEL, { input_tokens: 5 });
    m.delta(200, 5);
    m.messageUsage({ output_tokens: 12 });
    m.messageStart(900, MODEL, { input_tokens: 5 }); // closes message 1: 100 → 900

    const mid = m.snapshot(950);
    expect(mid.messages).toBe(1);
    expect(mid.generationMs).toBe(800);
    expect(mid.outputTokens).toBe(12);
    expect(mid.partial).toBe(true);
    expect(mid.inFlight).toBe(true);
    expect(mid.inFlightMs).toBe(50);

    m.delta(1000, 3);
    m.messageUsage({ output_tokens: 6 });
    m.messageStop(1400); // message 2: 900 → 1400
    const snap = m.snapshot(1500);
    expect(snap.messages).toBe(2);
    expect(snap.generationMs).toBe(1300);
    expect(snap.outputTokens).toBe(18);
    expect(snap.partial).toBe(true);
  });

  describe('finish against the CLI turn total', () => {
    function oneMessage(tokens: number): TurnSpeedMeter {
      const m = new TurnSpeedMeter();
      m.startTurn(0);
      m.messageStart(100, MODEL, { input_tokens: 1 });
      m.delta(200, 5);
      m.messageUsage({ output_tokens: tokens });
      m.messageStop(1200);
      return m;
    }

    it('a different turnOutputTokens marks the turn partial', () => {
      const final = oneMessage(25).finish(1300, { turnOutputTokens: 40 });
      expect(final.outputTokens).toBe(25);
      expect(final.turnOutputTokens).toBe(40);
      expect(final.partial).toBe(true);
    });

    it('an equal turnOutputTokens leaves partial unset', () => {
      const final = oneMessage(25).finish(1300, { turnOutputTokens: 25 });
      expect(final.turnOutputTokens).toBe(25);
      expect(final.partial).toBeUndefined();
    });

    it('no turnOutputTokens leaves partial unset and omits the field', () => {
      const final = oneMessage(25).finish(1300, {});
      expect(final.turnOutputTokens).toBeUndefined();
      expect(final.durationMs).toBeUndefined();
      expect(final.partial).toBeUndefined();
    });
  });

  describe('finish cost handling', () => {
    function oneMessage(): TurnSpeedMeter {
      const m = new TurnSpeedMeter();
      m.startTurn(0);
      m.messageStart(100, MODEL, { input_tokens: 100 });
      m.delta(200, 5);
      m.messageUsage({ output_tokens: 20 });
      m.messageStop(700);
      return m;
    }
    const estimate = computeCost({ model: MODEL, input_tokens: 100, output_tokens: 20 });

    it('costUsd undefined keeps the estimate with costEstimated', () => {
      const final = oneMessage().finish(800, { turnOutputTokens: 20 });
      expect(final.costUsd).toBeCloseTo(estimate, 12);
      expect(final.costEstimated).toBe(true);
    });

    it('costUsd 0 keeps the estimate with costEstimated', () => {
      const final = oneMessage().finish(800, { turnOutputTokens: 20, costUsd: 0 });
      expect(final.costUsd).toBeCloseTo(estimate, 12);
      expect(final.costUsd).toBeGreaterThan(0);
      expect(final.costEstimated).toBe(true);
    });

    it('a positive CLI cost replaces the estimate and drops costEstimated', () => {
      const final = oneMessage().finish(800, { turnOutputTokens: 20, costUsd: 0.25 });
      expect(final.costUsd).toBe(0.25);
      expect(final.costEstimated).toBeUndefined();
      expect('costEstimated' in final).toBe(false);
    });

    it('a turn with no messages finishes with zero tokens, no ttft and no cost', () => {
      const m = new TurnSpeedMeter();
      m.startTurn(100);
      const final = m.finish(500, {});
      expect(final.final).toBe(true);
      expect(final.startedAt).toBe(100);
      expect(final.outputTokens).toBe(0);
      expect(final.generationMs).toBe(0);
      expect(final.messages).toBe(0);
      expect(final.ttftMs).toBeNull();
      expect(final.costUsd).toBeUndefined();
      expect(final.costEstimated).toBeUndefined();
      expect(final.partial).toBeUndefined();
      expect(final.endedAt).toBe(500);
      expect(tokensPerSecond(final)).toBeNull();
    });
  });

  it('ignores events after finish, and startTurn afterwards starts fresh', () => {
    const m = new TurnSpeedMeter();
    m.startTurn(0);
    m.messageStart(100, MODEL, { input_tokens: 1 });
    m.delta(200, 5);
    m.messageUsage({ output_tokens: 10 });
    m.messageStop(700);
    const final = m.finish(800, { turnOutputTokens: 10, costUsd: 0.1 });
    const frozen = structuredClone(final);
    expect(m.active).toBe(false);

    m.messageStart(3000, MODEL, { input_tokens: 1 });
    m.delta(3100, 50);
    m.messageUsage({ output_tokens: 500 });
    m.messageStop(3500);

    expect(m.active).toBe(false);
    expect(m.snapshot(9999)).toEqual(frozen);
    expect(m.finish(10_000, { turnOutputTokens: 999, costUsd: 9 })).toEqual(frozen);

    m.startTurn(5000);
    expect(m.active).toBe(true);
    const fresh = m.snapshot(5100);
    expect(fresh).toEqual({
      startedAt: 5000,
      ttftMs: null,
      generationMs: 0,
      outputTokens: 0,
      messages: 0,
      inFlight: false,
      inFlightChars: 0,
      inFlightMs: 0,
      inFlightVisibleMs: 0,
      final: false,
    });
  });

  it('active is false fresh, true after startTurn, false after finish and after reset', () => {
    const m = new TurnSpeedMeter();
    expect(m.active).toBe(false);
    m.startTurn(0);
    expect(m.active).toBe(true);
    m.finish(100, {});
    expect(m.active).toBe(false);

    m.startTurn(200);
    m.messageStart(250, MODEL, undefined);
    m.delta(300, 1);
    expect(m.active).toBe(true);
    m.reset();
    expect(m.active).toBe(false);
    const snap = m.snapshot(400);
    expect(snap.startedAt).toBeUndefined();
    expect(snap.ttftMs).toBeNull();
    expect(snap.inFlight).toBe(false);
    expect(snap.messages).toBe(0);
    expect(snap.final).toBe(false);
  });

  describe('snapshot() is read-only', () => {
    it('two snapshots at different times agree on everything but the in-flight clock', () => {
      const m = new TurnSpeedMeter();
      m.startTurn(0);
      m.messageStart(100, MODEL, { input_tokens: 1 });
      m.delta(300, 4);
      m.messageUsage({ output_tokens: 7 });
      m.messageStop(900); // window 800
      m.messageStart(1500, MODEL, { input_tokens: 1 });
      m.delta(1600, 2);

      const a = m.snapshot(2000);
      const b = m.snapshot(3000);
      expect(a.ttftMs).toBe(300);
      expect(b.ttftMs).toBe(300);
      expect(b.generationMs).toBe(a.generationMs);
      expect(b.outputTokens).toBe(a.outputTokens);
      expect(b.messages).toBe(a.messages);
      expect(b.inFlightChars).toBe(a.inFlightChars);
      expect(a.inFlightMs).toBe(500);
      expect(b.inFlightMs).toBe(1500);

      // The open message was not closed by either snapshot.
      m.messageUsage({ output_tokens: 3 });
      m.messageStop(2600); // window 1500 → 2600 = 1100
      const final = m.finish(2700, { turnOutputTokens: 10 });
      expect(final.generationMs).toBe(800 + 1100);
      expect(final.outputTokens).toBe(10);
      expect(final.messages).toBe(2);
      expect(final.partial).toBeUndefined();
    });

    it('a snapshot before the first delta does not set ttft', () => {
      const m = new TurnSpeedMeter();
      m.startTurn(0);
      m.messageStart(100, MODEL, undefined);
      expect(m.snapshot(500).ttftMs).toBeNull();
      expect(m.snapshot(600).ttftMs).toBeNull();
      m.delta(800, 1);
      expect(m.snapshot(900).ttftMs).toBe(800);
      expect(m.snapshot(5000).ttftMs).toBe(800);
    });
  });
});

describe('tokensPerSecond', () => {
  it('is null for a zero generation window', () => {
    expect(tokensPerSecond({ outputTokens: 10, generationMs: 0 })).toBeNull();
  });

  it('is null for zero output tokens', () => {
    expect(tokensPerSecond({ outputTokens: 0, generationMs: 1000 })).toBeNull();
  });

  it('divides tokens by generation seconds', () => {
    expect(tokensPerSecond({ outputTokens: 150, generationMs: 2500 })).toBe(60);
    expect(tokensPerSecond({ outputTokens: 1, generationMs: 4 })).toBe(250);
  });
});

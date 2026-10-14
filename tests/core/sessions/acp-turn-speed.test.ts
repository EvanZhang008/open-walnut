/**
 * ACP turn speed meter (src/core/sessions/acp-turn-speed.ts): the readout a
 * Codex session shows, built from journal records. Codex reports usage for
 * its LAST model call only, so a several-call turn must say so instead of
 * passing one call's numbers off as the turn's.
 */
import { describe, it, expect } from 'vitest';
import { AcpTurnSpeedMeter } from '../../../src/core/sessions/acp-turn-speed.js';
import { snapshotAcpTurnUsage } from '../../../src/providers/acp-worker/protocol.js';

describe('AcpTurnSpeedMeter', () => {
  it('measures a one-call turn as the whole turn, with a priced cost', () => {
    const m = new AcpTurnSpeedMeter();
    m.start(1_000, 'openai.gpt-6.1-sol');
    m.chunk(2_500, 40);
    m.chunk(3_000, 400);
    const live = m.snapshot(3_200);
    expect(live.final).toBe(false);
    expect(live.ttftMs).toBe(1_500);
    expect(live.inFlight).toBe(true);
    expect(live.inFlightChars).toBe(440);
    m.usage();
    const speed = m.finish(5_000, { inputTokens: 1_000, cachedReadTokens: 9_000, outputTokens: 200, thoughtTokens: 50 }, false);
    expect(speed.final).toBe(true);
    expect(speed.messages).toBe(1);
    expect(speed.outputTokens).toBe(200);
    expect(speed.turnOutputTokens).toBe(200);
    // Reasoning tokens were decoded unseen, so the window opens at the call's start.
    expect(speed.generationMs).toBe(4_000);
    expect(speed.durationMs).toBe(4_000);
    expect(speed.tokenScope).toBeUndefined();
    expect(speed.inputTokens).toBe(1_000);
    expect(speed.cachedInputTokens).toBe(9_000);
    expect(speed.reasoningTokens).toBe(50);
    expect(speed.costUsd).toBeCloseTo(0.002 + 0.002 + 0.0009, 6);
    expect(speed.costEstimated).toBe(true);
  });

  it('scopes a several-call turn to its last call and shows no cost', () => {
    const m = new AcpTurnSpeedMeter();
    m.start(0, 'openai.gpt-6.1-sol');
    m.chunk(1_000, 10);
    m.toolCall(2_000, 'a');
    m.toolCall(2_100, 'b');
    m.usage();
    m.toolDone(5_000, 'a');
    // The next call starts only when every tool of the previous one is done.
    m.toolDone(6_000, 'b');
    m.chunk(7_000, 100);
    m.usage();
    const speed = m.finish(9_000, { outputTokens: 300 }, false);
    expect(speed.messages).toBe(2);
    expect(speed.tokenScope).toBe('last-call');
    expect(speed.outputTokens).toBe(300);
    // No reasoning tokens: the last call decoded from its first chunk (7s) to the end.
    expect(speed.generationMs).toBe(2_000);
    expect(speed.costUsd).toBeUndefined();
    expect(speed.ttftMs).toBe(1_000);
    expect(speed.durationMs).toBe(9_000);
  });

  it('shows no cost for a model with no price, rather than pricing it as another model', () => {
    const m = new AcpTurnSpeedMeter();
    m.start(0, 'some-vendor.unpriced-model');
    m.chunk(100, 20);
    m.usage();
    const speed = m.finish(1_000, { inputTokens: 5_000, outputTokens: 400 }, false);
    expect(speed.outputTokens).toBe(400);
    expect(speed.costUsd).toBeUndefined();
    expect(speed.costEstimated).toBeUndefined();
  });

  it('a turn with no usage keeps its timings and claims no tokens', () => {
    const m = new AcpTurnSpeedMeter();
    m.start(0, undefined);
    m.chunk(500, 20);
    const speed = m.finish(1_500, undefined, true);
    expect(speed.outputTokens).toBe(0);
    expect(speed.generationMs).toBe(0);
    expect(speed.interrupted).toBe(true);
    expect(speed.ttftMs).toBe(500);
    expect(speed.costUsd).toBeUndefined();
  });

  it('marks a turn it joined mid-way as partial, and is idle before any record', () => {
    const m = new AcpTurnSpeedMeter();
    expect(m.active).toBe(false);
    m.chunk(100, 5);
    expect(m.active).toBe(true);
    const speed = m.finish(200, { outputTokens: 3 }, false);
    expect(speed.partial).toBe(true);
    expect(speed.startedAt).toBeUndefined();
    expect(m.active).toBe(false);
  });

  it('ignores empty chunks and tool results it never saw start', () => {
    const m = new AcpTurnSpeedMeter();
    m.start(0, 'openai.gpt-6-luna');
    m.chunk(100, 0);
    m.toolDone(200, 'never-started');
    expect(m.snapshot(300).ttftMs).toBeNull();
    expect(m.snapshot(300).inFlight).toBe(false);
  });
});

describe('snapshotAcpTurnUsage', () => {
  it('keeps finite counts and drops the rest', () => {
    expect(snapshotAcpTurnUsage({ totalTokens: 10, inputTokens: 4, outputTokens: 6, thoughtTokens: -1, cachedReadTokens: 'x' }))
      .toEqual({ totalTokens: 10, inputTokens: 4, outputTokens: 6 });
    expect(snapshotAcpTurnUsage(null)).toBeUndefined();
    expect(snapshotAcpTurnUsage({ outputTokens: Number.NaN })).toBeUndefined();
  });
});

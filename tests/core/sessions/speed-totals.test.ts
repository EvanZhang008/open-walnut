/**
 * The session's per-model speed totals (src/core/sessions/speed-totals.ts): which turns count,
 * that one turn counts once however often its final is written, the cap, and the average.
 */
import { describe, it, expect } from 'vitest';
import { averageOf, countedThrough, foldTurnSpeed, laterTurn, MAX_SPEED_TOTAL_MODELS } from '../../../src/core/sessions/speed-totals.js';

const turn = (endedAt: number, outputTokens: number, generationMs: number, model = 'claude-opus-5-5', final = true) =>
  ({ final, model, outputTokens, generationMs, endedAt });

describe('speed totals', () => {
  it('adds a later final turn on its model and leaves the others', () => {
    const one = foldTurnSpeed(undefined, turn(10, 1_000, 10_000));
    const two = foldTurnSpeed(one, turn(20, 2_800, 20_000));
    const three = foldTurnSpeed(two, turn(30, 500, 1_000, 'claude-haiku-5-5'));
    expect(three).toEqual({
      'claude-opus-5-5': { outputTokens: 3_800, generationMs: 30_000, turns: 2, lastAt: 20 },
      'claude-haiku-5-5': { outputTokens: 500, generationMs: 1_000, turns: 1, lastAt: 30 },
    });
  });

  it('counts only turns the readout gives a rate: final, tokens, half a second, a model', () => {
    const totals = { m: { outputTokens: 1, generationMs: 1_000, turns: 1 } };
    for (const t of [turn(5, 100, 2_000, 'm', false), turn(5, 0, 2_000, 'm'), turn(5, 100, 499, 'm'), { ...turn(5, 100, 2_000), model: undefined }]) {
      expect(foldTurnSpeed(totals, t)).toBe(totals);
    }
  });

  it('never counts the same frozen final twice, nor an older turn a replay finishes again', () => {
    const totals = foldTurnSpeed(undefined, turn(20, 100, 1_000));
    expect(countedThrough(totals)).toBe(20);
    expect(laterTurn(turn(20, 100, 1_000), totals)).toBe(false);
    expect(laterTurn(turn(19, 100, 1_000), totals)).toBe(false);
    expect(laterTurn(turn(21, 100, 1_000), totals)).toBe(true);
    expect(laterTurn(turn(21, 100, 1_000), undefined)).toBe(true);
    expect(laterTurn({ ...turn(21, 100, 1_000), endedAt: undefined }, undefined)).toBe(false);
  });

  it('a replay that resumes mid-session counts nothing again, whatever model it names', () => {
    // T1..T3 counted; an ACP replay then finishes T2 and T3 again, keyed by the model it runs now.
    let totals = foldTurnSpeed(undefined, turn(10, 1_000, 10_000));
    totals = foldTurnSpeed(totals, turn(20, 1_000, 10_000));
    totals = foldTurnSpeed(totals, turn(30, 1_000, 10_000));
    const counted = totals;
    totals = foldTurnSpeed(totals, turn(20, 1_000, 10_000, 'gpt-6.2-sol'));
    totals = foldTurnSpeed(totals, turn(30, 1_000, 10_000, 'gpt-6.2-sol'));
    expect(totals).toBe(counted);
    expect(totals!['claude-opus-5-5']!.turns).toBe(3);
    // The next live turn counts.
    expect(foldTurnSpeed(totals, turn(40, 1_000, 10_000))!['claude-opus-5-5']!.turns).toBe(4);
  });

  it('keeps at most the cap of models, dropping the one used longest ago', () => {
    let totals: ReturnType<typeof foldTurnSpeed>;
    for (let i = 0; i < MAX_SPEED_TOTAL_MODELS + 2; i++) totals = foldTurnSpeed(totals, turn(100 + i, 100, 1_000, `model-${i}`));
    expect(Object.keys(totals!)).toHaveLength(MAX_SPEED_TOTAL_MODELS);
    expect(totals!['model-0']).toBeUndefined();
    expect(totals!['model-1']).toBeUndefined();
    expect(totals![`model-${MAX_SPEED_TOTAL_MODELS + 1}`]).toBeDefined();
    // The newest model is never the one dropped, so the watermark survives the cap.
    expect(countedThrough(totals)).toBe(100 + MAX_SPEED_TOTAL_MODELS + 1);
  });

  it('averages by tokens over time, summed over the models picked', () => {
    const totals = {
      a: { outputTokens: 12_800, generationMs: 100_000, turns: 42 },
      b: { outputTokens: 1_000, generationMs: 10_000, turns: 3 },
    };
    expect(averageOf(totals, (m) => m === 'a')).toMatchObject({ tps: 128, turns: 42 });
    expect(averageOf(totals, () => true)!.tps).toBeCloseTo(13_800 / 110, 9);
    expect(averageOf(totals, (m) => m === 'c')).toBeNull();
    expect(averageOf(undefined, () => true)).toBeNull();
  });
});

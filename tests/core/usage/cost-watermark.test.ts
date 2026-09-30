import { describe, it, expect } from 'vitest';
import { costIncrement, CostWatermark } from '../../../src/core/usage/cost-watermark.js';

/**
 * Regression tests for the session-cost inflation bug.
 *
 * The CLI/SDK report `total_cost_usd` as a RUNNING TOTAL for one process. Walnut
 * used to record that cumulative value every turn, re-billing the whole history
 * each turn — a real ~$36K of session spend showed as $223K (6–13× inflated).
 * The watermark bills only the per-result increment and ignores replays.
 */
describe('costIncrement (pure)', () => {
  it('bills the full amount on the first result', () => {
    expect(costIncrement(2.5, 0)).toEqual({ delta: 2.5, watermark: 2.5 });
  });

  it('bills only the increment when the running total rises', () => {
    expect(costIncrement(10, 6)).toEqual({ delta: 4, watermark: 10 });
  });

  it('bills 0 when the total is unchanged (the core bug: cumulative re-reported each turn)', () => {
    expect(costIncrement(10, 10)).toEqual({ delta: 0, watermark: 10 });
  });

  it('bills 0 when the total drops below the watermark (replayed JSONL burst)', () => {
    // daemon replays an older, smaller cumulative value — must NOT be billed
    expect(costIncrement(3, 25)).toEqual({ delta: 0, watermark: 25 });
  });

  it('treats undefined / non-positive totals as 0', () => {
    expect(costIncrement(undefined, 5)).toEqual({ delta: 0, watermark: 5 });
    expect(costIncrement(0, 5)).toEqual({ delta: 0, watermark: 5 });
    expect(costIncrement(-1, 5)).toEqual({ delta: 0, watermark: 5 });
  });
});

describe('CostWatermark (stateful)', () => {
  it('a single long session bills the final total ONCE, not once per turn', () => {
    const wm = new CostWatermark();
    // CLI reports the cumulative total every turn: 2 → 5 → 9 → 14
    const turns = [2, 5, 9, 14];
    const billed = turns.reduce((sum, total) => sum + wm.bill(total), 0);
    // Real spend is the final cumulative total, not 2+5+9+14=30
    expect(billed).toBeCloseTo(14, 6);
  });

  it('replayed result events within a process do not double-bill', () => {
    const wm = new CostWatermark();
    expect(wm.bill(5)).toBeCloseTo(5, 6);   // real turn
    expect(wm.bill(5)).toBe(0);             // exact replay
    expect(wm.bill(5)).toBe(0);             // exact replay again
    // a whole ascending series replayed (the 2026-06 burst pattern)
    expect(wm.bill(2)).toBe(0);
    expect(wm.bill(3)).toBe(0);
    expect(wm.bill(4)).toBe(0);
    // then a genuine new turn continues from the watermark
    expect(wm.bill(8)).toBeCloseTo(3, 6);
  });

  it('reset() on --resume starts a fresh process whose total restarts at 0', () => {
    const wm = new CostWatermark();
    // process A: 2 → 6
    expect(wm.bill(2)).toBeCloseTo(2, 6);
    expect(wm.bill(6)).toBeCloseTo(4, 6);
    // idle-kill → --resume spawns process B; its total_cost_usd restarts at 0
    wm.reset();
    // process B: 1.5 → 4 — billed in full from 0, NOT treated as a replay drop
    expect(wm.bill(1.5)).toBeCloseTo(1.5, 6);
    expect(wm.bill(4)).toBeCloseTo(2.5, 6);
    // total real cost across both processes = 6 + 4 = 10
  });

  it('reconstructs the real cost of a multi-process session (the prod pattern)', () => {
    // Mirrors session 14224539: climbs to ~28, resumes (reset) to a small value,
    // climbs again, with replay bursts mixed in.
    const wm = new CostWatermark();
    let real = 0;
    // run 1: cumulative climbs
    for (const t of [2.2, 6.9, 10.1, 28.8]) real += wm.bill(t);
    // replay burst of run 1 (same ascending values re-sent in <5min) → all 0
    for (const t of [2.2, 6.9, 10.1, 28.8]) real += wm.bill(t);
    // resume → new process
    wm.reset();
    for (const t of [5.8, 16.3, 28.8]) real += wm.bill(t);
    expect(real).toBeCloseTo(28.8 + 28.8, 6); // run1 final + run2 final
  });

  it('a re-attached instance seeded with the persisted watermark bills only the new turn', () => {
    // Instance A bills the first turn of a live process and persists its watermark.
    const a = new CostWatermark();
    expect(a.bill(0.15)).toBeCloseTo(0.15, 6);
    expect(a.value).toBeCloseTo(0.15, 6);
    // Instance B re-attaches to the SAME process (the queue re-created the runner)
    // and continues from the persisted value: the second result is the increment,
    // not the whole cumulative total again.
    const b = new CostWatermark();
    expect(b.seed(a.value)).toBe(true);
    expect(b.bill(0.178)).toBeCloseTo(0.028, 6);
    // Without the seed it would have charged the full 0.178 (the readout bug).
    expect(new CostWatermark().bill(0.178)).toBeCloseTo(0.178, 6);
  });

  it('seed() refuses anything that could hide real spend and reset() clears it', () => {
    const wm = new CostWatermark();
    for (const bad of [undefined, null, NaN, Infinity, -1, '0.5', {}]) {
      expect(wm.seed(bad)).toBe(false);
      expect(wm.value).toBe(0);
    }
    expect(wm.seed(0.4)).toBe(true);
    wm.reset();
    expect(wm.value).toBe(0);
    expect(wm.bill(0.3)).toBeCloseTo(0.3, 6);
  });
});

/**
 * wait-budget.ts keeps a queue's wait out of a test's time limit, also across the test's own later
 * `test.setTimeout`, which replaces the limit counted from the first hook (2026-11-03, CI: the
 * webkit voice-selection cases queued for the panel count lock, then set 90 s in their body, and
 * timed out in their first page.goto).
 */
import { describe, expect, it } from 'vitest';
import type { TestInfo } from '@playwright/test';
import { waitOutsideBudget } from '../e2e/browser/wait-budget';

/** The part of Playwright's TestInfo the helper reads: a limit, and a setter that replaces it. */
function fakeInfo(timeout: number): TestInfo & { set: number[] } {
  const set: number[] = [];
  const info = {
    timeout,
    set,
    setTimeout(ms: number) { this.timeout = ms; set.push(ms); },
  };
  return info as unknown as TestInfo & { set: number[] };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('waitOutsideBudget', () => {
  it('makes room before the wait, then keeps the budget plus what the wait took', async () => {
    const info = fakeInfo(30_000);
    await waitOutsideBudget(info, 600_000, async () => {
      expect(info.timeout).toBe(630_000);
      await sleep(60);
    });
    expect(info.timeout).toBeGreaterThanOrEqual(30_060);
    expect(info.timeout).toBeLessThan(31_000);
  });

  it("a later setTimeout of the test's own keeps the wait", async () => {
    const info = fakeInfo(30_000);
    await waitOutsideBudget(info, 600_000, () => sleep(80));
    info.setTimeout(90_000);
    expect(info.timeout).toBeGreaterThanOrEqual(90_080);
    expect(info.timeout).toBeLessThan(91_000);
    // No limit stays no limit.
    info.setTimeout(0);
    expect(info.timeout).toBe(0);
  });

  it('two waits on one test add up, counted once each', async () => {
    const info = fakeInfo(30_000);
    await waitOutsideBudget(info, 600_000, () => sleep(50));
    await waitOutsideBudget(info, 600_000, () => sleep(50));
    expect(info.timeout).toBeGreaterThanOrEqual(30_100);
    expect(info.timeout).toBeLessThan(31_000);
    info.setTimeout(90_000);
    expect(info.timeout).toBeGreaterThanOrEqual(90_100);
    expect(info.timeout).toBeLessThan(91_000);
  });

  it('a wait that gives up still counts, and its error reaches the caller', async () => {
    const info = fakeInfo(30_000);
    await expect(waitOutsideBudget(info, 600_000, async () => { await sleep(40); throw new Error('held'); })).rejects.toThrow('held');
    expect(info.timeout).toBeGreaterThanOrEqual(30_040);
    expect(info.timeout).toBeLessThan(31_000);
  });

  it('a test with no limit gets none', async () => {
    const info = fakeInfo(0);
    await waitOutsideBudget(info, 600_000, () => sleep(10));
    expect(info.timeout).toBe(0);
  });
});

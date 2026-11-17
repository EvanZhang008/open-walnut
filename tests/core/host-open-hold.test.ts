/**
 * Background asks to a host wait while a person opens a conversation there (src/core/host-open-hold.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { holdHostForOpen, hostOpenBusy, waitForHostOpens, OPEN_QUIET_MS, _resetHostOpenHoldsForTesting } from '../../src/core/host-open-hold.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { _resetHostOpenHoldsForTesting(); vi.useRealTimers(); });

describe('host open hold', () => {
  it('a host is busy while held and for a quiet spell after the last release, never another host', async () => {
    const a = holdHostForOpen('h1');
    const b = holdHostForOpen('h1');
    expect(hostOpenBusy('h1')).toBe(true);
    expect(hostOpenBusy('h2')).toBe(false);
    a(); a();
    expect(hostOpenBusy('h1')).toBe(true);
    b();
    expect(hostOpenBusy('h1')).toBe(true);
    await vi.advanceTimersByTimeAsync(OPEN_QUIET_MS);
    expect(hostOpenBusy('h1')).toBe(false);
  });

  it('a waiter resolves at once on a quiet host, after release plus the quiet spell on a held one, and at its cap', async () => {
    let done = false;
    await waitForHostOpens('quiet');
    const release = holdHostForOpen('h1');
    void waitForHostOpens('h1').then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(done).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(OPEN_QUIET_MS - 50);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toBe(true);

    let capped = false;
    holdHostForOpen('h3');
    void waitForHostOpens('h3', 2_000).then(() => { capped = true; });
    await vi.advanceTimersByTimeAsync(2_001);
    expect(capped).toBe(true);
  });
});

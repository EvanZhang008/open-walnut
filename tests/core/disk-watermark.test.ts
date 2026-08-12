/**
 * Disk watermark monitor — threshold logic, hysteresis, safe-mode wiring, and
 * notification plumbing (2026-08-12 cloud ENOSPC outage regression suite).
 *
 * The statfs syscall is mocked via the module's injection hook, so every fill
 * level is exact and no test depends on the machine's real disk.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-diskwm-test'));

import {
  usedPercent,
  nextLevel,
  pollDiskWatermarkOnce,
  getDiskWatermarkState,
  isDiskWriteBlocked,
  resetDiskWatermarkForTest,
  _setStatfsForTest,
  WARN_PCT,
  CRITICAL_PCT,
  HYSTERESIS_PCT,
  WARN_MIN_AVAIL_BYTES,
  CRITICAL_MIN_AVAIL_BYTES,
} from '../../src/core/disk-watermark.js';
import { isDiskPullOnly, resetSyncGuardForTest } from '../../src/integrations/git-sync.js';

const GiB = 1024 * 1024 * 1024;

/**
 * statfs stub for a 30GiB filesystem (the incident box's root size) at the
 * given used percent. Small on purpose: percent thresholds AND the
 * absolute-free gates must both trip, exactly like the real outage.
 */
function fakeFs(usedPct: number) {
  const blocks = 30 * 256; // 30GiB at 4MiB "blocks" — keeps numbers readable
  const bsize = 4 * 1024 * 1024;
  const bavail = Math.round(blocks * (100 - usedPct) / 100);
  return { bsize, blocks, bfree: bavail, bavail };
}

function stubUsedPct(pct: number): void {
  _setStatfsForTest(async () => fakeFs(pct));
}

beforeEach(() => {
  resetSyncGuardForTest();
  resetDiskWatermarkForTest();
});

afterEach(() => {
  _setStatfsForTest(null);
  resetDiskWatermarkForTest();
  resetSyncGuardForTest();
});

describe('usedPercent', () => {
  it('matches df semantics (root reserve counts as used)', () => {
    // 1000 blocks, 100 free but only 50 available to unprivileged users:
    // used=900, denom=950 → 95%
    expect(usedPercent({ bsize: 4096, blocks: 1000, bfree: 100, bavail: 50 })).toBe(95);
  });

  it('handles bigint fields and degenerate zero denominators', () => {
    expect(usedPercent({ bsize: 4096n, blocks: 1000n, bfree: 500n, bavail: 500n })).toBe(50);
    expect(usedPercent({ bsize: 4096, blocks: 0, bfree: 0, bavail: 0 })).toBe(0);
  });
});

describe('nextLevel thresholds + hysteresis', () => {
  const lowAvail = 1 * GiB; // low enough to satisfy both absolute-free gates

  it('enters warn at WARN_PCT and critical at CRITICAL_PCT', () => {
    expect(nextLevel(WARN_PCT - 1, lowAvail, 'ok')).toBe('ok');
    expect(nextLevel(WARN_PCT, lowAvail, 'ok')).toBe('warn');
    expect(nextLevel(CRITICAL_PCT - 1, lowAvail, 'ok')).toBe('warn');
    expect(nextLevel(CRITICAL_PCT, lowAvail, 'ok')).toBe('critical');
  });

  it('requires the absolute-free condition, not percent alone (APFS purgeable trap)', () => {
    // 92% used but 50GB genuinely available — a healthy large disk, not an emergency.
    expect(nextLevel(92, 50 * GiB, 'ok')).toBe('ok');
    expect(nextLevel(85, WARN_MIN_AVAIL_BYTES + GiB, 'ok')).toBe('ok');
    // And the entry cases just under the byte gates do trip.
    expect(nextLevel(85, WARN_MIN_AVAIL_BYTES, 'ok')).toBe('warn');
    expect(nextLevel(92, CRITICAL_MIN_AVAIL_BYTES, 'ok')).toBe('critical');
  });

  it('holds a level inside the hysteresis band instead of flapping', () => {
    // critical entered at 90; 89 stays critical (within 2 points), 87 drops.
    expect(nextLevel(CRITICAL_PCT - 1, lowAvail, 'critical')).toBe('critical');
    expect(nextLevel(CRITICAL_PCT - HYSTERESIS_PCT - 1, lowAvail, 'critical')).toBe('warn');
    // warn entered at 80; 79 stays warn, 77 drops to ok.
    expect(nextLevel(WARN_PCT - 1, lowAvail, 'warn')).toBe('warn');
    expect(nextLevel(WARN_PCT - HYSTERESIS_PCT - 1, lowAvail, 'warn')).toBe('ok');
  });

  it('never holds a level for a fresh (ok) reading', () => {
    expect(nextLevel(WARN_PCT - 1, lowAvail, 'ok')).toBe('ok');
  });
});

describe('pollDiskWatermarkOnce side effects', () => {
  it('fires ONE warn notification at 81% and none again while warn holds', async () => {
    const notify = vi.fn();
    stubUsedPct(81);
    await pollDiskWatermarkOnce(notify);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][2]).toBe('disk:warn');
    expect(getDiskWatermarkState().level).toBe('warn');
    expect(isDiskWriteBlocked()).toBe(false);
    expect(isDiskPullOnly()).toBe(false);

    // Steady state: same level, no repeat notification.
    await pollDiskWatermarkOnce(notify);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('at 92% blocks writes AND flips git-sync to disk pull-only', async () => {
    const notify = vi.fn();
    stubUsedPct(92);
    await pollDiskWatermarkOnce(notify);
    expect(getDiskWatermarkState().level).toBe('critical');
    expect(isDiskWriteBlocked()).toBe(true);
    expect(isDiskPullOnly()).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][2]).toBe('disk:critical');
  });

  it('recovery: critical → warn → ok releases the latch and write block', async () => {
    const notify = vi.fn();
    stubUsedPct(95);
    await pollDiskWatermarkOnce(notify);
    expect(isDiskPullOnly()).toBe(true);

    stubUsedPct(85); // below critical hysteresis, still warn
    await pollDiskWatermarkOnce(notify);
    expect(getDiskWatermarkState().level).toBe('warn');
    expect(isDiskWriteBlocked()).toBe(false);
    expect(isDiskPullOnly()).toBe(false);

    stubUsedPct(50);
    await pollDiskWatermarkOnce(notify);
    expect(getDiskWatermarkState().level).toBe('ok');
    // Notifications: 1 critical + 0 for recovery transitions (logs only).
    expect(notify.mock.calls.map((c) => c[2])).toEqual(['disk:critical']);
  });

  it('fail-open: statfs errors keep the previous state and never block writes', async () => {
    stubUsedPct(50);
    await pollDiskWatermarkOnce();
    _setStatfsForTest(async () => { throw new Error('EIO'); });
    const state = await pollDiskWatermarkOnce();
    expect(state.level).toBe('ok');
    expect(isDiskWriteBlocked()).toBe(false);
    expect(isDiskPullOnly()).toBe(false);
  });

  it('fail-open from critical: a statfs outage does not silently clear the block', async () => {
    stubUsedPct(95);
    await pollDiskWatermarkOnce();
    _setStatfsForTest(async () => { throw new Error('EIO'); });
    const state = await pollDiskWatermarkOnce();
    // Previous (critical) state is KEPT — monitor blindness must not lift the
    // guard while the disk may still be full.
    expect(state.level).toBe('critical');
    expect(isDiskWriteBlocked()).toBe(true);
  });
});

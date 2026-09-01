/**
 * Regression tests for the event-loop starvation fix (I1/I2 invariants):
 *
 *  1. listSessionsForHealthScan() returns ONLY the active set — running/idle
 *     always (no age window), stopped/error only within the recency window.
 *     The 2026-07 incident: 1380 stale 'stopped' rows were scanned every 30s
 *     because isTerminalSession only counted 'error' as terminal.
 *  2. listOrphanCandidates() returns recent terminal rows with a pid.
 *  3. runPeriodic(): reentrancy lock (no overlapping ticks) + per-tick budget.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-health-scan'));
vi.mock('../../src/utils/session-liveness.js', () => ({
  isSessionProcessAlive: async () => true,
  isLocalJsonlFresh: () => 'unknown',
}));

import { closeDb, getDb } from '../../src/core/session-db.js';
import {
  _resetSessionTrackerForTesting,
  createSessionRecord,
  updateSessionRecord,
  listSessionsForHealthScan,
  listOrphanCandidates,
} from '../../src/core/session-tracker.js';
import { runPeriodic } from '../../src/core/periodic-task.js';
import { WALNUT_HOME } from '../../src/constants.js';

async function resetAll(): Promise<void> {
  closeDb();
  _resetSessionTrackerForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
}

beforeEach(async () => {
  await resetAll();
});

afterEach(async () => {
  closeDb();
  _resetSessionTrackerForTesting();
});

/** Seed a session and force its process_status + last_status_change directly in SQL. */
async function seed(id: string, status: string, ageMs: number, extra?: { pid?: number; archived?: boolean }): Promise<void> {
  await createSessionRecord(id, `task-${id}`, 'proj', '/tmp');
  const ts = new Date(Date.now() - ageMs).toISOString();
  const db = getDb()!;
  db.prepare('UPDATE sessions SET process_status = ?, last_status_change = ?, pid = ?, archived = ? WHERE claude_session_id = ?')
    .run(status, ts, extra?.pid ?? null, extra?.archived ? 1 : 0, id);
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;

describe('listSessionsForHealthScan (active set)', () => {
  it('includes running/idle regardless of age, stopped/error only when recent', async () => {
    await seed('running-old', 'running', 30 * DAY);      // wedged for a month — MUST stay visible
    await seed('idle-old', 'idle', 10 * DAY);            // MUST stay visible
    await seed('stopped-recent', 'stopped', 1 * HOUR);   // recent terminal — visible (orphan/recovery window)
    await seed('error-recent', 'error', 2 * HOUR);       // visible
    await seed('stopped-stale', 'stopped', 3 * DAY);     // the 1380-row dead pool — MUST be excluded
    await seed('error-stale', 'error', 5 * DAY);         // excluded
    await seed('stopped-archived', 'stopped', 1 * HOUR, { archived: true }); // archived — excluded

    const scan = await listSessionsForHealthScan();
    const ids = scan.map(s => s.claudeSessionId).sort();
    expect(ids).toEqual(['error-recent', 'idle-old', 'running-old', 'stopped-recent']);
  });

  it('returns isolated rows (mutation does not poison later reads)', async () => {
    await seed('running-1', 'running', 0);
    const first = await listSessionsForHealthScan();
    first[0].process_status = 'stopped' as any;
    const second = await listSessionsForHealthScan();
    expect(second[0].process_status).toBe('running');
  });
});

describe('listOrphanCandidates', () => {
  it('returns only recent terminal rows that still have a pid', async () => {
    await seed('orphan-yes', 'stopped', 1 * HOUR, { pid: 12345 });
    await seed('orphan-no-pid', 'stopped', 1 * HOUR);
    await seed('orphan-stale', 'error', 3 * DAY, { pid: 999 });
    await seed('orphan-running', 'running', 1 * HOUR, { pid: 777 }); // not terminal

    const orphans = await listOrphanCandidates();
    expect(orphans.map(s => s.claudeSessionId)).toEqual(['orphan-yes']);
  });
});

describe('runPeriodic (tick hygiene)', () => {
  it('never overlaps ticks — reentrancy lock skips while previous tick runs', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    let runs = 0;
    const handle = runPeriodic('test.overlap', 30, 10_000, async () => {
      concurrent++
      runs++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise(r => setTimeout(r, 120))
      concurrent--
    });
    // Kick several times while the first tick is still sleeping
    handle.kick(); handle.kick(); handle.kick();
    await new Promise(r => setTimeout(r, 200));
    handle.stop();
    expect(maxConcurrent).toBe(1);
    expect(runs).toBeGreaterThanOrEqual(1);
  });

  it('reports overBudget so cooperative phases can abandon work', async () => {
    let sawOverBudget = false;
    const handle = runPeriodic('test.budget', 60_000, 30, async (ctx) => {
      await new Promise(r => setTimeout(r, 80));
      sawOverBudget = ctx.overBudget();
    });
    handle.kick();
    await new Promise(r => setTimeout(r, 200));
    handle.stop();
    expect(sawOverBudget).toBe(true);
  });

  // Regression: schedule() re-armed without clearing the pending handle, and it
  // runs both at construction AND in every tick's finally. So an out-of-band
  // kick() (the pin-retirement boot pass is the first caller) left the original
  // interval timer live: the task then fired TWICE per interval forever, plus one
  // extra for every additional kick. A daily sweep became two daily sweeps.
  it('kick() re-arms instead of stacking timers, and stop() cancels what is live', async () => {
    const HOUR = 60 * 60 * 1000;
    // Only the long interval timers count as "armed schedules" — the short
    // timers a tick body awaits are not schedules.
    const armed = new Set<unknown>();
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const setSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      ((fn: () => void, ms?: number, ...rest: unknown[]) => {
        const t = (realSetTimeout as unknown as (...a: unknown[]) => unknown)(fn, ms, ...rest);
        if ((ms ?? 0) >= 1000) armed.add(t);
        return t;
      }) as unknown as typeof setTimeout,
    );
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(
      ((t: unknown) => {
        armed.delete(t);
        (realClearTimeout as unknown as (a: unknown) => void)(t);
      }) as unknown as typeof clearTimeout,
    );
    // Settle via the REAL timer so the spy's >=1000ms filter never sees it.
    const settle = (): Promise<void> =>
      new Promise<void>(resolve => { realSetTimeout(resolve, 40); });

    try {
      let runs = 0;
      const handle = runPeriodic('test.rearm', HOUR, 10_000, async () => { runs++; });
      expect(armed.size).toBe(1); // construction armed exactly one

      handle.kick();
      await settle();
      expect(runs).toBe(1);
      expect(armed.size).toBe(1); // the tick's re-arm REPLACED the construction timer

      handle.kick();
      await settle();
      expect(runs).toBe(2);
      expect(armed.size).toBe(1); // still one, however many kicks

      handle.stop();
      expect(armed.size).toBe(0);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});

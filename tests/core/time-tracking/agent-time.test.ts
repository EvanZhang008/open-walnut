/**
 * Agent time — the turn-result rule, the bus collector, and the usage-ledger
 * backfill's "only days we never observed" guard.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-time-agent'));

import { WALNUT_HOME } from '../../../src/constants.js';
import { bus, EventNames } from '../../../src/core/event-bus.js';
import {
  agentMsFromResult, replayKey, startAgentTimeCollector, stopAgentTimeCollector, withLedgerBackfill,
} from '../../../src/core/time-tracking/agent-time.js';
import { stopTimeTracking } from '../../../src/web/routes/time.js';
import { getIndex, resetTimeStore } from '../../../src/core/time-tracking/store.js';
import { bucketKey, foldRecords, localDateKey } from '../../../src/core/time-tracking/rollup.js';
import type { RollupIndex } from '../../../src/core/time-tracking/types.js';

const TODAY = localDateKey(new Date());

beforeEach(async () => {
  resetTimeStore();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  stopAgentTimeCollector();
  resetTimeStore();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

/** Poll until the collector's async bank lands (or give up). */
async function waitForBucket(key: string, timeoutMs = 3000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ms = getIndex().get(key);
    if (ms !== undefined) return ms;
    await new Promise((r) => setTimeout(r, 10));
  }
  return getIndex().get(key) ?? 0;
}

describe('agentMsFromResult', () => {
  it('counts a finished turn at its reported wall time', () => {
    expect(agentMsFromResult({ sessionId: 'sess-aaaa-1111', duration: 4321.7 })).toBe(4322);
  });

  it('ignores intermediate results — teamActive / backgroundActive is NOT turn-over', () => {
    expect(agentMsFromResult({ duration: 5000, teamActive: true })).toBe(0);
    expect(agentMsFromResult({ duration: 5000, backgroundActive: true })).toBe(0);
  });

  it('ignores a missing, zero or nonsense duration', () => {
    expect(agentMsFromResult({})).toBe(0);
    expect(agentMsFromResult({ duration: 0 })).toBe(0);
    expect(agentMsFromResult({ duration: -1 })).toBe(0);
    expect(agentMsFromResult({ duration: Number.NaN })).toBe(0);
  });

  it('caps a stuck turn rather than counting days of wall time', () => {
    expect(agentMsFromResult({ duration: 48 * 60 * 60 * 1000 })).toBe(6 * 60 * 60 * 1000);
  });
});

describe('bus collector', () => {
  it('banks agent time for a completed turn, keyed by task', async () => {
    startAgentTimeCollector();
    bus.emit(EventNames.SESSION_RESULT, {
      sessionId: 'sess-aaaa-1111', taskId: 't_alpha', result: 'ok', duration: 90_000, turnGen: 1,
    }, ['web-ui']);
    expect(await waitForBucket(bucketKey(TODAY, 't_alpha', 'agent'))).toBe(90_000);
  });

  it('does not bank the same (session, turnGen) twice — a replayed result is not new work', async () => {
    startAgentTimeCollector();
    const event = {
      sessionId: 'sess-bbbb-2222', taskId: 't_beta', result: 'ok', duration: 10_000, turnGen: 7,
    };
    bus.emit(EventNames.SESSION_RESULT, event, ['web-ui']);
    expect(await waitForBucket(bucketKey(TODAY, 't_beta', 'agent'))).toBe(10_000);
    bus.emit(EventNames.SESSION_RESULT, event, ['web-ui']);
    bus.emit(EventNames.SESSION_RESULT, event, ['web-ui']);
    await new Promise((r) => setTimeout(r, 50));
    expect(getIndex().get(bucketKey(TODAY, 't_beta', 'agent'))).toBe(10_000);
  });

  it('still counts the first turn after a resume, which restarts turnGen at 0', async () => {
    // A resume/restart builds a fresh session instance (turnGen back to 0) under
    // the SAME claudeSessionId, while the replay guard lives as long as the
    // process. On (session, turnGen) alone that turn looked like a replay and its
    // time was dropped silently.
    startAgentTimeCollector();
    const sessionId = 'sess-9999-0000';
    const key = bucketKey(TODAY, 't_resume', 'agent');
    bus.emit(EventNames.SESSION_RESULT, { sessionId, taskId: 't_resume', result: 'ok', duration: 4_000, turnGen: 0 }, ['web-ui']);
    expect(await waitForBucket(key)).toBe(4_000);
    bus.emit(EventNames.SESSION_RESULT, { sessionId, taskId: 't_resume', result: 'ok', duration: 6_000, turnGen: 0 }, ['web-ui']);
    const until = Date.now() + 3000;
    while (Date.now() < until && getIndex().get(key) !== 10_000) await new Promise((r) => setTimeout(r, 10));
    expect(getIndex().get(key)).toBe(10_000);
  });

  it('counts successive turns of one session', async () => {
    startAgentTimeCollector();
    bus.emit(EventNames.SESSION_RESULT, { sessionId: 'sess-cccc-3333', taskId: 't_gamma', result: 'ok', duration: 1000, turnGen: 1 }, ['web-ui']);
    bus.emit(EventNames.SESSION_RESULT, { sessionId: 'sess-cccc-3333', taskId: 't_gamma', result: 'ok', duration: 2000, turnGen: 2 }, ['web-ui']);
    const key = bucketKey(TODAY, 't_gamma', 'agent');
    const until = Date.now() + 3000;
    while (Date.now() < until && getIndex().get(key) !== 3000) await new Promise((r) => setTimeout(r, 10));
    expect(getIndex().get(key)).toBe(3000);
  });

  it('ignores an intermediate result on the bus', async () => {
    startAgentTimeCollector();
    bus.emit(EventNames.SESSION_RESULT, {
      sessionId: 'sess-dddd-4444', taskId: 't_delta', result: 'partial', duration: 50_000, teamActive: true, turnGen: 1,
    }, ['web-ui']);
    await new Promise((r) => setTimeout(r, 50));
    expect(getIndex().get(bucketKey(TODAY, 't_delta', 'agent'))).toBeUndefined();
  });

  it('stops banking once unsubscribed', async () => {
    startAgentTimeCollector();
    stopAgentTimeCollector();
    bus.emit(EventNames.SESSION_RESULT, { sessionId: 'sess-eeee-5555', taskId: 't_eps', result: 'ok', duration: 5000, turnGen: 1 }, ['web-ui']);
    await new Promise((r) => setTimeout(r, 50));
    expect(getIndex().get(bucketKey(TODAY, 't_eps', 'agent'))).toBeUndefined();
  });

  it('stopTimeTracking detaches the collector and drops the rollup (server teardown)', async () => {
    startAgentTimeCollector();
    bus.emit(EventNames.SESSION_RESULT, { sessionId: 'sess-7777-8888', taskId: 't_stop', result: 'ok', duration: 3_000, turnGen: 1 }, ['web-ui']);
    expect(await waitForBucket(bucketKey(TODAY, 't_stop', 'agent'))).toBe(3_000);

    stopTimeTracking();
    // A mid-tick result after shutdown must not reach the torn-down store, and
    // the next startServer() in this process must not inherit the old rollup.
    expect(getIndex().size).toBe(0);
    bus.emit(EventNames.SESSION_RESULT, { sessionId: 'sess-7777-8888', taskId: 't_stop', result: 'ok', duration: 9_000, turnGen: 2 }, ['web-ui']);
    await new Promise((r) => setTimeout(r, 50));
    expect(getIndex().size).toBe(0);
  });
});

describe('replayKey', () => {
  it('is identical for a re-emit of the same result and different across turns', () => {
    const ev = { sessionId: 'sess-aaaa-1111', turnGen: 3, duration: 1234.4 };
    expect(replayKey(ev)).toBe(replayKey({ ...ev }));
    expect(replayKey({ ...ev, duration: 1234.6 })).not.toBe(replayKey(ev));
    expect(replayKey({ ...ev, turnGen: 4 })).not.toBe(replayKey(ev));
    expect(replayKey({ ...ev, sessionId: 'sess-bbbb-2222' })).not.toBe(replayKey(ev));
  });

  it('is null when there is nothing to dedup on', () => {
    expect(replayKey({ sessionId: 'sess-aaaa-1111' })).toBeNull();
    expect(replayKey({ turnGen: 1 })).toBeNull();
  });
});

describe('withLedgerBackfill', () => {
  it('leaves a day that already has observed agent time alone', async () => {
    const index: RollupIndex = foldRecords([
      { date: TODAY, ts: new Date().toISOString(), durationMs: 42_000, kind: 'agent', taskId: 't_alpha' },
    ]);
    const before = new Map(index);
    await withLedgerBackfill(index, [TODAY]);
    expect([...index.entries()].sort()).toEqual([...before.entries()].sort());
  });

  it('is a no-op when the ledger has nothing for the missing days', async () => {
    const index: RollupIndex = new Map();
    await withLedgerBackfill(index, [TODAY]);
    expect(index.size).toBe(0);
  });

  it('layers ledger turn time into a day the collector never observed', async () => {
    const { usageTracker } = await import('../../../src/core/usage/index.js');
    usageTracker.record({
      source: 'session', model: 'claude-code-cli',
      taskId: 't_ledger', sessionId: 'sess-ffff-6666',
      external_cost_usd: 0.42, duration_ms: 75_000,
    });
    // The ledger keys by UTC day; ask for that day so the join can match.
    const utcToday = new Date().toISOString().slice(0, 10);
    const index: RollupIndex = new Map();
    await withLedgerBackfill(index, [utcToday]);
    expect(index.get(bucketKey(utcToday, 't_ledger', 'agent'))).toBe(75_000);
    usageTracker.close();
  });
});

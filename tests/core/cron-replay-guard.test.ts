/**
 * Regression tests for the 2026-08-04 cron re-fire storm.
 *
 * Incident: an orphaned second server process shared cron-jobs.json with the
 * prod server. Each side blind-wrote its own stale in-memory snapshot, so the
 * daily-report job's state kept flapping back to "due" — it re-fired ~19
 * times in one day, creating a duplicate task on every run.
 *
 * The fix has two layers, both covered here:
 *  1. Replay guard (in-memory, per process): once a job ran for a schedule
 *     slot, this process refuses to run it again before the next slot — no
 *     matter what the (externally writable) store file says.
 *  2. Cross-process file lock + forceReload on every read-modify-write, so a
 *     mutation never persists a stale snapshot over another writer's state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../src/constants.js';
import { onTimer } from '../../src/core/cron/timer.js';
import * as ops from '../../src/core/cron/ops.js';
import type { CronServiceState, CronStoreFile } from '../../src/core/cron/types.js';

let tmpDir: string;
let storeCounter = 0;

function createMockLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any;
}

function makeStoreFile(nextRunAtMs: number): CronStoreFile {
  return {
    version: 2,
    jobs: [
      {
        id: 'job-daily',
        name: 'Daily Report',
        enabled: true,
        createdAtMs: 1_000,
        updatedAtMs: 1_000,
        schedule: { kind: 'cron', expr: '0 8 * * *', tz: 'UTC' },
        sessionTarget: 'isolated',
        wakeMode: 'next-cycle',
        payload: { kind: 'agentTurn', message: 'create the daily report task' },
        state: { nextRunAtMs },
      },
    ],
  };
}

async function makeState(nowMsRef: { value: number }): Promise<{ state: CronServiceState; storePath: string; runIsolated: ReturnType<typeof vi.fn>; log: any }> {
  const storePath = path.join(tmpDir, `cron-replay-${++storeCounter}.json`);
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  const runIsolated = vi.fn().mockResolvedValue({ status: 'ok', summary: 'done' });
  const log = createMockLog();
  const state: CronServiceState = {
    deps: {
      nowMs: () => nowMsRef.value,
      log,
      storePath,
      cronEnabled: true,
      broadcastCronNotification: vi.fn(),
      runMainAgentWithPrompt: vi.fn().mockResolvedValue(undefined),
      runIsolatedAgentJob: runIsolated,
      onEvent: vi.fn(),
    },
    store: null,
    timer: null,
    running: false,
    op: Promise.resolve(),
    warnedDisabled: false,
    replayGuard: new Map(),
  };
  return { state, storePath, runIsolated, log };
}

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('cron replay guard (2026-08-04 re-fire storm)', () => {
  it('does not re-execute when an external writer reverts the store to a due state', async () => {
    // 2026-08-04T15:00:00Z == 08:00 America/Los_Angeles-ish; use UTC cron for determinism
    const slotMs = Date.UTC(2026, 7, 4, 8, 0, 0);
    const now = { value: slotMs + 5 };
    const { state, storePath, runIsolated } = await makeState(now);
    await fs.writeFile(storePath, JSON.stringify(makeStoreFile(slotMs)), 'utf-8');

    await onTimer(state);
    expect(runIsolated).toHaveBeenCalledTimes(1);

    // External writer (second process / git-sync echo) reverts the file to the
    // pre-run snapshot: job due again at the SAME slot.
    await fs.writeFile(storePath, JSON.stringify(makeStoreFile(slotMs)), 'utf-8');

    now.value += 60_000; // one minute later, same slot
    await onTimer(state);
    // Store says due; replay guard must refuse.
    expect(runIsolated).toHaveBeenCalledTimes(1);
  });

  it('executes again once the next real schedule slot arrives', async () => {
    const slotMs = Date.UTC(2026, 7, 4, 8, 0, 0);
    const nextSlotMs = Date.UTC(2026, 7, 5, 8, 0, 0);
    const now = { value: slotMs + 5 };
    const { state, storePath, runIsolated } = await makeState(now);
    await fs.writeFile(storePath, JSON.stringify(makeStoreFile(slotMs)), 'utf-8');

    await onTimer(state);
    expect(runIsolated).toHaveBeenCalledTimes(1);

    now.value = nextSlotMs + 5;
    await onTimer(state);
    expect(runIsolated).toHaveBeenCalledTimes(2);
  });

  it('a user schedule edit clears the guard so the new schedule can fire', async () => {
    const slotMs = Date.UTC(2026, 7, 4, 8, 0, 0);
    const now = { value: slotMs + 5 };
    const { state, storePath, runIsolated } = await makeState(now);
    await fs.writeFile(storePath, JSON.stringify(makeStoreFile(slotMs)), 'utf-8');

    await onTimer(state);
    expect(runIsolated).toHaveBeenCalledTimes(1);

    // User reschedules to every minute — deliberate edit, guard must not block.
    await ops.update(state, 'job-daily', { schedule: { kind: 'every', everyMs: 60_000 } });
    now.value += 61_000;
    await onTimer(state);
    expect(runIsolated).toHaveBeenCalledTimes(2);
  });

  it('force run bypasses the guard; due run respects it', async () => {
    const slotMs = Date.UTC(2026, 7, 4, 8, 0, 0);
    const now = { value: slotMs + 5 };
    const { state, storePath, runIsolated } = await makeState(now);
    await fs.writeFile(storePath, JSON.stringify(makeStoreFile(slotMs)), 'utf-8');

    await onTimer(state);
    expect(runIsolated).toHaveBeenCalledTimes(1);

    // External revert to due state again
    await fs.writeFile(storePath, JSON.stringify(makeStoreFile(slotMs)), 'utf-8');
    now.value += 60_000;

    const dueResult = await ops.run(state, 'job-daily', 'due');
    expect(dueResult).toMatchObject({ ran: false });
    expect(runIsolated).toHaveBeenCalledTimes(1);

    const forceResult = await ops.run(state, 'job-daily', 'force');
    expect(forceResult).toMatchObject({ ran: true });
    expect(runIsolated).toHaveBeenCalledTimes(2);
  });

  it('mutating ops persist from a fresh read, not a stale snapshot', async () => {
    const slotMs = Date.UTC(2026, 7, 4, 8, 0, 0);
    const now = { value: slotMs - 60_000 };
    const { state, storePath } = await makeState(now);
    await fs.writeFile(storePath, JSON.stringify(makeStoreFile(slotMs)), 'utf-8');

    // Prime the in-memory snapshot.
    await ops.list(state, { includeDisabled: true });

    // External writer disables the job on disk (e.g. the user toggled it in
    // the other process's UI).
    const external = makeStoreFile(slotMs);
    external.jobs[0].enabled = false;
    external.jobs[0].state.nextRunAtMs = undefined;
    await fs.writeFile(storePath, JSON.stringify(external), 'utf-8');

    // A mutation on THIS process must not resurrect the stale enabled state.
    await ops.add(state, {
      name: 'Other Job',
      enabled: false,
      schedule: { kind: 'every', everyMs: 60_000 },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'x' },
    });

    const onDisk = JSON.parse(await fs.readFile(storePath, 'utf-8')) as CronStoreFile;
    const daily = onDisk.jobs.find((j) => j.id === 'job-daily')!;
    expect(daily.enabled).toBe(false);
    expect(onDisk.jobs).toHaveLength(2);
  });
});

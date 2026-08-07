/**
 * Tests for the cron-state.json sidecar split (2026-08-04 re-fire storm,
 * structural fix).
 *
 * cron-jobs.json holds DEFINITIONS only and syncs between machines via the
 * git data repo; per-job runtime state (nextRunAtMs/lastRunAtMs/...) lives in
 * a machine-local, gitignored cron-state.json sidecar. This removes the
 * cross-machine echo channel where a stale synced nextRunAtMs revived a
 * past-due slot and re-fired the job.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../src/constants.js';
import * as ops from '../../src/core/cron/ops.js';
import { ensureLoaded, persist, cronStatePath } from '../../src/core/cron/store.js';
import { locked } from '../../src/core/cron/timer.js';
import type { CronServiceState, CronStoreFile, CronStateFile } from '../../src/core/cron/types.js';

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

function makeState(storePath: string, nowMs: number): CronServiceState {
  return {
    deps: {
      nowMs: () => nowMs,
      log: createMockLog(),
      storePath,
      cronEnabled: false,
      broadcastCronNotification: vi.fn(),
      runMainAgentWithPrompt: vi.fn().mockResolvedValue(undefined),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: 'ok', summary: 'done' }),
      onEvent: vi.fn(),
    },
    store: null,
    timer: null,
    running: false,
    op: Promise.resolve(),
    warnedDisabled: false,
    replayGuard: new Map(),
  };
}

async function newStorePath(): Promise<string> {
  const storePath = path.join(tmpDir, `sidecar-${++storeCounter}`, 'cron-jobs.json');
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  return storePath;
}

async function readRaw<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf-8')) as T;
}

const NOW = Date.UTC(2026, 7, 5, 12, 0, 0);

function everyJobInput(name = 'Every Job') {
  return {
    name,
    enabled: true,
    schedule: { kind: 'every' as const, everyMs: 60_000, anchorMs: NOW },
    sessionTarget: 'main' as const,
    wakeMode: 'now' as const,
    payload: { kind: 'systemEvent' as const, text: 'periodic check' },
  };
}

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('cron-state.json sidecar', () => {
  it('persist() strips state from cron-jobs.json and writes it to the sidecar', async () => {
    const storePath = await newStorePath();
    const state = makeState(storePath, NOW);

    const job = await ops.add(state, everyJobInput());
    expect(job.state.nextRunAtMs).toBeDefined();

    const jobsFile = await readRaw<CronStoreFile>(storePath);
    expect(jobsFile.jobs).toHaveLength(1);
    expect(jobsFile.jobs[0].id).toBe(job.id);
    // Definitions file carries NO runtime state at all
    expect('state' in (jobsFile.jobs[0] as object)).toBe(false);

    const stateFile = await readRaw<CronStateFile>(cronStatePath(storePath));
    expect(stateFile.version).toBe(1);
    expect(stateFile.states[job.id]).toBeDefined();
    expect(stateFile.states[job.id].nextRunAtMs).toBe(job.state.nextRunAtMs);
  });

  it('ensureLoaded() round-trips: a fresh process sees the same in-memory state', async () => {
    const storePath = await newStorePath();
    const writer = makeState(storePath, NOW);
    const job = await ops.add(writer, everyJobInput());

    // Simulate a job having run: mutate runtime state and persist under lock,
    // exactly like timer.ts does.
    await locked(writer, async () => {
      const target = writer.store!.jobs.find((j) => j.id === job.id)!;
      target.state.lastRunAtMs = NOW - 60_000;
      target.state.lastStatus = 'ok';
      target.state.lastDurationMs = 1234;
      await persist(writer);
    });

    // Fresh process (new state object) reloads from disk.
    const reader = makeState(storePath, NOW);
    await locked(reader, async () => {
      await ensureLoaded(reader, { skipRecompute: true });
    });
    const reloaded = reader.store!.jobs.find((j) => j.id === job.id)!;
    expect(reloaded.state).toEqual({
      nextRunAtMs: job.state.nextRunAtMs,
      lastRunAtMs: NOW - 60_000,
      lastStatus: 'ok',
      lastDurationMs: 1234,
    });
  });

  it('legacy cron-jobs.json with embedded state migrates: state loads, next persist strips it', async () => {
    const storePath = await newStorePath();
    // Pre-sidecar file written by an old binary: state embedded per job.
    const legacy: CronStoreFile = {
      version: 2,
      jobs: [
        {
          id: 'legacy-1',
          name: 'Legacy Job',
          enabled: true,
          createdAtMs: NOW - 120_000,
          updatedAtMs: NOW - 120_000,
          schedule: { kind: 'every', everyMs: 60_000, anchorMs: NOW - 120_000 },
          sessionTarget: 'main',
          wakeMode: 'now',
          payload: { kind: 'systemEvent', text: 'legacy check' },
          state: { nextRunAtMs: NOW + 30_000, lastRunAtMs: NOW - 60_000, lastStatus: 'ok' },
        },
      ],
    };
    await fs.writeFile(storePath, JSON.stringify(legacy), 'utf-8');

    const state = makeState(storePath, NOW);
    const jobs = await ops.list(state, { includeDisabled: true });
    // Embedded state seeded the in-memory representation
    expect(jobs[0].state.lastRunAtMs).toBe(NOW - 60_000);
    expect(jobs[0].state.lastStatus).toBe('ok');

    // The migration persist already ran (ensureLoaded marks the store dirty):
    // jobs file is stripped, sidecar carries the state.
    const jobsFile = await readRaw<CronStoreFile>(storePath);
    expect('state' in (jobsFile.jobs[0] as object)).toBe(false);
    const stateFile = await readRaw<CronStateFile>(cronStatePath(storePath));
    expect(stateFile.states['legacy-1'].lastRunAtMs).toBe(NOW - 60_000);
  });

  it('sidecar wins over a legacy embedded state echoed back into the jobs file', async () => {
    const storePath = await newStorePath();
    const state = makeState(storePath, NOW);
    const job = await ops.add(state, everyJobInput());

    // An old binary on another box rewrites the (synced) jobs file WITH its
    // own embedded state — a stale echo. The local sidecar must win.
    // (lastStatus/lastError are never recomputed, so they cleanly prove
    // WHICH state object was loaded — nextRunAtMs alone would be healed by
    // recomputeNextRuns and mask a wrong pick.)
    const echoed = await readRaw<CronStoreFile>(storePath);
    (echoed.jobs[0] as any).state = {
      nextRunAtMs: NOW - 3_600_000,
      lastStatus: 'error',
      lastError: 'echoed from other box',
    };
    await fs.writeFile(storePath, JSON.stringify(echoed), 'utf-8');

    const jobs = await ops.list(state, { includeDisabled: true });
    expect(jobs[0].state.lastStatus).toBeUndefined();
    expect(jobs[0].state.lastError).toBeUndefined();
    expect(jobs[0].state.nextRunAtMs).toBe(job.state.nextRunAtMs);
  });

  it("drops a removed job's entry from the sidecar", async () => {
    const storePath = await newStorePath();
    const state = makeState(storePath, NOW);
    const keep = await ops.add(state, everyJobInput('Keep'));
    const drop = await ops.add(state, everyJobInput('Drop'));

    let stateFile = await readRaw<CronStateFile>(cronStatePath(storePath));
    expect(Object.keys(stateFile.states).sort()).toEqual([keep.id, drop.id].sort());

    await ops.remove(state, drop.id);

    stateFile = await readRaw<CronStateFile>(cronStatePath(storePath));
    expect(Object.keys(stateFile.states)).toEqual([keep.id]);
  });
});

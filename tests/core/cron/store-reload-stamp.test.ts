/**
 * Every cron op forces a reload of the store under the lock, so another writer's change is never
 * overwritten. On the live server (2026-11-21) that meant both files were read and parsed about
 * 5 times a second: 3,291 reads of cron-state.json and cron-jobs.json in 10 minutes, 6.5 GB of
 * JSON text, the largest source of the server's garbage. A forced reload now keeps the store
 * while both files still carry the stamp this process last read or wrote, and a write leaves a
 * file whose text did not change as it is. These tests hold both halves: no read while nothing
 * changed, a read whenever anything else wrote, threw, or the reread clock ran out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-cron-reload-stamp'));

import { WALNUT_HOME } from '../../../src/constants.js';
import * as ops from '../../../src/core/cron/ops.js';
import { locked } from '../../../src/core/cron/timer.js';
import { CRON_REREAD_MAX_MS, cronStatePath } from '../../../src/core/cron/store.js';
import { _resetJsonIoForTesting, jsonIoTop } from '../../../src/core/observability/json-io.js';
import type { CronServiceState } from '../../../src/core/cron/types.js';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis() } as any;

async function makeState(): Promise<CronServiceState> {
  const storePath = path.join(WALNUT_HOME, 'cron-jobs.json');
  await fs.writeFile(storePath, JSON.stringify({ version: 2, jobs: [{
    id: 'job-a', name: 'Nightly digest', enabled: true, createdAtMs: 1_000, updatedAtMs: 1_000,
    schedule: { kind: 'cron', expr: '0 8 * * *', tz: 'UTC' }, sessionTarget: 'isolated', wakeMode: 'next-cycle',
    payload: { kind: 'agentTurn', message: 'write the digest' }, state: {},
  }] }), 'utf-8');
  return {
    deps: { nowMs: () => Date.now(), log, storePath, cronEnabled: false, broadcastCronNotification: vi.fn(), runMainAgentWithPrompt: vi.fn(), runIsolatedAgentJob: vi.fn(), onEvent: vi.fn() },
    store: null, timer: null, running: false, op: Promise.resolve(), warnedDisabled: false, replayGuard: new Map(),
  } as unknown as CronServiceState;
}

/** Reads and writes of the two cron files since the last reset. */
function io(state: CronServiceState) {
  const rows = jsonIoTop(50);
  const of = (p: string) => rows.find((r) => r.file === p) ?? { reads: 0, writes: 0 };
  const jobs = of(state.deps.storePath);
  const sidecar = of(cronStatePath(state.deps.storePath));
  return { reads: jobs.reads + sidecar.reads, jobsWrites: jobs.writes, stateWrites: sidecar.writes };
}

/** Bumps a file's mtime and size the way any other writer would. */
async function rewriteJobs(state: CronServiceState, name: string): Promise<void> {
  const raw = JSON.parse(await fs.readFile(state.deps.storePath, 'utf-8'));
  raw.jobs[0].name = name;
  await fs.writeFile(state.deps.storePath, JSON.stringify(raw), 'utf-8');
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  _resetJsonIoForTesting();
});
afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('cron store: a forced reload keeps what still matches the disk', () => {
  it('reads the files once for many ops while nothing else writes them', async () => {
    const state = await makeState();
    await ops.list(state, { includeDisabled: true }); // the first load, plus its migration write
    _resetJsonIoForTesting();
    for (let i = 0; i < 20; i += 1) {
      await ops.list(state, { includeDisabled: true });
      await ops.status(state);
    }
    expect(io(state).reads).toBe(0);
  });

  it("reads again after another writer changed the jobs file, and shows that writer's change", async () => {
    const state = await makeState();
    await ops.list(state, { includeDisabled: true });
    await rewriteJobs(state, 'Evening digest');
    _resetJsonIoForTesting();
    const jobs = await ops.list(state, { includeDisabled: true });
    expect(jobs.map((j) => j.name)).toEqual(['Evening digest']);
    expect(io(state).reads).toBe(2); // both files: one load
  });

  it('reads again after the runtime sidecar was changed by another writer', async () => {
    const state = await makeState();
    await ops.list(state, { includeDisabled: true });
    const sidecar = cronStatePath(state.deps.storePath);
    const raw = JSON.parse(await fs.readFile(sidecar, 'utf-8'));
    raw.states['job-a'] = { ...raw.states['job-a'], lastStatus: 'error', lastError: 'from another box' };
    await fs.writeFile(sidecar, JSON.stringify(raw), 'utf-8');
    const [job] = await ops.list(state, { includeDisabled: true });
    expect(job!.state.lastError).toBe('from another box');
  });

  it('an op that wrote keeps its own write without reading it back, and an edit lands on disk', async () => {
    const state = await makeState();
    await ops.list(state, { includeDisabled: true });
    await ops.update(state, 'job-a', { name: 'Morning digest' });
    _resetJsonIoForTesting();
    const [job] = await ops.list(state, { includeDisabled: true });
    expect(job!.name).toBe('Morning digest');
    expect(io(state).reads).toBe(0);
    const onDisk = JSON.parse(await fs.readFile(state.deps.storePath, 'utf-8'));
    expect(onDisk.jobs[0].name).toBe('Morning digest');
  });

  it('a write that changes only runtime state leaves the jobs file untouched', async () => {
    const state = await makeState();
    await ops.list(state, { includeDisabled: true });
    await ops.update(state, 'job-a', { name: 'Morning digest' });
    const before = await fs.stat(state.deps.storePath);
    _resetJsonIoForTesting();
    await locked(state, async () => {
      const { persist } = await import('../../../src/core/cron/store.js');
      state.store!.jobs[0]!.state.lastError = 'runtime only';
      await persist(state);
    });
    const after = await fs.stat(state.deps.storePath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(io(state).jobsWrites).toBe(0);
    expect(io(state).stateWrites).toBeGreaterThan(0);
    const sidecar = JSON.parse(await fs.readFile(cronStatePath(state.deps.storePath), 'utf-8'));
    expect(sidecar.states['job-a'].lastError).toBe('runtime only');
  });

  it('after a reread (the 30 s clock), a write that changes only runtime state still leaves the jobs file untouched', async () => {
    const state = await makeState();
    await ops.update(state, 'job-a', { name: 'Morning digest' });
    state.disk!.readAt = Date.now() - CRON_REREAD_MAX_MS - 1;
    await ops.list(state, { includeDisabled: true }); // rereads both files
    const before = await fs.stat(state.deps.storePath);
    _resetJsonIoForTesting();
    await locked(state, async () => {
      const { ensureLoaded, persist } = await import('../../../src/core/cron/store.js');
      await ensureLoaded(state, { forceReload: true, skipRecompute: true });
      state.store!.jobs[0]!.state.lastError = 'runtime only';
      await persist(state);
    });
    expect(io(state).jobsWrites).toBe(0);
    expect(io(state).stateWrites).toBe(1);
    expect((await fs.stat(state.deps.storePath)).mtimeMs).toBe(before.mtimeMs);
  });

  it('an op that threw after changing the store in memory: the next op reads the disk again', async () => {
    const state = await makeState();
    await ops.list(state, { includeDisabled: true });
    await expect(locked(state, async () => {
      state.store!.jobs[0]!.name = 'never written';
      throw new Error('boom');
    })).rejects.toThrow('boom');
    const [job] = await ops.list(state, { includeDisabled: true });
    expect(job!.name).toBe('Nightly digest');
  });

  it('reads the files again once the reread clock ran out, even with the stamp unchanged', async () => {
    const state = await makeState();
    await ops.list(state, { includeDisabled: true });
    _resetJsonIoForTesting();
    state.disk!.readAt = Date.now() - CRON_REREAD_MAX_MS - 1;
    await ops.list(state, { includeDisabled: true });
    expect(io(state).reads).toBe(2);
    _resetJsonIoForTesting();
    await ops.list(state, { includeDisabled: true });
    expect(io(state).reads).toBe(0);
  });

  it('a write after another writer changed the file writes it, even when its text is the one written last', async () => {
    const state = await makeState();
    await ops.update(state, 'job-a', { name: 'Morning digest' });
    const ours = await fs.readFile(state.deps.storePath, 'utf-8');
    await rewriteJobs(state, 'Evening digest');
    // A persist with no reload first (as run's last phase does): the text matches what this
    // process last wrote, but the file moved since, so it is written again.
    await locked(state, async () => {
      const { persist } = await import('../../../src/core/cron/store.js');
      await persist(state);
    });
    expect(await fs.readFile(state.deps.storePath, 'utf-8')).toBe(ours);
  });

  it('the runtime sidecar is written compact (written on every check), the synced jobs file stays indented', async () => {
    const state = await makeState();
    await ops.update(state, 'job-a', { name: 'Morning digest' });
    const sidecar = await fs.readFile(cronStatePath(state.deps.storePath), 'utf-8');
    expect(sidecar.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(sidecar).states['job-a']).toBeTruthy();
    expect((await fs.readFile(state.deps.storePath, 'utf-8')).split('\n').length).toBeGreaterThan(5);
  });

  it('a file deleted under it is read as missing, not kept', async () => {
    const state = await makeState();
    await ops.list(state, { includeDisabled: true });
    await fs.rm(state.deps.storePath);
    expect(await ops.list(state, { includeDisabled: true })).toEqual([]);
  });
});

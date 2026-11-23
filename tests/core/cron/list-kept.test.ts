/**
 * A reader that only shows the routines (the user-status pass) takes them as this process last
 * read or wrote them, without the store's lock (cron ops.listKept). Every op holds that lock while
 * it reloads and writes the store, and each recorded trigger check is one: on the Mac (2026-11-20)
 * the status pass's list waited behind them for up to 11.7 s, and a brief_write waited for it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-cron-list-kept'));

import { WALNUT_HOME } from '../../../src/constants.js';
import * as ops from '../../../src/core/cron/ops.js';
import { locked } from '../../../src/core/cron/timer.js';
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

/** Takes the store's lock as an op does, and keeps it until `release()`. */
async function holdLock(state: CronServiceState): Promise<{ release: () => Promise<void> }> {
  let release!: () => void;
  let held!: () => void;
  const holding = new Promise<void>((r) => { held = r; });
  const done = locked(state, () => new Promise<void>((r) => { release = r; held(); }));
  await holding;
  return { release: async () => { release(); await done; } };
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});
afterEach(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }); });

describe('cron listKept', () => {
  it('answers while an op holds the store lock, where the locked list waits', async () => {
    const state = await makeState();
    expect((await ops.list(state, { includeDisabled: true })).map((j) => j.id)).toEqual(['job-a']);
    const lock = await holdLock(state);
    // The positive control: the locked list waits for the op.
    let listed = false;
    const waiting = ops.list(state, { includeDisabled: true }).then((jobs) => { listed = true; return jobs; });
    const kept = await ops.listKept(state, { includeDisabled: true });
    expect(kept.map((j) => j.name)).toEqual(['Nightly digest']);
    expect(listed).toBe(false);
    await lock.release();
    expect((await waiting).map((j) => j.id)).toEqual(['job-a']);
  });

  it('shows what an op wrote, and takes the locked list when nothing was loaded or the copy is old', async () => {
    const state = await makeState();
    // Nothing loaded yet: the locked list loads it.
    expect((await ops.listKept(state)).map((j) => j.id)).toEqual(['job-a']);
    await ops.update(state, 'job-a', { name: 'Morning digest' });
    expect((await ops.listKept(state)).map((j) => j.name)).toEqual(['Morning digest']);
    // Another process rewrote the file a minute ago and no op read it since: the copy is too old.
    const raw = JSON.parse(await fs.readFile(state.deps.storePath, 'utf-8'));
    raw.jobs[0].name = 'Evening digest';
    await fs.writeFile(state.deps.storePath, JSON.stringify(raw), 'utf-8');
    state.keptAt = Date.now() - ops.KEPT_LIST_MAX_AGE_MS - 1;
    expect((await ops.listKept(state)).map((j) => j.name)).toEqual(['Evening digest']);
  });

  // The class: a status source that took the locked list would wait behind every trigger check again.
  it('the user-status pass reads the routines without the lock', () => {
    const src = readFileSync(path.join(__dirname, '../../../src/core/user-status-sync.ts'), 'utf-8');
    const calls = src.match(/\blistRoutines\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((c) => !c.includes('kept: true'))).toEqual([]);
  });

  // 2026-11-23: trigger_list (GET /api/v1/routines) waited 7 to 11 s behind the lock, past its op's
  // 10 s self-call limit. Every route that only shows routines, and the replica relay's reads, read kept.
  it.each([
    ['src/web/routes/routines-v1.ts', /\b(?:listRoutines|getRoutine)\([^)]*\)/g],
    ['src/web/routes/cron.ts', /\b(?:listRoutines|getRoutine)\((?:[^()]|\([^()]*\))*\)/g],
  ])('%s reads the routines without the lock', (file, re) => {
    const src = readFileSync(path.join(__dirname, '../../..', file), 'utf-8');
    const calls = src.match(re) ?? [];
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.filter((c) => !c.includes('kept: true'))).toEqual([]);
  });

  it("the replica relay's list and get read without the lock", () => {
    const src = readFileSync(path.join(__dirname, '../../../src/core/routines/routines-core.ts'), 'utf-8');
    expect(src).toMatch(/case 'list': return await listRoutines\([^;]*kept: true/);
    expect(src).toMatch(/case 'get': return await getRoutine\(id, \{ kept: true \}\)/);
  });
});

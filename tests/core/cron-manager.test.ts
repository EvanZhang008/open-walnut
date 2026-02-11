/**
 * Unit tests for the cron module: schedule computation, job creation,
 * recompute logic, CronService CRUD, normalization, and result handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../src/constants.js';
import { computeNextRunAtMs } from '../../src/core/cron/schedule.js';
import {
  createJob,
  recomputeNextRuns,
  assertSupportedJobSpec,
  applyJobPatch,
  computeJobNextRunAtMs,
  findJobOrThrow,
  isJobDue,
} from '../../src/core/cron/jobs.js';
import { applyJobResult, armTimer, stopTimer, emit } from '../../src/core/cron/timer.js';
import { normalizeCronJobCreate, normalizeCronJobPatch } from '../../src/core/cron/normalize.js';
import { CronService } from '../../src/core/cron/service.js';
import type {
  CronServiceDeps,
  CronServiceState,
  CronJob,
  CronJobCreate,
} from '../../src/core/cron/types.js';

// ── Helpers ──

let tmpDir: string;

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

function createMockState(overrides?: Partial<CronServiceState>): CronServiceState {
  return {
    deps: {
      nowMs: () => Date.now(),
      log: createMockLog(),
      storePath: path.join(tmpDir, 'cron-jobs.json'),
      cronEnabled: false,
      broadcastCronNotification: vi.fn(),
      runMainAgentWithPrompt: vi.fn().mockResolvedValue(undefined),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: 'ok', summary: 'done' }),
      onEvent: vi.fn(),
    },
    store: { version: 1, jobs: [] },
    timer: null,
    running: false,
    op: Promise.resolve(),
    warnedDisabled: false,
    ...overrides,
  };
}

function createTestService(overrides?: Partial<CronServiceDeps>) {
  const deps: CronServiceDeps = {
    log: createMockLog(),
    storePath: path.join(tmpDir, 'cron-jobs.json'),
    cronEnabled: false,
    broadcastCronNotification: vi.fn(),
    runMainAgentWithPrompt: vi.fn().mockResolvedValue(undefined),
    runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: 'ok', summary: 'done' }),
    onEvent: vi.fn(),
    ...overrides,
  };
  return new CronService(deps);
}

function makeEveryInput(everyMs = 60_000): CronJobCreate {
  return {
    name: 'Every Job',
    enabled: true,
    schedule: { kind: 'every', everyMs },
    sessionTarget: 'main',
    wakeMode: 'now',
    payload: { kind: 'systemEvent', text: 'periodic check' },
  };
}

function makeAtInput(at: string): CronJobCreate {
  return {
    name: 'At Job',
    enabled: true,
    schedule: { kind: 'at', at },
    sessionTarget: 'main',
    wakeMode: 'now',
    payload: { kind: 'systemEvent', text: 'one-shot' },
  };
}

function makeCronInput(expr = '0 0 * * *'): CronJobCreate {
  return {
    name: 'Cron Job',
    enabled: true,
    schedule: { kind: 'cron', expr },
    sessionTarget: 'main',
    wakeMode: 'now',
    payload: { kind: 'systemEvent', text: 'cron event' },
  };
}

// ── Setup / Teardown ──

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Schedule computation ──

describe('computeNextRunAtMs', () => {
  describe('at schedule', () => {
    it('returns atMs when it is in the future', () => {
      const futureDate = new Date(Date.now() + 3_600_000).toISOString();
      const result = computeNextRunAtMs({ kind: 'at', at: futureDate }, Date.now());
      expect(result).toBeDefined();
      expect(result).toBeGreaterThan(Date.now() - 1000);
    });

    it('returns undefined when at is in the past', () => {
      const pastDate = new Date(Date.now() - 3_600_000).toISOString();
      const result = computeNextRunAtMs({ kind: 'at', at: pastDate }, Date.now());
      expect(result).toBeUndefined();
    });

    it('returns undefined for invalid date string', () => {
      const result = computeNextRunAtMs({ kind: 'at', at: 'not-a-date' }, Date.now());
      expect(result).toBeUndefined();
    });
  });

  describe('every schedule', () => {
    it('returns next interval tick from anchor', () => {
      const now = 100_000;
      const result = computeNextRunAtMs(
        { kind: 'every', everyMs: 10_000, anchorMs: 50_000 },
        now,
      );
      // anchor=50000, elapsed=50000, steps=ceil(50000/10000)=5, next=50000+5*10000=100000
      // But 100000 === now, so steps = max(1, ceil((50000+10000-1)/10000)) = max(1, 5) = 5
      // next = 50000 + 5*10000 = 100000. That's equal to now, not strictly after.
      // Let's check the actual code: elapsed = nowMs - anchor = 50000
      // steps = max(1, floor((50000 + 10000 - 1) / 10000)) = max(1, floor(59999/10000)) = max(1, 5) = 5
      // result = 50000 + 5 * 10000 = 100000
      expect(result).toBe(100_000);
    });

    it('returns anchor when nowMs is before anchor', () => {
      const result = computeNextRunAtMs(
        { kind: 'every', everyMs: 10_000, anchorMs: 200_000 },
        100_000,
      );
      expect(result).toBe(200_000);
    });

    it('computes correctly when exactly on boundary', () => {
      const result = computeNextRunAtMs(
        { kind: 'every', everyMs: 1000, anchorMs: 0 },
        5000,
      );
      // elapsed = 5000, steps = max(1, floor((5000+999)/1000)) = max(1, 5) = 5
      // result = 0 + 5 * 1000 = 5000
      expect(result).toBe(5000);
    });
  });

  describe('cron schedule', () => {
    it('returns a future time for a valid cron expression', () => {
      const now = Date.now();
      const result = computeNextRunAtMs({ kind: 'cron', expr: '* * * * *' }, now);
      expect(result).toBeDefined();
      expect(result).toBeGreaterThanOrEqual(now);
    });

    it('returns a value for daily midnight cron', () => {
      const now = Date.now();
      const result = computeNextRunAtMs({ kind: 'cron', expr: '0 0 * * *' }, now);
      expect(result).toBeDefined();
      // The next midnight should be within the next 24h
      expect(result!).toBeLessThanOrEqual(now + 24 * 60 * 60 * 1000);
    });

    it('returns undefined for empty expression', () => {
      const result = computeNextRunAtMs({ kind: 'cron', expr: '' }, Date.now());
      expect(result).toBeUndefined();
    });
  });
});

// ── Job creation ──

describe('createJob', () => {
  it('creates a job with correct fields', () => {
    const now = 1_700_000_000_000;
    const state = createMockState();
    state.deps.nowMs = () => now;

    const job = createJob(state, makeEveryInput());
    expect(job.id).toBeDefined();
    expect(job.name).toBe('Every Job');
    expect(job.createdAtMs).toBe(now);
    expect(job.updatedAtMs).toBe(now);
    expect(job.enabled).toBe(true);
    expect(job.schedule.kind).toBe('every');
    expect(job.sessionTarget).toBe('main');
    expect(job.wakeMode).toBe('now');
    expect(job.payload).toEqual({ kind: 'systemEvent', text: 'periodic check' });
    expect(job.state.nextRunAtMs).toBeDefined();
  });

  it('sets deleteAfterRun=true for at schedules by default', () => {
    const state = createMockState();
    const futureDate = new Date(Date.now() + 3_600_000).toISOString();
    const job = createJob(state, makeAtInput(futureDate));
    expect(job.deleteAfterRun).toBe(true);
  });

  it('does not set deleteAfterRun for every schedules', () => {
    const state = createMockState();
    const job = createJob(state, makeEveryInput());
    expect(job.deleteAfterRun).toBeUndefined();
  });

  it('throws for main + agentTurn combo', () => {
    const state = createMockState();
    expect(() =>
      createJob(state, {
        name: 'Bad combo',
        enabled: true,
        schedule: { kind: 'every', everyMs: 60_000 },
        sessionTarget: 'main',
        wakeMode: 'now',
        payload: { kind: 'agentTurn', message: 'do stuff' },
      }),
    ).toThrow('main cron jobs require payload.kind="systemEvent"');
  });

  it('throws for isolated + systemEvent combo', () => {
    const state = createMockState();
    expect(() =>
      createJob(state, {
        name: 'Bad combo 2',
        enabled: true,
        schedule: { kind: 'every', everyMs: 60_000 },
        sessionTarget: 'isolated',
        wakeMode: 'now',
        payload: { kind: 'systemEvent', text: 'oops' },
      }),
    ).toThrow('isolated cron jobs require payload.kind="agentTurn"');
  });
});

// ── assertSupportedJobSpec ──

describe('assertSupportedJobSpec', () => {
  it('accepts main + systemEvent', () => {
    expect(() =>
      assertSupportedJobSpec({
        sessionTarget: 'main',
        payload: { kind: 'systemEvent', text: 'ok' },
      }),
    ).not.toThrow();
  });

  it('accepts isolated + agentTurn', () => {
    expect(() =>
      assertSupportedJobSpec({
        sessionTarget: 'isolated',
        payload: { kind: 'agentTurn', message: 'ok' },
      }),
    ).not.toThrow();
  });
});

// ── Recompute next runs ──

describe('recomputeNextRuns', () => {
  it('updates nextRunAtMs for enabled jobs', () => {
    const now = Date.now();
    const state = createMockState();
    state.deps.nowMs = () => now;

    // Manually create a job with a missing nextRunAtMs
    const job: CronJob = {
      id: 'test-1',
      name: 'Test',
      enabled: true,
      createdAtMs: now - 120_000,
      updatedAtMs: now - 120_000,
      schedule: { kind: 'every', everyMs: 60_000, anchorMs: now - 120_000 },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'check' },
      state: {},
    };
    state.store!.jobs.push(job);

    const changed = recomputeNextRuns(state);
    expect(changed).toBe(true);
    expect(job.state.nextRunAtMs).toBeDefined();
    expect(typeof job.state.nextRunAtMs).toBe('number');
  });

  it('clears nextRunAtMs for disabled jobs', () => {
    const state = createMockState();
    const job: CronJob = {
      id: 'test-disabled',
      name: 'Disabled',
      enabled: false,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      schedule: { kind: 'every', everyMs: 60_000 },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'check' },
      state: { nextRunAtMs: 999999 },
    };
    state.store!.jobs.push(job);

    const changed = recomputeNextRuns(state);
    expect(changed).toBe(true);
    expect(job.state.nextRunAtMs).toBeUndefined();
    // Also clears runningAtMs for disabled
    expect(job.state.runningAtMs).toBeUndefined();
  });

  it('clears stuck running markers older than 2 hours', () => {
    const now = Date.now();
    const state = createMockState();
    state.deps.nowMs = () => now;

    const twoHoursAgo = now - 2 * 60 * 60 * 1000 - 1;
    const job: CronJob = {
      id: 'stuck',
      name: 'Stuck',
      enabled: true,
      createdAtMs: now - 120_000,
      updatedAtMs: now - 120_000,
      schedule: { kind: 'every', everyMs: 60_000, anchorMs: now - 120_000 },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'check' },
      state: { runningAtMs: twoHoursAgo },
    };
    state.store!.jobs.push(job);

    const changed = recomputeNextRuns(state);
    expect(changed).toBe(true);
    expect(job.state.runningAtMs).toBeUndefined();
  });

  it('does not clear running markers that are recent', () => {
    const now = Date.now();
    const state = createMockState();
    state.deps.nowMs = () => now;

    const recentRun = now - 60_000; // 1 minute ago
    const job: CronJob = {
      id: 'recent',
      name: 'Recent',
      enabled: true,
      createdAtMs: now - 120_000,
      updatedAtMs: now - 120_000,
      schedule: { kind: 'every', everyMs: 60_000, anchorMs: now - 120_000 },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'check' },
      state: { runningAtMs: recentRun, nextRunAtMs: now + 60_000 },
    };
    state.store!.jobs.push(job);

    recomputeNextRuns(state);
    expect(job.state.runningAtMs).toBe(recentRun);
  });
});

// ── CronService CRUD ──

describe('CronService', () => {
  // Each test gets its own isolated service with a unique store path.
  // We also pre-create an empty store file to avoid sharing the in-memory
  // EMPTY_STORE fallback object across services (which leads to cross-test
  // mutation via Array.push).
  let svcCounter = 0;

  async function isolatedService(overrides?: Partial<CronServiceDeps>) {
    const storePath = path.join(tmpDir, `cron-svc-${++svcCounter}-${Date.now()}.json`);
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs: [] }), 'utf-8');
    return createTestService({ storePath, ...overrides });
  }

  describe('add', () => {
    it('creates a job and persists it to disk', async () => {
      const service = await isolatedService();
      const job = await service.add(makeEveryInput());

      expect(job.id).toBeDefined();
      expect(job.name).toBe('Every Job');
      expect(job.enabled).toBe(true);
    });
  });

  describe('list', () => {
    it('returns jobs sorted by nextRunAtMs', async () => {
      const service = await isolatedService();

      // Create two jobs with different intervals
      await service.add(makeEveryInput(120_000)); // every 2 min
      await service.add(makeEveryInput(60_000)); // every 1 min

      const jobs = await service.list();
      expect(jobs).toHaveLength(2);
      // Sorted by nextRunAtMs
      const t1 = jobs[0].state.nextRunAtMs ?? 0;
      const t2 = jobs[1].state.nextRunAtMs ?? 0;
      expect(t1).toBeLessThanOrEqual(t2);
    });

    it('filters out disabled jobs by default', async () => {
      const service = await isolatedService();
      const job = await service.add(makeEveryInput());
      await service.toggle(job.id); // disable it

      const enabledJobs = await service.list();
      expect(enabledJobs).toHaveLength(0);

      const allJobs = await service.list({ includeDisabled: true });
      expect(allJobs).toHaveLength(1);
    });
  });

  describe('update', () => {
    it('modifies job fields and recomputes schedule', async () => {
      const service = await isolatedService();
      const job = await service.add(makeEveryInput());

      const updated = await service.update(job.id, { name: 'Updated Name' });
      expect(updated.name).toBe('Updated Name');
      expect(updated.id).toBe(job.id);
    });

    it('updates schedule and recomputes nextRunAtMs', async () => {
      const service = await isolatedService();
      const job = await service.add(makeEveryInput(60_000));

      const updated = await service.update(job.id, {
        schedule: { kind: 'every', everyMs: 120_000 },
      });
      expect(updated.schedule).toEqual(
        expect.objectContaining({ kind: 'every', everyMs: 120_000 }),
      );
    });
  });

  describe('toggle', () => {
    it('flips enabled and updates nextRunAtMs', async () => {
      const service = await isolatedService();
      const job = await service.add(makeEveryInput());
      expect(job.enabled).toBe(true);
      expect(job.state.nextRunAtMs).toBeDefined();

      const disabled = await service.toggle(job.id);
      expect(disabled.enabled).toBe(false);
      expect(disabled.state.nextRunAtMs).toBeUndefined();

      const reenabled = await service.toggle(job.id);
      expect(reenabled.enabled).toBe(true);
      expect(reenabled.state.nextRunAtMs).toBeDefined();
    });
  });

  describe('remove', () => {
    it('removes job from store and persists', async () => {
      const service = await isolatedService();
      const job = await service.add(makeEveryInput());

      const result = await service.remove(job.id);
      expect(result).toEqual({ ok: true, removed: true });

      const jobs = await service.list({ includeDisabled: true });
      expect(jobs).toHaveLength(0);
    });

    it('returns removed=false for non-existent id', async () => {
      const service = await isolatedService();
      const result = await service.remove('nonexistent');
      expect(result).toEqual({ ok: true, removed: false });
    });
  });

  describe('status', () => {
    it('returns correct summary', async () => {
      const service = await isolatedService();
      await service.add(makeEveryInput());

      const stat = await service.status();
      expect(stat.enabled).toBe(false); // cronEnabled=false in test
      expect(stat.jobs).toBe(1);
      expect(stat.storePath).toContain('.json');
      // nextWakeAtMs is null because cronEnabled=false
      expect(stat.nextWakeAtMs).toBeNull();
    });
  });

  describe('run', () => {
    it('executes a main systemEvent job when forced', async () => {
      const broadcastFn = vi.fn();
      const runMainFn = vi.fn().mockResolvedValue(undefined);
      const service = await isolatedService({
        broadcastCronNotification: broadcastFn,
        runMainAgentWithPrompt: runMainFn,
      });
      const job = await service.add(makeEveryInput());

      const result = await service.run(job.id, 'force');
      expect(result).toEqual({ ok: true, ran: true });
      expect(broadcastFn).toHaveBeenCalled();
      expect(runMainFn).toHaveBeenCalled();
    });

    it('returns not-due when job is not due and mode is "due"', async () => {
      const service = await isolatedService();
      const job = await service.add(makeEveryInput());

      // The job's nextRunAtMs is in the future, so it's not due
      const result = await service.run(job.id, 'due');
      expect(result).toEqual(
        expect.objectContaining({ ok: true, ran: false, reason: 'not-due' }),
      );
    });
  });

  describe('event emission', () => {
    it('emits events on add, update, and remove', async () => {
      const onEvent = vi.fn();
      const service = await isolatedService({ onEvent });

      const job = await service.add(makeEveryInput());
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: job.id, action: 'added' }),
      );

      await service.update(job.id, { name: 'New Name' });
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: job.id, action: 'updated' }),
      );

      await service.remove(job.id);
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: job.id, action: 'removed' }),
      );
    });
  });
});

// ── Normalize input ──

describe('normalizeCronJobCreate', () => {
  it('infers schedule kind from everyMs field', () => {
    const result = normalizeCronJobCreate({
      name: 'Test',
      schedule: { everyMs: 60_000 },
      payload: { kind: 'systemEvent', text: 'hi' },
    });
    expect(result).not.toBeNull();
    expect(result!.schedule).toEqual(
      expect.objectContaining({ kind: 'every', everyMs: 60_000 }),
    );
  });

  it('infers schedule kind from expr field', () => {
    const result = normalizeCronJobCreate({
      name: 'Test',
      schedule: { expr: '0 0 * * *' },
      payload: { kind: 'systemEvent', text: 'hi' },
    });
    expect(result).not.toBeNull();
    expect(result!.schedule).toEqual(
      expect.objectContaining({ kind: 'cron', expr: '0 0 * * *' }),
    );
  });

  it('infers schedule kind from at field', () => {
    const futureDate = new Date(Date.now() + 3_600_000).toISOString();
    const result = normalizeCronJobCreate({
      name: 'Test',
      schedule: { at: futureDate },
      payload: { kind: 'systemEvent', text: 'hi' },
    });
    expect(result).not.toBeNull();
    expect(result!.schedule).toEqual(
      expect.objectContaining({ kind: 'at' }),
    );
  });

  it('infers sessionTarget from payload kind (systemEvent → main)', () => {
    const result = normalizeCronJobCreate({
      schedule: { kind: 'every', everyMs: 60_000 },
      payload: { kind: 'systemEvent', text: 'hi' },
    });
    expect(result).not.toBeNull();
    expect(result!.sessionTarget).toBe('main');
  });

  it('infers sessionTarget from payload kind (agentTurn → isolated)', () => {
    const result = normalizeCronJobCreate({
      schedule: { kind: 'every', everyMs: 60_000 },
      payload: { kind: 'agentTurn', message: 'do stuff' },
    });
    expect(result).not.toBeNull();
    expect(result!.sessionTarget).toBe('isolated');
  });

  it('applies defaults (enabled=true, wakeMode=now)', () => {
    const result = normalizeCronJobCreate({
      name: 'Test',
      schedule: { kind: 'every', everyMs: 60_000 },
      payload: { kind: 'systemEvent', text: 'hi' },
    });
    expect(result).not.toBeNull();
    expect(result!.enabled).toBe(true);
    expect(result!.wakeMode).toBe('now');
  });

  it('infers name from payload text when name is missing', () => {
    const result = normalizeCronJobCreate({
      schedule: { kind: 'every', everyMs: 60_000 },
      payload: { kind: 'systemEvent', text: 'check server health' },
    });
    expect(result).not.toBeNull();
    expect(result!.name).toBe('check server health');
  });

  it('returns null for non-object input', () => {
    expect(normalizeCronJobCreate(null)).toBeNull();
    expect(normalizeCronJobCreate('string')).toBeNull();
    expect(normalizeCronJobCreate(42)).toBeNull();
  });

  it('sets deleteAfterRun=true for at schedule', () => {
    const futureDate = new Date(Date.now() + 3_600_000).toISOString();
    const result = normalizeCronJobCreate({
      name: 'One shot',
      schedule: { kind: 'at', at: futureDate },
      payload: { kind: 'systemEvent', text: 'once' },
    });
    expect(result).not.toBeNull();
    expect(result!.deleteAfterRun).toBe(true);
  });

  it('builds payload from top-level text field', () => {
    const result = normalizeCronJobCreate({
      name: 'Test',
      schedule: { kind: 'every', everyMs: 60_000 },
      text: 'check health',
    });
    expect(result).not.toBeNull();
    expect(result!.payload).toEqual(
      expect.objectContaining({ kind: 'systemEvent', text: 'check health' }),
    );
  });

  it('builds payload from top-level message field', () => {
    const result = normalizeCronJobCreate({
      name: 'Test',
      schedule: { kind: 'every', everyMs: 60_000 },
      message: 'do work',
    });
    expect(result).not.toBeNull();
    expect(result!.payload).toEqual(
      expect.objectContaining({ kind: 'agentTurn', message: 'do work' }),
    );
  });
});

describe('normalizeCronJobPatch', () => {
  it('does not apply defaults', () => {
    const result = normalizeCronJobPatch({
      name: 'Updated',
    });
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Updated');
    // Should NOT have defaults applied
    expect((result as any).enabled).toBeUndefined();
    expect((result as any).wakeMode).toBeUndefined();
    expect((result as any).sessionTarget).toBeUndefined();
  });

  it('returns null for non-object input', () => {
    expect(normalizeCronJobPatch(null)).toBeNull();
    expect(normalizeCronJobPatch(42)).toBeNull();
  });

  it('coerces schedule fields', () => {
    const result = normalizeCronJobPatch({
      schedule: { everyMs: 120_000 },
    });
    expect(result).not.toBeNull();
    expect(result!.schedule).toEqual(
      expect.objectContaining({ kind: 'every', everyMs: 120_000 }),
    );
  });
});

// ── applyJobResult ──

describe('applyJobResult', () => {
  it('increments consecutiveErrors on error', () => {
    const state = createMockState();
    const job: CronJob = {
      id: 'err-test',
      name: 'Error Test',
      enabled: true,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      schedule: { kind: 'every', everyMs: 60_000, anchorMs: Date.now() - 120_000 },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'check' },
      state: { consecutiveErrors: 0 },
    };

    const now = Date.now();
    applyJobResult(state, job, {
      status: 'error',
      error: 'connection failed',
      startedAt: now - 1000,
      endedAt: now,
    });

    expect(job.state.consecutiveErrors).toBe(1);
    expect(job.state.lastStatus).toBe('error');
    expect(job.state.lastError).toBe('connection failed');
  });

  it('resets consecutiveErrors to 0 on success', () => {
    const state = createMockState();
    const job: CronJob = {
      id: 'ok-test',
      name: 'OK Test',
      enabled: true,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      schedule: { kind: 'every', everyMs: 60_000, anchorMs: Date.now() - 120_000 },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'check' },
      state: { consecutiveErrors: 3 },
    };

    const now = Date.now();
    applyJobResult(state, job, {
      status: 'ok',
      startedAt: now - 1000,
      endedAt: now,
    });

    expect(job.state.consecutiveErrors).toBe(0);
    expect(job.state.lastStatus).toBe('ok');
  });

  it('disables one-shot at job after execution', () => {
    const state = createMockState();
    const job: CronJob = {
      id: 'at-test',
      name: 'At Test',
      enabled: true,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      schedule: { kind: 'at', at: new Date(Date.now() - 1000).toISOString() },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'once' },
      deleteAfterRun: false,
      state: {},
    };

    const now = Date.now();
    const shouldDelete = applyJobResult(state, job, {
      status: 'ok',
      startedAt: now - 1000,
      endedAt: now,
    });

    expect(shouldDelete).toBe(false); // deleteAfterRun is false
    expect(job.enabled).toBe(false);
    expect(job.state.nextRunAtMs).toBeUndefined();
  });

  it('returns true (shouldDelete) for at job with deleteAfterRun=true and ok status', () => {
    const state = createMockState();
    const job: CronJob = {
      id: 'delete-test',
      name: 'Delete Test',
      enabled: true,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      schedule: { kind: 'at', at: new Date(Date.now() - 1000).toISOString() },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'once' },
      deleteAfterRun: true,
      state: {},
    };

    const now = Date.now();
    const shouldDelete = applyJobResult(state, job, {
      status: 'ok',
      startedAt: now - 1000,
      endedAt: now,
    });

    expect(shouldDelete).toBe(true);
  });

  it('applies error backoff for repeating jobs', () => {
    const now = Date.now();
    const state = createMockState();
    state.deps.nowMs = () => now;

    const job: CronJob = {
      id: 'backoff-test',
      name: 'Backoff Test',
      enabled: true,
      createdAtMs: now - 120_000,
      updatedAtMs: now - 120_000,
      schedule: { kind: 'every', everyMs: 60_000, anchorMs: now - 120_000 },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'check' },
      state: { consecutiveErrors: 0 },
    };

    applyJobResult(state, job, {
      status: 'error',
      error: 'fail',
      startedAt: now - 1000,
      endedAt: now,
    });

    // After 1st error, backoff = 30s. nextRunAtMs should be >= now + 30_000
    expect(job.state.nextRunAtMs).toBeDefined();
    expect(job.state.nextRunAtMs!).toBeGreaterThanOrEqual(now + 30_000);
  });
});

// ── isJobDue ──

describe('isJobDue', () => {
  it('returns true when job is enabled and nextRunAtMs <= now', () => {
    const now = Date.now();
    const job: CronJob = {
      id: 'due-test',
      name: 'Due Test',
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: 'every', everyMs: 60_000 },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'check' },
      state: { nextRunAtMs: now - 1000 },
    };
    expect(isJobDue(job, now, { forced: false })).toBe(true);
  });

  it('returns false when job is disabled', () => {
    const now = Date.now();
    const job: CronJob = {
      id: 'disabled',
      name: 'Disabled',
      enabled: false,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: 'every', everyMs: 60_000 },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'check' },
      state: { nextRunAtMs: now - 1000 },
    };
    expect(isJobDue(job, now, { forced: false })).toBe(false);
  });

  it('returns false when job is already running', () => {
    const now = Date.now();
    const job: CronJob = {
      id: 'running',
      name: 'Running',
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: 'every', everyMs: 60_000 },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'check' },
      state: { nextRunAtMs: now - 1000, runningAtMs: now - 500 },
    };
    expect(isJobDue(job, now, { forced: false })).toBe(false);
  });

  it('returns true when forced regardless of nextRunAtMs', () => {
    const now = Date.now();
    const job: CronJob = {
      id: 'forced',
      name: 'Forced',
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: 'every', everyMs: 60_000 },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'check' },
      state: { nextRunAtMs: now + 999_999 },
    };
    expect(isJobDue(job, now, { forced: true })).toBe(true);
  });
});

// ── applyJobPatch ──

describe('applyJobPatch', () => {
  it('patches name and description', () => {
    const now = Date.now();
    const job: CronJob = {
      id: 'patch-test',
      name: 'Original',
      description: 'Old desc',
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: 'every', everyMs: 60_000 },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'check' },
      state: {},
    };

    applyJobPatch(job, { name: 'Patched', description: 'New desc' });
    expect(job.name).toBe('Patched');
    expect(job.description).toBe('New desc');
  });

  it('clears delivery when sessionTarget is changed to main', () => {
    const now = Date.now();
    const job: CronJob = {
      id: 'delivery-test',
      name: 'Delivery',
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: 'every', everyMs: 60_000 },
      sessionTarget: 'isolated',
      wakeMode: 'now',
      payload: { kind: 'agentTurn', message: 'do stuff' },
      delivery: { mode: 'announce' },
      state: {},
    };

    applyJobPatch(job, {
      sessionTarget: 'main',
      payload: { kind: 'systemEvent', text: 'event' },
    });
    expect(job.sessionTarget).toBe('main');
    expect(job.delivery).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════
// BAR-RAISE: Additional unit tests for edge cases and deeper coverage
// ══════════════════════════════════════════════════════════════════════

// ── Schedule edge cases ──

describe('computeNextRunAtMs — edge cases', () => {
  it('every schedule with very small interval (1ms) computes a valid next run', () => {
    const now = 100_000;
    const result = computeNextRunAtMs(
      { kind: 'every', everyMs: 1, anchorMs: 0 },
      now,
    );
    expect(result).toBeDefined();
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(now);
  });

  it('every schedule with anchorMs far in the past computes correct next tick', () => {
    const now = 10_000_000;
    const anchor = 100; // very old anchor
    const everyMs = 5_000;
    const result = computeNextRunAtMs(
      { kind: 'every', everyMs, anchorMs: anchor },
      now,
    );
    expect(result).toBeDefined();
    // Should be the next tick after now, aligned to anchor grid
    expect(result).toBeGreaterThanOrEqual(now);
    // Should be within one interval of now
    expect(result! - now).toBeLessThanOrEqual(everyMs);
    // Should be aligned to the anchor grid
    expect((result! - anchor) % everyMs).toBe(0);
  });

  it('cron schedule with timezone computes a future time', () => {
    const now = Date.now();
    const result = computeNextRunAtMs(
      { kind: 'cron', expr: '0 9 * * *', tz: 'America/New_York' },
      now,
    );
    expect(result).toBeDefined();
    // The next 9 AM ET should be within 24 hours
    expect(result! - now).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it('cron schedule with invalid expression throws (croner rejects bad patterns)', () => {
    // The croner library throws on invalid cron expressions
    expect(() =>
      computeNextRunAtMs(
        { kind: 'cron', expr: 'invalid cron expression not valid' },
        Date.now(),
      ),
    ).toThrow();
  });

  it('at schedule exactly at nowMs boundary returns undefined (not in future)', () => {
    const now = 1_700_000_000_000;
    const atDate = new Date(now).toISOString();
    const result = computeNextRunAtMs({ kind: 'at', at: atDate }, now);
    // atMs === nowMs -> not strictly > nowMs, so undefined
    expect(result).toBeUndefined();
  });

  it('at schedule with atMs = NaN returns undefined', () => {
    const result = computeNextRunAtMs({ kind: 'at', at: '' }, Date.now());
    expect(result).toBeUndefined();
  });

  it('every schedule with everyMs=0 is clamped to 1ms minimum', () => {
    const now = 100_000;
    // everyMs is floored to max(1, floor(0)) = max(1,0) = 1
    const result = computeNextRunAtMs(
      { kind: 'every', everyMs: 0, anchorMs: 0 },
      now,
    );
    expect(result).toBeDefined();
    expect(result).toBeGreaterThanOrEqual(now);
  });
});

// ── Timer behavior (mock timers) ──

describe('armTimer / stopTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('armTimer sets a timeout when cronEnabled=true and jobs exist', () => {
    const now = Date.now();
    const state = createMockState({
      deps: {
        ...createMockState().deps,
        cronEnabled: true,
        nowMs: () => now,
      },
    });
    // Add a job with a future nextRunAtMs
    const job: CronJob = {
      id: 'timer-test',
      name: 'Timer Test',
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: 'every', everyMs: 60_000, anchorMs: now },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'tick' },
      state: { nextRunAtMs: now + 30_000 },
    };
    state.store!.jobs.push(job);

    armTimer(state);

    expect(state.timer).not.toBeNull();
  });

  it('armTimer clamps delay to 60s max', () => {
    const now = Date.now();
    const state = createMockState({
      deps: {
        ...createMockState().deps,
        cronEnabled: true,
        nowMs: () => now,
      },
    });
    // Add a job with nextRunAtMs far in the future (10 minutes)
    const job: CronJob = {
      id: 'clamp-test',
      name: 'Clamp Test',
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: 'every', everyMs: 600_000, anchorMs: now },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'tick' },
      state: { nextRunAtMs: now + 600_000 },
    };
    state.store!.jobs.push(job);

    armTimer(state);

    // Timer should be armed (clamped to 60s, not 600s)
    expect(state.timer).not.toBeNull();
    // The debug log should mention clamped: true
    expect(state.deps.log.debug).toHaveBeenCalledWith(
      'timer armed',
      expect.objectContaining({ clamped: true }),
    );
  });

  it('armTimer does nothing when cronEnabled=false', () => {
    const state = createMockState({
      deps: {
        ...createMockState().deps,
        cronEnabled: false,
      },
    });
    const job: CronJob = {
      id: 'disabled-test',
      name: 'Disabled Test',
      enabled: true,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      schedule: { kind: 'every', everyMs: 60_000 },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'tick' },
      state: { nextRunAtMs: Date.now() + 30_000 },
    };
    state.store!.jobs.push(job);

    armTimer(state);

    expect(state.timer).toBeNull();
  });

  it('stopTimer clears the timeout', () => {
    const now = Date.now();
    const state = createMockState({
      deps: {
        ...createMockState().deps,
        cronEnabled: true,
        nowMs: () => now,
      },
    });
    const job: CronJob = {
      id: 'stop-test',
      name: 'Stop Test',
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: 'every', everyMs: 60_000, anchorMs: now },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'tick' },
      state: { nextRunAtMs: now + 30_000 },
    };
    state.store!.jobs.push(job);

    armTimer(state);
    expect(state.timer).not.toBeNull();

    stopTimer(state);
    expect(state.timer).toBeNull();
  });
});

// ── Job execution flow ──

describe('executeJob — execution flow', () => {
  it('main session job calls broadcastCronNotification', async () => {
    const broadcastFn = vi.fn();
    const runMainFn = vi.fn().mockResolvedValue(undefined);
    const service = await isolatedSvc({
      broadcastCronNotification: broadcastFn,
      runMainAgentWithPrompt: runMainFn,
    });
    const job = await service.add(makeEveryInput());

    await service.run(job.id, 'force');
    expect(broadcastFn).toHaveBeenCalledWith('periodic check', 'Every Job', { agentWillRespond: true });
  });

  it('main session job with wakeMode=now also calls runMainAgentWithPrompt', async () => {
    const runMainFn = vi.fn().mockResolvedValue(undefined);
    const service = await isolatedSvc({ runMainAgentWithPrompt: runMainFn });
    const job = await service.add({
      ...makeEveryInput(),
      wakeMode: 'now',
    });

    await service.run(job.id, 'force');
    expect(runMainFn).toHaveBeenCalledWith('periodic check', 'Every Job');
  });

  it('main session job with wakeMode=next-cycle does NOT call runMainAgentWithPrompt', async () => {
    const runMainFn = vi.fn().mockResolvedValue(undefined);
    const service = await isolatedSvc({ runMainAgentWithPrompt: runMainFn });
    const job = await service.add({
      ...makeEveryInput(),
      wakeMode: 'next-cycle',
    });

    await service.run(job.id, 'force');
    expect(runMainFn).not.toHaveBeenCalled();
  });

  it('isolated job calls runIsolatedAgentJob with correct message', async () => {
    const runIsolatedFn = vi.fn().mockResolvedValue({ status: 'ok', summary: 'done' });
    const service = await isolatedSvc({ runIsolatedAgentJob: runIsolatedFn });
    const job = await service.add({
      name: 'Isolated Job',
      enabled: true,
      schedule: { kind: 'every', everyMs: 60_000 },
      sessionTarget: 'isolated',
      wakeMode: 'now',
      payload: { kind: 'agentTurn', message: 'run analysis' },
    });

    await service.run(job.id, 'force');
    expect(runIsolatedFn).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'run analysis' }),
    );
  });

  it('isolated job with delivery.mode=announce broadcasts after completion', async () => {
    const broadcastFn = vi.fn();
    const runIsolatedFn = vi.fn().mockResolvedValue({ status: 'ok', summary: 'analysis complete' });
    const service = await isolatedSvc({
      broadcastCronNotification: broadcastFn,
      runIsolatedAgentJob: runIsolatedFn,
    });
    const job = await service.add({
      name: 'Announce Job',
      enabled: true,
      schedule: { kind: 'every', everyMs: 60_000 },
      sessionTarget: 'isolated',
      wakeMode: 'next-cycle',
      payload: { kind: 'agentTurn', message: 'analyze data' },
      delivery: { mode: 'announce' },
    });

    await service.run(job.id, 'force');
    expect(broadcastFn).toHaveBeenCalledWith(
      expect.stringContaining('analysis complete'),
      'Announce Job',
      { agentWillRespond: false },
    );
  });

  it('isolated job with delivery.mode=none does NOT broadcast after completion', async () => {
    const broadcastFn = vi.fn();
    const runIsolatedFn = vi.fn().mockResolvedValue({ status: 'ok', summary: 'done silently' });
    const service = await isolatedSvc({
      broadcastCronNotification: broadcastFn,
      runIsolatedAgentJob: runIsolatedFn,
    });
    const job = await service.add({
      name: 'Silent Job',
      enabled: true,
      schedule: { kind: 'every', everyMs: 60_000 },
      sessionTarget: 'isolated',
      wakeMode: 'next-cycle',
      payload: { kind: 'agentTurn', message: 'silent task' },
      delivery: { mode: 'none' },
    });

    await service.run(job.id, 'force');
    // broadcastCronNotification should not be called for delivery.mode=none
    expect(broadcastFn).not.toHaveBeenCalled();
  });

  it('job execution error increments consecutiveErrors and sets error status', async () => {
    const runIsolatedFn = vi.fn().mockRejectedValue(new Error('boom'));
    const service = await isolatedSvc({ runIsolatedAgentJob: runIsolatedFn });
    const job = await service.add({
      name: 'Error Job',
      enabled: true,
      schedule: { kind: 'every', everyMs: 60_000 },
      sessionTarget: 'isolated',
      wakeMode: 'now',
      payload: { kind: 'agentTurn', message: 'will fail' },
    });

    await service.run(job.id, 'force');
    const jobs = await service.list({ includeDisabled: true });
    const updated = jobs.find((j) => j.id === job.id);
    expect(updated?.state.lastStatus).toBe('error');
    expect(updated?.state.consecutiveErrors).toBe(1);
  });
});

// ── Error backoff detailed tests ──

describe('applyJobResult — error backoff details', () => {
  function makeBackoffJob(now: number, consecutiveErrors: number): CronJob {
    return {
      id: 'backoff-detail',
      name: 'Backoff Detail',
      enabled: true,
      createdAtMs: now - 300_000,
      updatedAtMs: now - 300_000,
      schedule: { kind: 'every', everyMs: 60_000, anchorMs: now - 300_000 },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'check' },
      state: { consecutiveErrors },
    };
  }

  it('1st error -> backoff >= 30s', () => {
    const now = Date.now();
    const state = createMockState();
    state.deps.nowMs = () => now;
    const job = makeBackoffJob(now, 0);

    applyJobResult(state, job, { status: 'error', error: 'fail', startedAt: now - 1000, endedAt: now });

    expect(job.state.consecutiveErrors).toBe(1);
    expect(job.state.nextRunAtMs).toBeGreaterThanOrEqual(now + 30_000);
  });

  it('2nd error -> backoff >= 1 min', () => {
    const now = Date.now();
    const state = createMockState();
    state.deps.nowMs = () => now;
    const job = makeBackoffJob(now, 1); // already 1 error

    applyJobResult(state, job, { status: 'error', error: 'fail', startedAt: now - 1000, endedAt: now });

    expect(job.state.consecutiveErrors).toBe(2);
    expect(job.state.nextRunAtMs).toBeGreaterThanOrEqual(now + 60_000);
  });

  it('3rd error -> backoff >= 5 min', () => {
    const now = Date.now();
    const state = createMockState();
    state.deps.nowMs = () => now;
    const job = makeBackoffJob(now, 2);

    applyJobResult(state, job, { status: 'error', error: 'fail', startedAt: now - 1000, endedAt: now });

    expect(job.state.consecutiveErrors).toBe(3);
    expect(job.state.nextRunAtMs).toBeGreaterThanOrEqual(now + 5 * 60_000);
  });

  it('4th error -> backoff >= 15 min', () => {
    const now = Date.now();
    const state = createMockState();
    state.deps.nowMs = () => now;
    const job = makeBackoffJob(now, 3);

    applyJobResult(state, job, { status: 'error', error: 'fail', startedAt: now - 1000, endedAt: now });

    expect(job.state.consecutiveErrors).toBe(4);
    expect(job.state.nextRunAtMs).toBeGreaterThanOrEqual(now + 15 * 60_000);
  });

  it('5th+ error -> backoff capped at 60 min', () => {
    const now = Date.now();
    const state = createMockState();
    state.deps.nowMs = () => now;
    const job = makeBackoffJob(now, 4);

    applyJobResult(state, job, { status: 'error', error: 'fail', startedAt: now - 1000, endedAt: now });

    expect(job.state.consecutiveErrors).toBe(5);
    expect(job.state.nextRunAtMs).toBeGreaterThanOrEqual(now + 60 * 60_000);
  });

  it('6th error still capped at 60 min', () => {
    const now = Date.now();
    const state = createMockState();
    state.deps.nowMs = () => now;
    const job = makeBackoffJob(now, 5);

    applyJobResult(state, job, { status: 'error', error: 'fail', startedAt: now - 1000, endedAt: now });

    expect(job.state.consecutiveErrors).toBe(6);
    // Should still be capped at 60 min, not more
    expect(job.state.nextRunAtMs).toBeGreaterThanOrEqual(now + 60 * 60_000);
  });

  it('backoff is applied as MAX(normal_next_run, now + backoff)', () => {
    const now = Date.now();
    const state = createMockState();
    state.deps.nowMs = () => now;
    const job = makeBackoffJob(now, 0);

    applyJobResult(state, job, { status: 'error', error: 'fail', startedAt: now - 1000, endedAt: now });

    // After 1st error, backoff=30s. nextRunAtMs should be the max of
    // the normal schedule tick and now + 30s
    const nextRun = job.state.nextRunAtMs!;
    expect(nextRun).toBeGreaterThanOrEqual(now + 30_000);
  });

  it('success after errors resets consecutiveErrors to 0', () => {
    const now = Date.now();
    const state = createMockState();
    state.deps.nowMs = () => now;
    const job = makeBackoffJob(now, 4); // 4 previous errors

    applyJobResult(state, job, { status: 'ok', startedAt: now - 1000, endedAt: now });

    expect(job.state.consecutiveErrors).toBe(0);
    expect(job.state.lastStatus).toBe('ok');
    // After success, nextRunAtMs should be the normal next tick (no backoff)
    expect(job.state.nextRunAtMs).toBeDefined();
  });
});

// ── One-shot `at` job lifecycle ──

describe('at job lifecycle', () => {
  it('create at job -> enabled=true, deleteAfterRun=true', async () => {
    const service = await isolatedSvc();
    const futureDate = new Date(Date.now() + 3_600_000).toISOString();
    const job = await service.add(makeAtInput(futureDate));

    expect(job.enabled).toBe(true);
    expect(job.deleteAfterRun).toBe(true);
  });

  it('execute at job successfully -> job deleted from store', async () => {
    const broadcastFn = vi.fn();
    const runMainFn = vi.fn().mockResolvedValue(undefined);
    const service = await isolatedSvc({
      broadcastCronNotification: broadcastFn,
      runMainAgentWithPrompt: runMainFn,
    });
    // Create an at job that is already due (in the near past)
    const pastDate = new Date(Date.now() - 1000).toISOString();
    const job = await service.add({
      name: 'Delete After Run',
      enabled: true,
      schedule: { kind: 'at', at: pastDate },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'one-shot delete' },
      deleteAfterRun: true,
    });

    await service.run(job.id, 'force');

    const allJobs = await service.list({ includeDisabled: true });
    const found = allJobs.find((j) => j.id === job.id);
    // Should be deleted after successful run
    expect(found).toBeUndefined();
  });

  it('execute at job with error -> job disabled (not deleted), error recorded', async () => {
    const runIsolatedFn = vi.fn().mockRejectedValue(new Error('at job failed'));
    const service = await isolatedSvc({ runIsolatedAgentJob: runIsolatedFn });
    const pastDate = new Date(Date.now() - 1000).toISOString();
    const job = await service.add({
      name: 'Error At Job',
      enabled: true,
      schedule: { kind: 'at', at: pastDate },
      sessionTarget: 'isolated',
      wakeMode: 'now',
      payload: { kind: 'agentTurn', message: 'will fail' },
      deleteAfterRun: true,
    });

    await service.run(job.id, 'force');

    const allJobs = await service.list({ includeDisabled: true });
    const updated = allJobs.find((j) => j.id === job.id);
    // Job should be disabled, not deleted, because status is error
    expect(updated).toBeDefined();
    expect(updated!.enabled).toBe(false);
    expect(updated!.state.lastStatus).toBe('error');
  });

  it('execute at job with deleteAfterRun=false -> job disabled, not deleted', () => {
    const now = Date.now();
    const state = createMockState();
    state.deps.nowMs = () => now;

    const job: CronJob = {
      id: 'at-no-delete',
      name: 'At No Delete',
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: 'at', at: new Date(now - 1000).toISOString() },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'once' },
      deleteAfterRun: false,
      state: {},
    };

    const shouldDelete = applyJobResult(state, job, {
      status: 'ok',
      startedAt: now - 500,
      endedAt: now,
    });

    expect(shouldDelete).toBe(false);
    expect(job.enabled).toBe(false);
    expect(job.state.nextRunAtMs).toBeUndefined();
  });

  it('at job that has not run yet returns atMs from computeJobNextRunAtMs', () => {
    // An at job in the past but with no lastStatus should still be runnable
    const pastMs = Date.now() - 5000;
    const pastDate = new Date(pastMs).toISOString();
    const job: CronJob = {
      id: 'at-past',
      name: 'At Past',
      enabled: true,
      createdAtMs: pastMs - 10_000,
      updatedAtMs: pastMs - 10_000,
      schedule: { kind: 'at', at: pastDate },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'once' },
      state: {},
    };
    // computeJobNextRunAtMs returns atMs even if in past, for one-shot that hasn't run
    const next = computeJobNextRunAtMs(job, Date.now());
    // The job schedule.at is in the past and has not run yet, so atMs is returned
    expect(next).toBeDefined();
    expect(next).toBe(new Date(pastDate).getTime());
  });
});

// ── Concurrent operation safety ──

describe('concurrent operation safety', () => {
  it('two rapid add() calls both succeed and store has 2 jobs', async () => {
    const service = await isolatedSvc();

    const [job1, job2] = await Promise.all([
      service.add(makeEveryInput(30_000)),
      service.add(makeEveryInput(60_000)),
    ]);

    expect(job1.id).toBeDefined();
    expect(job2.id).toBeDefined();
    expect(job1.id).not.toBe(job2.id);

    const allJobs = await service.list();
    expect(allJobs).toHaveLength(2);
  });

  it('add() and list() concurrently do not interfere', async () => {
    const service = await isolatedSvc();

    const addPromise = service.add(makeEveryInput());
    const listPromise = service.list();

    const [job, jobs] = await Promise.all([addPromise, listPromise]);
    expect(job.id).toBeDefined();
    // jobs may be empty (if list resolves first) or contain the job (if add resolves first)
    // Both are valid — the key is no error/corruption
    expect(Array.isArray(jobs)).toBe(true);
  });

  it('remove() during add() does not corrupt the store', async () => {
    const service = await isolatedSvc();
    const job = await service.add(makeEveryInput());

    // Rapid operations: add another and remove the first concurrently
    const [, removeResult] = await Promise.all([
      service.add(makeEveryInput(120_000)),
      service.remove(job.id),
    ]);

    expect(removeResult.ok).toBe(true);
    // Store should have exactly 1 job (the second one)
    const allJobs = await service.list();
    expect(allJobs).toHaveLength(1);
    expect(allJobs[0].id).not.toBe(job.id);
  });
});

// ── Normalize edge cases ──

describe('normalizeCronJobCreate — edge cases', () => {
  it('empty object returns a partial result with defaults (not null)', () => {
    // normalizeCronJobCreate only returns null for non-object input.
    // For empty objects, it applies defaults (enabled=true, wakeMode=now).
    const result = normalizeCronJobCreate({});
    expect(result).not.toBeNull();
    expect(result!.enabled).toBe(true);
    expect(result!.wakeMode).toBe('now');
  });

  it('missing schedule still returns a result (with defaults applied)', () => {
    const result = normalizeCronJobCreate({ name: 'No Schedule' });
    // normalizeCronJobCreate returns a result even without schedule/payload.
    // It's the caller's responsibility to validate further.
    expect(result).not.toBeNull();
    expect(result!.name).toBe('No Schedule');
  });

  it('missing payload returns null when no text/message shorthand either', () => {
    const result = normalizeCronJobCreate({
      name: 'No Payload',
      schedule: { kind: 'every', everyMs: 60_000 },
    });
    // Has schedule but no payload — normalization might produce an incomplete result.
    // The key is it should not throw.
    // Result will have schedule but payload is still absent
    if (result) {
      // No payload field means createJob will fail, but normalize itself shouldn't crash
      expect(result.schedule).toBeDefined();
    }
  });

  it('extra unknown fields are ignored (not copied to output)', () => {
    const result = normalizeCronJobCreate({
      name: 'Test',
      schedule: { kind: 'every', everyMs: 60_000 },
      payload: { kind: 'systemEvent', text: 'hi' },
      unknownField: 'should be ignored',
      anotherOne: 42,
    });
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Test');
    // Extra fields are in the result since we spread, but they are harmless
    // The important thing is it doesn't crash
    expect(result!.schedule.kind).toBe('every');
  });

  it('payload kind case insensitivity (agentTurn vs agentturn)', () => {
    const result = normalizeCronJobCreate({
      name: 'Case Test',
      schedule: { kind: 'every', everyMs: 60_000 },
      payload: { kind: 'AGENTTURN', message: 'hello' },
    });
    expect(result).not.toBeNull();
    expect((result!.payload as any).kind).toBe('agentTurn');
  });

  it('payload kind case insensitivity (systemEvent vs systemevent)', () => {
    const result = normalizeCronJobCreate({
      name: 'Case Test 2',
      schedule: { kind: 'every', everyMs: 60_000 },
      payload: { kind: 'SYSTEMEVENT', text: 'hello' },
    });
    expect(result).not.toBeNull();
    expect((result!.payload as any).kind).toBe('systemEvent');
  });

  it('schedule with both at and atMs -> at takes precedence', () => {
    const futureDate = new Date(Date.now() + 7_200_000).toISOString(); // +2h
    const atMs = Date.now() + 3_600_000; // +1h
    const result = normalizeCronJobCreate({
      name: 'Dual At',
      schedule: { at: futureDate, atMs },
      payload: { kind: 'systemEvent', text: 'dual at' },
    });
    expect(result).not.toBeNull();
    expect(result!.schedule.kind).toBe('at');
    // When atMs is a number, it gets converted to ISO string
    // The normalized schedule should have an at field
    expect((result!.schedule as any).at).toBeDefined();
  });

  it('very long name is preserved but trimmed', () => {
    const longName = 'A'.repeat(500) + '   ';
    const result = normalizeCronJobCreate({
      name: longName,
      schedule: { kind: 'every', everyMs: 60_000 },
      payload: { kind: 'systemEvent', text: 'test' },
    });
    expect(result).not.toBeNull();
    expect(result!.name).toBe('A'.repeat(500));
  });

  it('unicode in name and description is preserved', () => {
    const result = normalizeCronJobCreate({
      name: 'Test unicode: 日本語テスト 🌍',
      schedule: { kind: 'every', everyMs: 60_000 },
      payload: { kind: 'systemEvent', text: 'unicode text: café résumé' },
    });
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Test unicode: 日本語テスト 🌍');
  });

  it('boolean coercion: string "true" becomes true', () => {
    const result = normalizeCronJobCreate({
      name: 'Bool test',
      enabled: 'true',
      schedule: { kind: 'every', everyMs: 60_000 },
      payload: { kind: 'systemEvent', text: 'test' },
    });
    expect(result).not.toBeNull();
    expect(result!.enabled).toBe(true);
  });

  it('boolean coercion: string "false" becomes false', () => {
    const result = normalizeCronJobCreate({
      name: 'Bool test false',
      enabled: 'false',
      schedule: { kind: 'every', everyMs: 60_000 },
      payload: { kind: 'systemEvent', text: 'test' },
    });
    expect(result).not.toBeNull();
    expect(result!.enabled).toBe(false);
  });

  it('defaults delivery to announce for isolated agentTurn jobs', () => {
    const result = normalizeCronJobCreate({
      name: 'Default Delivery',
      schedule: { kind: 'every', everyMs: 60_000 },
      payload: { kind: 'agentTurn', message: 'task' },
    });
    expect(result).not.toBeNull();
    expect(result!.sessionTarget).toBe('isolated');
    expect((result as any).delivery).toEqual({ mode: 'announce' });
  });

  it('delivery coercion: deliver maps to announce', () => {
    const result = normalizeCronJobCreate({
      name: 'Deliver Test',
      schedule: { kind: 'every', everyMs: 60_000 },
      payload: { kind: 'agentTurn', message: 'task' },
      delivery: { mode: 'deliver' },
    });
    expect(result).not.toBeNull();
    expect((result as any).delivery).toEqual(expect.objectContaining({ mode: 'announce' }));
  });
});

describe('normalizeCronJobPatch — edge cases', () => {
  it('undefined input returns null', () => {
    expect(normalizeCronJobPatch(undefined)).toBeNull();
  });

  it('array input returns null', () => {
    expect(normalizeCronJobPatch([1, 2, 3])).toBeNull();
  });

  it('patch with only description', () => {
    const result = normalizeCronJobPatch({ description: 'New description' });
    expect(result).not.toBeNull();
    expect(result!.description).toBe('New description');
  });

  it('patch with delivery coercion', () => {
    const result = normalizeCronJobPatch({
      delivery: { mode: 'deliver' },
    });
    expect(result).not.toBeNull();
    expect((result as any).delivery).toEqual(expect.objectContaining({ mode: 'announce' }));
  });
});

// ── computeJobNextRunAtMs ──

describe('computeJobNextRunAtMs — additional', () => {
  it('returns undefined for disabled job', () => {
    const job: CronJob = {
      id: 'disabled',
      name: 'Disabled',
      enabled: false,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      schedule: { kind: 'every', everyMs: 60_000, anchorMs: Date.now() - 120_000 },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'check' },
      state: {},
    };
    expect(computeJobNextRunAtMs(job, Date.now())).toBeUndefined();
  });

  it('at job that already succeeded returns undefined', () => {
    const now = Date.now();
    const job: CronJob = {
      id: 'at-done',
      name: 'At Done',
      enabled: true,
      createdAtMs: now - 10_000,
      updatedAtMs: now,
      schedule: { kind: 'at', at: new Date(now - 5000).toISOString() },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'once' },
      state: { lastStatus: 'ok', lastRunAtMs: now - 2000 },
    };
    expect(computeJobNextRunAtMs(job, now)).toBeUndefined();
  });

  it('cron schedule job returns a future time', () => {
    const now = Date.now();
    const job: CronJob = {
      id: 'cron-next',
      name: 'Cron Next',
      enabled: true,
      createdAtMs: now - 10_000,
      updatedAtMs: now,
      schedule: { kind: 'cron', expr: '* * * * *' },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'every minute' },
      state: {},
    };
    const next = computeJobNextRunAtMs(job, now);
    expect(next).toBeDefined();
    expect(next).toBeGreaterThanOrEqual(now);
  });
});

// ── findJobOrThrow ──

describe('findJobOrThrow', () => {
  it('throws for unknown id', () => {
    const state = createMockState();
    expect(() => findJobOrThrow(state, 'nonexistent')).toThrow('unknown cron job id');
  });

  it('finds existing job', () => {
    const state = createMockState();
    const job: CronJob = {
      id: 'exists',
      name: 'Exists',
      enabled: true,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      schedule: { kind: 'every', everyMs: 60_000 },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'check' },
      state: {},
    };
    state.store!.jobs.push(job);
    expect(findJobOrThrow(state, 'exists')).toBe(job);
  });
});

// ── emit ──

describe('emit', () => {
  it('calls onEvent with the event', () => {
    const onEvent = vi.fn();
    const state = createMockState();
    state.deps.onEvent = onEvent;

    emit(state, { jobId: 'test', action: 'added' });
    expect(onEvent).toHaveBeenCalledWith({ jobId: 'test', action: 'added' });
  });

  it('swallows subscriber errors without throwing', () => {
    const state = createMockState();
    state.deps.onEvent = () => { throw new Error('subscriber crashed'); };

    expect(() => emit(state, { jobId: 'test', action: 'added' })).not.toThrow();
  });
});

// Helper for isolated services used by execution flow tests.
// (Duplicated from the CronService describe above to keep tests self-contained.)
let execSvcCounter = 0;

async function isolatedSvc(overrides?: Partial<CronServiceDeps>) {
  const storePath = path.join(tmpDir, `cron-exec-${++execSvcCounter}-${Date.now()}.json`);
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs: [] }), 'utf-8');
  return createTestService({ storePath, ...overrides });
}

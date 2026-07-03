/**
 * Routines layer unit tests: executor registry, executor-compat sync,
 * store v1→v2 migration, normalize executor support, and timer dispatch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  registerExecutor,
  getExecutor,
  listExecutors,
  clearExecutors,
  runExecutor,
} from '../../src/core/routines/registry.js';
import { createMainAgentExecutor } from '../../src/core/routines/executors/main-agent.js';
import { createWalnutAgentExecutor } from '../../src/core/routines/executors/walnut-agent.js';
import { createClaudeCodeExecutor } from '../../src/core/routines/executors/claude-code.js';
import {
  deriveExecutorFromLegacy,
  deriveLegacyFromExecutor,
  syncExecutorFields,
} from '../../src/core/cron/executor-compat.js';
import { normalizeCronJobCreate } from '../../src/core/cron/normalize.js';
import { CronService } from '../../src/core/cron/service.js';
import type { CronServiceDeps, CronJob } from '../../src/core/cron/types.js';

let tmpDir: string;

function createMockLog() {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(),
  } as any;
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

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-routines-test-'));
  clearExecutors();
});

afterEach(async () => {
  clearExecutors();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Registry ──

describe('executor registry', () => {
  it('registers and lists executors', () => {
    registerExecutor(createMainAgentExecutor({
      broadcastCronNotification: vi.fn(),
      runMainAgentWithPrompt: vi.fn(),
    }));
    registerExecutor(createWalnutAgentExecutor({ runIsolatedAgentJob: vi.fn() }));
    registerExecutor(createClaudeCodeExecutor());

    expect(listExecutors().map((e) => e.type).sort()).toEqual([
      'claude-code', 'main-agent', 'walnut-agent',
    ]);
    expect(getExecutor('claude-code')?.label).toBe('Claude Code');
  });

  it('runExecutor returns error for unknown type', async () => {
    const res = await runExecutor(
      { name: 'x' } as CronJob,
      { type: 'nope', config: {} },
      'msg',
    );
    expect(res.status).toBe('error');
    expect(res.error).toContain('unknown executor type');
  });

  it('runExecutor validates config before running', async () => {
    registerExecutor(createClaudeCodeExecutor());
    const res = await runExecutor(
      { name: 'x' } as CronJob,
      { type: 'claude-code', config: { instructions: 'do stuff' } }, // missing cwd
      'do stuff',
    );
    expect(res.status).toBe('error');
    expect(res.error).toContain('cwd');
  });
});

// ── Executor validation ──

describe('executor validate()', () => {
  it('claude-code requires instructions and cwd', () => {
    const def = createClaudeCodeExecutor();
    expect(def.validate({}).ok).toBe(false);
    expect(def.validate({ instructions: 'x' }).ok).toBe(false);
    expect(def.validate({ instructions: 'x', cwd: '/tmp' }).ok).toBe(true);
  });

  it('claude-code drops __local__ host sentinel', () => {
    const def = createClaudeCodeExecutor();
    const res = def.validate({ instructions: 'x', cwd: '/tmp', host: '__local__' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.config.host).toBeUndefined();
  });

  it('main-agent requires instructions', () => {
    const def = createMainAgentExecutor({
      broadcastCronNotification: vi.fn(),
      runMainAgentWithPrompt: vi.fn(),
    });
    expect(def.validate({ instructions: '  ' }).ok).toBe(false);
    expect(def.validate({ instructions: 'hello' }).ok).toBe(true);
  });
});

// ── Legacy ↔ executor compat ──

describe('executor-compat', () => {
  it('derives main-agent from main/systemEvent', () => {
    const ex = deriveExecutorFromLegacy({
      sessionTarget: 'main',
      payload: { kind: 'systemEvent', text: 'ping' },
    });
    expect(ex).toEqual({ type: 'main-agent', config: { instructions: 'ping' } });
  });

  it('derives walnut-agent from isolated/agentTurn with timeout', () => {
    const ex = deriveExecutorFromLegacy({
      sessionTarget: 'isolated',
      payload: { kind: 'agentTurn', message: 'work', timeoutSeconds: 30 },
    });
    expect(ex.type).toBe('walnut-agent');
    expect(ex.config).toEqual({ instructions: 'work', timeoutSeconds: 30 });
  });

  it('derives legacy isolated/agentTurn from claude-code (safe degradation)', () => {
    const legacy = deriveLegacyFromExecutor({
      type: 'claude-code',
      config: { instructions: 'build it', cwd: '/repo' },
    });
    expect(legacy.sessionTarget).toBe('isolated');
    expect(legacy.payload).toEqual({ kind: 'agentTurn', message: 'build it' });
  });

  it('syncExecutorFields is idempotent', () => {
    const job = {
      sessionTarget: 'main',
      payload: { kind: 'systemEvent', text: 'hi' },
    } as CronJob;
    expect(syncExecutorFields(job)).toBe(true); // derived executor
    expect(job.executor?.type).toBe('main-agent');
    expect(syncExecutorFields(job)).toBe(false); // already consistent
  });
});

// ── Store migration v1 → v2 ──

describe('store v1→v2 migration', () => {
  it('migrates a v1 store file: adds executors, keeps legacy fields, bumps version', async () => {
    const storePath = path.join(tmpDir, 'cron-jobs.json');
    const v1 = {
      version: 1,
      jobs: [
        {
          id: 'job-main', name: 'Main Job', enabled: true,
          createdAtMs: 1, updatedAtMs: 1,
          schedule: { kind: 'every', everyMs: 60000 },
          sessionTarget: 'main', wakeMode: 'now',
          payload: { kind: 'systemEvent', text: 'sync-tasks' },
          state: {},
        },
        {
          id: 'job-iso', name: 'Iso Job', enabled: false,
          createdAtMs: 1, updatedAtMs: 1,
          schedule: { kind: 'cron', expr: '0 9 * * 1-5' },
          sessionTarget: 'isolated', wakeMode: 'next-cycle',
          payload: { kind: 'agentTurn', message: 'summarize PRs' },
          delivery: { mode: 'announce' },
          state: {},
        },
      ],
    };
    await fs.writeFile(storePath, JSON.stringify(v1));

    const service = createTestService({ storePath });
    const jobs = await service.list({ includeDisabled: true });

    const mainJob = jobs.find((j) => j.id === 'job-main')!;
    expect(mainJob.executor).toEqual({ type: 'main-agent', config: { instructions: 'sync-tasks' } });
    expect(mainJob.sessionTarget).toBe('main'); // legacy retained
    expect(mainJob.payload).toEqual({ kind: 'systemEvent', text: 'sync-tasks' });

    const isoJob = jobs.find((j) => j.id === 'job-iso')!;
    expect(isoJob.executor?.type).toBe('walnut-agent');
    expect(isoJob.executor?.config.instructions).toBe('summarize PRs');
    expect(isoJob.delivery).toEqual({ mode: 'announce' });

    // Persisted file bumped to v2
    const onDisk = JSON.parse(await fs.readFile(storePath, 'utf-8'));
    expect(onDisk.version).toBe(2);
    expect(onDisk.jobs).toHaveLength(2);
  });

  it('is idempotent: reloading a migrated store changes nothing', async () => {
    const storePath = path.join(tmpDir, 'cron-jobs.json');
    await fs.writeFile(storePath, JSON.stringify({
      version: 1,
      jobs: [{
        id: 'j1', name: 'J', enabled: true, createdAtMs: 1, updatedAtMs: 1,
        schedule: { kind: 'every', everyMs: 60000 },
        sessionTarget: 'main', wakeMode: 'now',
        payload: { kind: 'systemEvent', text: 'x' }, state: {},
      }],
    }));

    const s1 = createTestService({ storePath });
    await s1.list({ includeDisabled: true });
    const after1 = await fs.readFile(storePath, 'utf-8');

    const s2 = createTestService({ storePath });
    const jobs = await s2.list({ includeDisabled: true });
    const after2 = await fs.readFile(storePath, 'utf-8');

    expect(jobs[0].executor?.type).toBe('main-agent');
    // Byte-identical apart from state recompute noise — compare structurally
    expect(JSON.parse(after2).jobs[0].executor).toEqual(JSON.parse(after1).jobs[0].executor);
    expect(JSON.parse(after2).version).toBe(2);
  });
});

// ── Normalize executor input ──

describe('normalize with executor', () => {
  it('accepts executor-shaped create input without payload', () => {
    const input = normalizeCronJobCreate({
      name: 'CC Routine',
      schedule: { kind: 'cron', expr: '0 9 * * 1-5' },
      executor: { type: 'claude-code', config: { instructions: 'review PRs', cwd: '/repo', host: 'clouddev' } },
    });
    expect(input).not.toBeNull();
    expect(input!.executor).toEqual({
      type: 'claude-code',
      config: { instructions: 'review PRs', cwd: '/repo', host: 'clouddev' },
    });
  });

  it('legacy-shaped input still normalizes (no executor field)', () => {
    const input = normalizeCronJobCreate({
      name: 'Legacy',
      schedule: { kind: 'every', everyMs: 60000 },
      sessionTarget: 'main',
      payload: { kind: 'systemEvent', text: 'ping' },
    });
    expect(input).not.toBeNull();
    expect(input!.sessionTarget).toBe('main');
  });

  it('infers a name from executor instructions', () => {
    const input = normalizeCronJobCreate({
      schedule: { kind: 'every', everyMs: 60000 },
      executor: { type: 'walnut-agent', config: { instructions: 'daily summary of my inbox' } },
    });
    expect(input).not.toBeNull();
    expect(input!.name).toContain('daily summary');
  });
});

// ── Service-level: create + dispatch through executor ──

describe('service with executors', () => {
  it('creates a job from executor input and derives legacy fields', async () => {
    const service = createTestService();
    const input = normalizeCronJobCreate({
      name: 'CC',
      schedule: { kind: 'every', everyMs: 60000 },
      executor: { type: 'claude-code', config: { instructions: 'go', cwd: '/repo' } },
    })!;
    const job = await service.add(input);
    expect(job.executor?.type).toBe('claude-code');
    // Safe degradation mapping
    expect(job.sessionTarget).toBe('isolated');
    expect(job.payload).toEqual({ kind: 'agentTurn', message: 'go' });
  });

  it('dispatches non-legacy executor via runExecutor dep on run(force)', async () => {
    const runExecutorMock = vi.fn().mockResolvedValue({ status: 'ok', summary: 'session started' });
    const runIsolated = vi.fn().mockResolvedValue({ status: 'ok', summary: 'iso' });
    const service = createTestService({
      runExecutor: runExecutorMock,
      runIsolatedAgentJob: runIsolated,
    });
    const job = await service.add(normalizeCronJobCreate({
      name: 'CC', schedule: { kind: 'every', everyMs: 60000 },
      executor: { type: 'claude-code', config: { instructions: 'go', cwd: '/repo' } },
    })!);

    await service.run(job.id, 'force');

    expect(runExecutorMock).toHaveBeenCalledTimes(1);
    const [calledJob, calledExecutor, calledMessage] = runExecutorMock.mock.calls[0];
    expect(calledJob.id).toBe(job.id);
    expect(calledExecutor.type).toBe('claude-code');
    expect(calledMessage).toBe('go');
    // Legacy isolated path must NOT also fire
    expect(runIsolated).not.toHaveBeenCalled();
  });

  it('main-agent executor jobs still dispatch through the legacy main path', async () => {
    const runMain = vi.fn().mockResolvedValue(undefined);
    const broadcast = vi.fn().mockResolvedValue(undefined);
    const runExecutorMock = vi.fn();
    const service = createTestService({
      runMainAgentWithPrompt: runMain,
      broadcastCronNotification: broadcast,
      runExecutor: runExecutorMock,
    });
    const job = await service.add(normalizeCronJobCreate({
      name: 'Main', schedule: { kind: 'every', everyMs: 60000 }, wakeMode: 'now',
      executor: { type: 'main-agent', config: { instructions: 'ping me' } },
    })!);

    await service.run(job.id, 'force');

    expect(broadcast).toHaveBeenCalled();
    expect(runMain).toHaveBeenCalledWith('ping me', 'Main');
    expect(runExecutorMock).not.toHaveBeenCalled();
  });

  it('skips non-legacy executor job when runExecutor dep is missing', async () => {
    const service = createTestService(); // no runExecutor
    const job = await service.add(normalizeCronJobCreate({
      name: 'CC', schedule: { kind: 'every', everyMs: 60000 },
      executor: { type: 'claude-code', config: { instructions: 'go', cwd: '/repo' } },
    })!);
    await service.run(job.id, 'force');
    const [reloaded] = await service.list({ includeDisabled: true });
    expect(reloaded.state.lastStatus).toBe('skipped');
  });
});

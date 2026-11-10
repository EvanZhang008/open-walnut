/**
 * An init processor's `timeoutSeconds` bounds that ACTION, never the whole run, and Run now
 * says how a run that did not succeed ended.
 *
 * 2026-11-10 CI (tests/e2e/triage-run.test.ts): the Inbox Triage routine gives its batch action
 * 30 s, and the engine used those 30 s as the cap of the WHOLE run. The run's claude-code
 * executor then waited for room on its host (a routine start may wait up to ROUTINE_WAIT_MS,
 * a minute, while earlier runs hold the slots), the 30 s cap failed the run with "timed out",
 * the start went on with nobody waiting for it, and POST /api/routines/:id/run still answered
 * `{ ok: true, ran: true }`. These rules keep every member of that class out:
 *  - a wait the executor owns always fits inside the run's cap, whatever the action's timeout;
 *  - an executor slower than the action's timeout still finishes the run;
 *  - an action slower than its timeout fails the run, naming the action, and nothing starts;
 *  - a forced run that errored or was skipped reports its status and error.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../../src/constants.js';
import { CronService } from '../../../src/core/cron/service.js';
import { jobTimeoutMs } from '../../../src/core/cron/timer.js';
import { ROUTINE_WAIT_MS } from '../../../src/core/routines/run-start-deps.js';
import { TRIAGE_ACTION_TIMEOUT_SECONDS } from '../../../src/core/triage/types.js';
import type { CronJobCreate, CronServiceDeps } from '../../../src/core/cron/types.js';

let counter = 0;

function mockLog() {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any;
}

async function service(deps: Partial<CronServiceDeps>): Promise<CronService> {
  const storePath = path.join(WALNUT_HOME, `init-timeout-${++counter}`, 'cron-jobs.json');
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  return new CronService({
    log: mockLog(),
    storePath,
    cronEnabled: false,
    broadcastCronNotification: vi.fn(),
    runMainAgentWithPrompt: vi.fn().mockResolvedValue(undefined),
    runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: 'ok', summary: 'done' }),
    onEvent: vi.fn(),
    ...deps,
  });
}

function routine(timeoutSeconds: number): CronJobCreate {
  return {
    name: 'Batch routine',
    enabled: true,
    schedule: { kind: 'every', everyMs: 30 * 60_000 },
    wakeMode: 'next-cycle',
    initProcessor: { actionId: 'batch', invokeAgent: true, timeoutSeconds },
    executor: { type: 'claude-code', config: { instructions: 'Read the batch.', cwd: '/tmp' } },
  } as CronJobCreate;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('init processor timeout scope', () => {
  it("a routine start's own wait for room fits inside the run's cap, whatever the action's timeout", () => {
    for (const seconds of [1, TRIAGE_ACTION_TIMEOUT_SECONDS, 60, 120]) {
      const cap = jobTimeoutMs({ payload: { kind: 'systemEvent', text: '' }, initProcessor: { actionId: 'a', timeoutSeconds: seconds } });
      expect(cap, `action timeout ${seconds}s`).toBeGreaterThan(ROUTINE_WAIT_MS);
      expect(cap, `action timeout ${seconds}s`).toBeGreaterThanOrEqual(seconds * 1_000);
    }
  });

  it('an executor slower than the action timeout still finishes the run', async () => {
    const runAction = vi.fn().mockResolvedValue({ status: 'ok', summary: 'the batch' });
    const runExecutor = vi.fn(async () => { await sleep(1_500); return { status: 'ok' as const, summary: 'started' }; });
    const svc = await service({ runAction, runExecutor: runExecutor as never });
    const job = await svc.add(routine(1));

    const result = await svc.run(job.id, 'force');

    expect(result).toEqual({ ok: true, ran: true });
    expect(runExecutor).toHaveBeenCalledTimes(1);
    const stored = (await svc.list({ includeDisabled: true })).find((j) => j.id === job.id);
    expect(stored?.state.lastStatus).toBe('ok');
    expect(stored?.state.lastError).toBeUndefined();
  });

  it('an action slower than its timeout fails the run with its name, and nothing starts', async () => {
    const runAction = vi.fn(async () => { await sleep(3_000); return { status: 'ok' as const, summary: 'late' }; });
    const runExecutor = vi.fn().mockResolvedValue({ status: 'ok', summary: 'started' });
    const svc = await service({ runAction, runExecutor: runExecutor as never });
    const job = await svc.add(routine(1));

    const result = await svc.run(job.id, 'force');

    expect(result).toMatchObject({ ok: true, ran: true, status: 'error' });
    expect((result as { error?: string }).error).toContain("init processor 'batch' timed out after 1s");
    expect(runExecutor).not.toHaveBeenCalled();
    const stored = (await svc.list({ includeDisabled: true })).find((j) => j.id === job.id);
    expect(stored?.state.lastStatus).toBe('error');
  });

  it('a forced run whose executor fails or declines reports it, never a bare ran:true', async () => {
    const runAction = vi.fn().mockResolvedValue({ status: 'ok', summary: 'the batch' });
    const failing = vi.fn().mockResolvedValue({ status: 'error', error: 'Not started: this Mac had no room for 60 seconds.' });
    const svc = await service({ runAction, runExecutor: failing as never });
    const job = await svc.add(routine(30));
    expect(await svc.run(job.id, 'force')).toEqual({
      ok: true, ran: true, status: 'error', error: 'Not started: this Mac had no room for 60 seconds.',
    });

    const declining = vi.fn().mockResolvedValue({ status: 'skipped', summary: 'outside active hours' });
    const svc2 = await service({ runAction: declining });
    const job2 = await svc2.add(routine(30));
    expect(await svc2.run(job2.id, 'force')).toEqual({ ok: true, ran: true, status: 'skipped', summary: 'outside active hours' });
  });
});

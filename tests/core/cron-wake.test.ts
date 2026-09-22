/**
 * `wake`: a routine that also runs on a COUNT of events, not only on its clock
 * (src/core/cron/types.ts CronWake).
 *
 * The acceptance rules this file pins, in the order they were written:
 *  1. crossing the threshold is what makes the routine due; the run consumes the
 *     batch and the clock moves on by a full interval,
 *  2. the counter survives a restart and lives in the machine-local
 *     cron-state.json sidecar — never in the git-synced cron-jobs.json,
 *  3. `skipWhenIdle`: a timed run with an empty counter is skipped and the
 *     executor is never called (asserted as zero model spend),
 *  4. without the flag the same job still runs on the clock,
 *  5. an event that arrives DURING the run is not swallowed — the reset
 *     SUBTRACTS what the dispatch observed instead of zeroing (the correctness
 *     heart of the feature),
 *  9. a check trigger refuses a wake counter, at create and at patch, with a 400,
 * 10. an UNREADABLE wake patch is refused with a 400, never ignored: an absent
 *     key means "leave the stored wake alone", so dropping a bad one answered 200
 *     and changed nothing at all,
 * 11. two crossings around one run collapse: the second is answered
 *     `already-running` rather than starting a second run.
 *
 * Plus the two invariants a later change could quietly break: a save that does
 * not mention `wake` must not erase it, and a wake fire must leave an audit row
 * carrying the text it injected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../src/constants.js';
import { CronService } from '../../src/core/cron/service.js';
import { cronStatePath } from '../../src/core/cron/store.js';
import { normalizeCronJobCreate, normalizeCronJobPatch } from '../../src/core/cron/normalize.js';
import { applyJobPatch } from '../../src/core/cron/jobs.js';
import type { CronJob, CronJobCreate, CronStateFile, CronStoreFile } from '../../src/core/cron/types.js';
import { setCronService } from '../../src/web/routes/cron.js';
import { createRoutine, patchRoutine } from '../../src/core/routines/routines-core.js';
import { SessionControlError } from '../../src/core/sessions/session-controls.js';

const NOW = Date.UTC(2026, 8, 21, 9, 0, 0);
const EVERY_MS = 30 * 60_000;
const MAIL_EVENT = 'plugin:mail:messages-received';

let tmpDir: string;
let storeCounter = 0;

function createMockLog() {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any;
}

type Harness = {
  service: CronService;
  storePath: string;
  runExecutor: ReturnType<typeof vi.fn>;
  now: { value: number };
};

async function makeService(opts?: {
  storePath?: string;
  now?: { value: number };
  runExecutor?: ReturnType<typeof vi.fn>;
}): Promise<Harness> {
  const now = opts?.now ?? { value: NOW };
  const storePath = opts?.storePath
    ?? path.join(tmpDir, `wake-${++storeCounter}`, 'cron-jobs.json');
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  const runExecutor = opts?.runExecutor
    ?? vi.fn().mockResolvedValue({ status: 'ok', summary: 'triaged 22 items' });
  const service = new CronService({
    nowMs: () => now.value,
    log: createMockLog(),
    storePath,
    cronEnabled: false, // no real timer: every run in here is driven explicitly
    broadcastCronNotification: vi.fn(),
    runMainAgentWithPrompt: vi.fn().mockResolvedValue(undefined),
    runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: 'ok', summary: 'done' }),
    runExecutor: runExecutor as never,
    onEvent: vi.fn(),
  });
  return { service, storePath, runExecutor, now };
}

function wakeRoutine(overrides?: Partial<CronJobCreate>): CronJobCreate {
  return {
    name: 'Inbox triage',
    enabled: true,
    schedule: { kind: 'every', everyMs: EVERY_MS, anchorMs: NOW },
    wakeMode: 'next-cycle',
    executor: { type: 'claude-code', config: { instructions: 'Triage the inbox.', cwd: '/tmp' } },
    wake: { events: [MAIL_EVENT], countField: 'count', threshold: 20 },
    ...overrides,
  } as CronJobCreate;
}

async function readRaw<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf-8')) as T;
}

/** The stored job, read WITHOUT list()'s recompute (which would heal a due slot). */
async function readJob(storePath: string, jobId: string): Promise<CronJob> {
  const jobs = await readRaw<CronStoreFile>(storePath);
  const states = await readRaw<CronStateFile>(cronStatePath(storePath));
  const job = jobs.jobs.find((j) => j.id === jobId)!;
  return { ...job, state: states.states[jobId] ?? {} };
}

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  setCronService(null);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('wake: the counter half of a routine trigger', () => {
  it('fires on the event that crosses the threshold, then consumes the batch and moves the clock', async () => {
    const { service, storePath, runExecutor, now } = await makeService();
    const job = await service.add(wakeRoutine());
    expect(job.wake).toEqual({ events: [MAIL_EVENT], countField: 'count', threshold: 20 });
    expect(job.state.nextRunAtMs).toBe(NOW + EVERY_MS);

    // Three mail reports carrying 7, 7 and 8 items: only the third is due.
    const first = await service.bumpWake(job.id, 7);
    expect(first).toMatchObject({ count: 7, threshold: 20, due: false });
    expect((await service.bumpWake(job.id, 7))!.due).toBe(false);
    const third = await service.bumpWake(job.id, 8);
    expect(third).toMatchObject({ count: 22, due: true });
    expect(runExecutor).not.toHaveBeenCalled();

    // The flush window has passed; this is what the subscriber does next.
    now.value = NOW + 5_000;
    const result = await service.run(job.id, 'force');
    expect(result).toEqual({ ok: true, ran: true });
    expect(runExecutor).toHaveBeenCalledTimes(1);
    expect(runExecutor.mock.calls[0][2]).toBe('Triage the inbox.');

    const after = await readJob(storePath, job.id);
    expect(after.state.wakeCount).toBe(0);
    expect(after.state.lastStatus).toBe('ok');
    // A full interval from the anchor, not "5s from now".
    expect(after.state.nextRunAtMs).toBe(NOW + EVERY_MS);
  });

  it('keeps the counter in the machine-local sidecar, and it survives a restart', async () => {
    const first = await makeService();
    const job = await first.service.add(wakeRoutine());
    expect((await first.service.bumpWake(job.id, 15))!.due).toBe(false);

    // The definitions file (which git-syncs between machines) must carry the
    // wake DEFINITION and no counter: a counter echoed back from another box
    // firing a job here is the 2026-08-04 storm in a new costume.
    const jobsFile = await readRaw<CronStoreFile>(first.storePath);
    const stored = jobsFile.jobs.find((j) => j.id === job.id)! as CronJob & { state?: unknown };
    expect(stored.wake).toEqual({ events: [MAIL_EVENT], countField: 'count', threshold: 20 });
    expect('state' in stored).toBe(false);
    expect(JSON.stringify(jobsFile)).not.toContain('wakeCount');

    const stateFile = await readRaw<CronStateFile>(cronStatePath(first.storePath));
    expect(stateFile.states[job.id].wakeCount).toBe(15);
    expect(stateFile.states[job.id].wakeLastAtMs).toBe(NOW);

    // A fresh process on the same store picks the counter up where it was.
    const second = await makeService({ storePath: first.storePath });
    const resumed = await second.service.bumpWake(job.id, 6);
    expect(resumed).toMatchObject({ count: 21, due: true });
  });

  it('skipWhenIdle: an empty counter skips the timed run without calling the executor', async () => {
    const { service, storePath, runExecutor, now } = await makeService();
    const job = await service.add(wakeRoutine({
      wake: { events: [MAIL_EVENT], countField: 'count', threshold: 20, skipWhenIdle: true },
    }));

    now.value = NOW + EVERY_MS + 1;
    const result = await service.run(job.id, 'due');
    expect(result).toEqual({ ok: true, ran: true });
    // Zero model spend is the point of the flag.
    expect(runExecutor).not.toHaveBeenCalled();

    const after = await readJob(storePath, job.id);
    expect(after.state.lastStatus).toBe('skipped');
    // The slot was CONSUMED: the clock advanced by one interval, so the job is
    // not re-evaluated as due on every tick (the reason the skip lives in
    // executeJobCore and not in findDueJobs).
    expect(after.state.nextRunAtMs).toBe(NOW + 2 * EVERY_MS);
    expect(after.state.fireLog).toBeUndefined();
    expect(await service.run(job.id, 'due')).toEqual({ ok: true, ran: false, reason: 'not-due' });

    // And the replay guard is armed for that slot: an external writer flapping
    // the store back to a due state (the 2026-08-04 storm) cannot re-run it.
    const states = await readRaw<CronStateFile>(cronStatePath(storePath));
    states.states[job.id].nextRunAtMs = NOW;
    await fs.writeFile(cronStatePath(storePath), JSON.stringify(states), 'utf-8');
    expect(await service.run(job.id, 'due')).toEqual({
      ok: true, ran: false, reason: 'already-ran-this-slot',
    });
    expect(runExecutor).not.toHaveBeenCalled();
  });

  it('without skipWhenIdle the same job still runs on the clock with an empty counter', async () => {
    const { service, runExecutor, now } = await makeService();
    const job = await service.add(wakeRoutine());

    now.value = NOW + EVERY_MS + 1;
    await service.run(job.id, 'due');
    expect(runExecutor).toHaveBeenCalledTimes(1);
  });

  it('does not swallow an event that arrives mid-run: the reset subtracts what the dispatch observed', async () => {
    // 20 items fire the routine; 3 more arrive while it is running. Zeroing the
    // counter after the run would throw those 3 away.
    let harness: Harness;
    const runExecutor = vi.fn(async () => {
      await harness.service.bumpWake(jobId, 3);
      return { status: 'ok' as const, summary: 'triaged' };
    });
    harness = await makeService({ runExecutor });
    const job = await harness.service.add(wakeRoutine());
    const jobId = job.id;

    expect((await harness.service.bumpWake(jobId, 20))!.due).toBe(true);
    await harness.service.run(jobId, 'force');

    const after = await readJob(harness.storePath, jobId);
    expect(after.state.wakeCount).toBe(3);
  });

  /**
   * A run that ERRORED looked at nothing, so its batch is still waiting.
   *
   * Taking the count anyway spent the batch on a run that never read it AND left the routine below its
   * threshold, so the backoff retry arrived as "no new items" under skipWhenIdle and the clock leg stalled
   * until the threshold filled again from scratch.
   */
  it('keeps the batch when the run failed, so the retry still has something to read', async () => {
    const runExecutor = vi.fn(async () => ({ status: 'error' as const, error: 'the host is unreachable' }));
    const { service, storePath } = await makeService({ runExecutor });
    const job = await service.add(wakeRoutine({
      wake: { events: [MAIL_EVENT], countField: 'count', threshold: 20, skipWhenIdle: true },
    }));

    expect((await service.bumpWake(job.id, 20))!.due).toBe(true);
    await service.run(job.id, 'force');

    const after = await readJob(storePath, job.id);
    expect(after.state.lastStatus).toBe('error');
    expect(after.state.wakeCount, 'nobody read those 20 items').toBe(20);
    // And the backoff retry is a real run, not a skip: the counter is still over the threshold.
    await service.run(job.id, 'force');
    expect(runExecutor).toHaveBeenCalledTimes(2);
  });

  /**
   * Run now is a person asking to see the routine work. Answering with a silent skip reads as the button
   * being broken, because a skip writes no `lastError` and no fire row: the card just says "skipped".
   */
  it('runs a forced job even when the counter is empty and skipWhenIdle is on', async () => {
    const { service, storePath, runExecutor } = await makeService();
    const job = await service.add(wakeRoutine({
      wake: { events: [MAIL_EVENT], countField: 'count', threshold: 20, skipWhenIdle: true },
    }));

    expect(await service.run(job.id, 'force')).toEqual({ ok: true, ran: true });
    expect(runExecutor).toHaveBeenCalledTimes(1);
    const after = await readJob(storePath, job.id);
    expect(after.state.lastStatus).toBe('ok');
    // A DUE run with the same empty counter is still skipped: the exemption is the force, not the flag.
    await service.run(job.id, 'due');
    expect(runExecutor).toHaveBeenCalledTimes(1);
  });

  it('records one audit row per wake fire, carrying the text it injected', async () => {
    const { service, storePath } = await makeService();
    const job = await service.add(wakeRoutine());
    await service.bumpWake(job.id, 20);
    await service.run(job.id, 'force');

    const after = await readJob(storePath, job.id);
    expect(after.state.fireLog).toHaveLength(1);
    expect(after.state.fireLog![0]).toMatchObject({
      outcome: 'fired',
      items: 20,
      delivery: { status: 'ok', summary: 'triaged 22 items' },
    });
    expect(after.state.fireLog![0].injected).toEqual({
      chars: 'Triage the inbox.'.length,
      preview: 'Triage the inbox.',
    });
    // No daemon owns a wake fire, so there is no (epoch, seq) on the row.
    expect(after.state.fireLog![0].seq).toBeUndefined();
  });

  it('clamps a long injected preview to 600 characters', async () => {
    const instructions = 'x'.repeat(1_000);
    const { service, storePath } = await makeService();
    const job = await service.add(wakeRoutine({
      executor: { type: 'claude-code', config: { instructions, cwd: '/tmp' } },
    }));
    await service.bumpWake(job.id, 20);
    await service.run(job.id, 'force');

    const row = (await readJob(storePath, job.id)).state.fireLog![0];
    expect(row.injected!.chars).toBe(1_000);
    expect(row.injected!.preview).toHaveLength(601); // 600 + the ellipsis
  });

  it('answers a second crossing with already-running instead of starting a second run', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const runExecutor = vi.fn(async () => {
      await held;
      return { status: 'ok' as const, summary: 'triaged' };
    });
    const { service, storePath } = await makeService({ runExecutor });
    const job = await service.add(wakeRoutine());
    await service.bumpWake(job.id, 20);

    const firstRun = service.run(job.id, 'force');
    // Give the run time to take the store lock and mark itself running.
    await vi.waitFor(async () => {
      expect((await readJob(storePath, job.id)).state.runningAtMs).toBeTypeOf('number');
    });

    // A second batch crosses the threshold again while the first run is in
    // flight. Forcing a run is still refused: one routine, one run.
    await service.bumpWake(job.id, 20);
    expect(await service.run(job.id, 'force')).toEqual({
      ok: true, ran: false, reason: 'already-running',
    });

    release();
    await firstRun;
    expect(runExecutor).toHaveBeenCalledTimes(1);
    // The second batch is intact: only the observed 20 were consumed.
    expect((await readJob(storePath, job.id)).state.wakeCount).toBe(20);
  });

  it('refuses a wake counter on a check trigger, at create and at patch, with a 400', async () => {
    const { service } = await makeService();
    setCronService(service);

    // Legacy-shaped (no `executor` key) so this stays a test about the refusal:
    // an executor ref would be validated against the registry first, which no
    // unit-test process populates.
    const both = {
      name: 'Both',
      schedule: { kind: 'every', everyMs: EVERY_MS },
      sessionTarget: 'main',
      payload: { kind: 'systemEvent', text: 'go' },
      check: { run: 'echo \'{"fire": false}\'', host: '__local__' },
      wake: { events: [MAIL_EVENT], threshold: 5 },
    };
    await expect(createRoutine(both)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('wake events cannot be combined with a check'),
    });

    // Adding a wake to a STORED trigger is the same refusal, resolved against
    // the stored job rather than the patch alone.
    const stored = await service.add(wakeRoutine({
      wake: undefined,
      check: { run: 'echo \'{"fire": false}\'', host: '__local__' },
    }));
    await expect(patchRoutine(stored.id, { wake: { events: [MAIL_EVENT], threshold: 5 } }))
      .rejects.toBeInstanceOf(SessionControlError);

    // And the engine itself refuses it on every path, not only through REST.
    await expect(service.add(wakeRoutine({
      check: { run: 'echo 1', host: '__local__' },
    }))).rejects.toThrow(/wake events cannot be combined with a check/);
  });

  it('a save that does not mention wake leaves it alone; an explicit null clears it', async () => {
    const { service } = await makeService();
    const job = await service.add(wakeRoutine());

    // Exactly what RoutineForm sends: name + schedule + executor, no `wake`.
    const formPatch = normalizeCronJobPatch({
      name: 'Inbox triage (renamed)',
      schedule: { kind: 'every', everyMs: EVERY_MS },
      executor: { type: 'claude-code', config: { instructions: 'Triage the inbox.', cwd: '/tmp' } },
    })!;
    expect('wake' in formPatch).toBe(false);
    const saved = await service.update(job.id, formPatch);
    expect(saved.wake).toEqual({ events: [MAIL_EVENT], countField: 'count', threshold: 20 });

    const cleared = await service.update(job.id, normalizeCronJobPatch({ wake: null })!);
    expect(cleared.wake).toBeUndefined();
  });

  it('normalizes wake input: event-name shape, non-negative threshold, safe countField', async () => {
    const patch = normalizeCronJobPatch({
      wake: {
        events: [MAIL_EVENT, MAIL_EVENT, 'not an event name', 'plugin:slack:messages-received'],
        threshold: '12.7',
        countField: ' count ',
        skipWhenIdle: 'yes',
      },
    })!;
    expect(patch.wake).toEqual({
      events: [MAIL_EVENT, 'plugin:slack:messages-received'],
      threshold: 12,
      countField: 'count',
    });

    // A negative threshold clamps to 0 (clock only), and a prototype-hazard key
    // is dropped rather than used to index an arbitrary event payload.
    expect(normalizeCronJobPatch({
      wake: { events: [MAIL_EVENT], threshold: -3, countField: '__proto__' },
    })!.wake).toEqual({ events: [MAIL_EVENT], threshold: 0 });

    // Nothing countable left REFUSES the input. Dropping the key instead meant
    // "leave the stored wake alone" (applyJobPatch reads key presence), so the
    // caller got a 200 and no change — see the 400 case below.
    expect(normalizeCronJobPatch({ wake: { events: ['bare-word'], threshold: 5 } })).toBeNull();
    expect(normalizeCronJobPatch({ wake: { events: [], threshold: 5 } })).toBeNull();
    expect(normalizeCronJobPatch({ wake: { threshold: 5 } })).toBeNull();
    // A create carrying the same unreadable block is refused too: storing a
    // clock-only routine would not be what the caller asked for either.
    expect(normalizeCronJobCreate({
      name: 'Bad wake',
      schedule: { kind: 'every', everyMs: EVERY_MS },
      payload: { kind: 'systemEvent', text: 'go' },
      wake: { events: ['Mail Received'] },
    })).toBeNull();
  });

  it('refuses an unreadable wake patch with a 400 instead of silently keeping the old one', async () => {
    const { service } = await makeService();
    setCronService(service);
    const job = await service.add(wakeRoutine());

    // An event name that fails the name pattern (a human label, not a bus event).
    await expect(patchRoutine(job.id, { wake: { events: ['Mail Received'], threshold: 5 } }))
      .rejects.toMatchObject({ statusCode: 400 });
    // An empty array is the "clear the counter" attempt: refused, and said out
    // loud, rather than answered 200 with the old counter still running.
    await expect(patchRoutine(job.id, { wake: { events: [], threshold: 5 } }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(patchRoutine(job.id, { wake: { events: ['Mail Received'] } }))
      .rejects.toBeInstanceOf(SessionControlError);

    // The stored routine is untouched by a refused patch...
    const stored = (await service.list({ includeDisabled: true })).find((j) => j.id === job.id)!;
    expect(stored.wake).toEqual({ events: [MAIL_EVENT], countField: 'count', threshold: 20 });
    // ...and the two meanings that must survive the refusal: null REMOVES it,
    // an omitted key leaves it alone.
    const renamed = await patchRoutine(job.id, { name: 'Inbox triage (renamed)' });
    expect((renamed.job as CronJob).wake).toEqual({ events: [MAIL_EVENT], countField: 'count', threshold: 20 });
    const cleared = await patchRoutine(job.id, { wake: null });
    expect((cleared.job as CronJob).wake).toBeUndefined();

    // Create refuses it on the same path. Legacy-shaped (no `executor` key) so
    // this stays a test about the refusal, not about the executor registry.
    await expect(createRoutine({
      name: 'Bad wake',
      schedule: { kind: 'every', everyMs: EVERY_MS },
      sessionTarget: 'main',
      payload: { kind: 'systemEvent', text: 'go' },
      wake: { events: ['Mail Received'], threshold: 5 },
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('applyJobPatch treats wake by key presence, exactly like check', () => {
    const job = {
      id: 'j1', name: 'n', enabled: true, createdAtMs: NOW, updatedAtMs: NOW,
      schedule: { kind: 'every', everyMs: EVERY_MS, anchorMs: NOW },
      sessionTarget: 'isolated', wakeMode: 'next-cycle',
      payload: { kind: 'agentTurn', message: 'go' },
      executor: { type: 'claude-code', config: { instructions: 'go' } },
      wake: { events: [MAIL_EVENT], threshold: 4 },
      state: {},
    } as unknown as CronJob;

    applyJobPatch(job, { name: 'renamed' });
    expect(job.wake).toEqual({ events: [MAIL_EVENT], threshold: 4 });
    applyJobPatch(job, { wake: null });
    expect(job.wake).toBeUndefined();
  });
});

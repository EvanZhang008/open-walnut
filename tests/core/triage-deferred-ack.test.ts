/**
 * A triage run that waits for a free slot keeps its batch until it really starts.
 *
 * With every host full, the routine files the run's task (`quickStartSession({ deferStart })`, whose
 * task:created carries `deferredStart`) and starts it later. Acknowledging the claim at that create
 * dropped the batch for a run that a person could still cancel or delete, so those items were never
 * triaged. Now the claim is BOUND to the waiting task and acknowledged when that task's own
 * session came up: the routine's verdict (`routine_start.state === 'started'`), never the dispatch
 * or session:started alone (the provider emits that before its spawn is confirmed), keyed by the task:
 *
 *   - full queue, then cancel: the items stay and the next fire's batch carries them;
 *   - the real start acknowledges once (a retry's second session:started is a no-op);
 *   - a dispatch whose spawn fails acknowledges nothing, and a failed start gives the items back;
 *   - a run that came up without its event is settled from its task: no second batch;
 *   - a late start of an older run never acknowledges a newer claim;
 *   - fires while the run waits build no second batch of the same items, past the claim TTL too.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-triage-deferred-ack'));

const tasks = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock('../../src/core/task-manager.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTask: vi.fn(async (id: string) => {
    const t = tasks.get(id);
    if (!t) throw new Error(`No task found matching "${id}"`);
    return t;
  }),
}));

import { WALNUT_HOME } from '../../src/constants.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import { getConfig, saveConfig } from '../../src/core/config-manager.js';
import { startTriageRuns } from '../../src/core/triage/runs.js';
import { TRIAGE_PROJECT } from '../../src/core/triage/bootstrap.js';
import { run as runBatch } from '../../src/actions/inbox-triage-batch.js';
import {
  CLAIM_TTL_MS,
  claimTriageBatch,
  loadTriageState,
  recordTriageArrivals,
  releaseTriageClaimHeldBy,
  triageStatePath,
  type TriagePendingSlack,
} from '../../src/core/triage/state.js';
import type { Task } from '../../src/core/types.js';

const HOME = (): string => WALNUT_HOME;
const ctx = { WALNUT_HOME, params: {} };

function slackRows(prefix: string, n: number): TriagePendingSlack[] {
  return Array.from({ length: n }, (_, i) => ({
    conversation: '#room', isDm: false, isMention: false, alias: 'person',
    ts: `${prefix}-${i}`, permalink: '', text: `${prefix} line ${i}`, atMs: Date.now(),
  }));
}

function runTask(id: string, over: Record<string, unknown> = {}): Task {
  const task = {
    id, title: 'Triage run', project: TRIAGE_PROJECT, agent_id: 'triage', phase: 'TODO',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...over,
  };
  tasks.set(id, task);
  return task as unknown as Task;
}

/** The task as the routine leaves it while it waits for capacity. */
function waiting(id: string): Task {
  return runTask(id, {
    start_queue: { at: new Date().toISOString(), wait_for_slot: true, params: {} },
    routine_start: { state: 'starting', waited_for_slot: true },
  });
}

async function until(done: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const started = (taskId: string): void => bus.emit(EventNames.SESSION_STARTED, { taskId, sessionId: `s-${taskId}` }, ['web-ui']);
/** The routine's verdict that the run's session came up, as its settle write reaches the bus. */
const verdict = (taskId: string): void => bus.emit(EventNames.TASK_UPDATED, { task: tasks.get(taskId) as unknown as Task }, ['web-ui']);
const dispatched = (taskId: string): void => bus.emit(EventNames.SESSION_START, { taskId, message: 'batch' }, ['session-runner']);

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
}

let handle: { stop(): void; stats(): { acked: number } } | null = null;
let withdrawSuperseded: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  handle?.stop();
  tasks.clear();
  await fs.rm(triageStatePath(HOME()), { force: true });
  const config = await getConfig();
  await saveConfig({
    ...config,
    triage: { enabled: true, every: '30m', every_messages: 20, sources: ['slack'], active_hours: '' },
  } as never);
  withdrawSuperseded = vi.fn(async () => ({ withdrawn: [], kept: 0, failed: 0 }));
  handle = startTriageRuns({
    home: HOME(),
    withdrawSuperseded,
    listRunTaskIds: async () => [],
    getTask: async (id) => tasks.get(id) as Task | undefined,
    completeTask: async () => undefined,
    appendJournal: async () => 'notes/x.md',
    recordOutcome: async () => undefined,
  });
});

afterEach(() => {
  handle?.stop();
  handle = null;
});

/** A fire that finds every host full: the batch is claimed and its run task filed without a start. */
async function fireIntoFullQueue(taskId: string): Promise<string> {
  const batch = await runBatch(ctx);
  expect(batch.invoke).toBe(true);
  bus.emit(EventNames.TASK_CREATED, { task: runTask(taskId), deferredStart: true }, ['web-ui']);
  await until(async () => (await loadTriageState(HOME())).claim?.taskId === taskId, 'the claim bound to the waiting run');
  waiting(taskId);
  return batch.content;
}

describe('a triage run waiting for a free slot', () => {
  it('a cancelled wait keeps the batch: the next fire carries the same items', async () => {
    await recordTriageArrivals({ slack: slackRows('a', 3) }, HOME());
    await fireIntoFullQueue('t-wait');
    await settle();
    expect(handle!.stats().acked).toBe(0);
    expect((await loadTriageState(HOME())).pending.slack).toHaveLength(3);

    // The person cancels the queued run (start-queue.ts clears the queue, the start fails).
    runTask('t-wait', { start_queue: null, routine_start: { state: 'failed' } });
    const next = await runBatch(ctx);
    expect(next.invoke).toBe(true);
    expect(next.content).toContain('a line 0');
    expect(next.content).toContain('already handed to a run that never started');
    const state = await loadTriageState(HOME());
    expect(state.claim?.taskId).toBeUndefined();
    expect(state.pending.slack).toHaveLength(3);
    expect(withdrawSuperseded).not.toHaveBeenCalled();
  });

  it('a deleted wait keeps the batch too', async () => {
    await recordTriageArrivals({ slack: slackRows('d', 2) }, HOME());
    await fireIntoFullQueue('t-gone');
    tasks.delete('t-gone');
    const next = await runBatch(ctx);
    expect(next.invoke).toBe(true);
    expect(next.content).toContain('d line 1');
  });

  it('the real start acknowledges once, and a manual start of a cancelled wait acknowledges nothing', async () => {
    await recordTriageArrivals({ slack: slackRows('s', 2) }, HOME());
    await fireIntoFullQueue('t-start');

    // Capacity came back: the drain clears the queue, quickStartSession dispatches, the CLI comes up.
    runTask('t-start', { start_queue: null, routine_start: { state: 'starting' } });
    dispatched('t-start');
    started('t-start');
    await settle();
    // Neither the dispatch nor session:started is proof the spawn worked.
    expect((await loadTriageState(HOME())).claim?.taskId).toBe('t-start');
    runTask('t-start', { start_queue: null, routine_start: { state: 'started' } });
    verdict('t-start');
    await until(async () => (await loadTriageState(HOME())).claim === undefined, 'the acknowledgement');
    // The routine's spawn retry starts it again: nothing more is acknowledged or withdrawn.
    await recordTriageArrivals({ slack: slackRows('later', 1) }, HOME());
    await claimTriageBatch(Date.now(), HOME());
    verdict('t-start');
    started('t-start');
    await settle();

    const state = await loadTriageState(HOME());
    expect(handle!.stats().acked).toBe(1);
    expect(withdrawSuperseded).toHaveBeenCalledTimes(1);
    expect(state.runs).toBe(1);
    expect(state.claim).toBeDefined();
    expect(state.pending.slack.map((r) => r.ts)).toEqual(['later-0']);
  });

  it('a late start of an older run cannot acknowledge a newer claim', async () => {
    await recordTriageArrivals({ slack: slackRows('old', 2) }, HOME());
    await fireIntoFullQueue('t-old');
    // The old wait stops carrying the batch, and a newer run takes a claim of its own.
    runTask('t-old', { start_queue: null, routine_start: { state: 'failed' } });
    await fireIntoFullQueue('t-new');
    const newer = (await loadTriageState(HOME())).claim!;
    expect(newer.taskId).toBe('t-new');

    // The old run is started anyway (by hand, or a stale replay of its start).
    runTask('t-old', { start_queue: null, routine_start: { state: 'started' } });
    started('t-old');
    verdict('t-old');
    await settle();
    expect((await loadTriageState(HOME())).claim).toEqual(newer);
    expect(handle!.stats().acked).toBe(0);

    // A claim nobody holds yet is not the old run's either.
    expect(await releaseTriageClaimHeldBy('t-new', HOME())).toBe(true);
    const fresh = await claimTriageBatch(Date.now(), HOME());
    started('t-old');
    verdict('t-old');
    await settle();
    expect((await loadTriageState(HOME())).claim?.atMs).toBe(fresh.claim.atMs);
  });

  it('fires while the run waits build no second batch, past the claim TTL too', async () => {
    await recordTriageArrivals({ slack: slackRows('w', 2) }, HOME());
    await fireIntoFullQueue('t-long');
    const claim = (await loadTriageState(HOME())).claim!;

    for (let round = 0; round < 3; round += 1) {
      const fire = await runBatch(ctx);
      expect(fire).toMatchObject({ invoke: false, status: 'skipped' });
      expect(fire.content).toContain('t-long');
    }
    const realNow = Date.now;
    vi.spyOn(Date, 'now').mockReturnValue(realNow() + CLAIM_TTL_MS * 4);
    try {
      expect((await runBatch(ctx)).status).toBe('skipped');
    } finally {
      vi.restoreAllMocks();
    }
    expect((await loadTriageState(HOME())).claim).toEqual(claim);
  });

  it('a dispatch whose spawn fails acknowledges nothing; a failed start gives the items back', async () => {
    await recordTriageArrivals({ slack: slackRows('f', 2) }, HOME());
    await fireIntoFullQueue('t-spawn');
    runTask('t-spawn', { start_queue: null, routine_start: { state: 'starting' } });
    dispatched('t-spawn');
    started('t-spawn');
    await settle();
    // The spawn failed; the routine's retry is in flight: still the run's batch, no second one.
    expect(handle!.stats().acked).toBe(0);
    expect((await runBatch(ctx)).status).toBe('skipped');
    // The retry failed too: the run is recorded failed, and the next fire carries the items.
    runTask('t-spawn', { start_queue: null, routine_start: { state: 'failed' } });
    const next = await runBatch(ctx);
    expect(next.invoke).toBe(true);
    expect(next.content).toContain('f line 1');
  });

  it('a run that came up with its event missed is settled from its task: no second batch of its items', async () => {
    await recordTriageArrivals({ slack: slackRows('m', 2) }, HOME());
    await fireIntoFullQueue('t-missed');
    runTask('t-missed', { start_queue: null, routine_start: { state: 'started' } });
    await recordTriageArrivals({ slack: slackRows('after', 1) }, HOME());
    const next = await runBatch(ctx);
    expect(next.invoke).toBe(true);
    expect(next.content).not.toContain('m line 0');
    expect(next.content).toContain('after line 0');
    expect((await loadTriageState(HOME())).runs).toBe(1);
  });

  it('a run started at once still acknowledges on its task:created', async () => {
    await recordTriageArrivals({ slack: slackRows('n', 1) }, HOME());
    await runBatch(ctx);
    bus.emit(EventNames.TASK_CREATED, { task: runTask('t-now') }, ['web-ui']);
    await until(async () => (await loadTriageState(HOME())).claim === undefined, 'the acknowledgement');
    started('t-now');
    await settle();
    expect(handle!.stats().acked).toBe(1);
    expect(withdrawSuperseded).toHaveBeenCalledTimes(1);
  });
});

describe('quickStartSession tells a deferred create apart', () => {
  it('its task:created carries deferredStart, and no session:start follows', async () => {
    const { quickStartSession } = await import('../../src/core/sessions/quick-start.js');
    const seen: Array<{ name: string; data: Record<string, unknown> }> = [];
    bus.subscribe('test-deferred-spy', (e) => { seen.push({ name: e.name, data: e.data as Record<string, unknown> }); }, {
      global: true, interest: [EventNames.TASK_CREATED, EventNames.SESSION_START],
    });
    try {
      const task = await quickStartSession({
        message: 'later', cwd: WALNUT_HOME, source: 'test', deferStart: true, project: 'Work', hostGate: { checked: true },
      } as never);
      const created = seen.find((e) => e.name === EventNames.TASK_CREATED && (e.data.task as Task).id === task.id);
      expect(created?.data.deferredStart).toBe(true);
      expect(seen.some((e) => e.name === EventNames.SESSION_START)).toBe(false);
    } finally {
      bus.unsubscribe('test-deferred-spy');
    }
  });
});

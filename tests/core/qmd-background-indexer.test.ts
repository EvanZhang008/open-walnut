import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeReservation {
  drained: Promise<void>;
  release: ReturnType<typeof vi.fn>;
}

interface FakeChild extends EventEmitter {
  exitCode: number | null;
  signalCode: string | null;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

interface IncrementalWork {
  memory?: boolean;
  taskIds?: string[];
  sessionIds?: string[];
  notePaths?: string[];
}

type ScheduleIncremental = (
  work: IncrementalWork,
) => void | Promise<void>;

const mocks = vi.hoisted(() => ({
  children: [] as FakeChild[],
  closeStores: vi.fn(async () => undefined),
  existsSync: vi.fn(() => true),
  fork: vi.fn(),
  getRuntimeModel: vi.fn(async () => 'hf:test/runtime-model.gguf'),
  assertPowerAvailable: vi.fn(async () => undefined),
  reservations: [] as FakeReservation[],
  reserve: vi.fn(),
  setRuntimeModel: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: mocks.existsSync,
    },
    existsSync: mocks.existsSync,
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    fork: mocks.fork,
  };
});

vi.mock('../../src/constants.js', () => ({
  IS_EPHEMERAL: false,
  WALNUT_HOME: '/tmp/walnut-qmd-background-indexer-test',
}));

vi.mock('../../src/core/qmd-work-queue.js', () => ({
  reserveQmdIndexWork: mocks.reserve,
}));

vi.mock('../../src/core/qmd-model.js', () => ({
  initializeQmdRuntimeModel: mocks.getRuntimeModel,
  setQmdRuntimeModel: mocks.setRuntimeModel,
}));

vi.mock('../../src/core/qmd-power.js', () => ({
  assertQmdBackgroundIndexPowerAvailable: mocks.assertPowerAvailable,
}));

vi.mock('../../src/core/qmd-store.js', () => ({
  closeQmdStores: mocks.closeStores,
}));

import * as backgroundIndexer from '../../src/core/qmd-background-indexer.js';

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.exitCode = null;
  child.signalCode = null;
  child.stderr = new PassThrough();
  child.kill = vi.fn((signal = 'SIGTERM') => {
    child.signalCode = signal;
    queueMicrotask(() => child.emit('exit', null, signal));
    return true;
  });
  return child;
}

function emitExit(
  child: FakeChild,
  code: number | null,
  signal: string | null = null,
): void {
  child.exitCode = code;
  child.signalCode = signal;
  child.emit('exit', code, signal);
}

function readForkPayload(callIndex: number): Record<string, unknown> {
  const args = mocks.fork.mock.calls[callIndex]?.[1] as string[] | undefined;
  expect(args?.[0], `fork call ${callIndex + 1} should contain a JSON work payload`).toBeTypeOf('string');
  return JSON.parse(args![0]) as Record<string, unknown>;
}

function findIncrementalWork(payload: Record<string, unknown>): IncrementalWork {
  for (const candidate of [
    payload.incremental,
    payload.work,
    payload.options,
    payload,
  ]) {
    if (!candidate || typeof candidate !== 'object') continue;
    const value = candidate as Record<string, unknown>;
    if (
      'memory' in value
      || 'taskIds' in value
      || 'sessionIds' in value
      || 'notePaths' in value
    ) {
      return value as IncrementalWork;
    }
  }
  throw new Error(`fork payload has no incremental work: ${JSON.stringify(payload)}`);
}

function getIncrementalScheduler(): ScheduleIncremental {
  const candidate = (
    backgroundIndexer as typeof backgroundIndexer & {
      scheduleQmdIncrementalIndex?: ScheduleIncremental;
    }
  ).scheduleQmdIncrementalIndex;
  expect(
    candidate,
    'qmd-background-indexer must export scheduleQmdIncrementalIndex()',
  ).toBeTypeOf('function');
  return candidate!;
}

async function waitForForkCount(count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(mocks.fork).toHaveBeenCalledTimes(count);
  });
}

beforeEach(() => {
  mocks.children.length = 0;
  mocks.reservations.length = 0;
  mocks.closeStores.mockClear();
  mocks.existsSync.mockReset().mockReturnValue(true);
  mocks.getRuntimeModel.mockReset().mockResolvedValue('hf:test/runtime-model.gguf');
  mocks.assertPowerAvailable.mockReset().mockResolvedValue(undefined);
  mocks.setRuntimeModel.mockClear();
  mocks.reserve.mockReset().mockImplementation(() => {
    const reservation: FakeReservation = {
      drained: Promise.resolve(),
      release: vi.fn(),
    };
    mocks.reservations.push(reservation);
    return reservation;
  });
  mocks.fork.mockReset().mockImplementation(() => {
    const child = makeChild();
    mocks.children.push(child);
    return child;
  });
});

afterEach(async () => {
  for (const child of mocks.children) {
    if (child.exitCode === null && child.signalCode === null) {
      emitExit(child, 0);
    }
  }
  await backgroundIndexer.stopQmdBackgroundIndex();
});

describe('QMD background worker scheduler', () => {
  it('forks a full job with the worker guard and releases its reservation on success', async () => {
    const run = backgroundIndexer.runQmdBackgroundIndex({
      initialize: true,
      force: true,
    });

    await waitForForkCount(1);

    const [workerPath, args, options] = mocks.fork.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string>; stdio: string[] },
    ];
    expect(workerPath).toContain('qmd-index-worker.js');
    expect(JSON.parse(args[0])).toMatchObject({
      initialize: true,
      force: true,
    });
    expect(options.env).toMatchObject({
      OPEN_WALNUT_HOME: '/tmp/walnut-qmd-background-indexer-test',
      WALNUT_QMD_WORKER: '1',
      QMD_EMBED_MODEL: 'hf:test/runtime-model.gguf',
    });
    expect(options.stdio).toEqual(['ignore', 'ignore', 'pipe', 'ipc']);
    expect(mocks.reserve).toHaveBeenCalledWith({ blockReads: false });

    emitExit(mocks.children[0], 0);
    await expect(run).resolves.toBeUndefined();
    expect(mocks.reservations[0].release).toHaveBeenCalledOnce();
  });

  it('applies a configured model and closes old stores before the worker starts', async () => {
    const model = 'hf:test/configured-model.gguf';
    const run = backgroundIndexer.runQmdBackgroundIndex({
      initialize: true,
      model,
      resetStores: true,
    });

    await waitForForkCount(1);

    expect(mocks.setRuntimeModel).toHaveBeenCalledWith(model);
    expect(mocks.closeStores).toHaveBeenCalledOnce();
    expect(mocks.setRuntimeModel).toHaveBeenCalledBefore(mocks.closeStores);
    expect(mocks.closeStores).toHaveBeenCalledBefore(mocks.fork);
    const workerArgs = mocks.fork.mock.calls[0]?.[1] as string[];
    expect(JSON.parse(workerArgs[0])).toMatchObject({
      kind: 'full',
      initialize: true,
      compact: true,
    });
    const options = mocks.fork.mock.calls[0]?.[2] as {
      env: Record<string, string>;
    };
    expect(options.env.QMD_EMBED_MODEL).toBe(model);
    expect(mocks.reserve).toHaveBeenCalledWith({ blockReads: true });

    emitExit(mocks.children[0], 0);
    await run;
  });

  it('merges pending incremental work behind a full worker without overlapping forks', async () => {
    const schedule = getIncrementalScheduler();
    const fullRun = backgroundIndexer.runQmdBackgroundIndex({ initialize: true });
    await waitForForkCount(1);

    const scheduled = [
      schedule({
        memory: true,
        taskIds: ['task-a'],
        notePaths: ['notes/a.md'],
      }),
      schedule({
        taskIds: ['task-a', 'task-b'],
        sessionIds: ['session-a'],
        notePaths: ['notes/a.md', 'notes/b.md'],
      }),
    ];

    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.fork).toHaveBeenCalledTimes(1);

    emitExit(mocks.children[0], 0);
    await fullRun;
    await waitForForkCount(2);

    const incremental = findIncrementalWork(readForkPayload(1));
    expect(incremental.memory).toBe(true);
    expect([...(incremental.taskIds ?? [])].sort()).toEqual(['task-a', 'task-b']);
    expect(incremental.sessionIds).toEqual(['session-a']);
    expect([...(incremental.notePaths ?? [])].sort()).toEqual([
      'notes/a.md',
      'notes/b.md',
    ]);

    emitExit(mocks.children[1], 0);
    await Promise.all(scheduled.map((value) => Promise.resolve(value)));
    expect(mocks.reservations[0].release).toHaveBeenCalledOnce();
    expect(mocks.reservations[1].release).toHaveBeenCalledOnce();
  });

  it('runs work queued during an active incremental worker in a following worker', async () => {
    const schedule = getIncrementalScheduler();
    const first = schedule({ taskIds: ['task-first'] });
    await waitForForkCount(1);
    expect(findIncrementalWork(readForkPayload(0)).taskIds).toEqual(['task-first']);

    const pending = [
      schedule({ sessionIds: ['session-next'] }),
      schedule({ memory: true, notePaths: ['notes/next.md'] }),
    ];
    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.fork).toHaveBeenCalledTimes(1);

    emitExit(mocks.children[0], 0);
    await waitForForkCount(2);

    const next = findIncrementalWork(readForkPayload(1));
    expect(next.memory).toBe(true);
    expect(next.sessionIds).toEqual(['session-next']);
    expect(next.notePaths).toEqual(['notes/next.md']);

    emitExit(mocks.children[1], 0);
    await Promise.all([
      Promise.resolve(first),
      ...pending.map((value) => Promise.resolve(value)),
    ]);
    expect(mocks.reservations[0].release).toHaveBeenCalledOnce();
    expect(mocks.reservations[1].release).toHaveBeenCalledOnce();
  });

  it('releases the reservation when the worker errors', async () => {
    const run = backgroundIndexer.runQmdBackgroundIndex();
    const rejection = expect(run).rejects.toThrow('worker launch failed');
    await waitForForkCount(1);

    mocks.children[0].emit('error', new Error('worker launch failed'));

    await rejection;
    expect(mocks.reservations[0].release).toHaveBeenCalledOnce();
  });

  it('defers the worker on battery power and releases its reservation', async () => {
    const deferred = Object.assign(new Error('deferred on battery'), {
      retryAfterMs: 300_000,
    });
    mocks.assertPowerAvailable.mockRejectedValueOnce(deferred);

    const run = backgroundIndexer.runQmdBackgroundIndex();
    await expect(run).rejects.toBe(deferred);

    expect(mocks.fork).not.toHaveBeenCalled();
    expect(mocks.reservations[0].release).toHaveBeenCalledOnce();
  });

  it('does not fork when shutdown begins during the power check', async () => {
    let releasePowerCheck!: () => void;
    mocks.assertPowerAvailable.mockImplementationOnce(() =>
      new Promise<void>((resolve) => { releasePowerCheck = resolve; }));

    const run = backgroundIndexer.runQmdBackgroundIndex();
    const settled = run.catch(() => undefined);
    await vi.waitFor(() => expect(mocks.assertPowerAvailable).toHaveBeenCalledOnce());

    await backgroundIndexer.stopQmdBackgroundIndex();
    releasePowerCheck();
    await settled;
    await new Promise((resolve) => setImmediate(resolve));

    expect(mocks.fork).not.toHaveBeenCalled();
    expect(mocks.reservations[0].release).toHaveBeenCalledOnce();
  });

  it('includes worker stderr and delays deterministic embedding retries', async () => {
    const run = backgroundIndexer.runQmdBackgroundIndex();
    const rejection = run.catch((error: unknown) => error);
    await waitForForkCount(1);

    mocks.children[0].stderr.write('Metal backend unavailable\n');
    mocks.children[0].emit('message', {
      type: 'error',
      error: 'QMD session: embedding failed for 20 chunk(s); partial vectors cleared for retry',
    });
    emitExit(mocks.children[0], 1);

    const error = await rejection as Error & { retryAfterMs?: number };
    expect(error.message).toContain('Metal backend unavailable');
    expect(error.retryAfterMs).toBe(6 * 60 * 60_000);
    expect(mocks.reservations[0].release).toHaveBeenCalledOnce();
  });

  it('releases the reservation when an active worker is stopped', async () => {
    const run = backgroundIndexer.runQmdBackgroundIndex();
    const settled = run.catch(() => undefined);
    await waitForForkCount(1);

    await backgroundIndexer.stopQmdBackgroundIndex();

    await settled;
    expect(mocks.children[0].kill).toHaveBeenCalledWith('SIGTERM');
    expect(mocks.reservations[0].release).toHaveBeenCalledOnce();
  });
});

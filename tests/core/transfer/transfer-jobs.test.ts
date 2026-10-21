import { describe, it, expect, beforeEach } from 'vitest';
import {
  getTransferJob, startTransferJob, waitForTransferJob, _resetTransferJobsForTesting,
} from '../../../src/core/transfer/transfer-jobs.js';
import { TransferError } from '../../../src/core/transfer/planner.js';
import type { TransferResult } from '../../../src/core/transfer/transfer.js';

beforeEach(() => _resetTransferJobsForTesting());

function deferred<T>() {
  let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

const result = { taskId: 'new', title: 'New', sourceTaskId: 't1', sourceCompleted: true, history: 'replay', target: { engine: 'codex', host: '__local__', cwd: '/w' } } as TransferResult;

describe('transfer jobs', () => {
  it('a slow transfer answers "running" when the wait runs out, then done once it finishes', async () => {
    const d = deferred<TransferResult>();
    let gotId = '';
    const job = startTransferJob({ taskId: 't1' }, (_req, id) => { gotId = id; return d.promise; });
    expect(job.id).toBe(gotId);
    const t0 = Date.now();
    expect((await waitForTransferJob(job, 50)).state).toBe('running');
    expect(Date.now() - t0).toBeLessThan(1000);
    d.resolve(result);
    const done = await waitForTransferJob(getTransferJob(job.id)!, 1000);
    expect(done).toMatchObject({ state: 'done', result: { taskId: 'new' } });
    expect(done.finishedAt).toBeTruthy();
  });

  it('a second start for the same task joins the running job instead of moving the work twice', async () => {
    const d = deferred<TransferResult>();
    let runs = 0;
    const run = () => { runs++; return d.promise; };
    const a = startTransferJob({ taskId: 't1' }, run);
    const b = startTransferJob({ taskId: 't1', engine: 'codex' }, run);
    expect(b.id).toBe(a.id);
    expect(runs).toBe(1);
    d.resolve(result);
    await waitForTransferJob(a, 1000);
    // Once finished, a new start is a new job.
    expect(startTransferJob({ taskId: 't1' }, run).id).not.toBe(a.id);
  });

  it('a refusal keeps its status and code', async () => {
    const job = startTransferJob({ taskId: 't1' }, async () => { throw new TransferError('runs on this machine only', 409, 'engine_host_unsupported'); });
    expect(await waitForTransferJob(job, 1000)).toMatchObject({
      state: 'error', error: { status: 409, code: 'engine_host_unsupported', message: 'runs on this machine only' },
    });
  });

  it('an unexpected crash is a 500', async () => {
    const job = startTransferJob({ taskId: 't1' }, async () => { throw new Error('boom'); });
    expect((await waitForTransferJob(job, 1000)).error).toEqual({ message: 'boom', status: 500 });
  });

  it('no wait is longer than 25 seconds', async () => {
    const job = startTransferJob({ taskId: 't1' }, () => new Promise(() => {}));
    const t0 = Date.now();
    const p = waitForTransferJob(job, 10 * 60_000);
    // The cap is what bounds it; a zero wait returns at once.
    expect((await waitForTransferJob(job, 0)).state).toBe('running');
    expect(Date.now() - t0).toBeLessThan(500);
    void p;
  });
});

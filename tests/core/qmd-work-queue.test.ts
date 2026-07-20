import { describe, expect, it } from 'vitest';
import {
  getQmdIndexWorkState,
  reserveQmdIndexWork,
  runQmdIndexWork,
  runQmdReadWork,
} from '../../src/core/qmd-work-queue.js';

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('QMD index work queue', () => {
  it('never overlaps work submitted by different indexing entry points', async () => {
    const firstGate = deferred();
    const started: string[] = [];

    const first = runQmdIndexWork('first-store', async () => {
      started.push('first');
      await firstGate.promise;
    });
    const second = runQmdIndexWork('second-store', async () => {
      started.push('second');
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual(['first']);
    expect(getQmdIndexWorkState()).toEqual({
      pending: 2,
      activeLabel: 'first-store',
    });

    firstGate.resolve();
    await Promise.all([first, second]);
    expect(started).toEqual(['first', 'second']);
    expect(getQmdIndexWorkState()).toEqual({
      pending: 0,
      activeLabel: null,
    });
  });

  it('continues with the next job after a failure', async () => {
    const order: string[] = [];
    const failed = runQmdIndexWork('failing-store', async () => {
      order.push('failed');
      throw new Error('expected failure');
    });
    const recovered = runQmdIndexWork('healthy-store', async () => {
      order.push('recovered');
    });

    await expect(failed).rejects.toThrow('expected failure');
    await expect(recovered).resolves.toBeUndefined();
    expect(order).toEqual(['failed', 'recovered']);
  });

  it('parks jobs submitted after an out-of-process reservation', async () => {
    const firstGate = deferred();
    const started: string[] = [];
    const first = runQmdIndexWork('before-reservation', async () => {
      started.push('first');
      await firstGate.promise;
    });

    await new Promise((resolve) => setImmediate(resolve));
    const reservation = reserveQmdIndexWork();
    const second = runQmdIndexWork('after-reservation', async () => {
      started.push('second');
    });

    firstGate.resolve();
    await reservation.drained;
    expect(started).toEqual(['first']);
    expect(getQmdIndexWorkState()).toEqual({
      pending: 1,
      activeLabel: null,
    });

    reservation.release();
    await Promise.all([first, second]);
    expect(started).toEqual(['first', 'second']);
  });

  it('allows interactive reads while an ordinary worker reservation is active', async () => {
    const reservation = reserveQmdIndexWork();
    await reservation.drained;

    await expect(runQmdReadWork(async () => 'committed snapshot'))
      .resolves.toBe('committed snapshot');

    reservation.release();
  });

  it('does not serialize ordinary concurrent searches', async () => {
    const firstGate = deferred();
    const started: string[] = [];
    const first = runQmdReadWork(async () => {
      started.push('first');
      await firstGate.promise;
    });
    const second = runQmdReadWork(async () => {
      started.push('second');
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual(['first', 'second']);

    firstGate.resolve();
    await Promise.all([first, second]);
  });

  it('drains active searches and rejects new searches for a model-reset worker', async () => {
    const readGate = deferred();
    const read = runQmdReadWork(async () => {
      await readGate.promise;
    });
    const reservation = reserveQmdIndexWork({ blockReads: true });

    let drained = false;
    void reservation.drained.then(() => { drained = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    await expect(runQmdReadWork(async () => undefined))
      .rejects.toThrow('QMD indexing is busy');

    readGate.resolve();
    await read;
    await reservation.drained;
    expect(drained).toBe(true);

    reservation.release();
    await expect(runQmdReadWork(async () => 'ready')).resolves.toBe('ready');
  });
});

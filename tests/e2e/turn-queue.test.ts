/**
 * E2E tests for the Main Agent Turn Queue.
 *
 * Verifies:
 * 1. Turn queue serializes concurrent main-agent turns
 * 2. Queue status is queryable
 * (applyJobResult's error bookkeeping is pinned in tests/core/cron-manager.test.ts.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

describe('Agent Turn Queue', () => {
  let enqueueMainAgentTurn: typeof import('../../src/web/agent-turn-queue.js').enqueueMainAgentTurn;
  let getQueueStatus: typeof import('../../src/web/agent-turn-queue.js').getQueueStatus;

  beforeEach(async () => {
    // Dynamic import to get fresh module after mock setup
    const mod = await import('../../src/web/agent-turn-queue.js');
    enqueueMainAgentTurn = mod.enqueueMainAgentTurn;
    getQueueStatus = mod.getQueueStatus;
  });

  it('executes tasks serially (max concurrency = 1)', async () => {
    const executionOrder: string[] = [];
    let task1Running = false;
    let task2StartedWhile1Running = false;

    const task1 = enqueueMainAgentTurn('task1', async () => {
      task1Running = true;
      executionOrder.push('task1-start');
      await new Promise((r) => setTimeout(r, 50));
      executionOrder.push('task1-end');
      task1Running = false;
      return 'result1';
    });

    const task2 = enqueueMainAgentTurn('task2', async () => {
      // If task1 is still running when task2 starts, the queue is broken
      if (task1Running) task2StartedWhile1Running = true;
      executionOrder.push('task2-start');
      await new Promise((r) => setTimeout(r, 10));
      executionOrder.push('task2-end');
      return 'result2';
    });

    const [r1, r2] = await Promise.all([task1, task2]);

    expect(r1).toBe('result1');
    expect(r2).toBe('result2');
    expect(task2StartedWhile1Running).toBe(false);
    // task1 must complete before task2 starts
    expect(executionOrder).toEqual(['task1-start', 'task1-end', 'task2-start', 'task2-end']);
  });

  it('returns correct queue status', async () => {
    // Initially empty
    const initial = getQueueStatus();
    expect(initial.active).toBe(0);
    expect(initial.queued).toBe(0);

    let resolveTask: () => void;
    const blockingTask = enqueueMainAgentTurn('blocking', () => {
      return new Promise<void>((r) => { resolveTask = r; });
    });

    // Give the queue time to pick up the task
    await new Promise((r) => setTimeout(r, 10));

    const during = getQueueStatus();
    expect(during.active).toBe(1);

    resolveTask!();
    await blockingTask;

    const after = getQueueStatus();
    expect(after.active).toBe(0);
    expect(after.queued).toBe(0);
  });

  it('propagates errors from tasks', async () => {
    const failingTask = enqueueMainAgentTurn('failing', async () => {
      throw new Error('intentional failure');
    });

    await expect(failingTask).rejects.toThrow('intentional failure');

    // Queue should be clear and accept new tasks after error
    const recovery = await enqueueMainAgentTurn('recovery', async () => 'ok');
    expect(recovery).toBe('ok');
  });

  it('handles three concurrent enqueues in order', async () => {
    const order: number[] = [];

    const p1 = enqueueMainAgentTurn('t1', async () => { order.push(1); });
    const p2 = enqueueMainAgentTurn('t2', async () => { order.push(2); });
    const p3 = enqueueMainAgentTurn('t3', async () => { order.push(3); });

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });
});

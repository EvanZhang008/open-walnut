import { describe, expect, it, vi } from 'vitest';
import { createQmdIncrementalQueue } from '../../src/core/qmd-incremental-queue.js';

describe('QMD incremental retry queue', () => {
  it('retries a failed batch without losing it', async () => {
    vi.useFakeTimers();
    try {
      const dispatch = vi.fn()
        .mockRejectedValueOnce(new Error('worker failed'))
        .mockResolvedValueOnce(undefined);
      const queue = createQmdIncrementalQueue({
        debounceMs: 10,
        retryBaseMs: 20,
        retryMaxMs: 20,
        dispatch,
      });

      queue.enqueue('task-a', 'sync');
      await vi.advanceTimersByTimeAsync(10);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenLastCalledWith(['task-a']);

      await vi.advanceTimersByTimeAsync(20);
      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(dispatch).toHaveBeenLastCalledWith(['task-a']);

      await queue.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors a worker retry floor and new events cannot accelerate it', async () => {
    vi.useFakeTimers();
    try {
      const deferred = Object.assign(new Error('embedding failed'), {
        retryAfterMs: 6 * 60 * 60_000,
      });
      const dispatch = vi.fn()
        .mockRejectedValueOnce(deferred)
        .mockResolvedValueOnce(undefined);
      const queue = createQmdIncrementalQueue({
        debounceMs: 10,
        retryBaseMs: 20,
        retryMaxMs: 20,
        dispatch,
      });

      queue.enqueue('session-a', 'sync');
      await vi.advanceTimersByTimeAsync(10);
      expect(dispatch).toHaveBeenCalledTimes(1);

      queue.enqueue('session-b', 'sync');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(dispatch).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(6 * 60 * 60_000 - 60_000);
      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(new Set(dispatch.mock.calls[1]?.[0])).toEqual(
        new Set(['session-a', 'session-b']),
      );

      await queue.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves a newer event that arrives while an older batch is in flight', async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const dispatch = vi.fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce(undefined);
    const queue = createQmdIncrementalQueue({
      debounceMs: 0,
      retryBaseMs: 0,
      retryMaxMs: 0,
      dispatch,
    });

    queue.enqueue('session-a', 'sync');
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));

    queue.enqueue('session-a', 'delete');
    releaseFirst();

    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
    expect(dispatch.mock.calls[1]).toEqual([['session-a']]);

    await queue.stop();
  });

  it('retries a failed in-flight batch together with newer events', async () => {
    let rejectFirst!: (error: Error) => void;
    const first = new Promise<void>((_, reject) => { rejectFirst = reject; });
    const dispatch = vi.fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce(undefined);
    const queue = createQmdIncrementalQueue({
      debounceMs: 0,
      retryBaseMs: 0,
      retryMaxMs: 0,
      dispatch,
    });

    queue.enqueue('task-a', 'sync');
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    queue.enqueue('task-b', 'sync');
    rejectFirst(new Error('worker failed'));

    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
    expect(new Set(dispatch.mock.calls[1]?.[0])).toEqual(
      new Set(['task-a', 'task-b']),
    );

    await queue.stop();
  });

  it('coalesces each ID to its latest operation for reporting', async () => {
    const onSuccess = vi.fn();
    const dispatch = vi.fn(async () => undefined);
    const queue = createQmdIncrementalQueue({
      debounceMs: 60_000,
      dispatch,
      onSuccess,
    });

    queue.enqueue('task-a', 'sync');
    queue.enqueue('task-a', 'delete');
    queue.enqueue('task-b', 'sync');
    await queue.flushNow();

    expect(dispatch).toHaveBeenCalledWith(['task-a', 'task-b']);
    expect(onSuccess).toHaveBeenCalledWith({
      synced: 1,
      deleted: 1,
    });

    await queue.stop();
  });

  it('holds re-syncs of the same ID until minIntervalMs elapses, then flushes the latest change', async () => {
    vi.useFakeTimers();
    try {
      const dispatch = vi.fn(async () => undefined);
      const queue = createQmdIncrementalQueue({
        debounceMs: 10,
        minIntervalMs: 1_000,
        dispatch,
      });

      // First sync of an ID dispatches at debounce cadence (no prior sync).
      queue.enqueue('session-a', 'sync');
      await vi.advanceTimersByTimeAsync(10);
      expect(dispatch).toHaveBeenCalledTimes(1);

      // Re-syncs inside the cooldown are held, not dispatched and not lost.
      queue.enqueue('session-a', 'sync');
      await vi.advanceTimersByTimeAsync(500);
      expect(dispatch).toHaveBeenCalledTimes(1);

      // Cooldown expiry flushes the held change exactly once.
      await vi.advanceTimersByTimeAsync(600);
      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(dispatch).toHaveBeenLastCalledWith(['session-a']);

      await queue.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cooldown holds one ID without delaying other IDs in the same batch', async () => {
    vi.useFakeTimers();
    try {
      const dispatch = vi.fn(async () => undefined);
      const queue = createQmdIncrementalQueue({
        debounceMs: 10,
        minIntervalMs: 1_000,
        dispatch,
      });

      queue.enqueue('session-a', 'sync');
      await vi.advanceTimersByTimeAsync(10);
      expect(dispatch).toHaveBeenCalledTimes(1);

      // session-a is cooling; a fresh session-b must not be blocked by it.
      queue.enqueue('session-a', 'sync');
      queue.enqueue('session-b', 'sync');
      await vi.advanceTimersByTimeAsync(10);
      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(dispatch).toHaveBeenLastCalledWith(['session-b']);

      // session-a still flushes after its cooldown.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(dispatch).toHaveBeenCalledTimes(3);
      expect(dispatch).toHaveBeenLastCalledWith(['session-a']);

      await queue.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('deletes bypass the cooldown', async () => {
    vi.useFakeTimers();
    try {
      const dispatch = vi.fn(async () => undefined);
      const queue = createQmdIncrementalQueue({
        debounceMs: 10,
        minIntervalMs: 60_000,
        dispatch,
      });

      queue.enqueue('session-a', 'sync');
      await vi.advanceTimersByTimeAsync(10);
      expect(dispatch).toHaveBeenCalledTimes(1);

      // Delete of a just-synced ID must not wait a minute.
      queue.enqueue('session-a', 'delete');
      await vi.advanceTimersByTimeAsync(10);
      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(dispatch).toHaveBeenLastCalledWith(['session-a']);

      await queue.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

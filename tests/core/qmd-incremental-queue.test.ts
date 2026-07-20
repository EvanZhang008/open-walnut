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
});

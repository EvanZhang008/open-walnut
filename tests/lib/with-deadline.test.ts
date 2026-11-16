import { describe, it, expect, vi, afterEach } from 'vitest';
import { withDeadline } from '../../src/lib/with-deadline.js';

afterEach(() => { vi.useRealTimers(); });

describe('withDeadline', () => {
  it('never runs onTimeout once the work has answered, even after the deadline passes', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn(() => 'fallback');
    await expect(withDeadline(Promise.resolve('value'), 5_000, onTimeout)).resolves.toBe('value');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never runs onTimeout after the work rejected', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn(() => 'fallback');
    await expect(withDeadline(Promise.reject(new Error('boom')), 5_000, onTimeout)).rejects.toThrow('boom');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('answers onTimeout once when the work outruns the deadline', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn(() => 'fallback');
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 60_000));
    const answer = withDeadline(slow, 5_000, onTimeout);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(answer).resolves.toBe('fallback');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});

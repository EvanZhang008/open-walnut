import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn(), cache: vi.fn() }));
vi.mock('../../web/src/api/sessions', () => ({ fetchSessionHistory: mocks.read, HISTORY_TAIL_LIMIT: 400 }));
vi.mock('../../web/src/cache/session-cache', () => ({ getHistoryCache: mocks.cache }));
import { primeSessionOpenHistory, takeSessionOpenHistory } from '../../web/src/api/session-open-prime';

afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });
describe('history started at the open click', () => {
  it('starts before mount and both consumers take the same response', async () => {
    vi.useFakeTimers();
    mocks.cache.mockReturnValue(null);
    const rows = Promise.resolve({ messages: [{ role: 'assistant', text: 'Latest answer' }] });
    mocks.read.mockReturnValue(rows);
    primeSessionOpenHistory('click-prime');
    primeSessionOpenHistory('click-prime');
    expect(mocks.read).toHaveBeenCalledTimes(1);
    const a = takeSessionOpenHistory('click-prime');
    const b = takeSessionOpenHistory('click-prime');
    expect(a).toBe(rows); expect(b).toBe(rows);
    await Promise.resolve();
    expect(takeSessionOpenHistory('click-prime')).toBeNull();
  });

  it('a failed first read stays handled and a later open can read again', async () => {
    vi.useFakeTimers();
    mocks.cache.mockReturnValue(null);
    mocks.read.mockReturnValueOnce(Promise.reject(new Error('host down'))).mockReturnValueOnce(Promise.resolve({ messages: [] }));
    primeSessionOpenHistory('retry-prime');
    await expect(takeSessionOpenHistory('retry-prime')).rejects.toThrow('host down');
    await Promise.resolve();
    primeSessionOpenHistory('retry-prime');
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(await takeSessionOpenHistory('retry-prime')).toEqual({ messages: [] });
  });

  it('a cached reopen starts no extra preview and another session never takes its read', async () => {
    vi.useFakeTimers();
    mocks.cache.mockReturnValue({ messages: [] });
    primeSessionOpenHistory('cached-prime');
    expect(mocks.read).not.toHaveBeenCalled();
    mocks.cache.mockReturnValue(null);
    mocks.read.mockReturnValue(Promise.resolve({ messages: [] }));
    primeSessionOpenHistory('other-prime');
    expect(takeSessionOpenHistory('wrong-prime')).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(takeSessionOpenHistory('other-prime')).toBeNull();
  });
});

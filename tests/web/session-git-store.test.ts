/**
 * The browser's shared git glance store (web/src/stores/session-git-store.ts):
 * rows mounting together ask in one request, an id read lately is not asked
 * again, a pushed event updates every row of that session, and a late answer
 * never puts back an older reading.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { SessionGitGlance } from '../../web/src/api/session-git-status';
import { SessionGitStore } from '../../web/src/stores/session-git-store';

function glance(id: string, checkedAt: string, files = 1, changedFiles: number | null = 2): SessionGitGlance {
  return {
    sessionId: id, changedFiles, checkedAt,
    repos: [{ repoRoot: '/r', branch: 'main', head: 'abc', upstream: 'origin/main', ahead: 0, behind: 0, files, untracked: 0, conflicted: 0, insertions: files, deletions: 0 }],
  };
}

let now = 0;
beforeEach(() => { vi.useFakeTimers(); now = 1_000_000; });
afterEach(() => { vi.useRealTimers(); });

describe('SessionGitStore', () => {
  it('rows mounting together are one request, and an id read lately is not asked again', async () => {
    const fetch = vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, glance(id, '2026-11-04T00:00:00Z')])));
    const store = new SessionGitStore({ fetch }, () => now);
    const l = vi.fn();
    store.subscribe('a', l);
    store.subscribe('b', l);
    store.subscribe('a', l);
    await vi.advanceTimersByTimeAsync(100);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0].sort()).toEqual(['a', 'b']);
    expect(store.get('a')?.repos[0]?.branch).toBe('main');
    expect(l).toHaveBeenCalled();
    now += 5_000;
    store.subscribe('a', vi.fn());
    await vi.advanceTimersByTimeAsync(100);
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 30_000;
    store.subscribe('a', vi.fn());
    await vi.advanceTimersByTimeAsync(100);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('an id the server has not read yet is not re-asked at once; its event fills it', async () => {
    const fetch = vi.fn(async () => ({ a: null }));
    const store = new SessionGitStore({ fetch }, () => now);
    const l = vi.fn();
    store.subscribe('a', l);
    await vi.advanceTimersByTimeAsync(100);
    store.subscribe('a', vi.fn());
    await vi.advanceTimersByTimeAsync(100);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(store.get('a')).toBeNull();
    store.apply(glance('a', '2026-11-04T00:00:05Z', 3));
    expect(store.get('a')?.repos[0]?.files).toBe(3);
    expect(l).toHaveBeenCalledTimes(1);
  });

  it('a late answer never puts back an older reading', () => {
    const store = new SessionGitStore({ fetch: vi.fn() }, () => now);
    store.apply(glance('a', '2026-11-04T00:00:10Z', 4));
    store.apply(glance('a', '2026-11-04T00:00:01Z', 1));
    expect(store.get('a')?.repos[0]?.files).toBe(4);
    expect(store.get('a')?.changedFiles).toBe(2);
    // A new Changed count is news at the same reading time.
    store.apply(glance('a', '2026-11-04T00:00:10Z', 4, 7));
    expect(store.get('a')?.changedFiles).toBe(7);
  });

  it('a failed batch is asked again on the next mount', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ a: glance('a', '2026-11-04T00:00:00Z') });
    const store = new SessionGitStore({ fetch }, () => now);
    store.subscribe('a', vi.fn());
    await vi.advanceTimersByTimeAsync(100);
    store.subscribe('a', vi.fn());
    await vi.advanceTimersByTimeAsync(100);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(store.get('a')).not.toBeNull();
  });

  it('placeholder column ids are never asked', async () => {
    const fetch = vi.fn(async () => ({}));
    const store = new SessionGitStore({ fetch }, () => now);
    store.subscribe('', vi.fn());
    await vi.advanceTimersByTimeAsync(100);
    expect(fetch).not.toHaveBeenCalled();
  });
});

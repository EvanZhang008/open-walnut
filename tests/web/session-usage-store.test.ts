import { describe, expect, it, vi } from 'vitest';
import type { SessionUsage } from '../../web/src/api/session-usage';
import { SessionUsageStore } from '../../web/src/stores/session-usage-store';

const value = (sessionId = 'session-a', revision = 1, limitUsd: number | null = 10): SessionUsage => ({
  sessionId, title: 'Session allowance', verifiedCostUsd: 2, verifiedCalls: 5, unverifiedCalls: 0,
  byAgent: [], byModel: [], checkedAt: null,
  budget: { limitUsd, spentUsd: 2, state: limitUsd === null ? 'unlimited' : 'active', reason: null, revision, updatedAt: null },
});
function deferred<T>() {
  let resolve!: (data: T) => void;
  let reject!: (error: unknown) => void;
  return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no; }), resolve, reject };
}

function harness() {
  const fetch = vi.fn().mockResolvedValue(value());
  const patch = vi.fn().mockResolvedValue(value('session-a', 2, 20));
  return { fetch, patch, store: new SessionUsageStore({ fetch, patch }) };
}

describe('session usage shared store', () => {
  it('deduplicates overlapping polls and shares the result with every surface', async () => {
    const { store, fetch } = harness();
    const read = deferred<SessionUsage>(); fetch.mockReturnValue(read.promise);
    const changed = vi.fn(); const unsubscribe = store.subscribe('session-a', changed);
    const first = store.refresh('session-a');
    expect(store.refresh('session-a')).toBe(first);
    expect(store.getSnapshot('session-a').loading).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    read.resolve(value()); await first;
    expect(store.getSnapshot('session-a')).toMatchObject({ loading: false, data: value(), error: null });
    expect(changed).toHaveBeenCalled(); unsubscribe();
  });
  it('answers Save immediately, sends lifetime limit and revision once, and never sends a prompt', async () => {
    const { store, patch } = harness(); await store.refresh('session-a');
    const write = deferred<SessionUsage>(); patch.mockReturnValue(write.promise);
    const saved = store.save('session-a', 20, 1);
    expect(store.getSnapshot('session-a').saving).toBe(true);
    expect(store.getSnapshot('session-a').data?.budget.limitUsd).toBe(10);
    expect(patch).toHaveBeenCalledWith('session-a', 20, 1);
    await expect(store.save('session-a', 30, 1)).rejects.toThrow('already saving');
    write.resolve(value('session-a', 2, 20)); await saved;
    expect(store.getSnapshot('session-a')).toMatchObject({ saving: false, data: { budget: { revision: 2, limitUsd: 20 } } });
  });
  it('aborts a pre-save poll and ignores its late answer after the write', async () => {
    const { store, fetch } = harness(); await store.refresh('session-a');
    const read = deferred<SessionUsage>(); fetch.mockReturnValue(read.promise);
    const before = store.refresh('session-a');
    const signal = fetch.mock.calls[1][1] as AbortSignal;
    await store.save('session-a', 20, 1);
    expect(signal.aborted).toBe(true);
    read.resolve(value('session-a', 1, 10)); await before;
    expect(store.getSnapshot('session-a').data?.budget.limitUsd).toBe(20);
    expect(store.getSnapshot('session-a').loading).toBe(false);
  });
  it('rejects mismatched session data and never applies one session to another', async () => {
    const { store, fetch, patch } = harness();
    fetch.mockResolvedValue(value('session-b'));
    expect(await store.refresh('session-a')).toBeNull();
    expect(store.getSnapshot('session-a').data).toBeNull();
    expect(store.getSnapshot('session-a').error).toContain('another session');
    patch.mockResolvedValue(value('session-b'));
    await expect(store.save('session-a', 20, 0)).rejects.toThrow('another session');
    expect(store.getSnapshot('session-b').data).toBeNull();
  });
  it('keeps a last good check on network failure and recovers on retry', async () => {
    const { store, fetch } = harness(); await store.refresh('session-a');
    fetch.mockRejectedValueOnce(new Error('Offline'));
    expect(await store.refresh('session-a')).toBeNull();
    expect(store.getSnapshot('session-a')).toMatchObject({ data: value(), error: 'Offline', loading: false });
    fetch.mockResolvedValue(value('session-a', 2)); await store.refresh('session-a');
    expect(store.getSnapshot('session-a').error).toBeNull();
  });
  it('keeps the confirmed budget on a rejected write and accepts explicit retry after refresh', async () => {
    const { store, fetch, patch } = harness(); await store.refresh('session-a');
    patch.mockRejectedValueOnce(Object.assign(new Error('Conflict'), { status: 409 }));
    await expect(store.save('session-a', 20, 1)).rejects.toThrow('Conflict');
    expect(store.getSnapshot('session-a').saving).toBe(false);
    expect(store.getSnapshot('session-a').data?.budget.revision).toBe(1);
    fetch.mockResolvedValue(value('session-a', 2, 15)); await store.refresh('session-a');
    patch.mockResolvedValue(value('session-a', 3, 20)); await store.save('session-a', 20, 2);
    expect(patch).toHaveBeenLastCalledWith('session-a', 20, 2);
    expect(store.getSnapshot('session-a').data?.budget.revision).toBe(3);
  });
  it('does not replace a newer known budget revision with an older polling response', async () => {
    const { store, fetch } = harness(); await store.save('session-a', 20, 1);
    fetch.mockResolvedValue(value('session-a', 1, 10)); await store.refresh('session-a');
    expect(store.getSnapshot('session-a').data?.budget.revision).toBe(2);
  });
  it('holds unrelated session snapshots independently and removes a lifetime limit with null', async () => {
    const { store, fetch, patch } = harness();
    fetch.mockImplementation(async (sid: string) => value(sid));
    await store.refresh('session-a'); await store.refresh('session-b');
    patch.mockResolvedValue(value('session-b', 2, null)); await store.save('session-b', null, 1);
    expect(patch).toHaveBeenLastCalledWith('session-b', null, 1);
    expect(store.getSnapshot('session-a').data?.budget.limitUsd).toBe(10);
    expect(store.getSnapshot('session-b').data?.budget.limitUsd).toBeNull();
  });
});

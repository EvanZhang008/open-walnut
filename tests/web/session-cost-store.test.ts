/**
 * The browser's copy of each session's cost (web/src/stores/session-cost-store.ts): saved and
 * restored across reloads, bounded, tolerant of a bad saved copy, and a `pending` answer never
 * replaces a known number.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { COST_STORE_KEY, COST_STORE_MAX, SessionCostStore } from '../../web/src/stores/session-cost-store';
import type { SessionCost } from '../../web/src/api/session-cost';

function cost(sessionId: string, status: SessionCost['status'], totalUsd: number | null = 102.31): SessionCost {
  return { sessionId, engine: 'codex', source: 'codex-rollout', status, totalUsd, responses: 3, unpricedResponses: 0, models: [],
    prices: { source: 'litellm' } };
}

function memoryStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: vi.fn((k: string, v: string) => { data.set(k, v); }),
    removeItem: (k: string) => { data.delete(k); },
  };
}

afterEach(() => { vi.useRealTimers(); });

describe('session cost store', () => {
  it('a reload shows the last finished read in its first snapshot', async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const first = new SessionCostStore({ fetch: async (id) => cost(id, 'priced') }, storage);
    await first.refresh('s1');
    await vi.advanceTimersByTimeAsync(300);
    expect(storage.setItem).toHaveBeenCalledTimes(1);

    const reloaded = new SessionCostStore({ fetch: () => new Promise(() => {}) }, storage);
    expect(reloaded.getSnapshot('s1').cost?.totalUsd).toBe(102.31);
    expect(reloaded.getSnapshot('s1')).toBe(reloaded.getSnapshot('s1'));
    expect(reloaded.getSnapshot('nope').cost).toBeNull();
  });

  it('a pending answer never replaces a priced one; the next finished read swaps in', async () => {
    let answer = cost('s1', 'priced', 102.31);
    const store = new SessionCostStore({ fetch: async () => answer });
    await store.refresh('s1');
    answer = cost('s1', 'pending', null);
    await store.refresh('s1');
    expect(store.getSnapshot('s1').cost?.status).toBe('priced');
    answer = cost('s1', 'unavailable', null);
    await store.refresh('s1');
    expect(store.getSnapshot('s1').cost?.totalUsd).toBe(102.31);
    answer = cost('s1', 'priced', 110);
    await store.refresh('s1');
    expect(store.getSnapshot('s1').cost?.totalUsd).toBe(110);
  });

  it('with nothing known, a pending answer shows (the toggle says it is reading)', async () => {
    const store = new SessionCostStore({ fetch: async (id) => cost(id, 'pending', null) });
    await store.refresh('s1');
    expect(store.getSnapshot('s1').cost?.status).toBe('pending');
  });

  it('keeps the newest sessions only, and saves no pending answer', async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const store = new SessionCostStore({ fetch: async (id) => cost(id, id === 'p' ? 'pending' : 'priced') }, storage);
    for (let i = 0; i < COST_STORE_MAX + 5; i++) await store.refresh(`s${i}`);
    await store.refresh('p');
    await vi.advanceTimersByTimeAsync(300);
    const saved = JSON.parse(storage.data.get(COST_STORE_KEY)!) as { entries: [string, SessionCost][] };
    expect(saved.entries).toHaveLength(COST_STORE_MAX);
    expect(saved.entries[0]![0]).toBe('s5');
    expect(saved.entries.map(([id]) => id)).not.toContain('p');
  });

  it('a saved copy it cannot read is ignored', () => {
    for (const bad of ['{not json', '[]', JSON.stringify({ entries: [['s1', { status: 'priced' }], 'x', ['s2', cost('s2', 'pending')]] })]) {
      const store = new SessionCostStore({ fetch: () => new Promise(() => {}) }, memoryStorage({ [COST_STORE_KEY]: bad }));
      expect(store.getSnapshot('s1').cost).toBeNull();
      expect(store.getSnapshot('s2').cost).toBeNull();
    }
  });

  it('one read per session at a time; it is aborted only when every caller let go', async () => {
    const signals: AbortSignal[] = [];
    const fetch = vi.fn((_id: string, signal: AbortSignal) => { signals.push(signal); return new Promise<SessionCost>(() => {}); });
    const store = new SessionCostStore({ fetch });
    const a = new AbortController();
    const b = new AbortController();
    void store.refresh('s1', a.signal);
    void store.refresh('s1', b.signal);
    expect(fetch).toHaveBeenCalledTimes(1);
    a.abort();
    expect(signals[0]!.aborted).toBe(false);
    b.abort();
    expect(signals[0]!.aborted).toBe(true);
    // The pill's warm-up holds its read to the end, whoever else lets go.
    const c = new AbortController();
    void store.refresh('s2');
    void store.refresh('s2', c.signal);
    c.abort();
    expect(signals[1]!.aborted).toBe(false);
  });

  it('warm-ups run one at a time across the page, and one whose pill left is dropped', async () => {
    const pending = new Map<string, (c: SessionCost) => void>();
    const signals = new Map<string, AbortSignal>();
    const fetch = vi.fn((id: string, signal: AbortSignal) => new Promise<SessionCost>((resolve, reject) => {
      pending.set(id, resolve);
      signals.set(id, signal);
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const store = new SessionCostStore({ fetch });
    const [a, b, c] = [new AbortController(), new AbortController(), new AbortController()];
    store.prefetch('s1', a.signal);
    store.prefetch('s2', b.signal);
    store.prefetch('s2', b.signal);
    store.prefetch('s3', c.signal);
    expect(fetch.mock.calls.map(([id]) => id)).toEqual(['s1']);
    b.abort();
    pending.get('s1')!(cost('s1', 'priced'));
    await vi.waitFor(() => expect(fetch.mock.calls.map(([id]) => id)).toEqual(['s1', 's3']));
    // The running one is aborted with its pill.
    c.abort();
    expect(signals.get('s3')!.aborted).toBe(true);
    expect(store.getSnapshot('s1').cost?.totalUsd).toBe(102.31);
  });

  it('a save keeps what another tab saved meanwhile', async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const tabA = new SessionCostStore({ fetch: async (id) => cost(id, 'priced', 1) }, storage);
    const tabB = new SessionCostStore({ fetch: async (id) => cost(id, 'priced', 2) }, storage);
    await tabA.refresh('a1');
    await vi.advanceTimersByTimeAsync(300);
    await tabB.refresh('b1');
    await vi.advanceTimersByTimeAsync(300);
    const saved = JSON.parse(storage.data.get(COST_STORE_KEY)!) as { entries: [string, SessionCost][] };
    expect(saved.entries.map(([id, c]) => [id, c.totalUsd])).toEqual([['a1', 1], ['b1', 2]]);
  });

  it('a failed read keeps the known number and says why only when there is none', async () => {
    let fail = false;
    const store = new SessionCostStore({ fetch: async (id) => { if (fail) throw new Error('down'); return cost(id, 'priced'); } });
    fail = true;
    await store.refresh('s0');
    expect(store.getSnapshot('s0')).toEqual({ cost: null, error: 'could not be read' });
    fail = false;
    await store.refresh('s1');
    fail = true;
    await store.refresh('s1');
    expect(store.getSnapshot('s1').cost?.totalUsd).toBe(102.31);
  });
});

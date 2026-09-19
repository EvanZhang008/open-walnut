/**
 * The recap-tip store: the merge between a session record and the live
 * `session:recap-updated` copy, the text-only dismissal identity, and the
 * storage key staying out of the cross-device ui-prefs mirror.
 *
 * Node env: localStorage is stubbed; the WS client and the ui-prefs-sync
 * module's API imports are mocked so the real predicate can be imported.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

class FakeStorage {
  private store = new Map<string, string>();
  get length() { return this.store.size; }
  key(i: number) { return [...this.store.keys()][i] ?? null; }
  getItem(k: string) { return this.store.get(k) ?? null; }
  setItem(k: string, v: string) { this.store.set(k, v); }
  removeItem(k: string) { this.store.delete(k); }
  clear() { this.store.clear(); }
}
const localStorage = new FakeStorage();
Object.defineProperty(globalThis, 'localStorage', { value: localStorage, writable: true, configurable: true });

const onEvent = vi.fn();
vi.mock('../../web/src/api/ws', () => ({ wsClient: { onEvent: (...args: unknown[]) => onEvent(...args) } }));
vi.mock('../../web/src/api/client', () => ({ apiGet: async () => ({ prefs: {} }), apiPut: async () => ({}) }));
vi.mock('../../web/src/api/device-token', () => ({ getDeviceToken: () => null }));

const {
  recapTipStore, recapTipVersion, initRecapTipStore, RECAP_DISMISSED_KEY,
} = await import('../../web/src/stores/recap-tip-store');
const { syncable } = await import('../../web/src/utils/ui-prefs-sync');

const SID = 'sess-a';
const T0 = '2026-09-18T09:00:00.000Z';
const T1 = '2026-09-18T09:30:00.000Z';

beforeEach(() => {
  localStorage.clear();
  recapTipStore.reset();
});

describe('recapTipStore.resolve: record merged with the live copy', () => {
  it('a record alone is returned as is; nothing is invented', () => {
    expect(recapTipStore.resolve(SID, { recap: 'r', recapAt: T0 })).toEqual({ recap: 'r', recapAt: T0 });
    expect(recapTipStore.resolve(SID, null)).toEqual({});
    expect(recapTipStore.resolve(SID, { recap: '', overview: '' })).toEqual({});
  });

  it('a live event newer than the record wins per field, and fills in a record that has no copy yet', () => {
    recapTipStore.ingestEvent({ sessionId: SID, recap: 'r1', recapAt: T1 });
    // Event before the record's first fetch: the tip still shows.
    expect(recapTipStore.resolve(SID, null)).toEqual({ recap: 'r1', recapAt: T1 });
    // Record fetched later but older (the fetch was in flight when the event landed).
    expect(recapTipStore.resolve(SID, { recap: 'r0', recapAt: T0, overview: 'o0', overviewAt: T0 }))
      .toEqual({ recap: 'r1', recapAt: T1, overview: 'o0', overviewAt: T0 });
  });

  it('a record refetched AFTER the event carries the same or a newer stamp and is not overridden', () => {
    recapTipStore.ingestEvent({ sessionId: SID, recap: 'r1', recapAt: T1 });
    const later = '2026-09-18T10:00:00.000Z';
    expect(recapTipStore.resolve(SID, { recap: 'r2', recapAt: later })).toEqual({ recap: 'r2', recapAt: later });
    expect(recapTipStore.resolve(SID, { recap: 'r1', recapAt: T1 })).toEqual({ recap: 'r1', recapAt: T1 });
  });

  it('events for another session do not leak; malformed events are ignored', () => {
    recapTipStore.ingestEvent({ sessionId: 'sess-b', recap: 'theirs', recapAt: T1 });
    recapTipStore.ingestEvent({ sessionId: SID });
    recapTipStore.ingestEvent(null);
    recapTipStore.ingestEvent({ recap: 'no id' });
    expect(recapTipStore.resolve(SID, { recap: 'mine', recapAt: T0 })).toEqual({ recap: 'mine', recapAt: T0 });
  });

  it('an overview-only event keeps the recap the previous event carried', () => {
    recapTipStore.ingestEvent({ sessionId: SID, recap: 'r1', recapAt: T1 });
    recapTipStore.ingestEvent({ sessionId: SID, overview: 'o1', overviewAt: T1 });
    expect(recapTipStore.resolve(SID, null)).toEqual({ recap: 'r1', recapAt: T1, overview: 'o1', overviewAt: T1 });
  });
});

describe('dismissal', () => {
  it('is keyed by the two texts only: a re-stamped identical tip stays hidden, new text shows', () => {
    const v = recapTipVersion({ overview: 'o', recap: 'r' });
    expect(recapTipVersion({ overview: 'o', recap: 'r' })).toBe(v);
    expect(recapTipVersion({ overview: 'o', recap: 'r2' })).not.toBe(v);
    expect(recapTipVersion({ overview: 'o2', recap: 'r' })).not.toBe(v);
    expect(recapTipVersion({ recap: 'r' })).not.toBe(v);
    recapTipStore.dismiss(SID, v);
    expect(recapTipStore.isDismissed(SID, v)).toBe(true);
    expect(recapTipStore.isDismissed('sess-b', v)).toBe(false);
    expect(recapTipStore.isDismissed(SID, recapTipVersion({ overview: 'o', recap: 'r2' }))).toBe(false);
  });

  it('survives a fresh store (reload) through localStorage and tolerates corrupt storage', () => {
    const v = recapTipVersion({ recap: 'r' });
    recapTipStore.dismiss(SID, v);
    recapTipStore.reset();
    expect(recapTipStore.isDismissed(SID, v)).toBe(true);
    localStorage.setItem(RECAP_DISMISSED_KEY, '{not json');
    recapTipStore.reset();
    expect(recapTipStore.isDismissed(SID, v)).toBe(false);
    recapTipStore.dismiss(SID, v); // and can write again over the corrupt value
    expect(JSON.parse(localStorage.getItem(RECAP_DISMISSED_KEY)!)).toEqual({ [SID]: v });
  });

  it('keeps the newest 200 sessions and drops the oldest', () => {
    for (let i = 0; i < 205; i++) recapTipStore.dismiss(`s${i}`, 'v');
    const stored = JSON.parse(localStorage.getItem(RECAP_DISMISSED_KEY)!) as Record<string, string>;
    expect(Object.keys(stored)).toHaveLength(200);
    expect(stored.s0).toBeUndefined();
    expect(stored.s4).toBeUndefined();
    expect(stored.s5).toBe('v');
    expect(stored.s204).toBe('v');
    // Re-dismissing an old session makes it the newest again.
    recapTipStore.dismiss('s5', 'v2');
    for (let i = 205; i < 210; i++) recapTipStore.dismiss(`s${i}`, 'v');
    const after = JSON.parse(localStorage.getItem(RECAP_DISMISSED_KEY)!) as Record<string, string>;
    expect(after.s5).toBe('v2');
    expect(after.s6).toBeUndefined();
  });

  it('the storage key is device-local: never mirrored into the synced ui-prefs file', () => {
    expect(syncable(RECAP_DISMISSED_KEY)).toBe(false);
  });
});

describe('initRecapTipStore', () => {
  it('registers the ONE WS subscription once', () => {
    initRecapTipStore();
    initRecapTipStore();
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][0]).toBe('session:recap-updated');
    // The handler feeds the store.
    (onEvent.mock.calls[0][1] as (d: unknown) => void)({ sessionId: SID, recap: 'via ws', recapAt: T1 });
    expect(recapTipStore.resolve(SID, null)).toEqual({ recap: 'via ws', recapAt: T1 });
  });
});

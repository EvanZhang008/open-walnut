/**
 * The recap-tip store: the merge between a session record and the live
 * `session:recap-updated` copy, and its single WS subscription.
 *
 * Node env: the WS client is mocked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const onEvent = vi.fn();
vi.mock('../../web/src/api/ws', () => ({ wsClient: { onEvent: (...args: unknown[]) => onEvent(...args) } }));
vi.mock('../../web/src/api/client', () => ({ apiGet: async () => ({ prefs: {} }), apiPut: async () => ({}) }));
vi.mock('../../web/src/api/device-token', () => ({ getDeviceToken: () => null }));

const { recapTipStore, initRecapTipStore } = await import('../../web/src/stores/recap-tip-store');

const SID = 'sess-a';
const T0 = '2026-09-18T09:00:00.000Z';
const T1 = '2026-09-18T09:30:00.000Z';

beforeEach(() => {
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

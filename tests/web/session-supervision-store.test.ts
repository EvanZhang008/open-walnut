/**
 * session-supervision store — the shared state behind the auto-restart toggle and
 * the Stop button. Both Homepage session columns and the Ask Walnut slot mount the
 * same controls for the same session id, so the invariants no browser spec can see
 * are exactly these: one entry per sid (one poll, one truth), a mutation is never
 * overwritten by a GET that was already in flight, and a stop distinguishes
 * "requesting" from "waiting for the host" from "host confirmed".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionSupervision } from '@/api/sessions';

const api = vi.hoisted(() => ({
  fetchSessionSupervision: vi.fn<(sid: string) => Promise<SessionSupervision>>(),
  setSessionSupervision: vi.fn<(sid: string, enabled: boolean) => Promise<SessionSupervision>>(),
  terminateSession: vi.fn<(sid: string, opts?: { force?: boolean }) => Promise<{ status: 'terminated' | 'pending'; sessionId: string }>>(),
}));

vi.mock('@/api/sessions', () => api);

import {
  getSessionSupervision,
  subscribeSessionSupervision,
  refreshSessionSupervision,
  changeSessionSupervision,
  stopSupervisedSession,
} from '@/stores/session-supervision-store';

type SupState = NonNullable<SessionSupervision['supervision']>['state'];

function sup(o: {
  enabled?: boolean;
  state?: SupState;
  stop?: 'pending' | 'confirmed' | null;
  generation?: number;
} = {}): SessionSupervision {
  const stop = o.stop ?? null;
  const enabled = o.enabled ?? false;
  return {
    available: true,
    startup: 'login',
    stopRequest: stop ? { id: 'stop-req-1', requestedAt: '2026-09-10T00:00:00.000Z', state: stop } : null,
    supervision: {
      enabled,
      state: o.state ?? (enabled ? 'watching' : 'disabled'),
      reason: null,
      generation: o.generation ?? 1,
      retryAt: null,
      updatedAt: 1_757_000_000_000,
    },
  };
}

// Deep clone at every API boundary crossing, so the store and the fixture never share objects that would hide a bug.
const clone = <T>(v: T): T => structuredClone(v);
const serveGet = (v: SessionSupervision) => api.fetchSessionSupervision.mockImplementation(async () => clone(v));
const servePut = (v: SessionSupervision) => api.setSessionSupervision.mockImplementation(async () => clone(v));
const serveStop = (status: 'terminated' | 'pending', sid: string) =>
  api.terminateSession.mockImplementation(async () => ({ status, sessionId: sid }));

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Advance microtasks only; never sleep in real time. */
const flush = async (n = 8): Promise<void> => { for (let i = 0; i < n; i++) await Promise.resolve(); };

const offs: Array<() => void> = [];

function reader(sid: string) {
  const r = {
    notified: 0,
    get snap() { return getSessionSupervision(sid); },
    off: () => {},
  };
  const off = subscribeSessionSupervision(sid, () => { r.notified++; });
  r.off = off;
  offs.push(off);
  return r;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks(); // also clears any *Once queue left over from the previous case
  serveGet(sup());
  servePut(sup());
  api.terminateSession.mockImplementation(async (sid) => ({ status: 'terminated', sessionId: sid }));
});

afterEach(() => {
  while (offs.length) offs.pop()!();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('session-supervision store — one entry per session id', () => {
  it('serves two subscribers of the SAME sid from one fetch and one snapshot object', async () => {
    const SID = 'sess-share-1';
    const g = deferred<SessionSupervision>();
    api.fetchSessionSupervision.mockReturnValueOnce(g.promise);
    const column = reader(SID);
    const askSlot = reader(SID);

    expect(api.fetchSessionSupervision).toHaveBeenCalledTimes(1);
    expect(column.snap.loading).toBe(true);
    expect(column.snap).toBe(askSlot.snap);

    g.resolve(clone(sup({ enabled: true })));
    await flush();

    expect(column.snap).toBe(askSlot.snap);
    expect(column.snap.value?.supervision?.enabled).toBe(true);
    expect(column.snap.loading).toBe(false);
    expect(column.snap.unavailable).toBe(false);
    expect(column.notified).toBe(1);
    expect(askSlot.notified).toBe(1);
  });

  it('keeps different sids isolated, and an unsubscribed sid reads the empty snapshot', async () => {
    const A = 'sess-iso-a';
    const B = 'sess-iso-b';
    api.fetchSessionSupervision.mockImplementation(async (sid) =>
      clone(sid === A ? sup({ enabled: true }) : sup({ enabled: false, stop: 'pending' })));
    const a = reader(A);
    const b = reader(B);
    await flush();

    expect(api.fetchSessionSupervision.mock.calls.map((c) => c[0])).toEqual([A, B]);
    expect(a.snap.value?.supervision?.enabled).toBe(true);
    expect(a.snap.stopPending).toBe(false);
    expect(b.snap.value?.supervision?.enabled).toBe(false);
    expect(b.snap.stopPending).toBe(true);

    servePut(sup({ enabled: false, state: 'disabled', generation: 7 }));
    await changeSessionSupervision(A, false);
    expect(a.snap.value?.supervision?.generation).toBe(7);
    expect(b.snap.value?.supervision?.generation).toBe(1);
    expect(b.snap.stopPending).toBe(true);

    const never = getSessionSupervision('sess-never-mounted');
    expect(never.value).toBeNull();
    expect(never.loading).toBe(true);
    expect(never.unavailable).toBe(false);
  });
});

describe('session-supervision store — toggle (PUT)', () => {
  it('shows the requested value to both readers without claiming it took effect', async () => {
    const SID = 'sess-put-pending';
    serveGet(sup({ enabled: false }));
    const column = reader(SID);
    const askSlot = reader(SID);
    await flush();

    const put = deferred<SessionSupervision>();
    api.setSessionSupervision.mockReturnValueOnce(put.promise);
    const pending = changeSessionSupervision(SID, true);

    expect(column.snap.writing).toBe(true);
    expect(column.snap.requestedEnabled).toBe(true);
    expect(askSlot.snap).toBe(column.snap);
    // While awaiting confirmation it still reports the server's old value: it must not claim the change took effect.
    expect(column.snap.value?.supervision?.enabled).toBe(false);
    expect(column.snap.value?.supervision?.state).toBe('disabled');

    // A second click during the write (from another surface) must not send another PUT.
    await changeSessionSupervision(SID, false);
    expect(api.setSessionSupervision).toHaveBeenCalledTimes(1);

    put.resolve(clone(sup({ enabled: true, state: 'watching', generation: 2 })));
    await pending;

    expect(api.setSessionSupervision).toHaveBeenCalledWith(SID, true);
    expect(column.snap.requestedEnabled).toBeNull();
    expect(column.snap.writing).toBe(false);
    expect(column.snap.value?.supervision?.enabled).toBe(true);
    expect(column.snap.value?.supervision?.generation).toBe(2);
    expect(askSlot.snap).toBe(column.snap);
  });

  it('a failed PUT keeps the server value, survives a successful poll, and clears on the next mutation', async () => {
    const SID = 'sess-put-fail';
    serveGet(sup({ enabled: false }));
    const r = reader(SID);
    await flush();

    api.setSessionSupervision.mockRejectedValueOnce(new Error('503 supervisor busy'));
    await changeSessionSupervision(SID, true);

    expect(r.snap.error).toBe('503 supervisor busy');
    expect(r.snap.requestedEnabled).toBeNull();
    expect(r.snap.writing).toBe(false);
    expect(r.snap.value?.supervision?.enabled).toBe(false);
    // A failed PUT does not mean the host is unreachable.
    expect(r.snap.unavailable).toBe(false);

    await refreshSessionSupervision(SID);
    expect(r.snap.error).toBe('503 supervisor busy');
    expect(r.snap.unavailable).toBe(false);

    servePut(sup({ enabled: true, state: 'watching', generation: 3 }));
    await changeSessionSupervision(SID, true);
    expect(r.snap.error).toBeNull();
    expect(r.snap.value?.supervision?.enabled).toBe(true);
    expect(r.snap.value?.supervision?.generation).toBe(3);
  });

  it('a GET that was already in flight cannot overwrite the PUT that landed first', async () => {
    const SID = 'sess-stale-get';
    const g = deferred<SessionSupervision>();
    api.fetchSessionSupervision.mockReturnValueOnce(g.promise);
    const r = reader(SID);

    servePut(sup({ enabled: true, state: 'watching', generation: 5 }));
    await changeSessionSupervision(SID, true);
    expect(r.snap.value?.supervision?.generation).toBe(5);

    g.resolve(clone(sup({ enabled: false, state: 'disabled', generation: 1 })));
    await flush();

    expect(r.snap.value?.supervision?.enabled).toBe(true);
    expect(r.snap.value?.supervision?.generation).toBe(5);
    expect(r.snap.loading).toBe(false);
    expect(api.fetchSessionSupervision).toHaveBeenCalledTimes(1);
  });

  it('defers a refresh requested during a write, then runs it exactly once afterwards', async () => {
    const SID = 'sess-defer-get';
    serveGet(sup({ enabled: false, generation: 1 }));
    const r = reader(SID);
    await flush();
    expect(api.fetchSessionSupervision).toHaveBeenCalledTimes(1);

    const put = deferred<SessionSupervision>();
    api.setSessionSupervision.mockReturnValueOnce(put.promise);
    const pending = changeSessionSupervision(SID, true);

    await refreshSessionSupervision(SID);
    await refreshSessionSupervision(SID);
    expect(api.fetchSessionSupervision).toHaveBeenCalledTimes(1);

    serveGet(sup({ enabled: true, state: 'watching', generation: 9 }));
    put.resolve(clone(sup({ enabled: true, state: 'checking', generation: 8 })));
    await pending;
    await flush();

    expect(api.fetchSessionSupervision).toHaveBeenCalledTimes(2);
    expect(r.snap.value?.supervision?.generation).toBe(9);
    expect(r.snap.writing).toBe(false);
  });
});

describe('session-supervision store — subscription lifecycle', () => {
  it('unsubscribing stops the poll and releases the entry; reopening fetches again', async () => {
    const SID = 'sess-reopen';
    serveGet(sup({ enabled: true, generation: 1 }));
    const first = reader(SID);
    await flush();
    expect(api.fetchSessionSupervision).toHaveBeenCalledTimes(1);
    const notifiedWhenClosed = first.notified;

    first.off();
    await vi.advanceTimersByTimeAsync(45_000);
    await flush();
    expect(api.fetchSessionSupervision).toHaveBeenCalledTimes(1);
    expect(first.notified).toBe(notifiedWhenClosed);
    // After release it returns to an empty snapshot: a reader that reopens sees loading, not a stale value someone else left.
    expect(getSessionSupervision(SID).value).toBeNull();
    expect(getSessionSupervision(SID).loading).toBe(true);

    serveGet(sup({ enabled: false, state: 'disabled', generation: 2 }));
    const second = reader(SID);
    expect(api.fetchSessionSupervision).toHaveBeenCalledTimes(2);
    await flush();
    expect(second.snap.value?.supervision?.generation).toBe(2);

    await vi.advanceTimersByTimeAsync(15_000);
    await flush();
    expect(api.fetchSessionSupervision).toHaveBeenCalledTimes(3);
  });
});

describe('session-supervision store — stop', () => {
  it('separates requesting, waiting for the host, and host-confirmed', async () => {
    const SID = 'sess-stop-states';
    serveGet(sup({ enabled: true }));
    const r = reader(SID);
    await flush();

    const term = deferred<{ status: 'terminated' | 'pending'; sessionId: string }>();
    api.terminateSession.mockReturnValueOnce(term.promise);
    const stopping = stopSupervisedSession(SID, true);

    // 1) Request in flight
    expect(r.snap.stopping).toBe(true);
    expect(r.snap.writing).toBe(true);
    expect(r.snap.stopPending).toBe(false);

    // 2) Awaiting host confirmation
    serveGet(sup({ enabled: true, state: 'watching', stop: 'pending' }));
    term.resolve({ status: 'pending', sessionId: SID });
    await stopping;

    expect(api.terminateSession).toHaveBeenCalledWith(SID, { force: true });
    expect(r.snap.stopping).toBe(false);
    expect(r.snap.writing).toBe(false);
    expect(r.snap.stopPending).toBe(true);
    expect(r.snap.value?.stopRequest?.state).toBe('pending');

    // 3) Host confirmed
    serveGet(sup({ enabled: false, state: 'inactive', stop: 'confirmed' }));
    await refreshSessionSupervision(SID);
    expect(r.snap.stopPending).toBe(false);
    expect(r.snap.value?.stopRequest?.state).toBe('confirmed');
    expect(r.snap.value?.supervision?.state).toBe('inactive');
  });

  it('re-reads the record after a terminated stop and drops the pending flag', async () => {
    const SID = 'sess-stop-confirmed';
    serveGet(sup({ enabled: true, stop: 'pending' }));
    const r = reader(SID);
    await flush();
    expect(r.snap.stopPending).toBe(true);

    serveStop('terminated', SID);
    serveGet(sup({ enabled: false, state: 'inactive', stop: 'confirmed', generation: 4 }));
    await stopSupervisedSession(SID);

    expect(api.fetchSessionSupervision).toHaveBeenCalledTimes(2);
    expect(r.snap.stopPending).toBe(false);
    expect(r.snap.stopping).toBe(false);
    expect(r.snap.value?.supervision?.state).toBe('inactive');
    expect(r.snap.value?.supervision?.generation).toBe(4);
    expect(r.snap.error).toBeNull();
    expect(r.snap.unavailable).toBe(false);
  });

  it('keeps stopPending when the follow-up read cannot reach the host', async () => {
    const SID = 'sess-stop-offline';
    serveGet(sup({ enabled: true }));
    const r = reader(SID);
    await flush();

    serveStop('pending', SID);
    api.fetchSessionSupervision.mockRejectedValue(new Error('daemon unreachable'));
    await stopSupervisedSession(SID);

    expect(r.snap.stopPending).toBe(true);
    expect(r.snap.stopping).toBe(false);
    expect(r.snap.writing).toBe(false);
    expect(r.snap.unavailable).toBe(true);
    expect(r.snap.error).toBe('daemon unreachable');
    // The last known record is kept, so the UI does not go blank after one failed read.
    expect(r.snap.value?.supervision?.enabled).toBe(true);
  });

  it('a failed stop is not swallowed by the refresh that follows it, and clears only on the next mutation', async () => {
    const SID = 'sess-stop-fail';
    serveGet(sup({ enabled: true }));
    const r = reader(SID);
    await flush();

    api.terminateSession.mockRejectedValueOnce(new Error('terminate refused: 409 cron_owner'));
    await expect(stopSupervisedSession(SID)).rejects.toThrow(/cron_owner/);

    expect(r.snap.error).toBe('terminate refused: 409 cron_owner');
    expect(r.snap.stopping).toBe(false);
    expect(r.snap.writing).toBe(false);
    expect(r.snap.stopPending).toBe(false);
    // That successful refresh proves the host is reachable, but it must not swallow the stop failure.
    expect(r.snap.unavailable).toBe(false);
    expect(api.fetchSessionSupervision).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(15_000);
    await flush();
    expect(r.snap.error).toBe('terminate refused: 409 cron_owner');

    serveStop('pending', SID);
    serveGet(sup({ enabled: true, stop: 'pending' }));
    await stopSupervisedSession(SID);
    expect(r.snap.error).toBeNull();
    expect(r.snap.stopPending).toBe(true);
  });

  it('a GET already in flight when stop starts neither overwrites it nor replaces the mandatory re-read', async () => {
    const SID = 'sess-stop-stale-get';
    serveGet(sup({ enabled: true, stop: 'pending', generation: 9 }));
    const g = deferred<SessionSupervision>();
    api.fetchSessionSupervision.mockReturnValueOnce(g.promise);
    const r = reader(SID);

    serveStop('pending', SID);
    const stopping = stopSupervisedSession(SID);
    await flush();

    g.resolve(clone(sup({ enabled: true, state: 'watching', stop: null, generation: 1 })));
    await stopping;
    await flush();

    expect(api.fetchSessionSupervision).toHaveBeenCalledTimes(2);
    expect(r.snap.stopPending).toBe(true);
    expect(r.snap.value?.stopRequest?.state).toBe('pending');
    expect(r.snap.value?.supervision?.generation).toBe(9);
  });
});

describe('session-supervision store — read failures', () => {
  it('marks the session unavailable on a timed-out GET and recovers on the next poll', async () => {
    const SID = 'sess-get-timeout';
    api.fetchSessionSupervision.mockRejectedValueOnce(new Error('Request timed out after 8000ms'));
    const r = reader(SID);
    await flush();

    expect(r.snap.loading).toBe(false);
    expect(r.snap.unavailable).toBe(true);
    expect(r.snap.error).toBe('Request timed out after 8000ms');
    expect(r.snap.value).toBeNull();

    serveGet(sup({ enabled: true, generation: 2 }));
    await vi.advanceTimersByTimeAsync(15_000);
    await flush();

    expect(api.fetchSessionSupervision).toHaveBeenCalledTimes(2);
    expect(r.snap.unavailable).toBe(false);
    expect(r.snap.error).toBeNull();
    expect(r.snap.value?.supervision?.enabled).toBe(true);
    expect(r.snap.value?.supervision?.generation).toBe(2);
  });
});

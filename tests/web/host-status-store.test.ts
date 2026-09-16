/**
 * Host connect-status store — the shared truth behind the picker's host tabs,
 * Settings › Remote hosts and the notification System pane.
 *
 * What matters here is everything a browser test cannot see, because it all comes
 * from the transport rather than from a click: four surfaces mounting at once cost
 * ONE request; a push updates every surface without a request; a push that arrives
 * out of order (behind a re-hydrate) must not rewind the UI to an older phase; and
 * a reconnect must RE-READ, because the server keeps no event buffer, so every
 * transition during the disconnect window is gone for good.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { HostStatus } from '@/api/hosts';

const hostsApi = vi.hoisted(() => ({
  fetchHostStatus: vi.fn<() => Promise<HostStatus[]>>(),
  connectHost: vi.fn<(host: string) => Promise<HostStatus>>(),
}));

// A stand-in for the WS singleton that lets the test BE the server: every
// module-scope onEvent registration is captured and can be fired by name.
const ws = vi.hoisted(() => {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    handlers,
    wsClient: {
      state: 'connected' as 'connecting' | 'connected' | 'disconnected',
      onEvent(name: string, cb: (data: unknown) => void) {
        let set = handlers.get(name);
        if (!set) { set = new Set(); handlers.set(name, set); }
        set.add(cb);
      },
      offEvent(name: string, cb: (data: unknown) => void) {
        handlers.get(name)?.delete(cb);
      },
    },
    emit(name: string, data: unknown) {
      for (const cb of handlers.get(name) ?? []) cb(data);
    },
  };
});

vi.mock('@/api/hosts', () => hostsApi);
vi.mock('@/api/ws', () => ({ wsClient: ws.wsClient }));

import {
  __resetHostStatusForTests,
  getAllHostStatus,
  getHostStatus,
  getHostStatusHydration,
  hasSeenHostStatusPush,
  hydrateHostStatus,
  seedHostStatus,
  subscribeHostStatus,
} from '@/hooks/useHostStatus';

let clock = 1_800_000_000_000;

function status(o: Partial<HostStatus> & { host: string }): HostStatus {
  return {
    label: o.host,
    hostname: `${o.host}.example.com`,
    connected: false,
    phase: 'ssh',
    phaseLabel: `Opening an SSH connection to ${o.host}…`,
    steps: [],
    phaseElapsedMs: 0,
    connectElapsedMs: 0,
    at: clock,
    ...o,
  };
}

/** Only microtasks — no real sleeping. */
const flush = async (n = 8): Promise<void> => { for (let i = 0; i < n; i++) await Promise.resolve(); };

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const offs: Array<() => void> = [];
function reader() {
  const r = { notified: 0, off: () => {} };
  r.off = subscribeHostStatus(() => { r.notified++; });
  offs.push(r.off);
  return r;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(clock);
  vi.resetAllMocks();
  __resetHostStatusForTests();
  hostsApi.fetchHostStatus.mockResolvedValue([]);
});

afterEach(() => {
  while (offs.length) offs.pop()!();
  vi.useRealTimers();
});

describe('host-status store — hydrate', () => {
  it('populates every host from one GET and serves both hooks and imperative reads', async () => {
    hostsApi.fetchHostStatus.mockResolvedValue([
      status({ host: 'devbox', connected: true, phase: 'connected', phaseLabel: 'Connected' }),
      status({ host: 'marina', phase: 'install-runtime', phaseLabel: 'Installing the session daemon runtime on marina…' }),
    ]);

    await hydrateHostStatus();

    expect(hostsApi.fetchHostStatus).toHaveBeenCalledTimes(1);
    expect(getHostStatus('devbox')?.connected).toBe(true);
    expect(getHostStatus('marina')?.phase).toBe('install-runtime');
    expect(getAllHostStatus().map((h) => h.host)).toEqual(['devbox', 'marina']);
    expect(getHostStatus('never-configured')).toBeUndefined();
  });

  it('deduplicates concurrent hydrates into ONE request, then serves the TTL from cache', async () => {
    const g = deferred<HostStatus[]>();
    hostsApi.fetchHostStatus.mockReturnValueOnce(g.promise);

    // Four surfaces mounting in the same tick (picker + Settings + System pane + a tab).
    const all = Promise.all([hydrateHostStatus(), hydrateHostStatus(), hydrateHostStatus(), hydrateHostStatus()]);
    expect(hostsApi.fetchHostStatus).toHaveBeenCalledTimes(1);

    g.resolve([status({ host: 'devbox' })]);
    await all;
    expect(getHostStatus('devbox')).toBeDefined();

    // Inside the TTL: no second request.
    vi.setSystemTime(clock + 14_000);
    await hydrateHostStatus();
    expect(hostsApi.fetchHostStatus).toHaveBeenCalledTimes(1);

    // Past it: one more.
    vi.setSystemTime(clock + 16_000);
    await hydrateHostStatus();
    expect(hostsApi.fetchHostStatus).toHaveBeenCalledTimes(2);
  });

  it('keeps the last-known statuses when the GET fails, and does not retry-storm', async () => {
    seedHostStatus(status({ host: 'devbox', connected: true, phase: 'connected' }));
    hostsApi.fetchHostStatus.mockRejectedValueOnce(new Error('503 daemon manager busy'));

    // A failure resolves (never rejects into a render) and keeps what we knew.
    await expect(hydrateHostStatus({ force: true })).resolves.toBeUndefined();
    expect(getHostStatus('devbox')?.connected).toBe(true);

    // A failed attempt arms the TTL too: four surfaces mounting against a sick
    // server must not turn into four requests.
    await hydrateHostStatus();
    await hydrateHostStatus();
    expect(hostsApi.fetchHostStatus).toHaveBeenCalledTimes(1);

    vi.setSystemTime(clock + 16_000);
    hostsApi.fetchHostStatus.mockResolvedValueOnce([status({ host: 'devbox', at: clock + 16_000, phase: 'failed', error: 'ssh: connect timed out' })]);
    await hydrateHostStatus();
    expect(hostsApi.fetchHostStatus).toHaveBeenCalledTimes(2);
    expect(getHostStatus('devbox')?.error).toBe('ssh: connect timed out');
  });

  it('stops asking a server that has no such route, and probes again after a reconnect', async () => {
    const notFound = Object.assign(new Error('Not Found'), { status: 404 });
    hostsApi.fetchHostStatus.mockRejectedValueOnce(notFound);
    await hydrateHostStatus();
    expect(hostsApi.fetchHostStatus).toHaveBeenCalledTimes(1);

    // Not even past the TTL: an older build will not grow the route on its own.
    vi.setSystemTime(clock + 60_000);
    await hydrateHostStatus();
    reader();
    await flush();
    expect(hostsApi.fetchHostStatus).toHaveBeenCalledTimes(1);

    // A reconnect can mean a deploy happened, so the forced read probes again.
    hostsApi.fetchHostStatus.mockResolvedValue([status({ host: 'devbox', at: clock + 60_000 })]);
    ws.emit('_ws:reconnected', {});
    await flush();
    expect(hostsApi.fetchHostStatus).toHaveBeenCalledTimes(2);
    expect(getHostStatus('devbox')).toBeDefined();
  });

  it('a push proves the server supports the feature, so the next hydrate is tried again', async () => {
    hostsApi.fetchHostStatus.mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }));
    await hydrateHostStatus();
    expect(hostsApi.fetchHostStatus).toHaveBeenCalledTimes(1);

    ws.emit('host:status', status({ host: 'devbox', phase: 'ssh', at: clock + 1 }));
    expect(getHostStatus('devbox')?.phase).toBe('ssh');

    vi.setSystemTime(clock + 20_000);
    hostsApi.fetchHostStatus.mockResolvedValue([status({ host: 'marina', at: clock + 20_000 })]);
    await hydrateHostStatus();
    expect(hostsApi.fetchHostStatus).toHaveBeenCalledTimes(2);
    expect(getHostStatus('marina')).toBeDefined();
  });

  it('subscribing kicks a TTL-guarded hydrate so a read-only surface needs no fetch call of its own', async () => {
    hostsApi.fetchHostStatus.mockResolvedValue([status({ host: 'devbox' })]);
    const tab = reader();
    const settings = reader();
    await flush();

    expect(hostsApi.fetchHostStatus).toHaveBeenCalledTimes(1);
    expect(getHostStatus('devbox')).toBeDefined();
    // Both readers saw the answer land; the first one also saw the read START
    // (hydration never → pending), which is what lets a surface say "checking".
    expect(tab.notified).toBe(3);
    expect(settings.notified).toBe(2);
  });

  it('tracks whether the server has answered yet: never → pending → done, 404 → unsupported, other → failed', async () => {
    expect(getHostStatusHydration()).toBe('never');
    const g = deferred<HostStatus[]>();
    hostsApi.fetchHostStatus.mockReturnValueOnce(g.promise);
    const p = hydrateHostStatus();
    expect(getHostStatusHydration()).toBe('pending');
    g.resolve([status({ host: 'devbox' })]);
    await p;
    expect(getHostStatusHydration()).toBe('done');

    // A re-read after success stays 'done' (stale-while-revalidate, no flicker).
    vi.setSystemTime(clock += 20_000);
    const g2 = deferred<HostStatus[]>();
    hostsApi.fetchHostStatus.mockReturnValueOnce(g2.promise);
    const p2 = hydrateHostStatus();
    expect(getHostStatusHydration()).toBe('done');
    g2.resolve([]);
    await p2;

    __resetHostStatusForTests();
    hostsApi.fetchHostStatus.mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }));
    await hydrateHostStatus();
    expect(getHostStatusHydration()).toBe('unsupported');

    __resetHostStatusForTests();
    hostsApi.fetchHostStatus.mockRejectedValueOnce(new Error('socket hang up'));
    await hydrateHostStatus();
    expect(getHostStatusHydration()).toBe('failed');

    // A push is an answer from the server too.
    ws.emit('host:status', status({ host: 'devbox', at: clock }));
    expect(getHostStatusHydration()).toBe('done');
  });
});

describe('host-status store — pushes', () => {
  it('applies a host:status push to every subscriber with no request', async () => {
    const r = reader();
    await flush();
    const before = hostsApi.fetchHostStatus.mock.calls.length;
    const notified = r.notified; // the hydrate answered no hosts, so it changed nothing

    ws.emit('host:status', status({ host: 'marina', phase: 'upload', phaseLabel: 'Uploading the session daemon to marina…', at: clock + 100 }));

    expect(getHostStatus('marina')?.phase).toBe('upload');
    expect(r.notified).toBe(notified + 1);
    expect(hostsApi.fetchHostStatus.mock.calls.length).toBe(before);
  });

  it('ignores a push older than the stored snapshot for the SAME host, and never blocks another host', async () => {
    const r = reader();
    await flush();
    const notifiedAfterHydrate = r.notified;

    ws.emit('host:status', status({ host: 'devbox', phase: 'handshake', at: clock + 500 }));
    expect(getHostStatus('devbox')?.phase).toBe('handshake');

    // A frame that was in flight while a forced re-hydrate overtook it.
    ws.emit('host:status', status({ host: 'devbox', phase: 'ssh', at: clock + 100 }));
    expect(getHostStatus('devbox')?.phase).toBe('handshake');
    expect(r.notified).toBe(notifiedAfterHydrate + 1); // dropped silently, no re-render

    // Same `at` still applies (a server can stamp two builds in one millisecond).
    ws.emit('host:status', status({ host: 'devbox', phase: 'connected', connected: true, at: clock + 500 }));
    expect(getHostStatus('devbox')?.connected).toBe(true);

    // An older stamp for a DIFFERENT host is not affected by devbox's clock.
    ws.emit('host:status', status({ host: 'marina', phase: 'probe', at: clock + 1 }));
    expect(getHostStatus('marina')?.phase).toBe('probe');
  });

  it('drops a malformed push instead of storing a host-less row', async () => {
    const r = reader();
    await flush();
    const notified = r.notified;

    ws.emit('host:status', null);
    ws.emit('host:status', { phase: 'ssh' });
    ws.emit('host:status', { host: '', phase: 'ssh' });

    expect(getAllHostStatus()).toHaveLength(0);
    expect(r.notified).toBe(notified);
  });

  it('re-reads on _ws:reconnected, because events during the disconnect are gone for good', async () => {
    hostsApi.fetchHostStatus.mockResolvedValue([status({ host: 'devbox', phase: 'ssh' })]);
    reader();
    await flush();
    expect(hostsApi.fetchHostStatus).toHaveBeenCalledTimes(1);

    // Well inside the TTL: only `force` gets through, which is the whole point.
    vi.setSystemTime(clock + 2_000);
    hostsApi.fetchHostStatus.mockResolvedValue([
      status({ host: 'devbox', connected: true, phase: 'connected', phaseLabel: 'Connected', at: clock + 2_000 }),
    ]);
    ws.emit('_ws:reconnected', {});
    await flush();

    expect(hostsApi.fetchHostStatus).toHaveBeenCalledTimes(2);
    expect(getHostStatus('devbox')?.connected).toBe(true);
  });

  it('remembers that a push has arrived — a hydrated status alone is not proof of pushes', async () => {
    // A cloud replica answers the GET with every host, then never pushes: the
    // picker must keep its fast poll there, so "pushes are live" is a separate fact.
    hostsApi.fetchHostStatus.mockResolvedValue([status({ host: 'devbox' })]);
    await hydrateHostStatus();
    expect(getHostStatus('devbox')).toBeDefined();
    expect(hasSeenHostStatusPush()).toBe(false);

    seedHostStatus(status({ host: 'devbox', phase: 'probe', at: clock + 1 }));   // a POST reply is not a push either
    expect(hasSeenHostStatusPush()).toBe(false);

    ws.emit('host:status', { phase: 'ssh' });                                   // malformed: does not count
    expect(hasSeenHostStatusPush()).toBe(false);
    ws.emit('host:status', status({ host: 'devbox', phase: 'ssh', at: clock + 2 }));
    expect(hasSeenHostStatusPush()).toBe(true);
  });

  it('an unsubscribed reader stops being notified but the store keeps tracking', async () => {
    const r = reader();
    await flush();
    const seen = r.notified;

    r.off();
    ws.emit('host:status', status({ host: 'devbox', phase: 'tunnel', at: clock + 10 }));

    expect(r.notified).toBe(seen);
    expect(getHostStatus('devbox')?.phase).toBe('tunnel');
  });
});

describe('host-status store — snapshot identity', () => {
  it('keeps the all-hosts array in first-seen order and only rebuilds it on a real change', async () => {
    hostsApi.fetchHostStatus.mockResolvedValue([
      status({ host: 'devbox' }), status({ host: 'marina' }), status({ host: 'acme-1' }),
    ]);
    await hydrateHostStatus();
    const first = getAllHostStatus();
    expect(first.map((h) => h.host)).toEqual(['devbox', 'marina', 'acme-1']);
    // Same array between reads: useSyncExternalStore compares by identity, and a
    // fresh array per read would re-render (or loop) forever.
    expect(getAllHostStatus()).toBe(first);

    // Updating a host in the middle must not move it to the end.
    ws.emit('host:status', status({ host: 'marina', connected: true, phase: 'connected', at: clock + 1 }));
    const afterUpdate = getAllHostStatus();
    expect(afterUpdate.map((h) => h.host)).toEqual(['devbox', 'marina', 'acme-1']);
    expect(afterUpdate).not.toBe(first);

    // A dropped push changes nothing at all.
    ws.emit('host:status', status({ host: 'marina', phase: 'ssh', at: clock - 5 }));
    expect(getAllHostStatus()).toBe(afterUpdate);
  });

  it('seedHostStatus lands the Connect-now response and the matching push is then a no-op', async () => {
    const r = reader();
    await flush();
    const notified = r.notified;

    const fresh = status({ host: 'devbox', phase: 'ssh', phaseLabel: 'Opening an SSH connection to devbox…', at: clock + 20 });
    seedHostStatus(fresh);
    expect(getHostStatus('devbox')).toBe(fresh);
    expect(r.notified).toBe(notified + 1);

    // The WS push from the same server-side transition arrives after the response.
    ws.emit('host:status', status({ host: 'devbox', phase: 'ssh', at: clock + 10 }));
    expect(getHostStatus('devbox')).toBe(fresh);
    expect(r.notified).toBe(notified + 1);
  });
});

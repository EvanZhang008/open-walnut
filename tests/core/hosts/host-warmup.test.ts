/**
 * Host warmup: the startup connect of every explicitly configured remote host.
 *
 * The invariants under test are the ones that protect the user's machines: ONE
 * connect at a time (N parallel ssh ControlMasters + N daemon deploys is what
 * corporate SSH front-ends rate-limit), a pace between them, only hosts the user
 * asked Walnut to manage (never the ~/.ssh/config entries getConfig merges in),
 * and a failure that is recorded rather than thrown (a host asleep at boot is
 * the normal case, not an incident).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HostWarmup, hostWarmupGateReason, type HostWarmupCandidate } from '../../../src/core/hosts/host-warmup.js';
import { bus, EventNames } from '../../../src/core/event-bus.js';

const NOW = new Date('2026-09-14T09:00:00Z').getTime();
const silent = { info: () => {}, warn: () => {} };

function host(key: string, extra: Partial<HostWarmupCandidate> = {}): HostWarmupCandidate {
  return { key, sshTarget: { hostname: `${key}.example.test` }, ...extra };
}

/** A connect that takes `ms` and tracks how many ran at once. */
function trackingConnect(ms = 1_000) {
  const order: string[] = [];
  let live = 0;
  let maxLive = 0;
  const fn = vi.fn(async (key: string) => {
    live++;
    maxLive = Math.max(maxLive, live);
    order.push(key);
    await new Promise((r) => setTimeout(r, ms));
    live--;
  });
  return { fn, order, get maxLive() { return maxLive; } };
}

describe('HostWarmup', () => {
  let warmup: HostWarmup | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    warmup?.stop();
    warmup = null;
    vi.useRealTimers();
  });

  it('waits out the startup delay, then connects hosts one at a time, paced', async () => {
    const connect = trackingConnect(1_000);
    warmup = new HostWarmup({
      startupDelayMs: 3_000, paceMs: 500, resweepIntervalMs: 0, log: silent,
      listHosts: async () => [host('devbox'), host('marina'), host('acme-1')],
      connect: connect.fn, isConnected: () => false, now: () => Date.now(),
    });
    warmup.start();

    await vi.advanceTimersByTimeAsync(2_900);
    expect(connect.fn).not.toHaveBeenCalled();   // startup delay honoured

    await vi.advanceTimersByTimeAsync(200);      // delay elapsed → first connect
    expect(connect.order).toEqual(['devbox']);

    await vi.advanceTimersByTimeAsync(1_200);    // 1000 connect + 500 pace: not yet
    expect(connect.order).toEqual(['devbox']);
    await vi.advanceTimersByTimeAsync(400);
    expect(connect.order).toEqual(['devbox', 'marina']);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(connect.order).toEqual(['devbox', 'marina', 'acme-1']);
    expect(connect.maxLive).toBe(1);             // NEVER two connects at once
    expect(warmup.snapshot()['acme-1']).toMatchObject({ state: 'done' });
  });

  it('skips __local__, disabled, discovered and already-connected hosts', async () => {
    const connect = trackingConnect(10);
    warmup = new HostWarmup({
      startupDelayMs: 1, paceMs: 1, resweepIntervalMs: 0, log: silent,
      listHosts: async () => [
        host('__local__'),
        host('off', { enabled: false }),
        host('from-ssh-config', { discovered: true }),
        host('already'),
        host('devbox'),
      ],
      connect: connect.fn,
      isConnected: (key) => key === 'already',
    });
    warmup.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(connect.order).toEqual(['devbox']);
    const snap = warmup.snapshot();
    expect(snap['__local__'].state).toBe('skipped');
    expect(snap['off'].state).toBe('skipped');
    expect(snap['from-ssh-config'].state).toBe('skipped');
    expect(snap['already'].state).toBe('done');
    expect(snap['devbox'].state).toBe('done');
  });

  it('records a failed connect with its message and keeps going', async () => {
    const seen: string[] = [];
    const connect = vi.fn(async (key: string) => {
      seen.push(key);
      if (key === 'devbox') throw new Error('Permission denied (publickey)');
    });
    const states: Array<[string, string]> = [];
    warmup = new HostWarmup({
      startupDelayMs: 1, paceMs: 1, resweepIntervalMs: 0, log: silent,
      listHosts: async () => [host('devbox'), host('marina')],
      connect, isConnected: () => false,
      onChange: (key, state) => { states.push([key, state]); },
    });
    warmup.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(seen).toEqual(['devbox', 'marina']);   // one failure does not stop the queue
    expect(warmup.snapshot()['devbox']).toMatchObject({
      state: 'failed', error: 'Permission denied (publickey)',
    });
    expect(warmup.snapshot()['marina'].state).toBe('done');
    // Every transition is announced, so the browser sees progress live.
    expect(states).toEqual([
      ['devbox', 'queued'], ['marina', 'queued'],
      ['devbox', 'running'], ['devbox', 'failed'],
      ['marina', 'running'], ['marina', 'done'],
    ]);
  });

  it('stop() mid-queue halts further connects and clears the timers', async () => {
    const connect = trackingConnect(100);
    warmup = new HostWarmup({
      startupDelayMs: 1, paceMs: 5_000, resweepIntervalMs: 60_000, log: silent,
      listHosts: async () => [host('devbox'), host('marina'), host('acme-1')],
      connect: connect.fn, isConnected: () => false,
    });
    warmup.start();
    await vi.advanceTimersByTimeAsync(200);       // devbox connected, parked in pace
    expect(connect.order).toEqual(['devbox']);

    warmup.stop();
    await vi.advanceTimersByTimeAsync(300_000);   // well past pace + resweep
    expect(connect.order).toEqual(['devbox']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('kick(host) re-warms exactly that host, even after it failed', async () => {
    let fail = true;
    const connect = vi.fn(async (key: string) => {
      if (key === 'devbox' && fail) throw new Error('no route to host');
    });
    warmup = new HostWarmup({
      startupDelayMs: 1, paceMs: 1, resweepIntervalMs: 0, log: silent,
      listHosts: async () => [host('devbox'), host('marina')],
      connect, isConnected: () => false,
    });
    warmup.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(warmup.snapshot()['devbox'].state).toBe('failed');
    connect.mockClear();

    fail = false;
    await warmup.kick('devbox');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connect.mock.calls.map((c) => c[0])).toEqual(['devbox']);  // marina untouched
    expect(warmup.snapshot()['devbox'].state).toBe('done');
  });

  it('kick() with no host re-lists and warms only the hosts that are not connected', async () => {
    const connected = new Set<string>();
    const connect = vi.fn(async (key: string) => { connected.add(key); });
    warmup = new HostWarmup({
      startupDelayMs: 1, paceMs: 1, resweepIntervalMs: 0, log: silent,
      listHosts: async () => [host('devbox'), host('marina')],
      connect, isConnected: (key) => connected.has(key),
    });
    warmup.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connect).toHaveBeenCalledTimes(2);
    connect.mockClear();

    await warmup.kick();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connect).not.toHaveBeenCalled();       // both already warm

    connected.delete('marina');                   // marina's tunnel died
    await warmup.kick();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connect.mock.calls.map((c) => c[0])).toEqual(['marina']);
  });

  it('the resweep timer re-warms only the hosts that are not connected', async () => {
    const connected = new Set<string>(['devbox']);
    const connect = vi.fn(async (key: string) => { connected.add(key); });
    warmup = new HostWarmup({
      startupDelayMs: 1, paceMs: 1, resweepIntervalMs: 10_000, log: silent,
      listHosts: async () => [host('devbox'), host('marina')],
      connect, isConnected: (key) => connected.has(key),
    });
    warmup.start();
    await vi.advanceTimersByTimeAsync(500);
    expect(connect.mock.calls.map((c) => c[0])).toEqual(['marina']);
    connect.mockClear();

    connected.delete('devbox');
    await vi.advanceTimersByTimeAsync(10_500);    // resweep fires
    expect(connect.mock.calls.map((c) => c[0])).toEqual(['devbox']);
  });

  it('start() twice is a no-op (no double queue, no double subscription)', async () => {
    const connect = vi.fn(async () => {});
    const listHosts = vi.fn(async () => [host('devbox')]);
    warmup = new HostWarmup({
      startupDelayMs: 50, paceMs: 1, resweepIntervalMs: 0, configQuietMs: 1, log: silent,
      listHosts, connect, isConnected: () => false,
    });
    const subscribe = vi.spyOn(bus, 'subscribe');
    warmup.start();
    warmup.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
    // One subscription → one sweep per config change (a doubled one would list twice).
    listHosts.mockClear();
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'hosts' }, ['web-ui']);
    await vi.advanceTimersByTimeAsync(100);
    expect(listHosts).toHaveBeenCalledTimes(1);
  });

  it('stopping one instance does not silence another (subscriptions are per instance)', async () => {
    const connect = vi.fn(async () => {});
    const first = new HostWarmup({
      startupDelayMs: 1, paceMs: 1, resweepIntervalMs: 0, configQuietMs: 1, log: silent,
      listHosts: async () => [], connect, isConnected: () => false,
    });
    first.start();
    let added = false;
    warmup = new HostWarmup({
      startupDelayMs: 1, paceMs: 1, resweepIntervalMs: 0, configQuietMs: 1, log: silent,
      listHosts: async () => (added ? [host('devbox')] : []), connect, isConnected: () => false,
    });
    warmup.start();
    await vi.advanceTimersByTimeAsync(100);
    // An in-process server restart: the old warmup goes, the new one must still
    // hear config changes (bus.unsubscribe is by NAME).
    first.stop();

    added = true;
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'hosts' }, ['web-ui']);
    await vi.advanceTimersByTimeAsync(100);
    expect(connect.mock.calls.map((c) => c[0])).toEqual(['devbox']);
  });

  it('a config:changed emit that never names this subscriber still triggers a kick', async () => {
    const connect = vi.fn(async () => {});
    warmup = new HostWarmup({
      startupDelayMs: 1, paceMs: 1, resweepIntervalMs: 0, log: silent,
      // Empty at boot; the "user just added a host" case.
      listHosts: async () => (added ? [host('devbox')] : []),
      connect, isConnected: () => false,
    });
    let added = false;
    warmup.start();
    await vi.advanceTimersByTimeAsync(500);
    expect(connect).not.toHaveBeenCalled();

    added = true;
    // Exactly how PUT /api/config emits: destinations ['web-ui'] only, so this
    // only lands because the subscription is global + interest-filtered.
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'hosts' }, ['web-ui']);
    await vi.advanceTimersByTimeAsync(500);
    // Not yet: Settings autosaves 600ms after every keystroke, and a hostname
    // dialled mid-typing gets pinned in the connection pool under that alias.
    expect(connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(connect.mock.calls.map((c) => c[0])).toEqual(['devbox']);
  });

  it('a burst of config saves is ONE sweep, after the typing stops', async () => {
    const connect = vi.fn(async () => {});
    const listHosts = vi.fn(async () => [host('devbox')]);
    warmup = new HostWarmup({
      startupDelayMs: 1, paceMs: 1, resweepIntervalMs: 0, configQuietMs: 2_000, log: silent,
      listHosts, connect, isConnected: () => false,
    });
    warmup.start();
    await vi.advanceTimersByTimeAsync(100);
    listHosts.mockClear();

    for (let i = 0; i < 5; i++) {
      bus.emit(EventNames.CONFIG_CHANGED, { key: 'hosts' }, ['web-ui']);
      await vi.advanceTimersByTimeAsync(600);      // one autosave per pause
    }
    expect(listHosts).not.toHaveBeenCalled();      // every save reset the quiet timer
    await vi.advanceTimersByTimeAsync(2_000);
    expect(listHosts).toHaveBeenCalledTimes(1);
  });

  it('kick(host) dials a ~/.ssh/config host the boot sweep skipped: a human asked for it', async () => {
    const connect = vi.fn(async () => {});
    warmup = new HostWarmup({
      startupDelayMs: 1, paceMs: 1, resweepIntervalMs: 0, log: silent,
      listHosts: async () => [host('from-ssh-config', { discovered: true }), host('off', { enabled: false })],
      connect, isConnected: () => false,
    });
    warmup.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(connect).not.toHaveBeenCalled();
    expect(warmup.snapshot()['from-ssh-config'].state).toBe('skipped');

    await warmup.kick('from-ssh-config');
    await vi.advanceTimersByTimeAsync(100);
    expect(connect.mock.calls.map((c) => c[0])).toEqual(['from-ssh-config']);
    expect(warmup.snapshot()['from-ssh-config'].state).toBe('done');

    // Disabled stays disabled even when asked: the route says so instead.
    await warmup.kick('off');
    await vi.advanceTimersByTimeAsync(100);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('never stacks a connect on a host somebody else is already connecting', async () => {
    const connect = vi.fn(async () => {});
    const inFlight = new Set<string>(['devbox']);
    warmup = new HostWarmup({
      startupDelayMs: 1, paceMs: 1, resweepIntervalMs: 0, log: silent,
      listHosts: async () => [host('devbox'), host('marina')],
      connect, isConnected: () => false, isConnecting: (key) => inFlight.has(key),
    });
    warmup.start();
    await vi.advanceTimersByTimeAsync(100);
    // devbox is mid-reconnect (its own loop, no pool-level dedup): left alone.
    expect(connect.mock.calls.map((c) => c[0])).toEqual(['marina']);
    expect(warmup.snapshot()['devbox']).toBeUndefined();

    // Queued first, THEN taken over by a picker click before its turn: dropped
    // from the queue rather than dialled twice.
    inFlight.clear();
    connect.mockClear();
    const slow = new HostWarmup({
      startupDelayMs: 1, paceMs: 1, resweepIntervalMs: 0, log: silent,
      listHosts: async () => [host('marina'), host('devbox')],
      connect: vi.fn(async (key: string) => {
        if (key === 'marina') { inFlight.add('devbox'); await new Promise((r) => setTimeout(r, 50)); }
        connect(key);
      }),
      isConnected: () => false, isConnecting: (key) => inFlight.has(key),
    });
    try {
      slow.start();
      await vi.advanceTimersByTimeAsync(500);
      expect(connect.mock.calls.map((c) => c[0])).toEqual(['marina']);
      expect(slow.snapshot()['devbox']).toBeUndefined();
    } finally { slow.stop(); }
  });

  it('a connect that resolves without a live connection is a failure, not done', async () => {
    warmup = new HostWarmup({
      startupDelayMs: 1, paceMs: 1, resweepIntervalMs: 0, log: silent,
      listHosts: async () => [host('devbox')],
      // getDaemonConnection resolving with the pooled instance while connect()
      // early-returned for somebody else's in-flight attempt.
      connect: async () => ({ connected: false }),
      isConnected: () => false,
    });
    warmup.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(warmup.snapshot()['devbox']).toMatchObject({ state: 'failed' });
    expect(warmup.snapshot()['devbox'].error).toMatch(/without a live connection/);
  });

  it('backs off a host that keeps failing: every consecutive failure doubles its wait, capped', async () => {
    const connect = vi.fn(async () => { throw new Error('ssh: connect timed out'); });
    warmup = new HostWarmup({
      startupDelayMs: 1, paceMs: 1, resweepIntervalMs: 10_000, maxBackoffMs: 35_000, log: silent,
      listHosts: async () => [host('laptop')],
      connect, isConnected: () => false,
    });
    warmup.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(connect).toHaveBeenCalledTimes(1);          // boot (t≈0): fails, wait becomes 10s

    await vi.advanceTimersByTimeAsync(10_000);          // resweep at 10s: 10s elapsed ≥ 10s → dial
    expect(connect).toHaveBeenCalledTimes(2);          // fails again, wait becomes 20s
    await vi.advanceTimersByTimeAsync(10_000);          // resweep at 20s: only 10s since → skipped
    expect(connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);          // resweep at 30s: 20s since → dial
    expect(connect).toHaveBeenCalledTimes(3);          // wait would be 40s, capped at 35s
    await vi.advanceTimersByTimeAsync(30_000);          // resweeps at 40/50/60s: 10/20/30s since → skipped
    expect(connect).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10_000);          // resweep at 70s: 40s since ≥ 35s cap → dial
    expect(connect).toHaveBeenCalledTimes(4);

    // A deliberate kick ignores the backoff and resets it to the base interval.
    await warmup.kick('laptop');
    await vi.advanceTimersByTimeAsync(100);
    expect(connect).toHaveBeenCalledTimes(5);          // t≈70.2s, fails: wait is 10s again
    await vi.advanceTimersByTimeAsync(20_000);          // resweep at 80s: 9.8s since → skipped; at 90s → dial
    expect(connect).toHaveBeenCalledTimes(6);
  });
});

describe('hostWarmupGateReason', () => {
  it('runs on a plain primary box', () => {
    expect(hostWarmupGateReason({ cloudMode: false, ephemeral: false, env: {}, config: {} })).toBeNull();
  });

  it('refuses in cloud mode, in an ephemeral sandbox, and under vitest', () => {
    expect(hostWarmupGateReason({ cloudMode: true, ephemeral: false, env: {} })).toBe('cloud mode');
    expect(hostWarmupGateReason({ cloudMode: false, ephemeral: true, env: {} })).toBe('ephemeral server');
    expect(hostWarmupGateReason({ cloudMode: false, ephemeral: false, env: { VITEST: 'true' } })).toBe('vitest');
  });

  it('honours both user off ramps', () => {
    expect(hostWarmupGateReason({
      cloudMode: false, ephemeral: false, env: { WALNUT_HOST_WARMUP: '0' },
    })).toBe('WALNUT_HOST_WARMUP=0');
    expect(hostWarmupGateReason({
      cloudMode: false, ephemeral: false, env: {}, config: { hosts_warmup: { enabled: false } },
    })).toBe('config hosts_warmup.enabled=false');
    expect(hostWarmupGateReason({
      cloudMode: false, ephemeral: false, env: {}, config: { hosts_warmup: { enabled: true } },
    })).toBeNull();
  });
});

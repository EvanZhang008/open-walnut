/**
 * C57: the user upgraded Claude Code in a terminal and came back to the window.
 * A host with a blocking readiness problem is re-checked on focus /
 * visibilitychange, at most once per host per minute; a healthy host never.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { HostStatus } from '@/api/hosts';

const hostsApi = vi.hoisted(() => ({
  fetchHostStatus: vi.fn<() => Promise<HostStatus[]>>(),
  connectHost: vi.fn<(host: string) => Promise<HostStatus>>(),
  checkHostReadiness: vi.fn<(host: string) => Promise<HostStatus>>(),
}));
const ws = vi.hoisted(() => {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    wsClient: {
      onEvent(name: string, cb: (data: unknown) => void) {
        if (!handlers.has(name)) handlers.set(name, new Set());
        handlers.get(name)!.add(cb);
      },
      offEvent(name: string, cb: (data: unknown) => void) { handlers.get(name)?.delete(cb); },
    },
    emit(name: string, data: unknown) { for (const cb of handlers.get(name) ?? []) cb(data); },
  };
});
vi.mock('@/api/hosts', () => hostsApi);
vi.mock('@/api/ws', () => ({ wsClient: ws.wsClient }));

import { __resetHostStatusForTests, subscribeHostStatus, recheckBlockedHosts, FOCUS_RECHECK_MIN_MS } from '@/hooks/useHostStatus';

const T0 = 1_900_000_000_000;
const outdated = { kind: 'claude_outdated', message: 'Claude Code on Build box is 2.1.220.', commands: [] };

function host(h: string, problems: unknown[]): HostStatus {
  return {
    host: h, label: h, hostname: `${h}.example.com`, connected: true, phase: 'connected', phaseLabel: 'Connected',
    steps: [], phaseElapsedMs: 0, connectElapsedMs: 0, at: T0, connectedAt: T0 - 60_000,
    readiness: { checkedAt: T0 - 1000, problems: problems as never },
  };
}

let win: EventTarget;
let doc: EventTarget & { visibilityState: string };
let off: () => void = () => {};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.resetAllMocks();
  win = new EventTarget();
  doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  __resetHostStatusForTests();
  hostsApi.fetchHostStatus.mockResolvedValue([]);
  hostsApi.checkHostReadiness.mockImplementation(async (h) => host(h, [outdated]));
  off = subscribeHostStatus(() => {});
  ws.emit('host:status', host('buildbox', [outdated]));
  ws.emit('host:status', host('devbox', []));
});

afterEach(() => {
  off();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const visible = () => doc.dispatchEvent(new Event('visibilitychange'));

describe('focus re-check of blocked hosts', () => {
  it('two visibilitychange events inside 60s ask once; after 60s they ask again', async () => {
    visible();
    visible();
    expect(hostsApi.checkHostReadiness).toHaveBeenCalledTimes(1);
    expect(hostsApi.checkHostReadiness).toHaveBeenCalledWith('buildbox', { background: true });
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(T0 + FOCUS_RECHECK_MIN_MS - 1);
    visible();
    expect(hostsApi.checkHostReadiness).toHaveBeenCalledTimes(1);
    vi.setSystemTime(T0 + FOCUS_RECHECK_MIN_MS + 1000);
    visible();
    expect(hostsApi.checkHostReadiness).toHaveBeenCalledTimes(2);
  });

  it('window focus counts too; a hidden tab does not ask', () => {
    doc.visibilityState = 'hidden';
    visible();
    expect(hostsApi.checkHostReadiness).not.toHaveBeenCalled();
    win.dispatchEvent(new Event('focus'));
    expect(hostsApi.checkHostReadiness).toHaveBeenCalledTimes(1);
  });

  it('a healthy or disconnected host is never re-checked', () => {
    expect(recheckBlockedHosts(T0)).toEqual(['buildbox']);
    ws.emit('host:status', { ...host('buildbox', [outdated]), connected: false, phase: 'failed', at: T0 + 1 });
    expect(recheckBlockedHosts(T0 + 10 * FOCUS_RECHECK_MIN_MS)).toEqual([]);
  });

  it('several blocked hosts are asked one at a time, in the background lane (never five urgent POSTs at once)', async () => {
    const resolvers: Array<() => void> = [];
    hostsApi.checkHostReadiness.mockImplementation((h) => new Promise((resolve) => {
      resolvers.push(() => resolve(host(h, [outdated])));
    }));
    for (const h of ['signbox', 'keybox', 'fixbox']) ws.emit('host:status', host(h, [outdated]));
    expect(recheckBlockedHosts(T0)).toEqual(['buildbox', 'signbox', 'keybox', 'fixbox']);
    // Only the first is in flight; the rest wait for it.
    expect(hostsApi.checkHostReadiness).toHaveBeenCalledTimes(1);
    for (let i = 1; i <= 4; i++) {
      expect(hostsApi.checkHostReadiness).toHaveBeenLastCalledWith(expect.any(String), { background: true });
      resolvers[i - 1]();
      await vi.advanceTimersByTimeAsync(0);
      expect(hostsApi.checkHostReadiness).toHaveBeenCalledTimes(Math.min(i + 1, 4));
    }
    expect(hostsApi.checkHostReadiness.mock.calls.map((c) => c[0])).toEqual(['buildbox', 'signbox', 'keybox', 'fixbox']);
  });

  it('a failed re-check is logged, not thrown', async () => {
    hostsApi.checkHostReadiness.mockRejectedValue(new Error('offline'));
    expect(() => visible()).not.toThrow();
    await Promise.resolve();
    expect(hostsApi.checkHostReadiness).toHaveBeenCalledTimes(1);
  });
});

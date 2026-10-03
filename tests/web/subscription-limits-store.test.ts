/**
 * The browser's copy of each host's subscription limit readings
 * (web/src/stores/subscription-limits-store.ts): frames keyed by host, a push
 * never goes backwards, hydration on the first subscriber and on reconnect,
 * a 204 keeps what is shown, and the server clock offset is kept. The WS
 * singleton and the API are faked at the module boundary.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HostLimitFrame } from '@/api/subscription-limits';

const api = vi.hoisted(() => ({
  fetchSubscriptionLimits: vi.fn<() => Promise<HostLimitFrame[] | null>>(),
}));
const ws = vi.hoisted(() => {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    handlers,
    wsClient: {
      onEvent(name: string, cb: (data: unknown) => void) {
        let set = handlers.get(name);
        if (!set) { set = new Set(); handlers.set(name, set); }
        set.add(cb);
      },
      offEvent() {},
    },
    emit(name: string, data: unknown) { for (const cb of handlers.get(name) ?? []) cb(data); },
  };
});
vi.mock('@/api/subscription-limits', async (importOriginal) => ({ ...(await importOriginal<object>()), ...api }));
vi.mock('@/api/ws', () => ({ wsClient: ws.wsClient }));

import {
  _resetSubscriptionLimitsStoreForTest, getLimitFrame, hydrateSubscriptionLimits, limitHostKey, serverNow,
  subscribeSubscriptionLimits, upsertLimitFrame,
} from '@/stores/subscription-limits-store';

function frame(host: string, updatedAt: number, utilization = 0.5, extra: Partial<HostLimitFrame> = {}): HostLimitFrame {
  return {
    host, updatedAt, serverNow: Date.now(),
    windows: { five_hour: { type: 'five_hour', utilization, resetsAt: Date.now() + 3_600_000, seenAt: updatedAt } },
    current: { status: 'allowed', type: 'five_hour', seenAt: updatedAt },
    ...extra,
  };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  _resetSubscriptionLimitsStoreForTest();
  api.fetchSubscriptionLimits.mockReset();
});

describe('subscription-limits-store', () => {
  it('the first subscriber hydrates; frames are found by host, no host meaning this machine', async () => {
    api.fetchSubscriptionLimits.mockResolvedValue([frame('__local__', 10, 0.7), frame('devbox', 10, 0.2)]);
    const calls: number[] = [];
    const off = subscribeSubscriptionLimits(() => calls.push(1));
    await flush();
    expect(api.fetchSubscriptionLimits).toHaveBeenCalledTimes(1);
    expect(getLimitFrame(undefined)?.windows.five_hour.utilization).toBe(0.7);
    expect(getLimitFrame('')?.host).toBe('__local__');
    expect(getLimitFrame('devbox')?.windows.five_hour.utilization).toBe(0.2);
    expect(getLimitFrame('elsewhere')).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
    // A second subscriber does not read again.
    const off2 = subscribeSubscriptionLimits(() => {});
    await flush();
    expect(api.fetchSubscriptionLimits).toHaveBeenCalledTimes(1);
    off(); off2();
  });

  it('a push replaces its host\'s frame; an older one (by updatedAt) is ignored; junk never lands', () => {
    ws.emit('host:subscription-limits', frame('__local__', 20, 0.4));
    ws.emit('host:subscription-limits', frame('__local__', 30, 0.6));
    ws.emit('host:subscription-limits', frame('__local__', 25, 0.1));
    expect(getLimitFrame(null)?.windows.five_hour.utilization).toBe(0.6);
    expect(upsertLimitFrame({ host: 'x' })).toBe(false);
    expect(upsertLimitFrame(null)).toBe(false);
    ws.emit('host:subscription-limits', { host: '', updatedAt: 1, windows: {} });
    expect(getLimitFrame('x')).toBeNull();
  });

  it('the snapshot identity is stable between changes and moves only for the host that changed', () => {
    upsertLimitFrame(frame('__local__', 1));
    upsertLimitFrame(frame('devbox', 1));
    const local = getLimitFrame(null);
    const remote = getLimitFrame('devbox');
    expect(getLimitFrame(null)).toBe(local);
    ws.emit('host:subscription-limits', frame('devbox', 2, 0.9));
    expect(getLimitFrame(null)).toBe(local);
    expect(getLimitFrame('devbox')).not.toBe(remote);
  });

  it('a 204 (null) keeps what is shown; a reconnect reads again', async () => {
    upsertLimitFrame(frame('__local__', 5, 0.33));
    api.fetchSubscriptionLimits.mockResolvedValue(null);
    await hydrateSubscriptionLimits(true);
    expect(getLimitFrame(null)?.windows.five_hour.utilization).toBe(0.33);
    api.fetchSubscriptionLimits.mockResolvedValue([frame('__local__', 9, 0.5)]);
    ws.emit('_ws:reconnected', undefined);
    await flush();
    expect(api.fetchSubscriptionLimits).toHaveBeenCalledTimes(2);
    expect(getLimitFrame(null)?.windows.five_hour.utilization).toBe(0.5);
  });

  it('a 404 (an older server) stops the asking; a network failure lets the next subscriber retry', async () => {
    api.fetchSubscriptionLimits.mockRejectedValueOnce(Object.assign(new Error('nf'), { status: 404 }));
    await hydrateSubscriptionLimits();
    await hydrateSubscriptionLimits();
    expect(api.fetchSubscriptionLimits).toHaveBeenCalledTimes(1);
    _resetSubscriptionLimitsStoreForTest();
    api.fetchSubscriptionLimits.mockRejectedValueOnce(new Error('offline'));
    await hydrateSubscriptionLimits();
    api.fetchSubscriptionLimits.mockResolvedValueOnce([]);
    await hydrateSubscriptionLimits();
    expect(api.fetchSubscriptionLimits).toHaveBeenCalledTimes(3);
  });

  it('concurrent hydrates share one request', async () => {
    let resolve!: (v: HostLimitFrame[]) => void;
    api.fetchSubscriptionLimits.mockReturnValue(new Promise((r) => { resolve = r; }));
    const a = hydrateSubscriptionLimits(true);
    const b = hydrateSubscriptionLimits(true);
    resolve([]);
    await Promise.all([a, b]);
    expect(api.fetchSubscriptionLimits).toHaveBeenCalledTimes(1);
  });

  it('keeps the server clock offset from the newest frame', () => {
    const skew = 90_000;
    upsertLimitFrame({ ...frame('__local__', 1), serverNow: Date.now() + skew });
    expect(Math.abs(serverNow() - (Date.now() + skew))).toBeLessThan(1000);
  });

  it('limitHostKey trims and maps empty to this machine', () => {
    expect(limitHostKey(undefined)).toBe('__local__');
    expect(limitHostKey('  ')).toBe('__local__');
    expect(limitHostKey(' devbox ')).toBe('devbox');
  });
});

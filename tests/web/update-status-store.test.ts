/**
 * The shared update-status store (web/src/hooks/useUpdateStatus.ts): the first
 * read at start, live from WS `system:update`, a forced refetch on every
 * `_ws:reconnected`, the panel's open within the freshness window, a push that
 * lands while a read is out, and an older server's shape (no live, no pushes).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const ws = vi.hoisted(() => {
  const handlers = new Map<string, Set<(d: unknown) => void>>();
  return {
    handlers,
    emit(name: string, data: unknown) { for (const fn of handlers.get(name) ?? []) fn(data); },
    wsClient: {
      onEvent(name: string, cb: (d: unknown) => void) { let s = handlers.get(name); if (!s) handlers.set(name, s = new Set()); s.add(cb); },
      offEvent(name: string, cb: (d: unknown) => void) { handlers.get(name)?.delete(cb); },
    },
  };
});
const api = vi.hoisted(() => ({ fetchUpdateStatus: vi.fn(), checkForUpdateNow: vi.fn() }));

vi.mock('@/api/ws', () => ({ wsClient: ws.wsClient }));
vi.mock('@/api/update', () => api);
vi.mock('@/utils/log', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import {
  applyUpdateStatus, peekUpdateStatus, refreshUpdateStatus, resetUpdateStatusForTests, startUpdateStatusStore,
} from '@/hooks/useUpdateStatus';

const NPM = { kind: 'npm', sourceDir: null, packageRoot: '/p', manager: 'npm', updateCommand: 'npm install -g open-walnut@latest' };
const base = (over: Record<string, unknown> = {}) => ({
  enabled: true, install: NPM, current: '0.5.1', channel: 'stable', latest: '0.9.0', tags: { latest: '0.9.0', nightly: null },
  available: true, checkedAt: null, error: null, checking: false, packageUrl: 'u', ...over,
});
const LIVE = { state: 'downloading', version: '0.9.0', error: null, canInstall: true, held: null, updatesAuto: true, idle: { ready: false, userIdleMs: 0, turnsRunning: 0, waitingSince: null } };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetUpdateStatusForTests();
  ws.handlers.clear();
  api.fetchUpdateStatus.mockReset();
  api.checkForUpdateNow.mockReset();
});

describe('update status store', () => {
  it('reads once at start, and a second start reads nothing more', async () => {
    api.fetchUpdateStatus.mockResolvedValue(base());
    startUpdateStatusStore();
    startUpdateStatusStore();
    await flush();
    expect(api.fetchUpdateStatus).toHaveBeenCalledTimes(1);
    expect(peekUpdateStatus()?.latest).toBe('0.9.0');
  });

  it('an older server: no live field and no pushes, the copy is exactly what it answered', async () => {
    api.fetchUpdateStatus.mockResolvedValue(base({ autoUpdate: true }));
    startUpdateStatusStore();
    await flush();
    expect(peekUpdateStatus()).toEqual(base({ autoUpdate: true }));
    expect(peekUpdateStatus()?.live).toBeUndefined();
  });

  it('a WS system:update replaces the copy at once (no fetch); a frame that is no status is ignored', async () => {
    api.fetchUpdateStatus.mockResolvedValue(base());
    startUpdateStatusStore();
    await flush();
    ws.emit('system:update', base({ live: LIVE }));
    expect(peekUpdateStatus()?.live?.state).toBe('downloading');
    ws.emit('system:update', { status: base({ live: { ...LIVE, state: 'installed' } }) });
    expect(peekUpdateStatus()?.live?.state).toBe('installed');
    ws.emit('system:update', { nonsense: true });
    ws.emit('system:update', null);
    expect(peekUpdateStatus()?.live?.state).toBe('installed');
    expect(api.fetchUpdateStatus).toHaveBeenCalledTimes(1);
  });

  it('every reconnect reads again, past the freshness window (the server may have restarted into a new version)', async () => {
    api.fetchUpdateStatus.mockResolvedValueOnce(base()).mockResolvedValueOnce(base({ current: '0.9.0', available: false }));
    startUpdateStatusStore();
    await flush();
    ws.emit('_ws:reconnected', {});
    await flush();
    expect(api.fetchUpdateStatus).toHaveBeenCalledTimes(2);
    expect(peekUpdateStatus()?.current).toBe('0.9.0');
  });

  it('the panel open reads again only after the freshness window', async () => {
    api.fetchUpdateStatus.mockResolvedValue(base());
    startUpdateStatusStore();
    await flush();
    await refreshUpdateStatus();
    expect(api.fetchUpdateStatus).toHaveBeenCalledTimes(1);
    await refreshUpdateStatus(true);
    expect(api.fetchUpdateStatus).toHaveBeenCalledTimes(2);
  });

  it('a push that lands while a read is out wins over that (older) read', async () => {
    const read = deferred<unknown>();
    api.fetchUpdateStatus.mockReturnValue(read.promise);
    startUpdateStatusStore();
    ws.emit('system:update', base({ live: { ...LIVE, state: 'restarting' } }));
    read.resolve(base({ live: { ...LIVE, state: 'installed' } }));
    await flush();
    expect(peekUpdateStatus()?.live?.state).toBe('restarting');
  });

  it('a reconnect while an older read is out reads once more after it (that read may predate the restart)', async () => {
    const old = deferred<unknown>();
    api.fetchUpdateStatus.mockReturnValueOnce(old.promise).mockResolvedValueOnce(base({ current: '0.9.0' }));
    startUpdateStatusStore();
    ws.emit('_ws:reconnected', {});
    ws.emit('_ws:reconnected', {});
    old.resolve(base({ live: { ...LIVE, state: 'restarting' } }));
    await flush(); await flush();
    expect(api.fetchUpdateStatus).toHaveBeenCalledTimes(2);
    expect(peekUpdateStatus()?.current).toBe('0.9.0');
  });

  it('a failed read keeps the copy it had', async () => {
    api.fetchUpdateStatus.mockResolvedValueOnce(base()).mockRejectedValueOnce(new Error('HTTP 502'));
    startUpdateStatusStore();
    await flush();
    ws.emit('_ws:reconnected', {});
    await flush();
    expect(peekUpdateStatus()?.latest).toBe('0.9.0');
  });

  it('applyUpdateStatus (the install/restart answer) publishes like a push', async () => {
    api.fetchUpdateStatus.mockResolvedValue(base());
    startUpdateStatusStore();
    await flush();
    applyUpdateStatus(base({ live: LIVE }));
    expect(peekUpdateStatus()?.live?.version).toBe('0.9.0');
  });
});

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../../helpers/mock-constants.js';
vi.mock('../../../src/constants.js', () => createMockConstants('usage-collection'));
const mocks = vi.hoisted(() => ({ send: vi.fn(), connect: vi.fn(), sessions: vi.fn(), config: vi.fn() }));
vi.mock('../../../src/core/config-manager.js', () => ({ getConfig: mocks.config }));
vi.mock('../../../src/core/session-tracker.js', () => ({ listSessions: mocks.sessions }));
vi.mock('../../../src/providers/daemon-connection.js', () => ({ getDaemonConnection: async () => ({
  connect: mocks.connect, hasCapability: () => true, send: mocks.send,
}) }));
import { collectUsage, responseUsageStore, collectionState } from '../../../src/core/usage/collection.js';
import { reconcileUsage } from '../../../src/providers/usage-reconcile-core.js';

function page(until: string) {
  return { result: { canonical: { records: [], diagnostics: {}, costStates: [] },
    upstream: { records: [], diagnostics: [], coverage: {} }, reconciliation: reconcileUsage([], []), until },
    ok: true, done: true };
}
beforeEach(() => {
  mocks.send.mockReset(); mocks.connect.mockReset();
  mocks.sessions.mockResolvedValue([{ claudeSessionId: 'example-session', host: '__local__', engine: 'claude', taskId: 'example-task' }]);
  mocks.config.mockResolvedValue({ usage: { proxy_log_dirs: { __local__: '/tmp/example-usage' } } });
});
afterAll(() => responseUsageStore().close());

describe('daemon-backed usage collection', () => {
  it('coalesces simultaneous collection requests without double scans', async () => {
    let finish!: (value: ReturnType<typeof page>) => void;
    mocks.send.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = collectUsage(undefined, '2026-10-13T00:00:00Z');
    const second = collectUsage(undefined, '2026-10-14T00:00:00Z');
    expect(second).toBe(first);
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
    expect(collectionState()).toMatchObject({ running: true, until: '2026-10-13T00:00:00Z' });
    expect(collectionState().id).toBeTruthy();
    const id = collectionState().id;
    finish(page('2026-10-13T00:00:00Z'));
    await first;
    expect(collectionState()).toMatchObject({ running: false, id, until: '2026-10-13T00:00:00Z' });
    expect(responseUsageStore().getOverview({}).accuracy.until).toBe('2026-10-13T00:00:00Z');
  });
  it('preserves the active range when a full rebuild joins a partial scan', async () => {
    let finish!: (value: ReturnType<typeof page>) => void;
    mocks.send.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const partial = collectUsage('2026-10-12T00:00:00Z', '2026-10-13T00:00:00Z');
    const full = collectUsage(undefined, '2026-10-14T00:00:00Z');
    expect(full).toBe(partial);
    expect(collectionState()).toMatchObject({ since: '2026-10-12T00:00:00Z', until: '2026-10-13T00:00:00Z' });
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
    finish(page('2026-10-13T00:00:00Z'));
    await partial;
    expect(collectionState().since).toBe('2026-10-12T00:00:00Z');
  });
  it('keeps the last complete cutoff when a later page fails and recovers on retry', async () => {
    mocks.send.mockResolvedValueOnce(page('2026-10-13T00:00:00Z'));
    await collectUsage(undefined, '2026-10-13T00:00:00Z');
    mocks.send.mockResolvedValueOnce({ ...page('2026-10-14T00:00:00Z'), done: false, key: 'page-key', offset: 500 })
      .mockRejectedValueOnce(new Error('Page timed out'));
    await collectUsage(undefined, '2026-10-14T00:00:00Z');
    expect(responseUsageStore().getOverview({}).accuracy.until).toBe('2026-10-13T00:00:00Z');
    expect(responseUsageStore().getOverview({}).accuracy.checks[0].source).toBe('Host collection');
    mocks.send.mockResolvedValueOnce(page('2026-10-14T00:00:00Z'));
    await collectUsage(undefined, '2026-10-14T00:00:00Z');
    expect(responseUsageStore().getOverview({}).accuracy.until).toBe('2026-10-14T00:00:00Z');
    expect(responseUsageStore().getOverview({}).accuracy.checks.some(check => check.source === 'Host collection')).toBe(false);
  });
});

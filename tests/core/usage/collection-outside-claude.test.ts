import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../../helpers/mock-constants.js';
vi.mock('../../../src/constants.js', () => createMockConstants('usage-collection-outside-claude'));
const mocks = vi.hoisted(() => ({ send: vi.fn(), connect: vi.fn(), sessions: vi.fn(), config: vi.fn() }));
vi.mock('../../../src/core/config-manager.js', () => ({ getConfig: mocks.config }));
vi.mock('../../../src/core/session-tracker.js', () => ({ listSessions: mocks.sessions }));
vi.mock('../../../src/providers/daemon-connection.js', () => ({ getDaemonConnection: async () => ({
  // A daemon that reads sessions outside Walnut (claude-outside-v1) and has no Codex outside scan.
  connect: mocks.connect, hasCapability: (cap: string) => cap !== 'codex-outside-v1', send: mocks.send,
}) }));
import { collectUsage, INCREMENTAL, responseUsageStore } from '../../../src/core/usage/collection.js';
import { reconcileUsage } from '../../../src/providers/usage-reconcile-core.js';
import type { CanonicalUsageRecord } from '../../../src/providers/usage-scan-core.js';

function record(responseId: string, sessionId: string): CanonicalUsageRecord {
  return { responseId, model: 'claude-opus-5-5', sessionId, timestamp: '2026-10-13T12:00:00.000Z', input_tokens: 10, output_tokens: 5,
    cache_creation_input_tokens: 0, cache_read_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    speed: 'standard', inference_geo: '', service_tier: 'standard', server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    pricing_context_complete: true, complete: true } as CanonicalUsageRecord;
}
function page(records: CanonicalUsageRecord[], outsideSessions: unknown[], until: string, diagnostics: Record<string, number> = {}) {
  return { result: { canonical: { records: [], diagnostics, costStates: [] }, upstream: { records: [], diagnostics: [], coverage: {} },
    reconciliation: reconcileUsage(records, []), until, outsideSessions }, ok: true, done: true };
}

beforeEach(() => {
  mocks.send.mockReset(); mocks.connect.mockReset();
  responseUsageStore().database.prepare("DELETE FROM usage_rollup_meta WHERE key LIKE 'claude_outside_%'").run();
  mocks.sessions.mockResolvedValue([{ claudeSessionId: 'walnut-run', host: '__local__', engine: 'claude', taskId: 'example-task' }]);
  mocks.config.mockResolvedValue({ usage: {} });
});
afterAll(() => responseUsageStore().close());

describe('collecting Claude Code sessions outside Walnut', () => {
  it('asks for them, reads the whole history the first time only, and notes who started each session', async () => {
    const outside = [{ sessionId: 'terminal-run', entrypoint: 'cli', cwd: '/home/u/repo' }];
    mocks.send.mockResolvedValueOnce(page([record('m1', 'walnut-run'), record('m2', 'terminal-run')], outside, '2026-10-13T13:00:00.000Z'));
    await collectUsage(INCREMENTAL, '2026-10-13T13:00:00.000Z');
    const first = mocks.send.mock.calls[0];
    expect(first[0]).toBe('usage.scan');
    expect(first[1]).toMatchObject({ outside: true, sessionIds: ['walnut-run'] });
    expect(first[1].since).toBeUndefined(); // never read in full before
    const store = responseUsageStore();
    expect(store.hasSession('terminal-run')).toBe(true);
    expect(store.rollup.originOf('__local__', 'terminal-run')).toMatchObject({ outside: true, originator: 'cli', cwd: '/home/u/repo' });
    expect(store.rollup.claudeOutsideBuilt('__local__')).toBe(true);

    mocks.send.mockResolvedValueOnce(page([], [], '2026-10-13T14:00:00.000Z'));
    await collectUsage(INCREMENTAL, '2026-10-13T14:00:00.000Z');
    expect(mocks.send.mock.calls[1][1].since).toBe(new Date(Date.parse('2026-10-13T13:00:00.000Z') - 2 * 60 * 60_000).toISOString());
  });

  it('a first pass with a start date does not count as the full read, so the next pass still reads from the beginning', async () => {
    mocks.send.mockResolvedValueOnce(page([], [], '2026-11-05T12:00:00.000Z'));
    await collectUsage('2026-11-01T00:00:00.000Z', '2026-11-05T12:00:00.000Z');
    expect(mocks.send.mock.calls[0][1].since).toBe('2026-11-01T00:00:00.000Z');
    expect(responseUsageStore().rollup.claudeOutsideBuilt('__local__')).toBe(false);
    mocks.send.mockResolvedValueOnce(page([], [], '2026-11-05T13:00:00.000Z'));
    await collectUsage(INCREMENTAL, '2026-11-05T13:00:00.000Z');
    expect(mocks.send.mock.calls[1][1].since).toBeUndefined();
    expect(responseUsageStore().rollup.claudeOutsideBuilt('__local__')).toBe(true);
  });

  it('reads a configured host that has no Walnut Claude session', async () => {
    mocks.config.mockResolvedValue({ usage: {}, hosts: { devbox: { enabled: true } } });
    mocks.send.mockResolvedValue(page([], [], '2026-11-05T14:00:00.000Z'));
    await collectUsage(INCREMENTAL, '2026-11-05T14:00:00.000Z');
    expect(mocks.send.mock.calls.filter(c => c[0] === 'usage.scan').length).toBe(2); // this computer and devbox
    expect(responseUsageStore().rollup.claudeOutsideBuilt('devbox')).toBe(true);
  });

  it('a full read that left a file unreadable is repeated, a few times at most', async () => {
    const rollup = responseUsageStore().rollup;
    for (const n of [1, 2]) {
      mocks.send.mockResolvedValueOnce(page([], [], `2026-11-06T0${n}:00:00.000Z`, { unreadable_files: 1 }));
      await collectUsage(INCREMENTAL, `2026-11-06T0${n}:00:00.000Z`);
      expect(rollup.claudeOutsideBuilt('__local__')).toBe(false);
      expect(mocks.send.mock.calls[n - 1][1].since).toBeUndefined();
    }
    mocks.send.mockResolvedValueOnce(page([], [], '2026-11-06T03:00:00.000Z', { unreadable_files: 1 }));
    await collectUsage(INCREMENTAL, '2026-11-06T03:00:00.000Z');
    expect(rollup.claudeOutsideBuilt('__local__')).toBe(true); // a file that stays unreadable stops holding it back
  });

  it('one machine reached under two names is read for sessions outside Walnut once, and no response is stored under both', async () => {
    mocks.config.mockResolvedValue({ usage: {}, net: { enabled: true },
      hosts: { studio: { transport: 'net', endpoint: 'x', enabled: true }, old: { discovered: true, hostname: 'studio', enabled: true } } });
    mocks.sessions.mockResolvedValue([
      { claudeSessionId: 'on-old', host: 'old', engine: 'claude', taskId: 't1' },
      { claudeSessionId: 'on-studio', host: 'studio', engine: 'claude', taskId: 't2' },
    ]);
    // The daemon answers with the responses of the sessions asked for, and those of the outside ones when asked to.
    mocks.send.mockImplementation(async (_cmd: string, params: { sessionIds?: string[]; outside?: boolean }) => {
      const ids = [...(params.sessionIds ?? []), ...(params.outside ? ['terminal-run'] : [])];
      return page(ids.map(id => record(`m-${id}`, id)), params.outside ? [{ sessionId: 'terminal-run', entrypoint: 'cli', cwd: '/work' }] : [], '2026-11-06T04:00:00.000Z');
    });
    await collectUsage(INCREMENTAL, '2026-11-06T04:00:00.000Z');
    const scans = mocks.send.mock.calls.filter(c => c[0] === 'usage.scan' && c[1].sessionIds);
    expect(scans.filter(c => c[1].outside).length).toBe(2); // this computer, and the machine reached as old and studio once
    const rows = responseUsageStore().database.prepare("SELECT session_id s, COUNT(DISTINCT host) hosts FROM response_usage WHERE session_id IN ('on-old','on-studio') GROUP BY session_id").all() as { s: string; hosts: number }[];
    expect(rows.length).toBe(2);
    for (const row of rows) expect(row.hosts).toBe(1);
  });

  it('reads the machine under its own name when only another name of it has sessions, so the read never moves between names', async () => {
    mocks.config.mockResolvedValue({ usage: {}, net: { enabled: true },
      hosts: { studio: { transport: 'net', endpoint: 'x', enabled: true }, old: { discovered: true, hostname: 'studio', enabled: true } } });
    mocks.sessions.mockResolvedValue([{ claudeSessionId: 'on-old', host: 'old', engine: 'claude', taskId: 't1' }]);
    mocks.send.mockResolvedValue(page([], [], '2026-11-06T05:00:00.000Z'));
    await collectUsage(INCREMENTAL, '2026-11-06T05:00:00.000Z');
    const rollup = responseUsageStore().rollup;
    expect(rollup.claudeOutsideBuilt('studio')).toBe(true);
    expect(rollup.claudeOutsideBuilt('old')).toBe(false);
  });

  it('a full read the link cut off falls back to collecting the host without it, and waits before trying the full read again', async () => {
    mocks.send.mockRejectedValueOnce(new Error('daemon command lost: usage.scan: connection closed'));
    mocks.send.mockResolvedValueOnce(page([record('m9', 'walnut-run')], [], '2026-11-06T06:00:00.000Z'));
    await collectUsage(INCREMENTAL, '2026-11-06T06:00:00.000Z');
    expect(mocks.send.mock.calls[0][1]).toMatchObject({ outside: true });
    expect(mocks.send.mock.calls[1][1].outside).toBeUndefined(); // the host's own sessions are still collected
    const rollup = responseUsageStore().rollup;
    expect(rollup.claudeOutsideBuilt('__local__')).toBe(false);
    mocks.send.mockResolvedValueOnce(page([], [], '2026-11-06T07:00:00.000Z'));
    await collectUsage(INCREMENTAL, '2026-11-06T07:00:00.000Z');
    expect(mocks.send.mock.calls[2][1].since).toBeDefined(); // not a full read again within the wait
    expect(mocks.send.mock.calls[2][1].outside).toBeUndefined();
  });

  it('a host that failed does not count as read in full', async () => {
    responseUsageStore().rollup.setThresholds([]);
    mocks.sessions.mockResolvedValue([{ claudeSessionId: 'walnut-run', host: 'devbox', engine: 'claude', taskId: 'example-task' }]);
    mocks.send.mockRejectedValue(new Error('timed out'));
    await collectUsage(INCREMENTAL, '2026-10-13T15:00:00.000Z');
    expect(responseUsageStore().rollup.claudeOutsideBuilt('devbox')).toBe(false);
  });
});

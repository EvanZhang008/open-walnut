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

  it('sessions that appear in the record while a long read runs are routed to their owner name, on every page', async () => {
    mocks.config.mockResolvedValue({ usage: {}, net: { enabled: true },
      hosts: { studio: { transport: 'net', endpoint: 'x', enabled: true }, old: { discovered: true, hostname: 'studio', enabled: true } } });
    const mine = { claudeSessionId: 'on-studio', host: 'studio', engine: 'claude', taskId: 't2' };
    mocks.sessions.mockReset();
    mocks.sessions.mockResolvedValueOnce([mine]);
    mocks.sessions.mockResolvedValueOnce([mine, { claudeSessionId: 'late-1', host: 'old', engine: 'claude', taskId: 'l1' }]);
    mocks.sessions.mockResolvedValue([mine, { claudeSessionId: 'late-1', host: 'old', engine: 'claude', taskId: 'l1' }, { claudeSessionId: 'late-2', host: 'studio', engine: 'claude', taskId: 'l2' }]);
    const first = { ...page([record('a1', 'late-1')], [{ sessionId: 'late-1', entrypoint: 'sdk-cli', cwd: '/w/l1' }], '2026-11-06T10:00:00.000Z'), done: false, key: 'k', offset: 1 };
    mocks.send.mockResolvedValueOnce(page([], [], '2026-11-06T10:00:00.000Z')); // this computer answers first, with nothing
    mocks.send.mockImplementation(async (_cmd: string, params: { key?: string }) => params.key
      ? page([record('a2', 'late-2')], [{ sessionId: 'late-2', entrypoint: 'sdk-cli', cwd: '/w/l2' }], '2026-11-06T10:00:00.000Z')
      : first);
    await collectUsage(INCREMENTAL, '2026-11-06T10:00:00.000Z');
    const rows = responseUsageStore().database.prepare("SELECT session_id s, host h FROM response_usage WHERE session_id IN ('late-1','late-2')").all() as { s: string; h: string }[];
    expect(rows.filter(r => r.s === 'late-1').length).toBe(0); // owned by the name 'old': that name's own read stores it
    expect(rows.find(r => r.s === 'late-2')?.h).toBe('studio');
    const rollup = responseUsageStore().rollup;
    expect(rollup.originOf('old', 'late-1')?.outside).toBeFalsy();
    expect(rollup.originOf('studio', 'late-2')?.outside).toBeFalsy(); // the second page came at once, still Walnut's
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

  it('a full read that fails between pages falls back the same way, and keeps what the pages stored', async () => {
    const first = { ...page([record('m21', 'walnut-run')], [], '2026-11-06T08:00:00.000Z'), done: false, key: 'k1', offset: 1 };
    mocks.send.mockResolvedValueOnce(first);
    mocks.send.mockRejectedValueOnce(new Error('daemon command lost: usage.scan: connection closed'));
    mocks.send.mockResolvedValueOnce(page([], [], '2026-11-06T08:00:00.000Z'));
    await collectUsage(INCREMENTAL, '2026-11-06T08:00:00.000Z');
    expect(mocks.send.mock.calls[2][1].outside).toBeUndefined();
    const rollup = responseUsageStore().rollup;
    expect(rollup.claudeOutsideBuilt('__local__')).toBe(false);
    expect(rollup.claudeOutsideFailedAt('__local__')).toBeGreaterThan(0);
    expect(responseUsageStore().hasSession('walnut-run')).toBe(true);
  });

  it('a Walnut session begun after the pass listed its sessions is Walnut\'s, not outside', async () => {
    // First listing: only walnut-run. The new session appears in the second listing, read when its transcript shows up in a page.
    mocks.sessions.mockReset();
    const mine = { claudeSessionId: 'walnut-run', host: '__local__', engine: 'claude', taskId: 'example-task' };
    mocks.sessions.mockResolvedValueOnce([mine]);
    mocks.sessions.mockResolvedValue([mine, { claudeSessionId: 'late-walnut-run', host: '__local__', engine: 'claude', taskId: 'late-task' }]);
    const metas = [{ sessionId: 'late-walnut-run', entrypoint: 'sdk-cli', cwd: '/home/u/tasks/late-task' }, { sessionId: 'terminal-p', entrypoint: 'sdk-cli', cwd: '/home/u/repo' }];
    mocks.send.mockResolvedValueOnce(page([record('m30', 'late-walnut-run'), record('m31', 'terminal-p')], metas, '2026-11-06T09:00:00.000Z'));
    await collectUsage(INCREMENTAL, '2026-11-06T09:00:00.000Z');
    const rollup = responseUsageStore().rollup;
    expect(rollup.originOf('__local__', 'late-walnut-run')?.outside).toBeFalsy();
    expect(rollup.originOf('__local__', 'terminal-p')?.outside).toBe(true); // a session nobody listed stays outside
  });

  it('an outside look an older build kept for a session Walnut has a record of is put right on the next pass, without the daemon resending it', async () => {
    responseUsageStore().rollup.recordOrigins([{ host: '__local__', sessionId: 'walnut-run', originator: 'sdk-ts', provider: '', cwd: '/w', outside: true, stored: true, firstAt: '', lastAt: '' },
      { host: '__local__', sessionId: 'terminal-x', originator: 'cli', provider: '', cwd: '/w', outside: true, stored: true, firstAt: '', lastAt: '' }]);
    mocks.send.mockResolvedValueOnce(page([], [], '2026-11-06T11:00:00.000Z'));
    await collectUsage(INCREMENTAL, '2026-11-06T11:00:00.000Z');
    const rollup = responseUsageStore().rollup;
    expect(rollup.originOf('__local__', 'walnut-run')).toMatchObject({ outside: false, stored: false });
    expect(rollup.originOf('__local__', 'terminal-x')?.outside).toBe(true);
  });

  it('a script\'s claude -p session Walnut imported because it began outside stays outside, and is not repaired into Walnut\'s', async () => {
    mocks.sessions.mockResolvedValue([
      { claudeSessionId: 'walnut-run', host: '__local__', engine: 'claude', taskId: 'example-task' },
      { claudeSessionId: 'script-run', host: '__local__', engine: 'claude', taskId: 'imp', human_note: 'Imported on request \u2014 started outside Walnut (claude -p).' },
      { claudeSessionId: 'script-seen', host: '__local__', engine: 'claude', taskId: 'imp2', human_note: 'Imported automatically \u2014 started outside Walnut (cli).' },
    ]);
    const rollup = responseUsageStore().rollup;
    rollup.recordOrigins([{ host: '__local__', sessionId: 'script-run', originator: 'sdk-cli', provider: '', cwd: '/w', outside: true, stored: true, firstAt: '', lastAt: '' }]);
    mocks.send.mockResolvedValueOnce(page([], [], '2026-11-06T12:00:00.000Z'));
    await collectUsage(INCREMENTAL, '2026-11-06T12:00:00.000Z');
    expect(rollup.originOf('__local__', 'script-run')?.outside).toBe(true); // not repaired
    expect(rollup.originOf('__local__', 'script-seen')).toMatchObject({ outside: true, stored: true }); // noted although the daemon sent nothing for it
    rollup.recordOrigins([{ host: '__local__', sessionId: 'script-seen', originator: 'sdk-cli', provider: '', cwd: '/w', outside: false, stored: false, firstAt: '', lastAt: '' }]);
    mocks.send.mockResolvedValueOnce(page([], [], '2026-11-06T12:30:00.000Z'));
    await collectUsage(INCREMENTAL, '2026-11-06T12:30:00.000Z');
    expect(rollup.originOf('__local__', 'script-seen')).toMatchObject({ outside: true, stored: true, originator: 'sdk-cli' }); // an older build's Walnut look is put right
  });

  it('a session of the SDK session server (sdk-ts) that Walnut has a record of is Walnut\'s', async () => {
    mocks.send.mockResolvedValueOnce(page([record('m32', 'walnut-run')], [{ sessionId: 'walnut-run', entrypoint: 'sdk-ts', cwd: '/home/u/tasks/example-task' }], '2026-11-06T09:30:00.000Z'));
    await collectUsage(INCREMENTAL, '2026-11-06T09:30:00.000Z');
    expect(responseUsageStore().rollup.originOf('__local__', 'walnut-run')?.outside).toBeFalsy();
  });

  it('a host that failed does not count as read in full', async () => {
    responseUsageStore().rollup.setThresholds([]);
    mocks.sessions.mockResolvedValue([{ claudeSessionId: 'walnut-run', host: 'devbox', engine: 'claude', taskId: 'example-task' }]);
    mocks.send.mockRejectedValue(new Error('timed out'));
    await collectUsage(INCREMENTAL, '2026-10-13T15:00:00.000Z');
    expect(responseUsageStore().rollup.claudeOutsideBuilt('devbox')).toBe(false);
  });
});

describe('an import that appears while a long read runs', () => {
  it('is Outside, because the second listing carries its note too', async () => {
    mocks.sessions.mockReset();
    const mine = { claudeSessionId: 'walnut-run', host: '__local__', engine: 'claude', taskId: 'example-task' };
    mocks.sessions.mockResolvedValueOnce([mine]);
    mocks.sessions.mockResolvedValue([mine, { claudeSessionId: 'late-import', host: '__local__', engine: 'claude', taskId: 'imp3', human_note: 'Imported automatically \u2014 started outside Walnut (claude -p).' }]);
    mocks.send.mockResolvedValueOnce(page([record('m50', 'late-import')], [{ sessionId: 'late-import', entrypoint: 'sdk-cli', cwd: '/w/x' }], '2026-11-06T13:00:00.000Z'));
    await collectUsage(INCREMENTAL, '2026-11-06T13:00:00.000Z');
    expect(responseUsageStore().rollup.originOf('__local__', 'late-import')?.outside).toBe(true);
  });
});

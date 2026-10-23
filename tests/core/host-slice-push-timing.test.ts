/**
 * When the Mac pushes a host its read copy (src/core/host-slice.ts ensureHostSliceSync).
 *
 * A host answers a session's `walnut` calls while the Mac is away only once its copy
 * names the session. The copy used to ride the 3 s debounce alone, so a lid closed
 * within 3 s of a start left the session unknown there and its writes answered
 * "hub unreachable" until the Mac came back (2026-10-23, tests/fleet). Now:
 *   - a session start pushes its host's copy at once (the start paths write the
 *     record first), and the rest of the burst still rides the debounce;
 *   - a status change of a session no pushed copy names (a record written at the
 *     CLI's init line, after the start event) pushes its host at once, once;
 *   - ordinary task churn still coalesces into one push 3 s after it began.
 * The pushes themselves are DaemonConnection's (mocked here): serialized per host there.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

const conn = vi.hoisted(() => ({
  pushHostSliceToAllHosts: vi.fn(),
  pushHostSliceToHost: vi.fn(),
  hostSliceNamesSession: vi.fn((_sid: string) => false),
}));
vi.mock('../../src/providers/daemon-connection.js', () => conn);

const records = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: vi.fn(async (sid: string) => records.get(sid) ?? null),
}));

import { bus } from '../../src/core/event-bus.js';
import { ensureHostSliceSync } from '../../src/core/host-slice.js';

/** Let the subscriber's async work (its module loads, the record read) finish; no timer moves. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

const now = () => new Date().toISOString();
const record = (sid: string, extra: Record<string, unknown> = {}) =>
  records.set(sid, { claudeSessionId: sid, taskId: `task-${sid}`, host: 'devbox', provider: 'cli', startedAt: now(), lastActiveAt: now(), ...extra });

describe('host copy push timing', () => {
  beforeAll(async () => {
    ensureHostSliceSync();
    // The subscriber is attached once the bus module has loaded.
    await settle();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterAll(() => { vi.useRealTimers(); });
  beforeEach(async () => {
    // Drain any debounce a previous case left armed, then start clean.
    await vi.advanceTimersByTimeAsync(3_000);
    conn.pushHostSliceToAllHosts.mockClear();
    conn.pushHostSliceToHost.mockClear();
    conn.hostSliceNamesSession.mockReset().mockImplementation(() => false);
  });

  it('a session start pushes its host at once; the rest of the burst still waits for the debounce', async () => {
    bus.emit('task:updated', { task: { id: 'task-a' } }, ['web-ui'], { source: 'task-start' });
    bus.emit('session:started', { taskId: 'task-a', project: 'Acme', host: 'devbox' }, ['main-ai'], { source: 'session-runner' });
    await settle();
    expect(conn.pushHostSliceToHost.mock.calls).toEqual([['devbox']]);
    expect(conn.pushHostSliceToAllHosts).not.toHaveBeenCalled();
    bus.emit('task:updated', { task: { id: 'task-a', session_id: 'sid-a' } }, ['web-ui'], { source: 'session-link' });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(conn.pushHostSliceToAllHosts).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(conn.pushHostSliceToAllHosts).toHaveBeenCalledTimes(1);
    expect(conn.pushHostSliceToHost).toHaveBeenCalledTimes(1);
  });

  it('a start on this machine (no host named) pushes the local copy', async () => {
    bus.emit('session:started', { taskId: 'task-b', project: '', host: undefined }, ['main-ai'], { source: 'session-runner' });
    await settle();
    expect(conn.pushHostSliceToHost.mock.calls).toEqual([['__local__']]);
  });

  it('a start that names only its session id pushes the host its record names', async () => {
    record('acp-c', { host: 'gpubox' });
    bus.emit('session:started', { sessionId: 'acp-c', claudeSessionId: 'acp-c', taskId: 'task-c', project: '', provider: 'cli' }, ['main-ai'], { source: 'session-runner' });
    await settle();
    expect(conn.pushHostSliceToHost.mock.calls).toEqual([['gpubox']]);
  });

  it('a burst of task events coalesces into one push for every host, 3 s after it began', async () => {
    for (let i = 0; i < 5; i++) {
      bus.emit('task:updated', { task: { id: 'task-d', title: `t${i}` } }, ['web-ui'], { source: 'api' });
      await vi.advanceTimersByTimeAsync(400);
    }
    await settle();
    expect(conn.pushHostSliceToAllHosts).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(conn.pushHostSliceToAllHosts).toHaveBeenCalledTimes(1);
    expect(conn.pushHostSliceToHost).not.toHaveBeenCalled();
    // Quiet afterwards: nothing more.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(conn.pushHostSliceToAllHosts).toHaveBeenCalledTimes(1);
  });

  it('a status change of a session no copy names pushes its host at once, and only once', async () => {
    record('late-e');
    const status = (sid: string) => bus.emit('session:status-changed', { sessionId: sid, process_status: 'running' }, ['*'], { source: 'session-runner' });
    status('late-e');
    await settle();
    expect(conn.pushHostSliceToHost.mock.calls).toEqual([['devbox']]);
    expect(conn.hostSliceNamesSession).toHaveBeenCalledWith('late-e');
    status('late-e');
    await settle();
    expect(conn.pushHostSliceToHost).toHaveBeenCalledTimes(1);
  });

  it('a status change of a session a copy already names, or no copy lists, waits for the debounce', async () => {
    record('named-f');
    conn.hostSliceNamesSession.mockImplementation((sid) => sid === 'named-f');
    record('archived-g', { archived: true });
    record('stale-h', { lastActiveAt: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString(), startedAt: new Date(Date.now() - 9 * 24 * 3600 * 1000).toISOString() });
    for (const sid of ['named-f', 'archived-g', 'stale-h', 'no-record-i']) {
      bus.emit('session:status-changed', { sessionId: sid, process_status: 'idle' }, ['*'], { source: 'session-runner' });
    }
    await settle();
    expect(conn.pushHostSliceToHost).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(conn.pushHostSliceToAllHosts).toHaveBeenCalledTimes(1);
  });
});

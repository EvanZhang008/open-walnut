import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord, Task } from '../../src/core/types.js';
const fixture = vi.hoisted(() => ({
  task: { id: 'exact-task', phase: 'IN_PROGRESS', session_id: 'exact-session' } as Task,
  record: { claudeSessionId: 'exact-session', host: 'fixture-host', process_status: 'running', pid: 5000 } as SessionRecord,
  connection: undefined as undefined | { send: ReturnType<typeof vi.fn> },
}));
vi.mock('../../src/core/task-manager.js', () => ({ getTask: async () => fixture.task, listTasksSlim: async () => [] }));
vi.mock('../../src/core/session-tracker.js', () => ({ getSessionsForTask: async () => [fixture.record] }));
vi.mock('../../src/providers/daemon-connection.js', () => ({ getConnectedDaemonConnection: () => fixture.connection }));
import { currentItemTaskStatus } from '../../src/core/human-inbox/item-status.js';

beforeEach(() => {
  fixture.connection = undefined;
  fixture.record = { claudeSessionId: 'exact-session', host: 'fixture-host', process_status: 'running', pid: 5000 } as SessionRecord;
  fixture.task.phase = 'IN_PROGRESS';
});
describe('Current Inbox task status requires fresh host truth', () => {
  it('does not publish Running from a saved pid while the owning host is disconnected', async () => {
    expect((await currentItemTaskStatus('exact-task')).status).toBe('unavailable');
  });
  it('asks the exact native session snapshot and separates an alive idle process from a running turn', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, alive: false });
    fixture.connection = { send };
    expect((await currentItemTaskStatus('exact-task')).status).toBe('stopped');
    expect(send).toHaveBeenCalledWith('getState', { sid: 'exact-session' }, 1500);
    send.mockResolvedValue({ ok: true, alive: true });
    expect((await currentItemTaskStatus('exact-task')).status).toBe('unavailable');
    send.mockResolvedValue({ ok: true, alive: true, snapshot: { cliState: 'idle', turnActive: false } });
    expect((await currentItemTaskStatus('exact-task')).status).toBe('idle');
    fixture.task.phase = 'NEED_ACTION';
    expect((await currentItemTaskStatus('exact-task')).status).toBe('waiting_user');
    send.mockResolvedValue({ ok: true, alive: true, snapshot: { cliState: 'running', turnActive: true } });
    expect((await currentItemTaskStatus('exact-task')).status).toBe('running');
  });
  it('honors permission, background work, scheduled work and result failure from the fresh native snapshot', async () => {
    const send = vi.fn(); fixture.connection = { send };
    for (const [patch, expected] of [
      [{ pendingPermission: { requestId: 'permission' } }, 'waiting_permission'],
      [{ detachedBgCount: 1 }, 'running'],
      [{ wakeupAt: Date.now() + 60_000 }, 'running'],
      [{ lastResult: { isError: true } }, 'error'],
    ] as const) {
      send.mockResolvedValue({ ok: true, alive: true, snapshot: { cliState: 'idle', turnActive: false, ...patch } });
      expect((await currentItemTaskStatus('exact-task')).status).toBe(expected);
    }
    fixture.record.process_status = 'idle';
    send.mockResolvedValue({ ok: true, alive: true, snapshot: { cliState: 'running', turnActive: true } });
    expect((await currentItemTaskStatus('exact-task')).status).toBe('running');
  });
  it('uses the ACP runtime identity and validates the provider identity before publishing state', async () => {
    fixture.record.engine = 'codex'; fixture.record.acpRuntimeId = 'acp-runtime';
    const send = vi.fn().mockResolvedValue({ ok: true, result: { providerSessionId: 'exact-session', turnActive: true, pendingPermissions: [] } });
    fixture.connection = { send };
    expect((await currentItemTaskStatus('exact-task')).status).toBe('running');
    expect(send).toHaveBeenCalledWith('acpState', { sid: 'acp-runtime' }, 1500);
    send.mockResolvedValue({ ok: true, result: { providerSessionId: 'exact-session', turnActive: false, pendingPermissions: [] } });
    expect((await currentItemTaskStatus('exact-task')).status).toBe('idle');
    send.mockResolvedValue({ ok: true, result: { providerSessionId: 'exact-session', turnActive: true, pendingPermissions: [{}] } });
    expect((await currentItemTaskStatus('exact-task')).status).toBe('waiting_permission');
    send.mockResolvedValue({ ok: true, result: { providerSessionId: 'other-session', turnActive: true, pendingPermissions: [] } });
    expect((await currentItemTaskStatus('exact-task')).status).toBe('unavailable');
    send.mockResolvedValue({ ok: false, errorKind: 'no_worker' });
    expect((await currentItemTaskStatus('exact-task')).status).toBe('stopped');
    fixture.record.acpRuntimeId = undefined;
    send.mockClear();
    expect((await currentItemTaskStatus('exact-task')).status).toBe('unavailable');
    expect(send).not.toHaveBeenCalled();
  });
  it('does not infer liveness on probe error or a malformed acknowledgement', async () => {
    const send = vi.fn().mockRejectedValue(new Error('Fixture transport unavailable'));
    fixture.connection = { send };
    expect((await currentItemTaskStatus('exact-task')).status).toBe('unavailable');
    send.mockResolvedValue({ ok: true });
    expect((await currentItemTaskStatus('exact-task')).status).toBe('unavailable');
  });
});

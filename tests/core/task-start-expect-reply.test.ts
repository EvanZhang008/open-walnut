import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-start'));
const mocks = vi.hoisted(() => ({
  getTask: vi.fn(), getProjectMetadata: vi.fn(), linkSession: vi.fn(), updateTaskRaw: vi.fn(), getSessionsForTask: vi.fn(),
  createSessionRecord: vi.fn(), updateSessionRecord: vi.fn(), resolveCaller: vi.fn(),
  startSession: vi.fn(), notifyRequesterFallback: vi.fn(), cancelPendingStart: vi.fn(), hasCapability: vi.fn(),
}));
vi.mock('../../src/core/task-manager.js', () => ({ getTask: mocks.getTask, getProjectMetadata: mocks.getProjectMetadata, linkSession: mocks.linkSession, updateTaskRaw: mocks.updateTaskRaw }));
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionsForTask: mocks.getSessionsForTask,
  createSessionRecord: mocks.createSessionRecord,
  updateSessionRecord: mocks.updateSessionRecord,
}));
vi.mock('../../src/core/sessions/session-send-core.js', () => ({ resolveCaller: mocks.resolveCaller }));
vi.mock('../../src/providers/claude-code-session.js', () => ({ sessionRunner: { startSession: mocks.startSession } }));
vi.mock('../../src/providers/daemon-connection.js', () => ({
  getConnectedDaemonConnection: () => ({ send: mocks.cancelPendingStart, hasCapability: mocks.hasCapability }),
  getDaemonConnection: vi.fn(),
}));
vi.mock('../../src/core/sessions/session-request-notify.js', () => ({ notifyRequesterFallback: mocks.notifyRequesterFallback }));

import { startSessionForTask, SessionExistsError, isTaskStarting } from '../../src/core/sessions/task-start.js';
import { REQUESTS_FILE, getSessionRequest } from '../../src/core/session-requests.js';

const params = { taskIdPrefix: 'task-1', message: 'Fix the flake.', source: 'test' };
const task = { id: 'task-1', title: 'Fix the flake', project: 'test', cwd: '/tmp/test-project' };

beforeEach(() => {
  vi.resetAllMocks();
  fs.rmSync(REQUESTS_FILE, { force: true });
  mocks.getTask.mockResolvedValue(task);
  mocks.getProjectMetadata.mockResolvedValue(undefined);
  mocks.getSessionsForTask.mockResolvedValue([]);
  mocks.updateSessionRecord.mockResolvedValue({});
  mocks.updateTaskRaw.mockResolvedValue({ changed: true });
  mocks.hasCapability.mockReturnValue(true);
  mocks.cancelPendingStart.mockRejectedValue(new Error('Host disconnected'));
  mocks.resolveCaller.mockResolvedValue({ kind: 'session', record: { claudeSessionId: 'asker-1' } });
  mocks.startSession.mockImplementation(async (data) => ({ claudeSessionId: data.preassignedSessionId, title: task.title }));
});
afterEach(() => { vi.useRealTimers(); });

describe('task start confirmation and reply contract', () => {
  it('seeds the record before invoking the runner and waits for confirmation', async () => {
    let finish!: (value: unknown) => void;
    mocks.startSession.mockImplementation((data) => new Promise((resolve) => {
      expect(mocks.createSessionRecord).toHaveBeenCalledWith(data.preassignedSessionId, task.id, task.project, task.cwd,
        expect.objectContaining({ initialProcessStatus: 'idle', initialStatusReason: 'awaiting_spawn' }));
      finish = resolve;
    }));
    const pending = startSessionForTask(params);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    const data = mocks.startSession.mock.calls[0][0];
    finish({ claudeSessionId: data.preassignedSessionId });
    const result = await pending;
    expect(result.started).toBe(true);
    expect(result.sessionId).toBe(data.preassignedSessionId);
  });

  it('registers a reply by default and teaches the task_send reply command', async () => {
    const result = await startSessionForTask(params);
    expect(result.requestId).toMatch(/^rq-[a-f0-9]{12}$/);
    await expect(getSessionRequest(result.requestId!)).resolves.toMatchObject({
      status: 'pending', fromSessionId: 'asker-1', toTaskId: 'task-1', toSessionId: result.sessionId,
    });
    expect(mocks.startSession.mock.calls[0][0].message).toBe('Fix the flake.\n'
      + `Reply when done: walnut tools call task_send '{"in_reply_to":"${result.requestId}","text":"<your result summary>"}'`);
  });

  it.each(['human', 'external'])('does not request a reply from an untracked %s caller', async (kind) => {
    mocks.resolveCaller.mockResolvedValue({ kind });
    const result = await startSessionForTask(params);
    expect(result.requestId).toBeUndefined();
    expect(mocks.startSession.mock.calls[0][0].message).toBe(params.message);
  });

  it('rejects explicit reply to an untracked caller before any launch write', async () => {
    mocks.resolveCaller.mockResolvedValue({ kind: 'human' });
    await expect(startSessionForTask({ ...params, expectReply: true })).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.createSessionRecord).not.toHaveBeenCalled();
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it('honors explicit fire-and-forget', async () => {
    const result = await startSessionForTask({ ...params, expectReply: false });
    expect(result.requestId).toBeUndefined();
    expect(mocks.resolveCaller).not.toHaveBeenCalled();
  });

  it('preserves the reply deadline', async () => {
    const result = await startSessionForTask({ ...params, replyTimeoutSecs: 7200 });
    const row = await getSessionRequest(result.requestId!);
    expect(row!.deadlineAt - Date.parse(row!.createdAt)).toBe(7_200_000);
  });

  it('blocks an existing live task before creating any request', async () => {
    mocks.getSessionsForTask.mockResolvedValue([{ claudeSessionId: 'live-1', process_status: 'idle' }]);
    await expect(startSessionForTask(params)).rejects.toBeInstanceOf(SessionExistsError);
    expect(mocks.createSessionRecord).not.toHaveBeenCalled();
    expect(fs.existsSync(REQUESTS_FILE)).toBe(false);
  });

  it('blocks concurrent starts even before the first record exists', async () => {
    let release!: (rows: unknown[]) => void;
    mocks.getSessionsForTask.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const first = startSessionForTask(params);
    await Promise.resolve();
    await expect(startSessionForTask(params)).rejects.toBeInstanceOf(SessionExistsError);
    release([]);
    await first;
    expect(mocks.startSession).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed start record, notifies the caller, and permits same-id retry', async () => {
    mocks.startSession.mockRejectedValueOnce(new Error('Working directory no longer exists: /tmp/missing'));
    await expect(startSessionForTask(params)).rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining('retry task_start') });
    expect(mocks.updateSessionRecord).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      process_status: 'error', errorMessage: expect.stringContaining('/tmp/missing'),
    }));
    expect(mocks.notifyRequesterFallback).toHaveBeenCalledWith(expect.objectContaining({ toTaskId: task.id }), 'error');
    await expect(startSessionForTask(params)).resolves.toMatchObject({ taskId: task.id, started: true });
  });

  it('returns starting on a bounded wait without releasing the in-flight guard', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let finish!: (value: unknown) => void;
    mocks.startSession.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = startSessionForTask({ ...params, expectReply: false });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toMatchObject({ started: false, taskId: task.id });
    await expect(startSessionForTask(params)).rejects.toBeInstanceOf(SessionExistsError);
    finish({ claudeSessionId: 'eventual-1' });
    await vi.waitFor(() => expect(isTaskStarting(task.id)).toBe(false));
  });

  it('keeps uncertain attempts blocked rather than minting a second run', async () => {
    mocks.getTask.mockResolvedValue({ ...task, last_start: { id: 'attempt-1', state: 'unconfirmed', session_id: 'old-run' } });
    await expect(startSessionForTask(params)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('unconfirmed') });
    expect(mocks.startSession).not.toHaveBeenCalled();
    expect(mocks.createSessionRecord).not.toHaveBeenCalled();
  });

  it.each(['native', 'provider-issued'])('retries an uncertain %s start only after the host cancels it', async (kind) => {
    mocks.getTask.mockResolvedValue({ ...task, last_start: { id: 'attempt-1', state: 'unconfirmed', runtime_id: 'runtime-old' } });
    mocks.cancelPendingStart.mockResolvedValue({ ok: true, cancelled: true, alive: false });
    await expect(startSessionForTask({ ...params, engine: kind === 'native' ? 'claude' : 'codex' })).resolves.toMatchObject({ started: true });
    expect(mocks.cancelPendingStart).toHaveBeenCalledWith('cancelPendingStart', { sid: 'runtime-old' }, 5_000);
    expect(mocks.startSession).toHaveBeenCalledTimes(1);
  });

  it('does not cancel or replace a process that actually started', async () => {
    mocks.getTask.mockResolvedValue({ ...task, last_start: { id: 'attempt-1', state: 'unconfirmed', runtime_id: 'runtime-old' } });
    mocks.cancelPendingStart.mockResolvedValue({ ok: true, cancelled: false, alive: true });
    await expect(startSessionForTask(params)).rejects.toBeInstanceOf(SessionExistsError);
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it('records provider-issued failure without inventing a provider session id', async () => {
    mocks.startSession.mockRejectedValueOnce(new Error('Adapter executable missing'));
    await expect(startSessionForTask({ ...params, engine: 'codex' })).rejects.toMatchObject({ statusCode: 502 });
    expect(mocks.createSessionRecord).not.toHaveBeenCalled();
    expect(mocks.updateTaskRaw).toHaveBeenLastCalledWith(task.id, expect.objectContaining({ last_start: expect.objectContaining({ state: 'failed', error: 'Adapter executable missing' }) }), expect.any(Object));
  });

  it('does not create a reply request if claiming the task fails', async () => {
    mocks.updateTaskRaw.mockRejectedValueOnce(new Error('Task store unavailable'));
    await expect(startSessionForTask(params)).rejects.toThrow('Task store unavailable');
    expect(fs.existsSync(REQUESTS_FILE)).toBe(false);
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it('does not report spawn failure when only outcome persistence fails', async () => {
    mocks.updateTaskRaw.mockResolvedValueOnce({ changed: true }).mockRejectedValueOnce(new Error('Task store unavailable'));
    await expect(startSessionForTask(params)).resolves.toMatchObject({ started: true });
    expect(mocks.updateSessionRecord).not.toHaveBeenCalled();
    expect(mocks.notifyRequesterFallback).not.toHaveBeenCalled();
  });

  it('releases the in-memory guard at the confirmation deadline and retains late success', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let finish!: (value: unknown) => void;
    mocks.startSession.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = startSessionForTask({ ...params, expectReply: false });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await pending).toMatchObject({ started: false });
    expect(isTaskStarting(task.id)).toBe(false);
    expect(mocks.updateTaskRaw).toHaveBeenLastCalledWith(task.id, expect.objectContaining({ last_start: expect.objectContaining({ state: 'unconfirmed' }) }), expect.any(Object));
    finish({ claudeSessionId: 'late-session' });
    await vi.waitFor(() => expect(mocks.updateTaskRaw).toHaveBeenLastCalledWith(task.id, expect.objectContaining({ last_start: expect.objectContaining({ state: 'started', session_id: 'late-session' }) }), expect.any(Object)));
  });

  it('inherits host even when cwd was explicitly supplied', async () => {
    mocks.getProjectMetadata.mockResolvedValue({ default_host: '__local__', default_cwd: '/tmp/project-default' });
    await startSessionForTask({ ...params, cwd: '/tmp/override' });
    expect(mocks.startSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/tmp/override', host: '' }));
  });

  it('uses the stored instruction on retry and respects explicit local host', async () => {
    mocks.getTask.mockResolvedValue({ ...task, description: 'Preserved instruction' });
    mocks.getProjectMetadata.mockResolvedValue({ default_host: 'not-enabled' });
    await startSessionForTask({ ...params, message: undefined, host: '' });
    expect(mocks.startSession).toHaveBeenCalledWith(expect.objectContaining({ host: '', message: expect.stringContaining('Preserved instruction') }));
  });
});

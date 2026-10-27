/**
 * task_start's launch choices that match the draft column (2026-10-27): effort,
 * "Create folder & start" (create_cwd) and an isolated workspace, each through
 * the same core the person's launch reaches (the --effort spawn arg and the
 * session record, ensureCwd, requestWorkspace), and the `applied` list a newer
 * op reads to tell an older server's silence from a refusal.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-start-options'));
const mocks = vi.hoisted(() => ({
  getTask: vi.fn(), getProjectMetadata: vi.fn(), linkSession: vi.fn(), updateTaskRaw: vi.fn(), getSessionsForTask: vi.fn(),
  createSessionRecord: vi.fn(), updateSessionRecord: vi.fn(), resolveCaller: vi.fn(), startSession: vi.fn(), requestWorkspace: vi.fn(),
}));
vi.mock('../../src/core/task-manager.js', () => ({ getTask: mocks.getTask, getProjectMetadata: mocks.getProjectMetadata, linkSession: mocks.linkSession, updateTaskRaw: mocks.updateTaskRaw }));
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionsForTask: mocks.getSessionsForTask, createSessionRecord: mocks.createSessionRecord, updateSessionRecord: mocks.updateSessionRecord,
}));
vi.mock('../../src/core/sessions/session-send-core.js', () => ({ resolveCaller: mocks.resolveCaller }));
vi.mock('../../src/providers/claude-code-session.js', () => ({ sessionRunner: { startSession: mocks.startSession } }));
vi.mock('../../src/core/workspaces/manager.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestWorkspace: mocks.requestWorkspace,
}));

import { startSessionForTask } from '../../src/core/sessions/task-start.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-start-options-'));
const task = { id: 'task-1', title: 'Fix the flake', project: 'test', cwd: tmp };
const params = { taskIdPrefix: 'task-1', message: 'Fix the flake.', source: 'test', expectReply: false };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getTask.mockResolvedValue(task);
  mocks.getProjectMetadata.mockResolvedValue(undefined);
  mocks.getSessionsForTask.mockResolvedValue([]);
  mocks.updateSessionRecord.mockResolvedValue({});
  mocks.updateTaskRaw.mockResolvedValue({ changed: true });
  mocks.startSession.mockImplementation(async (data) => ({ claudeSessionId: data.preassignedSessionId }));
  mocks.requestWorkspace.mockResolvedValue({ ...task, workspace: { state: 'creating' } });
});

describe('effort', () => {
  it('rides the spawn and the session record, as the person\'s effort pick does', async () => {
    const result = await startSessionForTask({ ...params, effort: 'xhigh' });
    expect(mocks.startSession.mock.calls[0][0].effort).toBe('xhigh');
    expect(mocks.createSessionRecord.mock.calls[0][4]).toMatchObject({ effort: 'xhigh' });
    expect(result.applied).toEqual(['effort']);
  });

  it('a start without one names nothing: the model default, and an empty applied list', async () => {
    const result = await startSessionForTask(params);
    expect(mocks.startSession.mock.calls[0][0].effort).toBeUndefined();
    expect(mocks.createSessionRecord.mock.calls[0][4].effort).toBeUndefined();
    expect(result.applied).toEqual([]);
  });

  it('refuses an unknown level and an ACP engine before any write', async () => {
    await expect(startSessionForTask({ ...params, effort: 'huge' as never })).rejects.toMatchObject({ statusCode: 400 });
    await expect(startSessionForTask({ ...params, effort: 'high', engine: 'codex' })).rejects.toMatchObject({
      statusCode: 400, message: expect.stringContaining('claude engine'),
    });
    expect(mocks.updateTaskRaw).not.toHaveBeenCalled();
    expect(mocks.startSession).not.toHaveBeenCalled();
  });
});

describe('create_cwd', () => {
  it('makes the missing folder before the spawn, and names it in applied', async () => {
    const dir = path.join(tmp, 'new', 'deep');
    const result = await startSessionForTask({ ...params, cwd: dir, createCwd: true });
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(mocks.startSession.mock.calls[0][0].cwd).toBe(dir);
    expect(result.applied).toEqual(['create_cwd']);
  });

  it('without it a missing folder is not made', async () => {
    const dir = path.join(tmp, 'never-made');
    await startSessionForTask({ ...params, cwd: dir });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('refuses shell characters in the folder it would make', async () => {
    await expect(startSessionForTask({ ...params, cwd: `${tmp}/x;rm`, createCwd: true })).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.startSession).not.toHaveBeenCalled();
  });
});

describe('workspace', () => {
  it('asks the host for the workspace and leaves the start waiting in it, with every launch choice', async () => {
    mocks.resolveCaller.mockResolvedValue({ kind: 'human' });
    const result = await startSessionForTask({
      ...params, effort: 'high', mode: 'auto', callerSid: 'lead-1', userRequest: 'start it in a clean copy now',
      workspace: { provider: 'git-worktree', inputs: { branch: 'fix/flake' } },
    });
    expect(result).toMatchObject({ taskId: 'task-1', started: false, preparing: true, applied: ['workspace', 'effort'] });
    expect(mocks.startSession).not.toHaveBeenCalled();
    const [taskId, req] = mocks.requestWorkspace.mock.calls[0];
    expect(taskId).toBe('task-1');
    expect(req).toMatchObject({
      provider: 'git-worktree', host: '__local__', anchor: tmp, inputs: { branch: 'fix/flake' },
      pending: {
        via: 'task-start', message: 'Fix the flake.', effort: 'high', mode: 'auto',
        caller_sid: 'lead-1', user_request: 'start it in a clean copy now', expect_reply: false,
      },
    });
  });

  it('a task whose workspace is ready starts in it now, and asks for none', async () => {
    mocks.getTask.mockResolvedValue({ ...task, workspace: { state: 'ready', host: '__local__', cwd: tmp, root: tmp, anchor: '/src/repo', repos: [] } });
    const result = await startSessionForTask({ ...params, workspace: { provider: 'git-worktree' } });
    expect(result.applied).toEqual(['workspace']);
    expect(mocks.startSession.mock.calls[0][0].cwd).toBe(tmp);
    expect(mocks.requestWorkspace).not.toHaveBeenCalled();
    expect(mocks.startSession).toHaveBeenCalled();
  });

  it('refuses before asking the host: a live session, a conversation, a complete task, no folder, create_cwd with it', async () => {
    const ws = { provider: 'git-worktree' };
    mocks.getSessionsForTask.mockResolvedValueOnce([{ claudeSessionId: 'live-1', process_status: 'idle' }]);
    await expect(startSessionForTask({ ...params, workspace: ws })).rejects.toMatchObject({ statusCode: 409 });
    mocks.getSessionsForTask.mockResolvedValueOnce([]).mockResolvedValueOnce([{ claudeSessionId: 'old-1', process_status: 'stopped', cwd: tmp }]);
    await expect(startSessionForTask({ ...params, workspace: ws })).rejects.toMatchObject({
      statusCode: 409, message: expect.stringContaining('already has its one session'),
    });
    mocks.getTask.mockResolvedValueOnce({ ...task, phase: 'COMPLETE' });
    await expect(startSessionForTask({ ...params, workspace: ws })).rejects.toMatchObject({ statusCode: 409 });
    mocks.getTask.mockResolvedValueOnce({ ...task, cwd: undefined });
    await expect(startSessionForTask({ ...params, workspace: ws })).rejects.toMatchObject({
      statusCode: 400, message: expect.stringContaining('no folder for a workspace'),
    });
    await expect(startSessionForTask({ ...params, workspace: ws, createCwd: true })).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.requestWorkspace).not.toHaveBeenCalled();
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it('a start waiting for a workspace already on the way is checked too (ACP + effort fails now, not at replay)', async () => {
    mocks.getTask.mockResolvedValue({ ...task, workspace: { state: 'creating', host: '__local__', root: tmp, cwd: tmp } });
    await expect(startSessionForTask({ ...params, engine: 'codex', effort: 'high' })).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.updateTaskRaw).not.toHaveBeenCalled();
  });

  it('a provider the host refuses is the start\'s error, and nothing starts', async () => {
    const { WorkspaceError } = await import('../../src/core/workspaces/daemon-client.js');
    mocks.requestWorkspace.mockRejectedValue(new WorkspaceError('Unknown workspace provider: nope', 400, 'unknown-provider'));
    await expect(startSessionForTask({ ...params, workspace: { provider: 'nope' } })).rejects.toMatchObject({
      statusCode: 400, message: expect.stringContaining('Unknown workspace provider'),
    });
    expect(mocks.startSession).not.toHaveBeenCalled();
  });
});

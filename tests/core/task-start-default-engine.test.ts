/**
 * task_start with no engine runs on the ONE default engine (Settings > Engines),
 * as every other Walnut launch does. It used to run Claude always, so a Main on a
 * local model started leads that needed Claude Code.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-start-default-engine'));
const mocks = vi.hoisted(() => ({
  getTask: vi.fn(), getProjectMetadata: vi.fn(), linkSession: vi.fn(), updateTaskRaw: vi.fn(), getSessionsForTask: vi.fn(),
  createSessionRecord: vi.fn(), updateSessionRecord: vi.fn(), startSession: vi.fn(), getConfig: vi.fn(),
}));
vi.mock('../../src/core/task-manager.js', () => ({ getTask: mocks.getTask, getProjectMetadata: mocks.getProjectMetadata, linkSession: mocks.linkSession, updateTaskRaw: mocks.updateTaskRaw }));
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionsForTask: mocks.getSessionsForTask, createSessionRecord: mocks.createSessionRecord, updateSessionRecord: mocks.updateSessionRecord,
}));
vi.mock('../../src/core/config-manager.js', () => ({ getConfig: mocks.getConfig }));
vi.mock('../../src/providers/claude-code-session.js', () => ({ sessionRunner: { startSession: mocks.startSession } }));

import { startSessionForTask } from '../../src/core/sessions/task-start.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-start-default-engine-'));
const task = { id: 'task-1', title: 'Lead of marina', project: 'test', cwd: tmp };
const params = { taskIdPrefix: 'task-1', message: 'Start.', source: 'test', expectReply: false };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getTask.mockResolvedValue(task);
  mocks.getProjectMetadata.mockResolvedValue(undefined);
  mocks.getSessionsForTask.mockResolvedValue([]);
  mocks.updateSessionRecord.mockResolvedValue({});
  mocks.updateTaskRaw.mockResolvedValue({ changed: true });
  mocks.startSession.mockImplementation(async (data) => ({ claudeSessionId: data.preassignedSessionId ?? 'provider-issued-1' }));
});

describe('task_start with no engine', () => {
  it('runs on the configured default engine', async () => {
    mocks.getConfig.mockResolvedValue({ defaults: { engine: 'opencode' } });
    await startSessionForTask(params);
    expect(mocks.startSession.mock.calls[0][0].engine).toBe('opencode');
  });

  it('runs Claude when no default is set (unchanged)', async () => {
    mocks.getConfig.mockResolvedValue({ defaults: {} });
    await startSessionForTask(params);
    expect(mocks.startSession.mock.calls[0][0].engine).toBeUndefined();
    expect(mocks.startSession.mock.calls[0][0].preassignedSessionId).toBeTruthy();
  });

  it('an engine the caller names still wins', async () => {
    mocks.getConfig.mockResolvedValue({ defaults: { engine: 'opencode' } });
    await startSessionForTask({ ...params, engine: 'codex' });
    expect(mocks.startSession.mock.calls[0][0].engine).toBe('codex');
  });

  it('an effort (Claude only) keeps Claude', async () => {
    mocks.getConfig.mockResolvedValue({ defaults: { engine: 'opencode' } });
    await startSessionForTask({ ...params, effort: 'high' });
    expect(mocks.startSession.mock.calls[0][0].engine).toBeUndefined();
  });

  it('a remote host keeps Claude (ACP engines run on this machine only)', async () => {
    mocks.getConfig.mockResolvedValue({ defaults: { engine: 'opencode' }, hosts: { devbox: { hostname: 'devbox' } } });
    await startSessionForTask({ ...params, host: 'devbox', cwd: '/work' });
    expect(mocks.startSession.mock.calls[0][0].engine).toBeUndefined();
  });
});

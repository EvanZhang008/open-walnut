/**
 * The first message of a session Walnut starts for a task (task-start.ts) does not pass the
 * queue, so it carries what an App gave the task itself: an AI-only brief leads it, told only
 * once the start went out (app-brief.ts). An engine switch starts this way too.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-app-brief-start'));
const mocks = vi.hoisted(() => ({
  getTask: vi.fn(), getProjectMetadata: vi.fn(), linkSession: vi.fn(), updateTaskRaw: vi.fn(), getSessionsForTask: vi.fn(),
  createSessionRecord: vi.fn(), updateSessionRecord: vi.fn(), resolveCaller: vi.fn(), startSession: vi.fn(),
  pendingAppState: vi.fn(), markTold: vi.fn(), release: vi.fn(),
}));
vi.mock('../../../src/core/task-manager.js', () => ({ getTask: mocks.getTask, getProjectMetadata: mocks.getProjectMetadata, linkSession: mocks.linkSession, updateTaskRaw: mocks.updateTaskRaw }));
vi.mock('../../../src/core/session-tracker.js', () => ({
  getSessionsForTask: mocks.getSessionsForTask, createSessionRecord: mocks.createSessionRecord, updateSessionRecord: mocks.updateSessionRecord,
}));
vi.mock('../../../src/core/sessions/session-send-core.js', () => ({ resolveCaller: mocks.resolveCaller }));
vi.mock('../../../src/providers/claude-code-session.js', () => ({ sessionRunner: { startSession: mocks.startSession } }));
vi.mock('../../../src/core/sessions/app-state.js', () => ({ pendingAppState: mocks.pendingAppState }));

import { startSessionForTask } from '../../../src/core/sessions/task-start.js';

const BRIEF = '<walnut-message kind="app-state" from="Quiz" title="brief" ai-only="true">\nrubric\n</walnut-message>';
const task = { id: 'task-1', title: 'Practice', project: 'test', cwd: '/tmp' };
const params = { taskIdPrefix: 'task-1', message: 'Start the round.', source: 'test', expectReply: false };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getTask.mockResolvedValue(task);
  mocks.getSessionsForTask.mockResolvedValue([]);
  mocks.updateSessionRecord.mockResolvedValue({});
  mocks.updateTaskRaw.mockResolvedValue({ changed: true });
  mocks.pendingAppState.mockResolvedValue({ text: BRIEF, markTold: mocks.markTold, release: mocks.release });
});

describe('the first message of a started session', () => {
  it('leads with the brief, and the brief counts as told once the start went out', async () => {
    mocks.startSession.mockImplementation(async (data) => ({ claudeSessionId: data.preassignedSessionId }));
    await startSessionForTask(params);
    const sent = String(mocks.startSession.mock.calls[0][0].message);
    expect(sent.startsWith(`${BRIEF}\n\n`)).toBe(true);
    expect(sent).toContain('Start the round.');
    expect(mocks.startSession.mock.calls[0][0].namingMessage).not.toContain('rubric');
    expect(mocks.pendingAppState.mock.calls[0][0]).toBe(mocks.startSession.mock.calls[0][0].preassignedSessionId);
    expect(mocks.markTold).toHaveBeenCalledTimes(1);
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('a start that fails gives it back for the next message', async () => {
    mocks.startSession.mockRejectedValue(new Error('spawn failed'));
    await expect(startSessionForTask(params)).rejects.toThrow('spawn failed');
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.markTold).not.toHaveBeenCalled();
  });

  it('an ACP engine, whose id comes from the provider: the brief leads, told under the id it got', async () => {
    mocks.startSession.mockImplementation(async () => ({ claudeSessionId: 'provider-sid-1' }));
    await startSessionForTask({ ...params, engine: 'codex' });
    expect(String(mocks.startSession.mock.calls[0][0].message).startsWith(`${BRIEF}\n\n`)).toBe(true);
    expect(mocks.pendingAppState.mock.calls[0][3]).toEqual({ taskId: 'task-1' });
    expect(mocks.markTold).toHaveBeenCalledWith('provider-sid-1');
  });

  it('a start with no message (an idle engine switch) runs no turn for the brief', async () => {
    mocks.startSession.mockImplementation(async (data) => ({ claudeSessionId: data.preassignedSessionId }));
    await startSessionForTask({ ...params, message: '', idle: true });
    expect(mocks.pendingAppState).not.toHaveBeenCalled();
    expect(String(mocks.startSession.mock.calls[0]?.[0]?.message ?? '')).not.toContain('rubric');
  });

  it('nothing to carry leaves the message as it was', async () => {
    mocks.pendingAppState.mockResolvedValue(null);
    mocks.startSession.mockImplementation(async (data) => ({ claudeSessionId: data.preassignedSessionId }));
    await startSessionForTask(params);
    expect(String(mocks.startSession.mock.calls[0][0].message)).not.toContain('walnut-message kind="app-state"');
  });
});

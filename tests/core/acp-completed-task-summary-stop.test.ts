/**
 * The turn-end summary of an ACP session whose task is COMPLETE starts its worker
 * again (completing the task stopped it), so the worker is stopped once the report
 * is in (src/core/session-hooks/builtins.ts stopAcpWorkerOfCompletedTask).
 * 2026-11-01: a completed OpenCode task's worker came back for its summary four
 * minutes after the completion and then stayed up idle.
 */
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-acp-completed-summary-stop'));

import { WALNUT_HOME } from '../../src/constants.js';
import { _resetForTesting, addTask, completeTask } from '../../src/core/task-manager.js';
import { _resetSessionTrackerForTesting, createSessionRecord, getSessionByClaudeId } from '../../src/core/session-tracker.js';
import { __resetTriageRateLimiter, runTriage } from '../../src/core/session-hooks/builtins.js';
import type { OnTurnCompletePayload } from '../../src/core/session-hooks/types.js';
import type { SessionRecord, Task } from '../../src/core/types.js';
import { sessionRunner } from '../../src/providers/claude-code-session.js';

const REPORT = `EXEC_SUMMARY: Fixed the word count.
GOAL: unchanged
CONTEXT: unchanged
PROGRESS: DONE fix - tests pass
WORK_LOG: append: Fixed count_words.
RECAP: Word count fixed.
PHASE_SIGNAL: implement-done
VERIFIED: ran-and-saw-pass`;

const acpMap = () => (sessionRunner as unknown as { acpSessions: Map<string, unknown> }).acpSessions;

beforeEach(async () => {
  _resetForTesting();
  _resetSessionTrackerForTesting();
  __resetTriageRateLimiter();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  acpMap().clear();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

async function summarize(task: Task, sessionId: string, engine: string) {
  const record = await createSessionRecord(sessionId, task.id, '', '/tmp/acp-done', {
    initialProcessStatus: 'idle', engine, acpRuntimeId: `rt-${sessionId}`,
  } as never);
  const fake = {
    runtimeId: `rt-${sessionId}`,
    sessionId,
    activity: 'idle',
    workerLive: true,
    establish: vi.fn(async () => sessionId),
    send: vi.fn(async () => {}),
    abortTurn: vi.fn(async () => {}),
    requestTurnCompleteSelfReport: vi.fn(async () => REPORT),
    gracefulStop: vi.fn(async () => { fake.workerLive = false }),
  };
  acpMap().set(sessionId, fake);
  await runTriage({
    sessionId, taskId: task.id, task, session: record as SessionRecord, result: 'done',
    turnIndex: 1, isPlanSession: false, timestamp: new Date().toISOString(), traceId: 't',
  } as OnTurnCompletePayload);
  return fake;
}

describe('the summary of a completed task on an ACP engine', () => {
  it('stops the worker it started again, and records it stopped', async () => {
    const { task } = await addTask({ title: 'Fix the word count', source: 'local', _skipPluginOps: true } as never);
    await completeTask(task.id);
    const fake = await summarize(task, 'acp-done-1', 'opencode');
    expect(fake.requestTurnCompleteSelfReport).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(fake.gracefulStop).toHaveBeenCalledOnce());
    expect(await getSessionByClaudeId('acp-done-1')).toMatchObject({ process_status: 'stopped' });
  });

  it('leaves the worker of an open task running', async () => {
    const { task } = await addTask({ title: 'Still open', source: 'local', _skipPluginOps: true } as never);
    const fake = await summarize(task, 'acp-open-1', 'goose');
    expect(fake.requestTurnCompleteSelfReport).toHaveBeenCalledOnce();
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.gracefulStop).not.toHaveBeenCalled();
    expect(await getSessionByClaudeId('acp-open-1')).toMatchObject({ process_status: 'idle' });
  });
});

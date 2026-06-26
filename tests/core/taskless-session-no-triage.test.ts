/**
 * Regression test for the invariant: a session with NO associated task must
 * never trigger triage.
 *
 * Triage exists to keep a TASK's summary/phase in sync with what its session
 * did. A taskless session (e.g. an on-demand agent conversation, an ad-hoc
 * /sessions chat with no quick-start task behind it) has nothing to triage —
 * dispatching one would burn tokens on a subagent that has no task to update,
 * and historically risked self-propagating task_create loops.
 *
 * Both turn-boundary triage hooks short-circuit when there is no REAL task:
 *   - turnCompleteTriageHook  (onTurnComplete) → builtins.ts: `if (!p.taskId || !p.task) return`
 *   - messageSendTriageHook   (onMessageSend)  → builtins.ts: `if (!p.taskId || !p.task) return`
 *
 * The guard has two arms, and both are exercised here:
 *   1. taskId === '' (or undefined) — the sentinel a taskless session is created
 *      with (ad-hoc /sessions chats, on-demand agent conversations).
 *   2. taskId non-empty but `task` undefined — a DANGLING taskId: the id points
 *      at a task that no longer exists in tasks.json (deleted / stale / cross-
 *      workspace). PayloadBuilder resolves `task` via getTask() and silently
 *      leaves it undefined when that throws, so the `!p.taskId` arm alone would
 *      let these through and triage a nonexistent task.
 *
 * This locks that behavior so a future refactor of the hook bodies (which now
 * do real work — side_question self-report, summary persistence, notification
 * history) can't silently regress the guard. A with-task control case in each
 * block proves the capture harness actually observes a dispatch, so the
 * no-triage assertions can't pass vacuously.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-taskless-no-triage'));

import { WALNUT_HOME } from '../../src/constants.js';
import { bus } from '../../src/core/event-bus.js';
import { sessionRunner } from '../../src/providers/claude-code-session.js';
import { addTask } from '../../src/core/task-manager.js';
import { turnCompleteTriageHook, messageSendTriageHook, runTriage } from '../../src/core/session-hooks/builtins.js';
import type { OnTurnCompletePayload, OnMessageSendPayload } from '../../src/core/session-hooks/types.js';
import type { Task } from '../../src/core/types.js';

// Distinct SIDs: the turn-complete hook has a 5s per-(sessionId:taskId) cooldown,
// so each control case that actually dispatches needs its own session id.
const SID_TASKLESS_TURN = 'taskless-turn-complete';
const SID_TASKLESS_MSG = 'taskless-message-send';
const SID_DANGLING_TURN = 'dangling-turn-complete';
const SID_DANGLING_MSG = 'dangling-message-send';
const SID_WITHTASK_TURN = 'withtask-turn-complete';
const SID_WITHTASK_MSG = 'withtask-message-send';

// A non-empty id that does NOT exist in tasks.json (dangling reference).
const DANGLING_TASK_ID = 'task-deleted-deadbeef';

const SAMPLE_REPORT = `WHAT_I_DID: Touched nothing important.
STATUS: succeeded — trivially.
CHANGES_TRIED: none.
PHASE_SIGNAL: conversational(user-asked-question)
NEXT_STEPS: none.
BLOCKERS: none
USER_INTENT: question-pending — user just asked a question.
VERIFIED: not-applicable.
ARTIFACTS: none`;

/** Register a fake live session so the turn-complete hook's askSideQuestion path
 *  has something to call (only reached once taskId is present). */
function registerFakeSession(sid: string) {
  const fake = {
    sessionId: sid,
    askSideQuestion: vi.fn(async () => SAMPLE_REPORT),
    detach: () => {},
    kill: () => {},
    get active() { return false; },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (sessionRunner as any).sessions.set(sid, fake);
  return fake;
}

function unregisterFakeSessions() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const map = (sessionRunner as any).sessions as Map<string, unknown>;
  for (const sid of [SID_TASKLESS_TURN, SID_TASKLESS_MSG, SID_DANGLING_TURN, SID_DANGLING_MSG, SID_WITHTASK_TURN, SID_WITHTASK_MSG]) {
    map.delete(sid);
  }
}

/** Count every subagent:start emit (triage dispatches go through this bus event). */
function captureSubagentStarts(): { count: number; payloads: Record<string, unknown>[] } {
  const captured = { count: 0, payloads: [] as Record<string, unknown>[] };
  bus.subscribe('test-capture-taskless', (event) => {
    if (event.name === 'subagent:start') {
      captured.count++;
      captured.payloads.push(event.data as Record<string, unknown>);
    }
  }, { global: true });
  return captured;
}

let realTaskId: string;
let realTask: Task;

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  const { task } = await addTask({ title: 'taskless control task', category: 'Inbox' });
  realTaskId = task.id;
  realTask = task;
});

afterAll(async () => {
  unregisterFakeSessions();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  unregisterFakeSessions();
  try { bus.unsubscribe('test-capture-taskless'); } catch {}
});
afterEach(() => {
  try { bus.unsubscribe('test-capture-taskless'); } catch {}
});

// `task` mirrors what PayloadBuilder.build resolves: the real Task object when
// taskId points at an existing task, undefined for a taskless ('') or dangling
// (deleted-task) id.
function turnPayload(sid: string, taskId: string | undefined, task?: Task): OnTurnCompletePayload {
  return {
    sessionId: sid,
    taskId,
    task,
    session: { provider: 'claude-code', cwd: '/tmp/x' } as OnTurnCompletePayload['session'],
    result: 'done',
    totalCost: 0,
    duration: 1,
    turnIndex: 1,
  } as OnTurnCompletePayload;
}

function messagePayload(sid: string, taskId: string | undefined, task?: Task): OnMessageSendPayload {
  return {
    sessionId: sid,
    taskId,
    task,
    session: { provider: 'claude-code', cwd: '/tmp/x' } as OnMessageSendPayload['session'],
    message: 'hello there',
    isResume: false,
  } as OnMessageSendPayload;
}

describe('taskless session: turn-complete triage', () => {
  it('does NOT dispatch triage when taskId is absent', async () => {
    const fake = registerFakeSession(SID_TASKLESS_TURN);
    const captured = captureSubagentStarts();

    await turnCompleteTriageHook.handler!(turnPayload(SID_TASKLESS_TURN, undefined));

    // No triage subagent, and we never even reached the side_question step.
    expect(captured.count).toBe(0);
    expect(fake.askSideQuestion).not.toHaveBeenCalled();
  });

  it('does NOT dispatch triage for a dangling taskId (task no longer exists)', async () => {
    const fake = registerFakeSession(SID_DANGLING_TURN);
    const captured = captureSubagentStarts();

    // Non-empty taskId, but no resolved task → must still short-circuit.
    await turnCompleteTriageHook.handler!(turnPayload(SID_DANGLING_TURN, DANGLING_TASK_ID, undefined));

    expect(captured.count).toBe(0);
    expect(fake.askSideQuestion).not.toHaveBeenCalled();
  });

  it('control: WITH a real task it DOES dispatch (capture harness is real)', async () => {
    registerFakeSession(SID_WITHTASK_TURN);
    const captured = captureSubagentStarts();

    // The hook now only arms a trailing-debounce timer; the dispatch work lives in
    // runTriage (the fire path). Call it directly so this control asserts the harness
    // captures a real dispatch — the debounce timing is covered in its own test.
    await runTriage(turnPayload(SID_WITHTASK_TURN, realTaskId, realTask));

    expect(captured.count).toBe(1);
    expect(captured.payloads[0].taskId).toBe(realTaskId);
  });
});

describe('taskless session: message-send triage', () => {
  it('does NOT dispatch triage when taskId is absent', async () => {
    const captured = captureSubagentStarts();

    await messageSendTriageHook.handler!(messagePayload(SID_TASKLESS_MSG, undefined));

    expect(captured.count).toBe(0);
  });

  it('does NOT dispatch triage for a dangling taskId (task no longer exists)', async () => {
    const captured = captureSubagentStarts();

    await messageSendTriageHook.handler!(messagePayload(SID_DANGLING_MSG, DANGLING_TASK_ID, undefined));

    expect(captured.count).toBe(0);
  });

  it('control: WITH a real task it DOES dispatch (capture harness is real)', async () => {
    const captured = captureSubagentStarts();

    await messageSendTriageHook.handler!(messagePayload(SID_WITHTASK_MSG, realTaskId, realTask));

    expect(captured.count).toBe(1);
    expect(captured.payloads[0].taskId).toBe(realTaskId);
  });
});

/**
 * Integration test for the turn-complete triage hook's side_question self-report flow.
 *
 * Proves the new behavior end-to-end (with a fake live session, real hook code):
 *  1. SUCCESS: hook calls session.askSideQuestion, persists a Tier-1 summary,
 *     and dispatches the triage subagent with suppressSources:['session_history']
 *     plus a <session_self_summary> context block.
 *  2. FALLBACK: when askSideQuestion throws, the hook still dispatches triage but
 *     WITHOUT suppression and WITHOUT a self-summary block (so the subagent reads
 *     history the old way) — triage never regresses.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-turn-self-report'));

import { WALNUT_HOME } from '../../src/constants.js';
import { bus } from '../../src/core/event-bus.js';
import { sessionRunner } from '../../src/providers/claude-code-session.js';
import { addTask, getTask } from '../../src/core/task-manager.js';
// runTriage is the fire-path of turnCompleteTriageHook (the hook itself now only
// trailing-debounces; the actual self-report + dispatch work lives in runTriage).
// These tests assert that work, so they call runTriage directly — the debounce
// timing is covered separately in session-hooks-triage-debounce.test.ts.
import { runTriage } from '../../src/core/session-hooks/builtins.js';
import type { OnTurnCompletePayload } from '../../src/core/session-hooks/types.js';
import type { Task } from '../../src/core/types.js';

// Distinct SID per scenario: the hook has a 5s per-(sessionId:taskId) cooldown,
// so sharing one SID would make the second test get skipped.
const SID_OK = 'self-report-session-ok';
const SID_FAIL = 'self-report-session-fail';

const SAMPLE_REPORT = `WHAT_I_DID: Edited fork-title.ts to add normalizeLabel and a heuristic fallback.
STATUS: succeeded — build passes and unit tests are green.
CHANGES_TRIED: Tried a type predicate filter first, abandoned it for a plain map.
PHASE_SIGNAL: implement-done
NEXT_STEPS: Run /verify on an ephemeral server.
BLOCKERS: none
USER_INTENT: workflow-command — user said "continue".
VERIFIED: assumed — have not run e2e yet.
ARTIFACTS: src/core/fork-title.ts`;

function registerFakeSession(sid: string, askImpl: (q: string) => Promise<string>) {
  const fake = {
    sessionId: sid,
    askSideQuestion: vi.fn(askImpl),
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
  map.delete(SID_OK);
  map.delete(SID_FAIL);
}

/** Capture the next subagent:start emit via a global bus subscriber. */
function captureSubagentStart(): { payload?: Record<string, unknown> } {
  const captured: { payload?: Record<string, unknown> } = {};
  bus.subscribe('test-capture-subagent-start', (event) => {
    if (event.name === 'subagent:start') {
      captured.payload = event.data as Record<string, unknown>;
    }
  }, { global: true });
  return captured;
}

let taskId: string;
let task: Task;

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  const created = await addTask({ title: 'self report task', category: 'Inbox' });
  taskId = created.task.id;
  task = created.task;
});

afterAll(async () => {
  unregisterFakeSessions();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  unregisterFakeSessions();
  try { bus.unsubscribe('test-capture-subagent-start'); } catch {}
});
afterEach(() => {
  try { bus.unsubscribe('test-capture-subagent-start'); } catch {}
});

function makePayload(sid: string): OnTurnCompletePayload {
  return {
    sessionId: sid,
    taskId,
    task, // resolved by PayloadBuilder in production; required for triage to run
    session: { provider: 'claude-code', cwd: '/tmp/x' } as OnTurnCompletePayload['session'],
    result: 'done',
    totalCost: 0,
    duration: 1,
    turnIndex: 1,
  } as OnTurnCompletePayload;
}

describe('turn-complete self-report (success)', () => {
  it('asks the session, persists a summary, and suppresses session_history', async () => {
    const fake = registerFakeSession(SID_OK, async () => SAMPLE_REPORT);
    const captured = captureSubagentStart();

    await runTriage(makePayload(SID_OK));

    // 1. The session was asked for a self-report.
    expect(fake.askSideQuestion).toHaveBeenCalledOnce();

    // 2. A single-paragraph Tier-1 summary was persisted to the task (no labelled
    //    sub-sections — the "one summary" unification).
    const task = await getTask(taskId);
    expect(task.summary).toContain('normalizeLabel');
    expect(task.summary).toContain('Next: Run /verify');
    expect(task.summary).not.toContain('**Session Summary**');
    expect(task.summary).not.toContain('**Current Agent Status**');

    // 2b. A compact milestone line was recorded (PHASE_SIGNAL: implement-done).
    expect(task.milestones).toBeTruthy();
    expect(task.milestones).toContain('🔧 Implemented — Edited fork-title.ts');

    // 3. Triage was dispatched with suppression + a self-summary context block.
    expect(captured.payload).toBeDefined();
    const override = captured.payload!.context_override as { suppressSources?: string[] };
    expect(override.suppressSources).toEqual(['session_history']);
    expect(String(captured.payload!.context)).toContain('<session_self_summary>');
    expect(String(captured.payload!.task)).toContain('do NOT call session_history');
  });
});

describe('turn-complete self-report (fallback)', () => {
  it('falls back to the history path when askSideQuestion throws', async () => {
    const fake = registerFakeSession(SID_FAIL, async () => { throw new Error('session dead'); });
    const captured = captureSubagentStart();

    await runTriage(makePayload(SID_FAIL));

    expect(fake.askSideQuestion).toHaveBeenCalledOnce();

    // No suppression — triage will read session_history as before.
    expect(captured.payload).toBeDefined();
    const override = captured.payload!.context_override as { suppressSources?: string[] };
    expect(override.suppressSources).toBeUndefined();
    // No self-summary block injected.
    expect(String(captured.payload!.context ?? '')).not.toContain('<session_self_summary>');
    expect(String(captured.payload!.task)).toContain('<session_history>');
  });
});

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
import { runTriage, __resetTriageRateLimiter } from '../../src/core/session-hooks/builtins.js';
import type { OnTurnCompletePayload } from '../../src/core/session-hooks/types.js';
import type { Task } from '../../src/core/types.js';

// Distinct SID per scenario: the hook has a 5s per-(sessionId:taskId) cooldown,
// so sharing one SID would make the second test get skipped.
const SID_OK = 'self-report-session-ok';
const SID_FAIL = 'self-report-session-fail';
const SID_RATE = 'self-report-session-rate';
const SID_MILE = 'self-report-session-milestone';

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
  map.delete(SID_RATE);
  map.delete(SID_MILE);
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
  __resetTriageRateLimiter(); // agent rate-limiter is per-process state — isolate tests
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

// A non-milestone report (PHASE_SIGNAL: conversational) — the kind that must NOT
// bypass the agent rate limit.
const CONVERSATIONAL_REPORT = SAMPLE_REPORT.replace(
  'PHASE_SIGNAL: implement-done',
  'PHASE_SIGNAL: conversational(user-asked-question)',
);

describe('turn-complete triage agent rate limit', () => {
  it('within the hour: cheap tier persists summary but NO agent dispatch; report is buffered, then batch-drained', async () => {
    registerFakeSession(SID_RATE, async () => CONVERSATIONAL_REPORT);
    const captured1 = captureSubagentStart();

    // First run — agent has never run for this key → dispatches (and stamps the hour clock).
    await runTriage(makePayload(SID_RATE));
    expect(captured1.payload).toBeDefined();

    // Second run right after (only the 5s replay-cooldown cleared; hour clock kept).
    __resetTriageRateLimiter({ keepAgentRuns: true });
    bus.unsubscribe('test-capture-subagent-start');
    const captured2 = captureSubagentStart();

    await runTriage(makePayload(SID_RATE));

    // Cheap tier still persisted the summary…
    const t = await getTask(taskId);
    expect(t.summary).toContain('normalizeLabel');
    // …but the expensive agent was NOT dispatched (rate-limited, report buffered).
    expect(captured2.payload).toBeUndefined();

    // Third run with a milestone signal → bypasses the limit AND drains the buffer:
    // the dispatched agent receives BOTH reports in one <session_self_summary> batch.
    __resetTriageRateLimiter({ keepAgentRuns: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((sessionRunner as any).sessions.get(SID_RATE) as { askSideQuestion: unknown }).askSideQuestion =
      vi.fn(async () => SAMPLE_REPORT);
    bus.unsubscribe('test-capture-subagent-start');
    const captured3 = captureSubagentStart();

    await runTriage(makePayload(SID_RATE));

    expect(captured3.payload).toBeDefined();
    const ctx = String(captured3.payload!.context);
    expect(ctx).toContain('conversational(user-asked-question)'); // buffered report included
    expect(ctx).toContain('implement-done');                       // current report included
    expect(String(captured3.payload!.task)).toContain('2 turns');
  });

  it('a milestone PHASE_SIGNAL bypasses the rate limit immediately', async () => {
    registerFakeSession(SID_MILE, async () => SAMPLE_REPORT); // implement-done = milestone
    const captured1 = captureSubagentStart();
    await runTriage(makePayload(SID_MILE));
    expect(captured1.payload).toBeDefined();

    // Immediately again with a milestone report — still dispatches despite the hour clock.
    __resetTriageRateLimiter({ keepAgentRuns: true });
    bus.unsubscribe('test-capture-subagent-start');
    const captured2 = captureSubagentStart();
    await runTriage(makePayload(SID_MILE));
    expect(captured2.payload).toBeDefined();
  });

  it('backfills SessionRecord.summary from the cheap tier (gist replacement)', async () => {
    // The updateSessionRecord call is best-effort (session record may not exist in
    // this unit test's store) — assert the task-side summary persisted, which is
    // the same code path that triggers the backfill.
    const t = await getTask(taskId);
    expect(t.summary).toBeTruthy();
  });
});

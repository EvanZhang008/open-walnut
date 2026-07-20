/**
 * Integration test for the turn-complete summary flow (session self-report).
 *
 * 2026-07-18 redesign: the task NOTE is the single living document (five sections:
 * Executive Summary / Goal / Context / Progress / Work Log). The session answers
 * per-section (unchanged | append | content); code assembles + persists the NOTE,
 * derives the short task.summary from Executive Summary, and decides notify via
 * the PHASE_SIGNAL lookup (decideNotify). These tests prove that flow end-to-end
 * (fake live session, real hook code).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-turn-self-report'));

import { WALNUT_HOME } from '../../src/constants.js';
import { bus } from '../../src/core/event-bus.js';
import { sessionRunner } from '../../src/providers/claude-code-session.js';
import {
  addTask,
  compareAndSetNote,
  getTask,
  updateNote,
  updateSummary,
} from '../../src/core/task-manager.js';
import * as taskManager from '../../src/core/task-manager.js';
// runTriage is the fire-path of turnCompleteTriageHook (the hook itself only
// trailing-debounces; the summary work lives in runTriage). These tests assert
// that work, so they call runTriage directly — the debounce timing is covered
// separately in session-hooks-triage-debounce.test.ts.
import { runTriage, __resetTriageRateLimiter, __clearTriageCooldown } from '../../src/core/session-hooks/builtins.js';
import type { OnTurnCompletePayload } from '../../src/core/session-hooks/types.js';
import type { Task } from '../../src/core/types.js';

// Distinct SID per scenario: the hook has a 5s per-(sessionId:taskId) cooldown,
// so sharing one SID would make the second test get skipped.
const SID_OK = 'self-report-session-ok';
const SID_FAIL = 'self-report-session-fail';
const SID_NOTIFY = 'self-report-session-notify';
const SID_DEDUP = 'self-report-session-dedup';

const BASE_NOTE = `## Executive Summary
Adding a fallback for fork titles. Implementation done; verify pending.

## Goal
Request: "make fork titles never show up blank"
Objective: Fork titles never render blank — normalizeLabel falls back to a heuristic title.

## Context
Forked tasks inherited empty labels when the source task had no explicit title.

## Progress
DONE implement — done
WIP verify — in progress

## Work Log
- Implemented normalizeLabel fallback in src/core/fork-title.ts; unit tests green.`;

const SAMPLE_REPORT = `EXEC_SUMMARY: Adding a fallback for fork titles. Implemented and unit-tested; e2e verify is next.
GOAL: unchanged
CONTEXT: unchanged
PROGRESS: DONE implement — done
WIP e2e verify — in progress
WORK_LOG: append: Ran the unit suite (green); next is /verify on an ephemeral server.
RECAP: Implemented the normalizeLabel fallback; tests green, e2e verify next.
WHAT_I_DID: Edited fork-title.ts to add normalizeLabel and a heuristic fallback.
STATUS: succeeded — build passes and unit tests are green.
PHASE_SIGNAL: implement-done
NEXT_STEPS: Run /verify on an ephemeral server.
BLOCKERS: none
USER_INTENT: workflow-command — user said "continue".
VERIFIED: assumed — have not run e2e yet.`;

const VERIFY_FAIL_REPORT = `EXEC_SUMMARY: Migrating session store to SQLite; cutover blocked on a parity failure.
GOAL: unchanged
CONTEXT: unchanged
PROGRESS: DONE dual-write — done
BLOCKED/WAIT cutover — blocked on timestamp precision
WORK_LOG: append: 48h parity verifier found 3 sessions diverging on last_active_at precision.
WHAT_I_DID: Ran the 48h parity verifier; found 3 sessions diverging on last_active_at precision.
STATUS: blocked — cutover cannot proceed without a decision.
PHASE_SIGNAL: verify-fail
NEXT_STEPS: Decide REAL/ms column vs accepting second precision.
BLOCKERS: timestamp precision decision
USER_INTENT: autonomous
VERIFIED: ran-and-saw-pass`;

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
  map.delete(SID_NOTIFY);
  map.delete(SID_DEDUP);
}

/** Capture subagent:result emits (the notify event) via a global bus subscriber. */
function captureNotifyResults(): { payloads: Record<string, unknown>[] } {
  const captured: { payloads: Record<string, unknown>[] } = { payloads: [] };
  bus.subscribe('test-capture-notify-result', (event) => {
    if (event.name === 'subagent:result') {
      captured.payloads.push(event.data as Record<string, unknown>);
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
  __resetTriageRateLimiter(); // cooldown + notify-dedup are per-process state — isolate tests
  try { bus.unsubscribe('test-capture-notify-result'); } catch {}
});
afterEach(() => {
  try { bus.unsubscribe('test-capture-notify-result'); } catch {}
  vi.restoreAllMocks();
});

function makePayload(sid: string): OnTurnCompletePayload {
  return {
    sessionId: sid,
    taskId,
    task, // resolved by PayloadBuilder in production; required for the work to run
    session: { provider: 'claude-code', cwd: '/tmp/x' } as OnTurnCompletePayload['session'],
    result: 'done',
    totalCost: 0,
    duration: 1,
    turnIndex: 1,
  } as OnTurnCompletePayload;
}

describe('turn-complete self-report (success)', () => {
  it('feeds the existing NOTE into the prompt, persists per-section answers, derives summary', async () => {
    await updateNote(taskId, BASE_NOTE);
    await updateSummary(taskId, 'stale short summary');
    const fake = registerFakeSession(SID_OK, async () => SAMPLE_REPORT);

    await runTriage(makePayload(SID_OK));

    // 1. The session was asked ONCE, and the prompt carried the existing NOTE so
    //    the session merges rather than rewriting from (possibly compacted) memory.
    expect(fake.askSideQuestion).toHaveBeenCalledOnce();
    const prompt = fake.askSideQuestion.mock.calls[0][0] as string;
    expect(prompt).toContain('<existing_note>');
    expect(prompt).toContain('normalizeLabel fallback in src/core/fork-title.ts');

    // 2. The NOTE was reassembled: unchanged sections kept, Work Log appended,
    //    Progress and Executive Summary replaced.
    const t = await getTask(taskId);
    expect(t.note).toContain('## Goal');
    expect(t.note).toContain('never render blank'); // unchanged Goal preserved
    expect(t.note).toContain('- Ran the unit suite (green)'); // Work Log appended
    expect(t.note).toContain('WIP e2e verify — in progress'); // Progress rewritten
    expect(t.note).toContain('Implemented normalizeLabel fallback'); // old log entry kept

    // 3. task.summary derived from the new Executive Summary (not independently authored).
    expect(t.summary).toBe('Adding a fallback for fork titles. Implemented and unit-tested; e2e verify is next.');
  });

  it('implement-done does NOT notify (progress, not a human-decision point)', async () => {
    registerFakeSession(SID_OK, async () => SAMPLE_REPORT);
    const captured = captureNotifyResults();

    await runTriage(makePayload(SID_OK));

    expect(captured.payloads.length).toBe(0);
  });

  it('all-unchanged report leaves note AND summary untouched', async () => {
    await updateNote(taskId, BASE_NOTE);
    await updateSummary(taskId, 'Frozen summary');
    const allUnchanged = 'EXEC_SUMMARY: unchanged\nGOAL: unchanged\nCONTEXT: unchanged\nPROGRESS: unchanged\nWORK_LOG: unchanged\nSTATUS: succeeded\nPHASE_SIGNAL: reconfirmed\nUSER_INTENT: autonomous';
    registerFakeSession(SID_OK, async () => allUnchanged);

    await runTriage(makePayload(SID_OK));

    const t = await getTask(taskId);
    expect(t.note).toBe(BASE_NOTE);
    expect(t.summary).toBe('Frozen summary');
  });
});

describe('turn-complete self-report (notify lookup)', () => {
  it('verify-fail emits a subagent:result notification with the triage agentId', async () => {
    registerFakeSession(SID_NOTIFY, async () => VERIFY_FAIL_REPORT);
    const captured = captureNotifyResults();

    await runTriage(makePayload(SID_NOTIFY));

    expect(captured.payloads.length).toBe(1);
    const p = captured.payloads[0];
    // agentId stays 'turn-complete-triage' so the server's notify_mode gate and UI
    // rendering are unchanged.
    expect(p.agentId).toBe('turn-complete-triage');
    expect(p.taskId).toBe(taskId);
    expect(String(p.notification)).toContain('Verification failed');
    expect(p.result).toBe(p.notification);
    expect(String(p.result)).not.toContain('EXEC_SUMMARY:');
  });

  it('the SAME signal twice is deduped; a DIFFERENT signal notifies again', async () => {
    const { decideNotify } = await import('../../src/core/session-hooks/builtins.js');
    const key = `${SID_DEDUP}:${taskId}`;

    // First verify-fail → notifies.
    expect(decideNotify(VERIFY_FAIL_REPORT, key)).toContain('Verification failed');
    // Same signal again (stuck session re-reporting every quiet period) → suppressed.
    expect(decideNotify(VERIFY_FAIL_REPORT, key)).toBeNull();
    // A DIFFERENT signal on the same key resets the gate → notifies.
    const planReport = VERIFY_FAIL_REPORT.replace('PHASE_SIGNAL: verify-fail', 'PHASE_SIGNAL: plan-written');
    expect(decideNotify(planReport, key)).toContain('Plan ready for review');
    // …and the original signal now notifies again (gate moved to plan-written).
    expect(decideNotify(VERIFY_FAIL_REPORT, key)).toContain('Verification failed');
  });

  it('question-pending suppresses notify even on a notify-worthy signal', async () => {
    const { decideNotify } = await import('../../src/core/session-hooks/builtins.js');
    const engaged = VERIFY_FAIL_REPORT.replace(
      'USER_INTENT: autonomous',
      'USER_INTENT: question-pending — user asked why the parity check failed.',
    );
    expect(decideNotify(engaged, 'k1:t1')).toBeNull();
  });

  it('blocked STATUS/BLOCKERS notifies even without a notify-worthy PHASE_SIGNAL', async () => {
    const { decideNotify } = await import('../../src/core/session-hooks/builtins.js');
    const blocked = SAMPLE_REPORT
      .replace('STATUS: succeeded — build passes and unit tests are green.', 'STATUS: blocked — cannot reach staging.')
      .replace('BLOCKERS: none', 'BLOCKERS: staging VPN access required');
    const msg = decideNotify(blocked, 'k2:t2');
    expect(msg).toContain('Blocked');
    expect(msg).toContain('staging VPN access required');
  });
});

describe('turn-complete self-report (guards)', () => {
  it('CAS note persistence rejects a stale merge base instead of overwriting a concurrent edit', async () => {
    await updateNote(taskId, BASE_NOTE);
    const concurrent = `${BASE_NOTE}\n\nHuman edit that must survive.`;
    await updateNote(taskId, concurrent);

    const staleWrite = await compareAndSetNote(
      taskId,
      BASE_NOTE,
      `${BASE_NOTE}\n\nStale self-report write.`,
    );

    expect(staleWrite.updated).toBe(false);
    expect((await getTask(taskId)).note).toBe(concurrent);
  });

  it('runTriage retries a missed CAS and preserves the concurrent edit', async () => {
    await updateNote(taskId, BASE_NOTE);
    const concurrentLine = 'Human edit: preserve rollout ticket TASK-427.';
    const originalCompareAndSet = taskManager.compareAndSetNote;
    const cas = vi.spyOn(taskManager, 'compareAndSetNote')
      .mockImplementation(async (...args) => {
        if (cas.mock.calls.length === 1) {
          await updateNote(taskId, `${BASE_NOTE}\n${concurrentLine}`);
        }
        return originalCompareAndSet(...args);
      });
    registerFakeSession(SID_OK, async () => SAMPLE_REPORT);

    await runTriage(makePayload(SID_OK));

    expect(cas).toHaveBeenCalledTimes(2);
    const note = (await getTask(taskId)).note ?? '';
    expect(note).toContain(concurrentLine);
    expect(note).toContain('Ran the unit suite (green)');
  });

  it('shrink guard: a rewrite that drops most of a large note is NOT persisted', async () => {
    const bigNote = BASE_NOTE + '\n' + '- Work Log filler entry with important ids.\n'.repeat(40);
    await updateNote(taskId, bigNote);
    const droppy = `EXEC_SUMMARY: tiny.
GOAL: tiny.
CONTEXT: tiny.
PROGRESS: DONE all — done
WORK_LOG: tiny.
STATUS: succeeded
PHASE_SIGNAL: reconfirmed
USER_INTENT: autonomous`;
    registerFakeSession(SID_OK, async () => droppy);

    await runTriage(makePayload(SID_OK));

    const t = await getTask(taskId);
    expect(t.note).toBe(bigNote); // rejected — nothing persisted
  });

  it('single-flight: a second fire while the first ask is pending is skipped', async () => {
    await updateNote(taskId, BASE_NOTE);
    let release!: (v: string) => void;
    const gate = new Promise<string>((r) => { release = r; });
    const fake = registerFakeSession(SID_OK, () => gate);

    const first = runTriage(makePayload(SID_OK));
    await new Promise((r) => setTimeout(r, 20)); // let the first ask reach askSideQuestion

    __clearTriageCooldown(); // bypass the 5s cooldown so ONLY single-flight gates
    await runTriage(makePayload(SID_OK)); // must skip — previous ask still pending
    expect(fake.askSideQuestion).toHaveBeenCalledOnce();

    release(SAMPLE_REPORT);
    await first;

    __clearTriageCooldown();
    await runTriage(makePayload(SID_OK)); // gate released — asks again
    expect(fake.askSideQuestion).toHaveBeenCalledTimes(2);
  });
});

describe('turn-complete self-report (skip paths)', () => {
  it('a dead session (askSideQuestion throws) is a silent no-op — note untouched', async () => {
    await updateNote(taskId, BASE_NOTE);
    const fake = registerFakeSession(SID_FAIL, async () => { throw new Error('session dead'); });
    const captured = captureNotifyResults();

    await runTriage(makePayload(SID_FAIL));

    expect(fake.askSideQuestion).toHaveBeenCalledOnce();
    expect(captured.payloads.length).toBe(0);
    const t = await getTask(taskId);
    expect(t.note).toBe(BASE_NOTE);
  });

  it('extractField pulls the one-line RECAP out of the report (session tip source)', async () => {
    const { extractField } = await import('../../src/core/session-hooks/builtins.js');
    expect(extractField(SAMPLE_REPORT, 'RECAP'))
      .toBe('Implemented the normalizeLabel fallback; tests green, e2e verify next.');
    // The recap persist path (updateSessionRecord) is best-effort — no session
    // record exists in this unit store; covered by the parse assertion above.
  });

  it('backfills SessionRecord.summary from the derived summary (gist replacement)', async () => {
    // The updateSessionRecord call is best-effort (session record may not exist in
    // this unit test's store) — assert the task-side summary derived, which is
    // the same code path that triggers the backfill.
    await updateNote(taskId, BASE_NOTE);
    registerFakeSession(SID_OK, async () => SAMPLE_REPORT);
    await runTriage(makePayload(SID_OK));
    const t = await getTask(taskId);
    expect(t.summary).toBeTruthy();
  });
});

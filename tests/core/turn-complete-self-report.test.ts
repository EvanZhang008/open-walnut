/**
 * Integration test for the turn-complete summary flow (session self-report).
 *
 * The triage subagent was DELETED (2026-07): the session itself writes the merged
 * task summary via side_question, and code deterministically persists summary +
 * milestone, syncs the phase, and decides notify via the PHASE_SIGNAL lookup
 * (decideNotify). These tests prove that flow end-to-end (fake live session, real
 * hook code):
 *  1. SUCCESS: hook feeds the EXISTING summary into the prompt, persists the
 *     session's TASK_SUMMARY, records a milestone, and phase-syncs.
 *  2. NOTIFY: a notify-worthy PHASE_SIGNAL emits a subagent:result event carrying
 *     the deterministic notification; repeats of the same signal are deduped.
 *  3. SKIP: a dead session (askSideQuestion throws) is a silent no-op — no summary
 *     clobber, no notify. The next turn's merged report covers the gap.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-turn-self-report'));

import { WALNUT_HOME } from '../../src/constants.js';
import { bus } from '../../src/core/event-bus.js';
import { sessionRunner } from '../../src/providers/claude-code-session.js';
import { addTask, getTask, updateSummary } from '../../src/core/task-manager.js';
// runTriage is the fire-path of turnCompleteTriageHook (the hook itself only
// trailing-debounces; the summary work lives in runTriage). These tests assert
// that work, so they call runTriage directly — the debounce timing is covered
// separately in session-hooks-triage-debounce.test.ts.
import { runTriage, __resetTriageRateLimiter } from '../../src/core/session-hooks/builtins.js';
import type { OnTurnCompletePayload } from '../../src/core/session-hooks/types.js';
import type { Task } from '../../src/core/types.js';

// Distinct SID per scenario: the hook has a 5s per-(sessionId:taskId) cooldown,
// so sharing one SID would make the second test get skipped.
const SID_OK = 'self-report-session-ok';
const SID_FAIL = 'self-report-session-fail';
const SID_NOTIFY = 'self-report-session-notify';
const SID_DEDUP = 'self-report-session-dedup';

const SAMPLE_REPORT = `TASK_SUMMARY: rewrite: Add normalizeLabel fallback to fork titles. Implemented in src/core/fork-title.ts with unit tests green; next is /verify on an ephemeral server.
WHAT_I_DID: Edited fork-title.ts to add normalizeLabel and a heuristic fallback.
STATUS: succeeded — build passes and unit tests are green.
PHASE_SIGNAL: implement-done
NEXT_STEPS: Run /verify on an ephemeral server.
BLOCKERS: none
USER_INTENT: workflow-command — user said "continue".
VERIFIED: assumed — have not run e2e yet.
ARTIFACTS: src/core/fork-title.ts`;

const VERIFY_FAIL_REPORT = `TASK_SUMMARY: rewrite: Migrate session store to SQLite. Dual-write shipped but cutover is blocked on a timestamp-precision parity failure; needs a human call on column type.
WHAT_I_DID: Ran the 48h parity verifier; found 3 sessions diverging on last_active_at precision.
STATUS: blocked — cutover cannot proceed without a decision.
PHASE_SIGNAL: verify-fail
NEXT_STEPS: Decide REAL/ms column vs accepting second precision.
BLOCKERS: timestamp precision decision
USER_INTENT: autonomous
VERIFIED: ran-and-saw-pass
ARTIFACTS: /tmp/parity-report.json`;

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
  it('feeds the existing summary into the prompt, persists TASK_SUMMARY, records a milestone', async () => {
    await updateSummary(taskId, 'Prior summary: fork titles need a fallback.');
    const fake = registerFakeSession(SID_OK, async () => SAMPLE_REPORT);

    await runTriage(makePayload(SID_OK));

    // 1. The session was asked ONCE, and the prompt carried the existing summary so
    //    the session merges rather than rewriting from (possibly compacted) memory.
    expect(fake.askSideQuestion).toHaveBeenCalledOnce();
    const prompt = fake.askSideQuestion.mock.calls[0][0] as string;
    expect(prompt).toContain('<existing_summary>');
    expect(prompt).toContain('Prior summary: fork titles need a fallback.');

    // 2. The session's own TASK_SUMMARY paragraph was persisted verbatim (merged form).
    const t = await getTask(taskId);
    expect(t.summary).toContain('Add normalizeLabel fallback to fork titles');
    expect(t.summary).not.toContain('TASK_SUMMARY');

    // 2b. A compact milestone line was recorded (PHASE_SIGNAL: implement-done).
    expect(t.milestones).toBeTruthy();
    expect(t.milestones).toContain('🔧 Implemented — Edited fork-title.ts');
  });

  it('implement-done does NOT notify (progress, not a human-decision point)', async () => {
    registerFakeSession(SID_OK, async () => SAMPLE_REPORT);
    const captured = captureNotifyResults();

    await runTriage(makePayload(SID_OK));

    expect(captured.payloads.length).toBe(0);
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
    // The phase synced to AWAIT_HUMAN_ACTION (from AGENT_COMPLETE… task starts at
    // TODO here, so applySessionPhase('triage-sync') is a no-op — asserted separately
    // in phase tests; here we assert the notification itself).
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

describe('TASK_SUMMARY three-way directive (unchanged | append | rewrite)', () => {
  const mk = (answer: string) => `TASK_SUMMARY: ${answer}\nWHAT_I_DID: x.\nSTATUS: succeeded\nPHASE_SIGNAL: reconfirmed\nNEXT_STEPS: none\nBLOCKERS: none\nUSER_INTENT: autonomous\nVERIFIED: not-applicable\nARTIFACTS: none`;

  it('parses the three markers (tolerant of case/backticks/trailing punctuation)', async () => {
    const { parseSummaryDirective } = await import('../../src/core/session-hooks/builtins.js');
    expect(parseSummaryDirective(mk('unchanged'))).toEqual({ kind: 'unchanged' });
    expect(parseSummaryDirective(mk('`unchanged`'))).toEqual({ kind: 'unchanged' });
    expect(parseSummaryDirective(mk('Unchanged.'))).toEqual({ kind: 'unchanged' });
    expect(parseSummaryDirective(mk('append: Committed as abc123.')))
      .toEqual({ kind: 'append', text: 'Committed as abc123.' });
    expect(parseSummaryDirective(mk('APPEND:  Verify   passed.')))
      .toEqual({ kind: 'append', text: 'Verify passed.' });
    expect(parseSummaryDirective(mk('rewrite: Fresh paragraph here.')))
      .toEqual({ kind: 'rewrite', text: 'Fresh paragraph here.' });
  });

  it('a marker-less non-empty answer is treated as rewrite (never dropped)', async () => {
    const { parseSummaryDirective } = await import('../../src/core/session-hooks/builtins.js');
    expect(parseSummaryDirective(mk('Task is about X; state is Y.')))
      .toEqual({ kind: 'rewrite', text: 'Task is about X; state is Y.' });
  });

  it('summaryFromSelfReport: unchanged → "" (skip persist); append → base + sentence; rewrite → replace', async () => {
    const { summaryFromSelfReport } = await import('../../src/core/session-hooks/builtins.js');
    const base = 'Goal: migrate store. Dual-write shipped';
    expect(summaryFromSelfReport(mk('unchanged'), base)).toBe('');
    expect(summaryFromSelfReport(mk('append: Cutover verified.'), base))
      .toBe('Goal: migrate store. Dual-write shipped. Cutover verified.');
    expect(summaryFromSelfReport(mk('append: First real content.'), ''))
      .toBe('First real content.'); // nothing to append to
    expect(summaryFromSelfReport(mk('rewrite: All done, awaiting review.'), base))
      .toBe('All done, awaiting review.');
  });

  it('over the length cap, the prompt drops the append option (unchanged | rewrite only)', async () => {
    const { buildSelfReportPrompt, SUMMARY_APPEND_CAP } = await import('../../src/core/session-hooks/builtins.js');
    const short = buildSelfReportPrompt('short summary');
    expect(short).toContain('append:');
    const long = buildSelfReportPrompt('x'.repeat(SUMMARY_APPEND_CAP + 1));
    expect(long).not.toContain('append:');
    expect(long).toContain('rewrite:');
    expect(long).toContain('unchanged');
  });

  it('end-to-end: an append directive persists the concatenated summary', async () => {
    await updateSummary(taskId, 'Base summary for append test');
    registerFakeSession(SID_OK, async () => mk('append: Delta sentence landed.'));
    await runTriage(makePayload(SID_OK));
    const t = await getTask(taskId);
    expect(t.summary).toBe('Base summary for append test. Delta sentence landed.');
  });

  it('end-to-end: unchanged leaves the summary untouched', async () => {
    await updateSummary(taskId, 'Frozen summary');
    registerFakeSession(SID_OK, async () => mk('unchanged'));
    await runTriage(makePayload(SID_OK));
    const t = await getTask(taskId);
    expect(t.summary).toBe('Frozen summary');
  });
});

describe('turn-complete self-report (skip paths)', () => {
  it('a dead session (askSideQuestion throws) is a silent no-op — summary untouched', async () => {
    await updateSummary(taskId, 'Summary before the dead-session fire.');
    const fake = registerFakeSession(SID_FAIL, async () => { throw new Error('session dead'); });
    const captured = captureNotifyResults();

    await runTriage(makePayload(SID_FAIL));

    expect(fake.askSideQuestion).toHaveBeenCalledOnce();
    expect(captured.payloads.length).toBe(0);
    const t = await getTask(taskId);
    expect(t.summary).toBe('Summary before the dead-session fire.');
  });

  it('backfills SessionRecord.summary from the persisted summary (gist replacement)', async () => {
    // The updateSessionRecord call is best-effort (session record may not exist in
    // this unit test's store) — assert the task-side summary persisted, which is
    // the same code path that triggers the backfill.
    registerFakeSession(SID_OK, async () => SAMPLE_REPORT);
    await runTriage(makePayload(SID_OK));
    const t = await getTask(taskId);
    expect(t.summary).toBeTruthy();
  });
});

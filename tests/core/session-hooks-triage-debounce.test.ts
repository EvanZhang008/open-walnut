/**
 * Unit tests for the turn-complete triage TRAILING DEBOUNCE.
 *
 * The expensive triage work (session self-report + subagent dispatch) must NOT run
 * on every turn during an interactive burst. Instead turnCompleteTriageHook arms a
 * per-session timer; the work (runTriage → bus.emit('subagent:start')) fires ONCE
 * only after the session has been quiet for config.agent.triage.debounce_minutes.
 *
 * These tests assert the SCHEDULING — when (and how many times) a triage subagent is
 * dispatched. They complement turn-complete-self-report and taskless-session-no-triage,
 * which call runTriage directly to assert the work itself.
 *
 * We use REAL timers with a short fractional-minute window (not fake timers): the fire
 * path (runTriage) does real fs I/O before it emits, which fake timers can't flush
 * deterministically. A ~250ms window keeps the whole file fast (<3s).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';
import { vi } from 'vitest';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-triage-debounce'));

import { WALNUT_HOME } from '../../src/constants.js';
import { bus } from '../../src/core/event-bus.js';
import { sessionRunner } from '../../src/providers/claude-code-session.js';
import { addTask } from '../../src/core/task-manager.js';
import { updateConfig } from '../../src/core/config-manager.js';
import { turnCompleteTriageHook, messageSendTriageHook } from '../../src/core/session-hooks/builtins.js';
import type { OnTurnCompletePayload, OnMessageSendPayload } from '../../src/core/session-hooks/types.js';
import type { Task } from '../../src/core/types.js';

// Short real-time window, large enough that the fire path's fs I/O (~tens of ms) is
// negligible against it. 0.01 min = 600ms. Tests wait with wide margins around it.
const DEBOUNCE_MIN = 0.01;
const DEBOUNCE_MS = Math.round(DEBOUNCE_MIN * 60_000); // 600ms

let taskId: string;
let task: Task;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Register a fake live session so runTriage's askSideQuestion path is exercised
 *  (it returns '' → triage falls back to the history path, which still dispatches). */
function registerFakeSession(sid: string) {
  const fake = {
    sessionId: sid,
    askSideQuestion: vi.fn(async () => ''),
    detach: () => {},
    kill: () => {},
    get active() { return false; },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (sessionRunner as any).sessions.set(sid, fake);
  return fake;
}

/** Capture subagent:start emits, tracking the per-session dispatch count. Assertions
 *  are scoped to a test's own sessionId via firedFor(), so a timer leaked from an
 *  earlier real-timer test can't pollute a later one. */
function captureDispatches(): { sessionIds: string[]; firedFor: (sid: string) => number } {
  const sessionIds: string[] = [];
  bus.subscribe('test-capture-debounce', (event) => {
    if (event.name === 'subagent:start') {
      const ov = (event.data as Record<string, unknown>).context_override as { sessionId?: string } | undefined;
      if (ov?.sessionId) sessionIds.push(ov.sessionId);
    }
  }, { global: true });
  return { sessionIds, firedFor: (sid: string) => sessionIds.filter((s) => s === sid).length };
}

function turnPayload(sid: string): OnTurnCompletePayload {
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

// Taskless message payload: cancelPendingTriage runs BEFORE the task guard in the
// message-send hook, so this cancels the pending turn-complete triage WITHOUT the
// message-send hook dispatching its own subagent — keeping the cancel assertion clean.
function messagePayload(sid: string): OnMessageSendPayload {
  return {
    sessionId: sid,
    taskId: undefined,
    task: undefined,
    session: { provider: 'claude-code', cwd: '/tmp/x' } as OnMessageSendPayload['session'],
    message: 'follow-up question',
    isResume: true,
  } as OnMessageSendPayload;
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  const created = await addTask({ title: 'debounce task', category: 'Inbox' });
  taskId = created.task.id;
  task = created.task;
  // Persist a short debounce window so the hook reads it (not the 3-min default).
  await updateConfig({ agent: { triage: { debounce_minutes: DEBOUNCE_MIN, notify_mode: 'off' } } });
});

afterAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  try { bus.unsubscribe('test-capture-debounce'); } catch { /* not subscribed */ }
});

afterEach(() => {
  try { bus.unsubscribe('test-capture-debounce'); } catch { /* not subscribed */ }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const map = (sessionRunner as any).sessions as Map<string, unknown>;
  for (const k of [...map.keys()]) if (k.startsWith('dbnc-')) map.delete(k);
});

describe('turn-complete triage: trailing debounce', () => {
  it('does NOT dispatch until the quiet window elapses, then fires exactly once', async () => {
    const sid = 'dbnc-single';
    registerFakeSession(sid);
    const cap = captureDispatches();

    await turnCompleteTriageHook.handler!(turnPayload(sid));
    // Armed but not fired — still inside the window.
    await sleep(DEBOUNCE_MS / 2);
    expect(cap.firedFor(sid)).toBe(0);

    // Cross the threshold (+ slack for the async fire path's fs I/O) → fires once.
    await sleep(DEBOUNCE_MS * 2);
    expect(cap.firedFor(sid)).toBe(1);
  });

  it('collapses a burst of turn-completes into a single dispatch', async () => {
    const sid = 'dbnc-burst';
    registerFakeSession(sid);
    const cap = captureDispatches();

    // Three rapid turn-completes, each inside the window — each re-arms the timer.
    await turnCompleteTriageHook.handler!(turnPayload(sid));
    await sleep(DEBOUNCE_MS / 3);
    await turnCompleteTriageHook.handler!(turnPayload(sid));
    await sleep(DEBOUNCE_MS / 3);
    await turnCompleteTriageHook.handler!(turnPayload(sid));

    // Nothing fired yet (the last arm reset the clock; only ~2/3 window elapsed).
    expect(cap.firedFor(sid)).toBe(0);

    // Only after a full quiet window from the LAST turn does it fire — once.
    await sleep(DEBOUNCE_MS * 2);
    expect(cap.firedFor(sid)).toBe(1);
  });

  it('a user message-send cancels the pending triage', async () => {
    const sid = 'dbnc-cancel';
    registerFakeSession(sid);
    const cap = captureDispatches();

    await turnCompleteTriageHook.handler!(turnPayload(sid));
    await sleep(DEBOUNCE_MS / 2); // partway into the window
    // User resumes interaction → must cancel the pending triage. Taskless message
    // payload so the message-send hook only cancels and does not dispatch its own.
    await messageSendTriageHook.handler!(messagePayload(sid));

    // Even well past the original window, the cancelled turn-complete triage never fires.
    await sleep(DEBOUNCE_MS * 3);
    expect(cap.firedFor(sid)).toBe(0);
  });

  it('keeps separate timers per session (no cross-talk)', async () => {
    const sidA = 'dbnc-a';
    const sidB = 'dbnc-b';
    registerFakeSession(sidA);
    registerFakeSession(sidB);
    const cap = captureDispatches();

    await turnCompleteTriageHook.handler!(turnPayload(sidA));
    await sleep(DEBOUNCE_MS / 2);
    await turnCompleteTriageHook.handler!(turnPayload(sidB)); // B armed half a window later

    // A's window elapses first → A fires, B still pending.
    await sleep(DEBOUNCE_MS); // A: 1.5 windows (fired), B: 1 window (just firing)
    expect(cap.sessionIds).toContain(sidA);

    // Give B its full window too → B fires.
    await sleep(DEBOUNCE_MS * 2);
    expect(cap.sessionIds).toContain(sidB);
  });
});

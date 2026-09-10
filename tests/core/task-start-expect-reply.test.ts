/**
 * Unit pins for session_start's expect_reply default (core/sessions/task-start.ts).
 *
 * This path had ZERO test coverage before 2026-09-01 — nothing in tests/ called
 * startSessionForTask at all — which is exactly why it needs pinning now: the
 * default flipped from opt-in to on, and the failure mode of getting it wrong is
 * silent in one direction and catastrophic in the other.
 *
 *   session caller, flag omitted  → request registered  (the point of the change)
 *   HUMAN caller, flag omitted    → NO request, NO error (the trap: a naive
 *                                   `default = true` makes every session the web
 *                                   UI or a plain CLI starts fail with 400)
 *   explicit true, human caller   → still 400 (the caller asked for a reply that
 *                                   has nowhere to land, so say so)
 *   explicit false, session caller→ opted out
 *
 * The request ledger is the REAL one against a temp WALNUT_HOME, so "was a row
 * registered" is observed on disk rather than inferred from a mock. Everything
 * the start path only needs to be *present* (task lookup, live-session probe,
 * the runner it emits to) is mocked at its module seam.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-start'));

const getTask = vi.fn();
vi.mock('../../src/core/task-manager.js', () => ({
  getTask: (...args: unknown[]) => getTask(...args),
}));

const getSessionsForTask = vi.fn();
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionsForTask: (...args: unknown[]) => getSessionsForTask(...args),
}));

/** task-start.ts dynamically imports resolveCaller from the send core; that is
 *  the ONE thing that decides which branch of the default we take, so it is the
 *  seam under test control. The rest of the send core is never reached here. */
const resolveCaller = vi.fn();
vi.mock('../../src/core/sessions/session-send-core.js', () => ({
  resolveCaller: (...args: unknown[]) => resolveCaller(...args),
}));

import { bus, EventNames } from '../../src/core/event-bus.js';
import { startSessionForTask } from '../../src/core/sessions/task-start.js';
import { QuickStartError } from '../../src/core/sessions/quick-start.js';
import { REQUESTS_FILE, getSessionRequest } from '../../src/core/session-requests.js';
import type { SessionRecord } from '../../src/core/types.js';

const NOW = new Date().toISOString();

function sessionRec(claudeSessionId: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    claudeSessionId,
    taskId: '',
    project: '',
    process_status: 'idle',
    mode: 'default',
    provider: 'cli',
    startedAt: NOW,
    lastActiveAt: NOW,
    messageCount: 0,
    ...overrides,
  } as SessionRecord;
}

/** SESSION_START payloads the runner would have received. */
let emitted: Array<Record<string, unknown>> = [];
let emitSpy: ReturnType<typeof vi.spyOn>;

/** The first message as the freshly started session will actually read it —
 *  this is where the reply trailer either is or isn't. */
function firstMessage(n = 0): string {
  return String(emitted[n]?.message ?? '');
}

async function expectStartError(p: Promise<unknown>, statusCode: number): Promise<QuickStartError> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, `expected QuickStartError(${statusCode})`).toBeInstanceOf(QuickStartError);
  const qsErr = err as QuickStartError;
  expect(qsErr.statusCode).toBe(statusCode);
  return qsErr;
}

beforeEach(() => {
  fs.rmSync(REQUESTS_FILE, { force: true });
  emitted = [];
  getTask.mockReset();
  getSessionsForTask.mockReset();
  resolveCaller.mockReset();

  getTask.mockResolvedValue({ id: 'task-1', title: 'Fix the flake', project: 'Walnut' });
  // No live session on the task — otherwise start refuses with 409 before it
  // ever reaches the expect_reply block.
  getSessionsForTask.mockResolvedValue([]);
  // Default caller for the happy path: another tracked session.
  resolveCaller.mockResolvedValue({
    kind: 'session',
    record: sessionRec('sess-asker-1', { title: 'Asker' }),
  });

  emitSpy = vi.spyOn(bus, 'emit').mockImplementation(((name: string, data: unknown) => {
    if (name === EventNames.SESSION_START) emitted.push(data as Record<string, unknown>);
  }) as never);
});

afterEach(() => {
  emitSpy.mockRestore();
});

describe('startSessionForTask — expect_reply default', () => {
  it('DEFAULTS to registering a request when a session caller omits the flag', async () => {
    const result = await startSessionForTask({
      taskIdPrefix: 'task-1',
      message: 'Fix the flake and report what changed.',
      callerSid: 'sess-asker-1',
      source: 'test',
    });

    expect(result.requestId).toMatch(/^rq-[a-f0-9]{12}$/);
    await expect(getSessionRequest(result.requestId!)).resolves.toMatchObject({
      status: 'pending',
      fromSessionId: 'sess-asker-1',
      toTaskId: 'task-1',
    });
    // The trailer must ride the FIRST message, or the new session never learns
    // how to answer — the request row alone is invisible to it. A plain first
    // message is not an envelope, so the trailer is the whole last line.
    expect(firstMessage()).toBe('Fix the flake and report what changed.\n'
      + `Reply when done: walnut tools call session_send `
      + `'{"in_reply_to":"${result.requestId}","text":"<your result summary>"}'`);
    // The new session is told its own id up front (preassigned for claude).
    expect(result.sessionId).toBeTruthy();
  });

  it('the DEFAULT degrades to no request for the HUMAN — it must not 400', async () => {
    // This is the regression that a naive `default = true` would cause: every
    // session started from the web UI or a plain terminal has a human caller,
    // and a human has no session for a reply to land in.
    resolveCaller.mockResolvedValue({ kind: 'human' });

    const result = await startSessionForTask({
      taskIdPrefix: 'task-1',
      message: 'just start it',
      source: 'test',
    });

    expect(result.requestId).toBeUndefined();
    expect(firstMessage()).toBe('just start it');
    expect(firstMessage()).not.toContain('Reply when done');
    expect(emitted).toHaveLength(1);
  });

  it('the DEFAULT degrades to no request for an EXTERNAL caller too', async () => {
    resolveCaller.mockResolvedValue({ kind: 'external' });

    const result = await startSessionForTask({
      taskIdPrefix: 'task-1', message: 'from somewhere else', source: 'test',
    });

    expect(result.requestId).toBeUndefined();
    expect(firstMessage()).not.toContain('Reply when done');
  });

  it('an EXPLICIT true from a non-session caller still fails loudly', async () => {
    // Silently dropping this one would be wrong in the other direction: the
    // caller asked to be told the outcome, so it must hear that it cannot be.
    resolveCaller.mockResolvedValue({ kind: 'human' });

    const err = await expectStartError(startSessionForTask({
      taskIdPrefix: 'task-1', message: 'answer me', expectReply: true, source: 'test',
    }), 400);
    expect(err.message).toContain('expect_reply needs a session caller');
    // Nothing was started — the refusal happens before the runner is told.
    expect(emitted).toHaveLength(0);
  });

  it('expect_reply: false opts a session caller out of the default', async () => {
    const result = await startSessionForTask({
      taskIdPrefix: 'task-1',
      message: 'fire and forget',
      callerSid: 'sess-asker-1',
      expectReply: false,
      source: 'test',
    });

    expect(result.requestId).toBeUndefined();
    expect(firstMessage()).toBe('fire and forget');
    // resolveCaller is not even consulted — false short-circuits the block.
    expect(resolveCaller).not.toHaveBeenCalled();
  });

  it('carries the caller-supplied reply_timeout into the registered row', async () => {
    const result = await startSessionForTask({
      taskIdPrefix: 'task-1',
      message: 'slow job',
      callerSid: 'sess-asker-1',
      replyTimeoutSecs: 7200,
      source: 'test',
    });

    const row = await getSessionRequest(result.requestId!);
    expect(row).toBeTruthy();
    // deadlineAt is epoch ms; createdAt is ISO. 7200s must survive the clamp
    // (60s..24h) instead of silently falling back to the 1h default.
    const window = row!.deadlineAt - new Date(row!.createdAt).getTime();
    expect(window).toBeGreaterThan(7100 * 1000);
    expect(window).toBeLessThan(7300 * 1000);
  });

  it('registers nothing when the task already has a live session (409 first)', async () => {
    // Ordering pin: the slot rule is checked BEFORE expect_reply, so a refused
    // start must not leave a pending row behind waiting on a session that was
    // never created.
    getSessionsForTask.mockResolvedValue([
      sessionRec('sess-live-1', { taskId: 'task-1', process_status: 'running' }),
    ]);

    await expectStartError(startSessionForTask({
      taskIdPrefix: 'task-1', message: 'second session', callerSid: 'sess-asker-1', source: 'test',
    }), 409);

    expect(fs.existsSync(REQUESTS_FILE)).toBe(false);
    expect(emitted).toHaveLength(0);
  });
});

/**
 * Unit pins for the fallback half of the reply loop — "Walnut speaks when the
 * target didn't" (core/sessions/session-request-notify.ts) plus the turn-end
 * edge that triggers it (session-hooks/builtins.ts → sessionRequestWatchHook).
 *
 * The invariant both share is exactly-once: three independent signals (an
 * explicit reply, the target's turn ending, the deadline sweeper) can fire for
 * the same request, and the asker must hear ONE voice. That is enforced by
 * settling the row FIRST — whoever loses the atomic transition stays silent —
 * which has a deliberate consequence this file pins too: a settled row is never
 * un-settled by a delivery failure, because re-arming it would let every later
 * edge speak again.
 *
 * Real ledger against a temp WALNUT_HOME + real deliverToSession; only the
 * session registry, the durable queue and the task-title lookup are mocked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-request-notify'));

const getSessionByClaudeId = vi.fn();
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: (...args: unknown[]) => getSessionByClaudeId(...args),
}));

const sendMessageToSession = vi.fn();
const enqueueMessage = vi.fn();
vi.mock('../../src/core/session-message-queue.js', () => ({
  sendMessageToSession: (...args: unknown[]) => sendMessageToSession(...args),
  enqueueMessage: (...args: unknown[]) => enqueueMessage(...args),
  getQueue: async () => [],
}));

const listTasksByIds = vi.fn();
vi.mock('../../src/core/task-manager.js', () => ({
  listTasksByIds: (...args: unknown[]) => listTasksByIds(...args),
}));

/** Observes the hook → notifier call without replacing the real behavior. */
const notifySpy = vi.fn();
vi.mock('../../src/core/sessions/session-request-notify.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/core/sessions/session-request-notify.js')>();
  return {
    ...orig,
    notifyRequesterFallback: (...args: Parameters<typeof orig.notifyRequesterFallback>) => {
      notifySpy(...args);
      return orig.notifyRequesterFallback(...args);
    },
  };
});

import {
  notifyRequesterFallback,
  sweepSessionRequests,
} from '../../src/core/sessions/session-request-notify.js';
import {
  REQUESTS_FILE,
  createSessionRequest,
  getSessionRequest,
  settleNotified,
  settleReplied,
  type SessionRequest,
} from '../../src/core/session-requests.js';
import { sessionRequestWatchHook } from '../../src/core/session-hooks/builtins.js';
import type { SessionHookContext } from '../../src/core/session-hooks/types.js';
import type { SessionRecord } from '../../src/core/types.js';

const ASKER = 'sess-asker-1';
const TARGET = 'sess-target-1';
const NOW = new Date().toISOString();

function rec(claudeSessionId: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
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

let sessions: SessionRecord[] = [];

async function arm(overrides: Partial<Parameters<typeof createSessionRequest>[0]> = {}): Promise<SessionRequest> {
  return createSessionRequest({
    fromSessionId: ASKER,
    toSessionId: TARGET,
    toTaskId: 'task-77',
    text: 'count the rows',
    ...overrides,
  });
}

/** Rewrites a row's deadline in place — the only way to make it overdue without a clock. */
function backdateDeadline(id: string): void {
  const store = JSON.parse(fs.readFileSync(REQUESTS_FILE, 'utf-8')) as { requests: SessionRequest[] };
  const row = store.requests.find((r) => r.id === id)!;
  row.deadlineAt = Date.now() - 1_000;
  fs.writeFileSync(REQUESTS_FILE, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
}

/** The phase-edge payload the hook dispatcher hands the handler. */
function phasePayload(over: { sessionId?: string; taskId?: string } = {}): SessionHookContext {
  return {
    domain: 'task',
    taskId: over.taskId ?? 'task-77',
    sessionId: 'sessionId' in over ? over.sessionId : TARGET,
    oldPhase: 'IN_PROGRESS',
    newPhase: 'AGENT_COMPLETE',
    eventSource: 'api',
    timestamp: NOW,
    traceId: 'trace-1',
    event: 'task:phase-changed',
  } as unknown as SessionHookContext;
}

function deliveredText(n = 0): string {
  const [, busText] = sendMessageToSession.mock.calls[n] as [string, string];
  return busText;
}

beforeEach(() => {
  fs.rmSync(REQUESTS_FILE, { force: true });
  sessions = [rec(ASKER, { title: 'Asker', taskId: 'task-asker' }), rec(TARGET, { title: 'Target' })];
  getSessionByClaudeId.mockReset();
  sendMessageToSession.mockReset();
  enqueueMessage.mockReset();
  listTasksByIds.mockReset();
  notifySpy.mockReset();

  getSessionByClaudeId.mockImplementation(async (sid: string) =>
    sessions.find((s) => s.claudeSessionId === sid) ?? null);
  sendMessageToSession.mockResolvedValue({ id: 'qm-notify' });
  enqueueMessage.mockResolvedValue({ id: 'qm-parked' });
  listTasksByIds.mockResolvedValue([{ id: 'task-77', title: 'Run the migration' }]);
});

describe('notifyRequesterFallback — the settle wins exactly once', () => {
  it('settles BEFORE delivering and tells the asker what happened', async () => {
    const rq = await arm();
    let statusAtDelivery: string | undefined;
    sendMessageToSession.mockImplementation(async () => {
      statusAtDelivery = (await getSessionRequest(rq.id))?.status;
      return { id: 'qm-notify' };
    });

    expect(await notifyRequesterFallback(rq, 'completed')).toBe(true);

    expect(statusAtDelivery).toBe('notified');
    const [sid, , opts] = sendMessageToSession.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(sid).toBe(ASKER);
    expect(opts.source).toBe('walnut-notify');
    const text = deliveredText();
    expect(text).toContain(`[Walnut notification — ${rq.id}]`);
    // The task title is embellishment on top of the settled row.
    expect(text).toContain('"Run the migration"');
    expect(text).toContain('Its turn ended WITHOUT an explicit reply');
  });

  it('stays silent when the row was already settled by a reply', async () => {
    const rq = await arm();
    await settleReplied(rq.id);

    expect(await notifyRequesterFallback(rq, 'completed')).toBe(false);

    expect(sendMessageToSession).not.toHaveBeenCalled();
    expect(enqueueMessage).not.toHaveBeenCalled();
    const row = await getSessionRequest(rq.id);
    expect(row?.status).toBe('replied');
    expect(row?.outcome).toBeUndefined();
  });

  it('stays silent on a second notify, whichever outcome it carries', async () => {
    const rq = await arm();
    expect(await notifyRequesterFallback(rq, 'error')).toBe(true);
    sendMessageToSession.mockClear();

    // The sweeper firing after the turn-end edge already spoke.
    expect(await notifyRequesterFallback(rq, 'timeout')).toBe(false);
    expect(sendMessageToSession).not.toHaveBeenCalled();
    const row = await getSessionRequest(rq.id);
    expect(row?.status).toBe('notified');
    expect(row?.outcome).toBe('error');
  });
});

describe('notifyRequesterFallback — a failure after the settle', () => {
  it('does NOT un-settle the row when delivery throws, and reports false', async () => {
    const rq = await arm();
    sendMessageToSession.mockRejectedValue(new Error('daemon offline'));

    expect(await notifyRequesterFallback(rq, 'timeout')).toBe(false);

    // Re-arming the row would let every later edge speak again — worse than a
    // lost notice, so the settle stands.
    const row = await getSessionRequest(rq.id);
    expect(row?.status).toBe('expired');
    expect(row?.outcome).toBe('timeout');
    expect(row?.settledAt).toBeTruthy();
  });

  it('reports false when the asking session is gone, with the row consumed', async () => {
    const rq = await arm();
    sessions = sessions.filter((s) => s.claudeSessionId !== ASKER);

    expect(await notifyRequesterFallback(rq, 'completed')).toBe(false);

    expect(sendMessageToSession).not.toHaveBeenCalled();
    expect((await getSessionRequest(rq.id))?.status).toBe('notified');
  });

  it('still notifies when the task-title lookup fails', async () => {
    const rq = await arm();
    listTasksByIds.mockRejectedValue(new Error('task store unavailable'));

    expect(await notifyRequesterFallback(rq, 'completed')).toBe(true);
    // Generic naming, but the notice is not lost.
    expect(deliveredText()).toContain(`[Walnut notification — ${rq.id}]`);
  });
});

describe('sweepSessionRequests', () => {
  it('expires only the overdue pending rows and counts the ones it notified', async () => {
    const overdue = await arm({ text: 'overdue question' });
    const fresh = await arm({ text: 'fresh question' });
    backdateDeadline(overdue.id);

    expect(await sweepSessionRequests()).toBe(1);

    const overdueRow = await getSessionRequest(overdue.id);
    expect(overdueRow?.status).toBe('expired');
    expect(overdueRow?.outcome).toBe('timeout');
    expect((await getSessionRequest(fresh.id))?.status).toBe('pending');

    expect(sendMessageToSession).toHaveBeenCalledTimes(1);
    expect(deliveredText()).toContain('has not replied by your deadline');

    // A second tick has nothing left to do (the row is no longer pending).
    sendMessageToSession.mockClear();
    expect(await sweepSessionRequests()).toBe(0);
    expect(sendMessageToSession).not.toHaveBeenCalled();
  });

  it('counts notifications, not sweeps: an undeliverable row still expires', async () => {
    const rq = await arm();
    backdateDeadline(rq.id);
    sessions = sessions.filter((s) => s.claudeSessionId !== ASKER);

    expect(await sweepSessionRequests()).toBe(0);
    expect((await getSessionRequest(rq.id))?.status).toBe('expired');
  });
});

describe('sessionRequestWatchHook — outcome selection at the turn-end edge', () => {
  async function fire(payload = phasePayload()): Promise<void> {
    await sessionRequestWatchHook.handler!(payload);
  }

  it('reports awaiting_human when the target sits on a permission prompt', async () => {
    const rq = await arm();
    sessions = sessions.map((s) => s.claudeSessionId === TARGET
      ? rec(TARGET, { title: 'Target', pendingPermission: { requestId: 'p-1', toolName: 'Bash', receivedAt: NOW } })
      : s);

    await fire();

    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy.mock.calls[0][0]).toMatchObject({ id: rq.id });
    expect(notifySpy.mock.calls[0][1]).toBe('awaiting_human');
    expect(deliveredText()).toContain('Do NOT send it messages while it waits');
  });

  it('reports error when the target session is in an error state', async () => {
    await arm();
    sessions = sessions.map((s) => s.claudeSessionId === TARGET
      ? rec(TARGET, { title: 'Target', process_status: 'error' }) : s);

    await fire();

    expect(notifySpy.mock.calls[0][1]).toBe('error');
    expect(deliveredText()).toContain('It hit an ERROR before replying');
  });

  it('reports completed otherwise', async () => {
    await arm();

    await fire();

    expect(notifySpy.mock.calls[0][1]).toBe('completed');
    expect(deliveredText()).toContain('Its turn ended WITHOUT an explicit reply');
  });

  it('notifies every pending request aimed at the target, and nothing when there are none', async () => {
    const a = await arm({ text: 'first question' });
    const b = await arm({ text: 'second question' });

    await fire();

    expect(notifySpy.mock.calls.map((c) => (c[0] as SessionRequest).id).sort()).toEqual([a.id, b.id].sort());
    expect(sendMessageToSession).toHaveBeenCalledTimes(2);

    notifySpy.mockClear();
    sendMessageToSession.mockClear();
    // Same edge again: both rows are settled now, so the hook does nothing.
    await fire();
    expect(notifySpy).not.toHaveBeenCalled();
    expect(sendMessageToSession).not.toHaveBeenCalled();
  });

  it('falls back to completed when the target session record cannot be read', async () => {
    await arm();
    getSessionByClaudeId.mockImplementation(async (sid: string) => {
      if (sid === TARGET) throw new Error('registry unavailable');
      return sessions.find((s) => s.claudeSessionId === sid) ?? null;
    });

    await fire();

    expect(notifySpy.mock.calls[0][1]).toBe('completed');
  });

  it('matches by task id when the edge carries no session id', async () => {
    const rq = await arm({ toSessionId: undefined, toTaskId: 'task-77' });

    await fire(phasePayload({ sessionId: undefined, taskId: 'task-77' }));

    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy.mock.calls[0][0]).toMatchObject({ id: rq.id });
    // No session record to consult → the neutral outcome.
    expect(notifySpy.mock.calls[0][1]).toBe('completed');
  });
});

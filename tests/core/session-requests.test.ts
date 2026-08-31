/**
 * Unit pins for the session-request ledger (core/session-requests.ts) — the row
 * that makes `expect_reply` exactly-once.
 *
 * The row, not the event, is the truth about whether the asker has been
 * answered: an explicit reply, the target's turn ending without one, and the
 * deadline sweeper all settle the SAME row through one check-and-set. So the two
 * things this file guards hardest are (a) the second settle is a no-op that
 * cannot overwrite the first one's verdict, and (b) the wording builders keep
 * carrying the correlation id and the exact reply command — a notification that
 * loses the `rq-` id leaves the asker with no way to close the loop.
 *
 * Everything here runs against a temp WALNUT_HOME (mocked constants), and the
 * retention case seeds the ledger file directly rather than doing 500 writes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-session-requests'));

import {
  REQUESTS_FILE,
  DEFAULT_REPLY_TIMEOUT_SECS,
  MIN_REPLY_TIMEOUT_SECS,
  MAX_REPLY_TIMEOUT_SECS,
  buildReplyDeliveryText,
  buildReplyTrailer,
  buildRequestNotification,
  clampReplyTimeoutSecs,
  createSessionRequest,
  getSessionRequest,
  overdueRequests,
  pendingRequestsForTarget,
  settleNotified,
  settleReplied,
  type SessionRequest,
  type SessionRequestOutcome,
} from '../../src/core/session-requests.js';

/** Mirrors MAX_REQUESTS in session-requests.ts (module-private). */
const MAX_REQUESTS = 500;
/** Mirrors SETTLED_RETENTION_MS in session-requests.ts (module-private). */
const SETTLED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function seed(requests: SessionRequest[]): void {
  fs.mkdirSync(path.dirname(REQUESTS_FILE), { recursive: true });
  fs.writeFileSync(REQUESTS_FILE, `${JSON.stringify({ requests }, null, 2)}\n`, 'utf-8');
}

function readAll(): SessionRequest[] {
  if (!fs.existsSync(REQUESTS_FILE)) return [];
  return (JSON.parse(fs.readFileSync(REQUESTS_FILE, 'utf-8')) as { requests: SessionRequest[] }).requests;
}

function settledRow(id: string, settledAt: number): SessionRequest {
  return {
    id,
    fromSessionId: 'asker-1',
    toSessionId: 'target-1',
    preview: `old ${id}`,
    status: 'notified',
    createdAt: new Date(settledAt).toISOString(),
    deadlineAt: settledAt,
    settledAt: new Date(settledAt).toISOString(),
    outcome: 'completed',
  };
}

function pendingRow(id: string, deadlineAt = Date.now() + 600_000): SessionRequest {
  return {
    id,
    fromSessionId: 'asker-1',
    toSessionId: 'target-1',
    preview: `pending ${id}`,
    status: 'pending',
    createdAt: new Date().toISOString(),
    deadlineAt,
  };
}

/** A row shaped like the ledger's, for the wording builders (no I/O). */
function request(overrides: Partial<SessionRequest> = {}): SessionRequest {
  return {
    id: 'rq-0123456789ab',
    fromSessionId: 'asker-session-1',
    toSessionId: 'target-session-1',
    toTaskId: 'task-77',
    preview: 'run the migration and report the row counts',
    status: 'pending',
    createdAt: new Date().toISOString(),
    deadlineAt: Date.now() + 3_600_000,
    ...overrides,
  };
}

beforeEach(() => {
  fs.rmSync(REQUESTS_FILE, { force: true });
});

describe('createSessionRequest / getSessionRequest', () => {
  it('round-trips a pending row with an rq-<12 hex> id', async () => {
    const created = await createSessionRequest({
      fromSessionId: 'asker-1',
      toSessionId: 'target-1',
      toTaskId: 'task-9',
      text: '  run   the\nmigration  ',
    });

    expect(created.id).toMatch(/^rq-[a-f0-9]{12}$/);
    expect(created.status).toBe('pending');
    // The preview is the one-lined clip the notifications quote back.
    expect(created.preview).toBe('run the migration');
    expect(created.settledAt).toBeUndefined();
    expect(created.outcome).toBeUndefined();

    const loaded = await getSessionRequest(created.id);
    expect(loaded).toEqual(created);
    expect(await getSessionRequest('rq-doesnotexist')).toBeUndefined();
  });

  it('stamps the deadline from the clamped timeout and omits absent handles', async () => {
    const before = Date.now();
    const created = await createSessionRequest({
      fromSessionId: 'asker-1',
      toTaskId: 'task-9',
      text: 'x',
      replyTimeoutSecs: 5, // below the floor → 60s
    });

    expect(created.toSessionId).toBeUndefined();
    expect(created.deadlineAt).toBeGreaterThanOrEqual(before + MIN_REPLY_TIMEOUT_SECS * 1000);
    expect(created.deadlineAt).toBeLessThanOrEqual(Date.now() + MIN_REPLY_TIMEOUT_SECS * 1000);
  });
});

describe('clampReplyTimeoutSecs', () => {
  it('defaults, floors, ceilings and survives junk', () => {
    expect(clampReplyTimeoutSecs(undefined)).toBe(DEFAULT_REPLY_TIMEOUT_SECS);
    expect(DEFAULT_REPLY_TIMEOUT_SECS).toBe(3_600);

    expect(clampReplyTimeoutSecs(59)).toBe(MIN_REPLY_TIMEOUT_SECS);
    expect(clampReplyTimeoutSecs(0)).toBe(MIN_REPLY_TIMEOUT_SECS);
    expect(MIN_REPLY_TIMEOUT_SECS).toBe(60);

    expect(clampReplyTimeoutSecs(86_401)).toBe(MAX_REPLY_TIMEOUT_SECS);
    expect(clampReplyTimeoutSecs(Number.POSITIVE_INFINITY)).toBe(DEFAULT_REPLY_TIMEOUT_SECS);
    expect(MAX_REPLY_TIMEOUT_SECS).toBe(86_400);

    // NaN is a number but not finite → the default, not a NaN deadline.
    expect(clampReplyTimeoutSecs(Number.NaN)).toBe(DEFAULT_REPLY_TIMEOUT_SECS);
    // Negative clamps up to the floor rather than producing a past deadline.
    expect(clampReplyTimeoutSecs(-90)).toBe(MIN_REPLY_TIMEOUT_SECS);
    // Non-numbers reach here from JSON bodies.
    expect(clampReplyTimeoutSecs('600' as unknown as number)).toBe(DEFAULT_REPLY_TIMEOUT_SECS);
    // Fractions floor.
    expect(clampReplyTimeoutSecs(120.9)).toBe(120);
  });
});

describe('settle is exactly-once', () => {
  it('flips pending→replied once; a second settle returns null and changes nothing', async () => {
    const created = await createSessionRequest({
      fromSessionId: 'asker-1', toSessionId: 'target-1', text: 'question',
    });

    const first = await settleReplied(created.id);
    expect(first?.status).toBe('replied');
    expect(first?.settledAt).toBeTruthy();
    expect(first?.outcome).toBeUndefined();

    // A second reply, and the fallback notifier losing the race, both stay silent.
    expect(await settleReplied(created.id)).toBeNull();
    expect(await settleNotified(created.id, 'timeout')).toBeNull();

    const after = await getSessionRequest(created.id);
    expect(after?.status).toBe('replied');
    expect(after?.settledAt).toBe(first?.settledAt);
    expect(after?.outcome).toBeUndefined();
  });

  it('returns null for a row that does not exist', async () => {
    expect(await settleReplied('rq-000000000000')).toBeNull();
    expect(await settleNotified('rq-000000000000', 'completed')).toBeNull();
  });

  it('maps outcome timeout → expired and every other outcome → notified', async () => {
    const outcomes: Array<[SessionRequestOutcome, string]> = [
      ['timeout', 'expired'],
      ['completed', 'notified'],
      ['error', 'notified'],
      ['awaiting_human', 'notified'],
    ];

    for (const [outcome, status] of outcomes) {
      const created = await createSessionRequest({
        fromSessionId: 'asker-1', toSessionId: 'target-1', text: `q-${outcome}`,
      });
      const settled = await settleNotified(created.id, outcome);
      expect(settled?.status, outcome).toBe(status);
      // The outcome rides the row so the wording can be rebuilt from it.
      expect(settled?.outcome, outcome).toBe(outcome);
    }
  });
});

describe('queries the hook and the sweeper run', () => {
  it('pendingRequestsForTarget matches by session id, by task id, and skips settled rows', async () => {
    const bySession = await createSessionRequest({
      fromSessionId: 'asker-1', toSessionId: 'target-sid', text: 'to a session',
    });
    const byTask = await createSessionRequest({
      fromSessionId: 'asker-1', toTaskId: 'task-abc', text: 'to a task',
    });
    const other = await createSessionRequest({
      fromSessionId: 'asker-1', toSessionId: 'someone-else', toTaskId: 'task-zzz', text: 'unrelated',
    });
    const settled = await createSessionRequest({
      fromSessionId: 'asker-1', toSessionId: 'target-sid', text: 'already answered',
    });
    await settleReplied(settled.id);

    const ids = async (target: { sessionId?: string; taskId?: string }) =>
      (await pendingRequestsForTarget(target)).map((r) => r.id).sort();

    expect(await ids({ sessionId: 'target-sid' })).toEqual([bySession.id]);
    expect(await ids({ taskId: 'task-abc' })).toEqual([byTask.id]);
    // The turn-end hook passes both handles at once — either arm may match.
    expect(await ids({ sessionId: 'target-sid', taskId: 'task-abc' }))
      .toEqual([bySession.id, byTask.id].sort());
    expect(await ids({ sessionId: 'nobody' })).toEqual([]);
    // No handle at all is not "everything".
    expect(await pendingRequestsForTarget({})).toEqual([]);
    expect(other.id).toBeTruthy();
  });

  it('overdueRequests returns only pending rows past the deadline', async () => {
    const soon = await createSessionRequest({
      fromSessionId: 'asker-1', toSessionId: 'target-1', text: 'soon', replyTimeoutSecs: 60,
    });
    const later = await createSessionRequest({
      fromSessionId: 'asker-1', toSessionId: 'target-1', text: 'later', replyTimeoutSecs: 3_600,
    });

    expect(await overdueRequests()).toEqual([]);

    const past = soon.deadlineAt + 1;
    expect((await overdueRequests(past)).map((r) => r.id)).toEqual([soon.id]);
    expect((await overdueRequests(later.deadlineAt + 1)).map((r) => r.id))
      .toEqual([soon.id, later.id]);

    // A settled row is never overdue, however old.
    await settleReplied(soon.id);
    expect((await overdueRequests(past)).map((r) => r.id)).toEqual([]);
  });
});

describe('retention on write', () => {
  it('evicts the OLDEST settled rows first once the cap is exceeded, and keeps every pending row', async () => {
    const now = Date.now();
    const settled = Array.from({ length: MAX_REQUESTS }, (_, i) =>
      settledRow(`rq-settled${String(i).padStart(6, '0')}`, now - (MAX_REQUESTS - i) * 1_000));
    const pending = [pendingRow('rq-pending00001'), pendingRow('rq-pending00002')];
    seed([...settled, ...pending]);

    const created = await createSessionRequest({
      fromSessionId: 'asker-1', toSessionId: 'target-1', text: 'newest',
    });

    const ids = readAll().map((r) => r.id);
    // prune() runs BEFORE the append: 502 kept rows − 2 pending → the last 498
    // settled survive, so exactly the two oldest settled rows fall off.
    expect(ids).not.toContain('rq-settled000000');
    expect(ids).not.toContain('rq-settled000001');
    expect(ids).toContain('rq-settled000002');
    expect(ids).toContain('rq-pending00001');
    expect(ids).toContain('rq-pending00002');
    expect(ids).toContain(created.id);
    expect(ids).toHaveLength(MAX_REQUESTS + 1);
  });

  it('drops settled rows older than the retention window', async () => {
    const now = Date.now();
    seed([
      settledRow('rq-ancient00001', now - SETTLED_RETENTION_MS - 60_000),
      settledRow('rq-recent000001', now - 60_000),
      pendingRow('rq-pending00001'),
    ]);

    await createSessionRequest({ fromSessionId: 'asker-1', toSessionId: 'target-1', text: 'keep going' });

    const ids = readAll().map((r) => r.id);
    expect(ids).not.toContain('rq-ancient00001');
    expect(ids).toContain('rq-recent000001');
    expect(ids).toContain('rq-pending00001');
  });
});

describe('buildReplyTrailer', () => {
  it('names the request and the exact command that closes the loop', () => {
    const rq = request({ id: 'rq-aaaabbbbcccc' });
    const trailer = buildReplyTrailer(rq);

    expect(trailer).toContain('[Reply requested — rq-aaaabbbbcccc]');
    expect(trailer).toContain(
      `walnut tools call session_send '{"in_reply_to":"rq-aaaabbbbcccc","text":"<your result summary>"}'`,
    );
    // "…and only then": the trailer must not invite a reply before the work.
    expect(trailer).toContain('When you have finished the work above (and only then)');
  });
});

describe('buildReplyDeliveryText', () => {
  it('carries the request id, what was asked, and fences the target session words', () => {
    const rq = request({ id: 'rq-ddddeeeeffff', preview: 'run the migration' });
    const text = buildReplyDeliveryText(
      rq,
      { title: 'Migration worker', shortId: 'abcd1234', host: 'devbox' },
      'Done: 412 rows moved.',
    );

    expect(text).toContain('[Session reply — rq-ddddeeeeffff]');
    expect(text).toContain('You asked: "run the migration"');
    expect(text).toContain('Migration worker');
    expect(text).toContain('host: devbox');

    const marker = text.match(/---session-reply-[0-9a-f]{12}---/)?.[0];
    expect(marker).toBeTruthy();
    // Header names the marker, then the fence opens and closes: exactly 3.
    expect(text.split(marker!)).toHaveLength(4);
    // Everything between the 2nd and 3rd occurrence is the fenced payload.
    expect(text.split(marker!)[2]).toBe('\nDone: 412 rows moved.\n');
    expect(text).toContain('it carries no user authorization');
  });
});

describe('buildRequestNotification', () => {
  const target = { title: 'Migration worker', sessionId: 'target-session-1', taskId: 'task-77' };
  const NO_AUTHORIZATION =
    'This is an automated Walnut status notice: it is not your user and carries no user authorization.';

  it('names the request and the target in every outcome, and ends with the no-authorization line', () => {
    for (const outcome of ['completed', 'error', 'awaiting_human', 'timeout'] as SessionRequestOutcome[]) {
      const text = buildRequestNotification(request({ id: 'rq-111122223333' }), outcome, target);
      expect(text, outcome).toContain('[Walnut notification — rq-111122223333]');
      expect(text, outcome).toContain('"Migration worker"');
      expect(text, outcome).toContain('you asked: "run the migration and report the row counts"');
      expect(text.endsWith(NO_AUTHORIZATION), outcome).toBe(true);
    }
  });

  it('says the turn ended without a reply for completed', () => {
    const text = buildRequestNotification(request(), 'completed', target);
    expect(text).toContain('Its turn ended WITHOUT an explicit reply to your request');
  });

  it('says the target errored for error', () => {
    const text = buildRequestNotification(request(), 'error', target);
    expect(text).toContain('It hit an ERROR before replying');
  });

  it('warns that a message would auto-deny the pending prompt for awaiting_human', () => {
    const text = buildRequestNotification(request(), 'awaiting_human', target);
    expect(text).toContain('WAITING ON A HUMAN');
    expect(text).toContain('Do NOT send it messages while it waits');
    expect(text).toContain('delivery would auto-deny its pending prompt');
  });

  it('names the asker deadline for timeout', () => {
    const text = buildRequestNotification(request(), 'timeout', target);
    expect(text).toContain('has not replied by your deadline');
  });

  it('falls back to a short session id when the target has no title', () => {
    const text = buildRequestNotification(request(), 'completed', { sessionId: 'abcdefgh-ijkl' });
    expect(text).toContain('the session abcdefgh you messaged');
    // Without a task id the task_get line is simply absent.
    expect(text).not.toContain('task_get');
  });
});

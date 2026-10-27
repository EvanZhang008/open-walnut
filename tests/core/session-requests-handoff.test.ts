/**
 * A request handed on (src/core/session-requests.ts linkHandoffs): a session that owes a
 * request names it (`hands_on`) on its ask to another task, and the owed request waits
 * for that answer. 2026-10-27, Main's reflection: a lead handed Main's request to a
 * worker and ended its turn, and Main heard "WAITING without an explicit reply" every time.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-session-requests-handoff'));

// The task of each session, as the tracker records it (a hand-off back to the asker's task is refused).
const taskOfSession: Record<string, string> = { 'sess-main': 'task-main', 'sess-main-2': 'task-main', 'sess-lead': 'task-lead', 'sess-worker': 'task-worker' };
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: async (sid: string) => (taskOfSession[sid] ? { claudeSessionId: sid, taskId: taskOfSession[sid] } : null),
}));

import {
  HANDOFF_GRACE_MS,
  MAX_CARRIERS,
  MAX_REPLY_TIMEOUT_SECS,
  REQUESTS_FILE,
  carriedState,
  createSessionRequest,
  deletePendingRequest,
  getSessionRequest,
  importOfflineRequest,
  listAllSessionRequests,
  settleNotified,
  settleReplied,
  type SessionRequest,
} from '../../src/core/session-requests.js';

const MAIN = 'sess-main';
const LEAD = 'sess-lead';
const WORKER = 'sess-worker';

/** Main asks the lead (task-lead) something. */
const askLead = (text = 'ship the login fix', over: Partial<Parameters<typeof createSessionRequest>[0]> = {}) =>
  createSessionRequest({ fromSessionId: MAIN, fromTaskId: 'task-main', toSessionId: LEAD, toTaskId: 'task-lead', text, ...over });

/** The lead asks its worker, handing on what it names. */
const handOn = (handsOn: string[], text = 'fix the login timeout', over: Partial<Parameters<typeof createSessionRequest>[0]> = {}) =>
  createSessionRequest({ fromSessionId: LEAD, fromTaskId: 'task-lead', toSessionId: WORKER, toTaskId: 'task-worker', text, handsOn, ...over });

beforeEach(() => {
  fs.rmSync(REQUESTS_FILE, { force: true });
});

describe('a request its target hands on by name', () => {
  it('waits for that answer, and its deadline moves past the new one', async () => {
    const owed = await askLead();
    const onward = await handOn([owed.id]);
    expect(onward.carries).toEqual([owed.id]);
    expect(onward.handOnRefused).toBeUndefined();
    const row = (await getSessionRequest(owed.id))!;
    expect(row.carriedBy).toMatchObject([{ id: onward.id, taskId: 'task-worker' }]);
    expect(row.deadlineAt).toBeGreaterThanOrEqual(onward.deadlineAt + HANDOFF_GRACE_MS);
    expect(row.ownDeadlineAt).toBe(owed.deadlineAt);
    expect(row.status).toBe('pending');
  });

  it('only what it names: another request it owes stays its own', async () => {
    const named = await askLead('ship the login fix');
    const other = await askLead('ok to deploy?');
    await handOn([named.id]);
    expect((await getSessionRequest(named.id))?.carriedBy?.length).toBe(1);
    expect((await getSessionRequest(other.id))?.carriedBy).toBeUndefined();
    // An ask that names nothing hands nothing on.
    await handOn([], 'unrelated');
    expect((await getSessionRequest(other.id))?.carriedBy).toBeUndefined();
  });

  it('a request owed by the task is handed on by any session of it', async () => {
    const toTask = await createSessionRequest({ fromSessionId: MAIN, fromTaskId: 'task-main', toTaskId: 'task-lead', text: 'start on it' });
    const onward = await handOn([toTask.id], 'fix it', { fromSessionId: 'sess-lead-2' });
    expect(onward.carries).toEqual([toTask.id]);
  });

  it('two tasks: it waits for both; the state follows the answers', async () => {
    const owed = await askLead();
    const a = await handOn([owed.id], 'part one', { toSessionId: undefined, toTaskId: 'task-a' });
    const b = await handOn([owed.id], 'part two', { toSessionId: undefined, toTaskId: 'task-b' });
    const rows = () => listAllSessionRequests();
    const row = async () => (await getSessionRequest(owed.id))!;
    expect((await row()).carriedBy?.map((c) => c.taskId)).toEqual(['task-a', 'task-b']);
    expect(carriedState(await row(), await rows())).toBe('out');
    await settleReplied(a.id);
    expect(carriedState(await row(), await rows())).toBe('out');
    await settleNotified(b.id, 'completed');
    expect(carriedState(await row(), await rows())).toBe('back');
    expect(carriedState({ id: 'x' } as unknown as SessionRequest, [])).toBe('none');
  });

  it('a chain: the worker handing it on again moves the first asker\'s deadline with it', async () => {
    const owed = await askLead();
    const onward = await handOn([owed.id]);
    const deeper = await createSessionRequest({
      fromSessionId: WORKER, fromTaskId: 'task-worker', toTaskId: 'task-sub', text: 'the hard part', replyTimeoutSecs: 12 * 3600, handsOn: [onward.id],
    });
    const row = (await getSessionRequest(onward.id))!;
    expect(row.deadlineAt).toBeGreaterThanOrEqual(deeper.deadlineAt + HANDOFF_GRACE_MS);
    expect((await getSessionRequest(owed.id))!.deadlineAt).toBeGreaterThanOrEqual(row.deadlineAt + HANDOFF_GRACE_MS);
  });
});

describe('what a hand-off refuses', () => {
  it('a request that is unknown, answered, or owed by someone else', async () => {
    const answered = await askLead('done already');
    await settleReplied(answered.id);
    const others = await createSessionRequest({ fromSessionId: MAIN, toSessionId: 'sess-other', toTaskId: 'task-other', text: 'not the lead\'s' });
    const onward = await handOn(['rq-0000000000aa', answered.id, others.id]);
    expect(onward.carries).toBeUndefined();
    expect(onward.handOnRefused).toEqual([
      { id: 'rq-0000000000aa', reason: 'unknown' }, { id: answered.id, reason: 'settled' }, { id: others.id, reason: 'not_yours' },
    ]);
    expect((await getSessionRequest(others.id))?.carriedBy).toBeUndefined();
  });

  it('a hand-off back to the asker (its session, or another session of its task) is a question to it, not a hand-off', async () => {
    const owed = await askLead();
    const back = await handOn([owed.id], 'which one?', { toSessionId: MAIN, toTaskId: 'task-main' });
    const backToTask = await handOn([owed.id], 'which one?', { toSessionId: 'sess-main-2', toTaskId: 'task-main' });
    expect(back.handOnRefused).toEqual([{ id: owed.id, reason: 'back_to_asker' }]);
    expect(backToTask.handOnRefused).toEqual([{ id: owed.id, reason: 'back_to_asker' }]);
    expect((await getSessionRequest(owed.id))?.carriedBy).toBeUndefined();
  });

  it('more than MAX_CARRIERS tasks', async () => {
    const owed = await askLead();
    for (let i = 0; i < MAX_CARRIERS; i++) await handOn([owed.id], `part ${i}`, { toSessionId: undefined, toTaskId: `task-p${i}` });
    const extra = await handOn([owed.id], 'one more', { toSessionId: undefined, toTaskId: 'task-extra' });
    expect(extra.handOnRefused).toEqual([{ id: owed.id, reason: 'too_many' }]);
    expect((await getSessionRequest(owed.id))?.carriedBy).toHaveLength(MAX_CARRIERS);
  });

  it('moving a deadline past the longest wait an asker may name', async () => {
    const owed = await askLead();
    await handOn([owed.id], 'long job', { replyTimeoutSecs: MAX_REPLY_TIMEOUT_SECS });
    const row = (await getSessionRequest(owed.id))!;
    expect(row.deadlineAt).toBe(Date.parse(row.createdAt) + MAX_REPLY_TIMEOUT_SECS * 1000);
  });
});

describe('when the work comes back, or never left', () => {
  it('an ask that never left stops holding what it carried, which gets its own deadline back', async () => {
    const owed = await askLead();
    const onward = await handOn([owed.id]);
    await deletePendingRequest(onward.id);
    const row = (await getSessionRequest(owed.id))!;
    expect(row.carriedBy).toBeUndefined();
    expect(row.ownDeadlineAt).toBeUndefined();
    expect(row.deadlineAt).toBe(owed.deadlineAt);
  });

  it('once the work is back, the wait shrinks to the target\'s own answer: its own deadline, or 10 min', async () => {
    const owed = await askLead();
    const onward = await handOn([owed.id], 'long job', { replyTimeoutSecs: 6 * 3600 });
    expect((await getSessionRequest(owed.id))!.deadlineAt).toBeGreaterThan(owed.deadlineAt + 4 * 3600_000);
    await settleReplied(onward.id);
    expect((await getSessionRequest(owed.id))!.deadlineAt).toBe(owed.deadlineAt);
    // An own deadline sooner than that: 10 minutes from the answer.
    const short = await askLead('quick', { replyTimeoutSecs: 60 });
    const next = await handOn([short.id], 'quick part');
    const before = Date.now();
    await settleNotified(next.id, 'completed');
    const at = (await getSessionRequest(short.id))!.deadlineAt;
    expect(at).toBeGreaterThanOrEqual(before + HANDOFF_GRACE_MS);
    expect(at).toBeLessThanOrEqual(Date.now() + HANDOFF_GRACE_MS);
  });

  it('a host links nothing, keeps the links on its copy, and its settle brings the work back', async () => {
    const owed = await askLead();
    const hostRow: SessionRequest = {
      id: 'rq-0123456789ab', fromSessionId: LEAD, toSessionId: WORKER, toTaskId: 'task-worker',
      preview: 'fix it', status: 'pending', createdAt: new Date().toISOString(), deadlineAt: Date.now() + 60_000,
    };
    expect(await importOfflineRequest(hostRow)).toBe(true);
    expect((await getSessionRequest(owed.id))?.carriedBy).toBeUndefined();
    // A server-made hand-off, then the host's copy of the owed row (no links, its first deadline).
    const onward = await handOn([owed.id]);
    const linked = (await getSessionRequest(owed.id))!;
    const { carriedBy: _c, ownDeadlineAt: _o, ...hostCopy } = linked;
    expect(await importOfflineRequest({ ...hostCopy, deadlineAt: owed.deadlineAt })).toBe(false);
    expect(await getSessionRequest(owed.id)).toMatchObject({ carriedBy: linked.carriedBy, deadlineAt: linked.deadlineAt });
    // The host settled the onward ask while this server was away: the owed request's wait comes back in.
    const onwardRow = (await getSessionRequest(onward.id))!;
    expect(await importOfflineRequest({ ...onwardRow, status: 'replied', settledAt: new Date().toISOString() })).toBe(true);
    expect((await getSessionRequest(owed.id))!.deadlineAt).toBe(owed.deadlineAt);
  });
});

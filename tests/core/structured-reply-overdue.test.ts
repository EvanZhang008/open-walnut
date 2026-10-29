/**
 * Partial replies and overdue requests (2026-10-28, the multi-agent tracking research):
 *   - a reply or a completion may carry result / evidence / not_done, and a non-empty
 *     not_done reads as Partial (src/core/peers/structured-reply.ts);
 *   - a request past its deadline stays OVERDUE, STILL OPEN until a reply settles it, with
 *     one reminder at twice the deadline (src/core/session-requests.ts);
 *   - the Brief's program-made "still open" footer (briefStillOpen in src/core/user-status.ts)
 *     and the post-compaction list (open-items-text.ts) name both.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-structured-reply'));

import {
  REQUESTS_FILE, buildOverdueReminder, claimReminder, overdueOpenRequests, reminderDueAt, settleLateReply,
  type SessionRequest,
} from '../../src/core/session-requests.js';
import { composeReplyText, isPartial, partialLine, readStructuredReply } from '../../src/core/peers/structured-reply.js';
import { briefMentions, briefStillOpen, resultIsPartial, type StillOpenTask } from '../../src/core/user-status.js';
import { createOpenItemsText } from '../../src/core/sessions/open-items-text.js';
import { parseWalnutMessage } from '../../src/core/peers/walnut-message-tag.js';

const H = 3_600_000;
const NOW = Date.parse('2026-10-28T12:00:00Z');

function seed(requests: SessionRequest[]): void {
  fs.mkdirSync(path.dirname(REQUESTS_FILE), { recursive: true });
  fs.writeFileSync(REQUESTS_FILE, `${JSON.stringify({ requests }, null, 2)}\n`, 'utf-8');
}

function row(id: string, status: SessionRequest['status'], askedHoursAgo: number, waitHours = 1, extra: Partial<SessionRequest> = {}): SessionRequest {
  const created = NOW - askedHoursAgo * H;
  return {
    id, fromSessionId: 'lead-sid', toTaskId: 'worker-1', toSessionId: 'worker-sid', preview: `ask ${id}`,
    status, createdAt: new Date(created).toISOString(), deadlineAt: created + waitHours * H,
    ...(status !== 'pending' ? { settledAt: new Date(created + waitHours * H).toISOString() } : {}),
    ...extra,
  };
}

describe('structured reply fields', () => {
  it('reads lists from a string or an array, drops bullets and empties, and knows Partial', () => {
    const r = readStructuredReply({ result: '  Shipped the line. ', evidence: '- /tmp/a.png\n\n* /tmp/b.png', not_done: ['iOS not tested', '', 7] });
    expect(r).toEqual({ result: 'Shipped the line.', evidence: ['/tmp/a.png', '/tmp/b.png'], not_done: ['iOS not tested'] });
    expect(isPartial(r)).toBe(true);
    expect(isPartial({ ...r!, settled: { at: 'x', how: 'taken' } } as never)).toBe(false);
    expect(partialLine(r)).toBe('Partial: iOS not tested');
    expect(readStructuredReply({ result: '  ', not_done: [] })).toBeNull();
  });

  it('the asker reads every field in plain text, so an older reader misses nothing', () => {
    const text = composeReplyText('Done mostly.', { result: 'Live on prod', evidence: ['/tmp/x.png'], not_done: ['TestFlight'] });
    expect(text).toBe('Done mostly.\n\nResult: Live on prod\n\nEvidence:\n- /tmp/x.png\n\nNot done (partial reply):\n- TestFlight');
    expect(composeReplyText(undefined, { result: 'Only this' })).toBe('Result: Only this');
    expect(composeReplyText('plain', null)).toBe('plain');
  });
});

describe('an overdue request stays open', () => {
  beforeEach(() => { fs.rmSync(REQUESTS_FILE, { force: true }); });

  it('lists expired requests still unanswered, and a late reply closes one exactly once', async () => {
    seed([row('rq-a', 'expired', 3), row('rq-b', 'pending', 0.2), row('rq-c', 'replied', 3), row('rq-old', 'expired', 8 * 24)]);
    expect((await overdueOpenRequests(NOW)).map((r) => r.id)).toEqual(['rq-a']);
    const late = await settleLateReply('rq-a', { not_done: ['docs'] });
    expect(late).toMatchObject({ status: 'replied', lateFrom: 'expired', reply: { not_done: ['docs'] } });
    expect(await settleLateReply('rq-a')).toBeNull();
    // A pending one is not "late": its own settle answers it.
    expect(await settleLateReply('rq-b')).toBeNull();
    expect(await overdueOpenRequests(NOW)).toEqual([]);
  });

  it('reminds once at twice its own wait, counted from the ask', async () => {
    const r = row('rq-a', 'expired', 3, 1);
    expect(reminderDueAt(r)).toBe(Date.parse(r.createdAt) + 2 * H);
    // A hand-off moved the deadline: the asker's own wait counts.
    expect(reminderDueAt({ ...r, deadlineAt: Date.parse(r.createdAt) + 5 * H, ownDeadlineAt: Date.parse(r.createdAt) + H })).toBe(Date.parse(r.createdAt) + 2 * H);
    seed([r]);
    expect(await claimReminder('rq-a', NOW)).toMatchObject({ remindedAt: new Date(NOW).toISOString() });
    expect(await claimReminder('rq-a', NOW)).toBeNull();
  });

  it('the reminder is a Walnut notice naming the request, its task and what to do', () => {
    const text = buildOverdueReminder([{ request: row('rq-a', 'expired', 3), target: { title: 'Worker', taskId: 'worker-1', sessionId: 'worker-sid', phase: 'IN_PROGRESS' } }], NOW);
    const env = parseWalnutMessage(text);
    expect(env?.attrs).toMatchObject({ kind: 'notification', request: 'rq-a', 'about-task': 'worker-1', outcome: 'timeout' });
    expect(env?.body).toContain('your request is still OVERDUE and open');
    expect(env?.body).toContain('- rq-a to Worker [worker-s] (worker-1, IN_PROGRESS now), asked about 3 hours ago: "ask rq-a"');
    expect(env?.body).toContain('this is the only reminder');
  });

  it('several due at once share one message', () => {
    const text = buildOverdueReminder([
      { request: row('rq-a', 'expired', 3), target: { taskId: 'w1' } },
      { request: row('rq-b', 'expired', 5), target: { taskId: 'w2' } },
    ], NOW);
    const env = parseWalnutMessage(text);
    expect(env?.attrs.request).toBeUndefined();
    expect(env?.body).toContain('2 of your requests are still OVERDUE');
    expect(env?.body).toContain('- rq-b');
  });

  it('only a request this Walnut made overdue is reminded: an upgrade sends no burst for old rows', async () => {
    const { createSessionRequest, settleNotified } = await import('../../src/core/session-requests.js');
    const r = await createSessionRequest({ fromSessionId: 'lead-sid', toTaskId: 'worker-1', text: 'x', replyTimeoutSecs: 60 });
    const settled = await settleNotified(r.id, 'timeout');
    expect(settled).toMatchObject({ status: 'expired' });
    expect(typeof settled?.overdueAt).toBe('string');
    expect((await settleNotified((await createSessionRequest({ fromSessionId: 'a', toTaskId: 'b', text: 'y' })).id, 'completed'))?.overdueAt).toBeUndefined();
  });
});

describe('the post-compaction list names Partial and overdue work', () => {
  const fmt = createOpenItemsText();
  it('adds its sections only when there is something in them', () => {
    const base = { task: { id: 'lead', title: 'Lead' }, subtasks: [], moreSubtasks: 0, waitingOn: [], askedOfYou: [] };
    expect(fmt.format(base, NOW)).toBe('');
    const text = fmt.format({
      ...base,
      subtasks: [{ id: 'w1', title: 'Worker', phase: 'IN_PROGRESS', partial: ['iOS'] }],
      partialDone: [{ id: 'w2', title: 'Done one', phase: 'COMPLETE', partial: ['docs', 'video'] }],
      overdueOut: [{ id: 'rq-a', to: 'w1', preview: 'status?', createdAt: new Date(NOW - 3 * H).toISOString() }],
      overdueIn: [{ id: 'rq-b', from: 'main', preview: 'report', createdAt: new Date(NOW - 5 * H).toISOString() }],
    }, NOW);
    expect(text).toContain('- w1 [IN_PROGRESS] Worker (Partial, not done: iOS)');
    expect(text).toContain('Finished subtasks whose result was Partial (1)');
    expect(text).toContain('- w2 Done one: not done: docs; video');
    expect(text).toContain('Overdue and still open: replies you asked for that missed their deadline (1)');
    expect(text).toContain('- rq-a to w1, asked 3h ago: "status?"');
    expect(text).toContain('Asked of you, overdue and still open (1)');
  });
});

describe('the Brief\'s still-open footer', () => {
  const t = (id: string, extra: Partial<StillOpenTask> = {}): StillOpenTask => ({ id, title: id.toUpperCase(), phase: 'IN_PROGRESS', parent_task_id: 'lead', ...extra });
  const lead: StillOpenTask = { id: 'lead', title: 'Lead', phase: 'IN_PROGRESS', org_role: 'lead', project: 'P' };

  it('lists open work the letter does not name, Partial results, overdue asks and long waits', () => {
    const tasks: StillOpenTask[] = [
      lead,
      t('named'),
      t('forgot', { user_status: { state: 'needs', ask: 'approve' } }),
      t('deep', { parent_task_id: 'forgot' }),
      t('done-partial', { phase: 'COMPLETE', result_report: { not_done: ['iOS'], at: new Date(NOW - H).toISOString() } }),
      t('settled', { phase: 'COMPLETE', result_report: { not_done: ['x'], settled: { at: 'y' }, at: new Date(NOW - H).toISOString() } }),
      t('old-partial', { phase: 'COMPLETE', result_report: { not_done: ['x'], at: new Date(NOW - 9 * 24 * H).toISOString() } }),
      t('stale', { user_status: { state: 'waiting', kind: 'lead' }, phase_changed_at: new Date(NOW - 50 * H).toISOString() }),
      // Another project's task, not below the lead: not its team.
      { id: 'other', title: 'Other', phase: 'IN_PROGRESS', project: 'Q' },
      // In its project but not its subtask: in the team (Partial, waits), never "not in the letter".
      { id: 'peer', title: 'Peer', phase: 'IN_PROGRESS', project: 'P' },
    ];
    const mentioned = briefMentions('Done: <task-ref id="named" label="Named"/> and <a class="task-link" data-task-id="stale">x</a>');
    const open = briefStillOpen(lead, tasks, {
      mentioned, now: NOW,
      overdue: [
        { id: 'rq-1', fromTaskId: 'lead', toTaskId: 'forgot', preview: 'status?', createdAt: new Date(NOW - 3 * H).toISOString() },
        { id: 'rq-2', fromTaskId: 'other', toTaskId: 'nobody', preview: 'x', createdAt: new Date(NOW).toISOString() },
      ],
    });
    // Needs first, then working.
    expect(open.unmentioned.map((x) => x.id)).toEqual(['forgot', 'deep']);
    expect(open.partial.map((p) => [p.task.id, p.notDone])).toEqual([['done-partial', ['iOS']]]);
    expect(open.overdue.map((r) => r.id)).toEqual(['rq-1']);
    expect(open.waitingLong.map((w) => [w.task.id, w.on])).toEqual([['stale', 'lead']]);
    expect(resultIsPartial(tasks[4].result_report)).toBe(true);
  });

  it('counts the rest past the limit, and Main\'s VPs are its own work', () => {
    const many = Array.from({ length: 11 }, (_, i) => t(`w${i}`));
    expect(briefStillOpen(lead, [lead, ...many], { mentioned: new Set(), now: NOW }).moreUnmentioned).toBe(3);
    const main: StillOpenTask = { id: 'main', title: 'Main', phase: 'IN_PROGRESS', org_role: 'main' };
    const vp: StillOpenTask = { id: 'vp', title: 'VP', phase: 'IN_PROGRESS', org_role: 'lead', project: 'P' };
    expect(briefStillOpen(main, [main, vp], { mentioned: new Set(), now: NOW }).unmentioned.map((x) => x.id)).toEqual(['vp']);
  });
});

describe('due dates feed the status (2026-10-28, the Grok Bot study: deadlines in the status)', () => {
  it('a bare date is due at the end of that day; overdue past it, soon within a day, silent before', async () => {
    const { dueStatus, dueAtMs, deriveUserStatus } = await import('../../src/core/user-status.js');
    const local = (s: string) => Date.parse(s);
    expect(dueAtMs('2026-10-28')).toBe(local('2026-10-28T23:59:59.999'));
    expect(dueStatus('2026-10-27', local('2026-10-28T09:00:00'))).toEqual({ at: '2026-10-27', state: 'overdue' });
    expect(dueStatus('2026-10-28', local('2026-10-28T09:00:00'))).toEqual({ at: '2026-10-28', state: 'soon' });
    expect(dueStatus('2026-11-05', local('2026-10-28T09:00:00'))).toBeUndefined();
    expect(dueStatus('garbage', NOW)).toBeUndefined();
    expect(dueStatus(undefined, NOW)).toBeUndefined();
    // On the derived status of an open task, never a done one.
    const open = deriveUserStatus({ phase: 'TODO', dueDate: '2026-10-27' }, local('2026-10-28T09:00:00'));
    expect(open.due).toEqual({ at: '2026-10-27', state: 'overdue' });
    expect(deriveUserStatus({ phase: 'COMPLETE', dueDate: '2026-10-27' }, NOW).due).toBeUndefined();
  });

  it('the Brief footer lists open team work past or near its due date, earliest first', () => {
    const lead: StillOpenTask = { id: 'lead', title: 'Lead', phase: 'IN_PROGRESS', org_role: 'lead', project: 'P' };
    const at = (h: number) => new Date(NOW + h * H).toISOString();
    const tasks: StillOpenTask[] = [
      lead,
      { id: 'late', title: 'Late', phase: 'IN_PROGRESS', parent_task_id: 'lead', due_date: at(-5) },
      { id: 'soon', title: 'Soon', phase: 'TODO', parent_task_id: 'lead', due_date: at(3) },
      { id: 'later', title: 'Later', phase: 'TODO', parent_task_id: 'lead', due_date: at(72) },
      { id: 'closed', title: 'Closed', phase: 'COMPLETE', parent_task_id: 'lead', due_date: at(-5) },
    ];
    const open = briefStillOpen(lead, tasks, { mentioned: new Set(), now: NOW });
    expect(open.due.map((d) => [d.task.id, d.state])).toEqual([['late', 'overdue'], ['soon', 'soon']]);
  });
});

/**
 * The user away from Main's or a lead's chat (2026-10-31, the user before going to sleep: when he is
 * not in the chat, an important update goes to his inbox, in one thread, and a morning report on
 * request). Pure parts: who is away (org/user-away.ts), the hint that says so (hints/hint-registry.ts
 * user-away), how a letter of an absence goes out (human-inbox/away-thread.ts), the report
 * (org/morning-report.ts) and the rule in the prompts. The server flow is in tests/e2e/away-inbox.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('away-inbox-pure'));

import { AWAY_AFTER_MS, awayAfterMs, awayStateOf } from '../../../src/core/org/user-away.js';
import { USER_BACK_TEXT, effectiveHints } from '../../../src/core/hints/hint-registry.js';
import { advanceHintState, planHints } from '../../../src/core/hints/hint-send.js';
import { AWAY_THREAD_MAX_MS, DECISION_QUIET_MS, decisionNoteText, foldedTurnText, planAwaySend } from '../../../src/core/human-inbox/away-thread.js';
import { normalizeStore } from '../../../src/core/human-inbox/normalize.js';
const normalizeRecord = (raw: unknown) => normalizeStore({ version: 1, letters: [raw] } as never).letters[0];
import { buildMorningReport, parseReportAt, reportTime } from '../../../src/core/org/morning-report.js';
import { AWAY_INBOX_LINE, WALNUT_PROMPT_MARK, defaultInstructions } from '../../../src/core/sessions/session-context.js';
import { instructionNoticeFor } from '../../../src/core/sessions/instruction-notice.js';
import type { LetterRecord } from '../../../src/core/human-inbox/types.js';
import type { Task } from '../../../src/core/types.js';

const NOW = Date.parse('2026-11-01T15:00:00Z');
const MIN = 60_000;

describe('who is away (awayStateOf)', () => {
  const base = { taskId: 't-lead', heartbeats: new Map<string, number>(), streaming: false, now: NOW, afterMs: AWAY_AFTER_MS };
  it('never seen is away with no since; a message he typed or a heartbeat in the chat is presence', () => {
    expect(awayStateOf({ ...base, sessions: [] })).toEqual({ away: true, lastSeenAt: null });
    const typed = (ago: number) => [{ claudeSessionId: 's1', chatInputAt: new Date(NOW - ago).toISOString() }];
    expect(awayStateOf({ ...base, sessions: typed(10 * MIN) })).toEqual({ away: false, lastSeenAt: NOW - 10 * MIN });
    expect(awayStateOf({ ...base, sessions: typed(40 * MIN) })).toEqual({ away: true, lastSeenAt: NOW - 40 * MIN });
    // The web console or the phone reported attention on the task, or on one of its sessions.
    expect(awayStateOf({ ...base, sessions: typed(40 * MIN), heartbeats: new Map([['task:t-lead', NOW - 2 * MIN]]) }).away).toBe(false);
    expect(awayStateOf({ ...base, sessions: typed(40 * MIN), heartbeats: new Map([['session:s1', NOW - 2 * MIN]]) }).away).toBe(false);
    // Another task's heartbeat says nothing about this chat.
    expect(awayStateOf({ ...base, sessions: typed(40 * MIN), heartbeats: new Map([['task:t-other', NOW]]) }).away).toBe(true);
    // Answering a letter stamps humanInputAt only: he is still away from the chat.
    expect(awayStateOf({ ...base, sessions: [{ claudeSessionId: 's1', humanInputAt: new Date(NOW).toISOString() } as never] }).away).toBe(true);
    // A session screen open on the phone now.
    expect(awayStateOf({ ...base, sessions: typed(5 * 60 * MIN), streaming: true })).toEqual({ away: false, lastSeenAt: NOW });
  });

  it('the threshold is 30 minutes unless the env says otherwise', () => {
    expect(awayAfterMs({})).toBe(30 * MIN);
    expect(awayAfterMs({ WALNUT_AWAY_AFTER_MINUTES: '5' })).toBe(5 * MIN);
    expect(awayAfterMs({ WALNUT_AWAY_AFTER_MINUTES: 'x' })).toBe(30 * MIN);
  });
});

describe('the user-away hint', () => {
  type Rec = { claudeSessionId: string; output_mode?: 'markdown'; hintState?: never };
  const config = { session: {} } as never;
  const send = (rec: Rec, role: 'lead' | 'worker', away: { away: boolean; lastSeenAt: number | null } | null, sentBy: 'person' | 'agent' = 'agent') => {
    const p = planHints({ hints: effectiveHints(config), target: { sessionId: rec.claudeSessionId, role }, record: rec as never, config, sentBy, inChat: sentBy === 'person', away });
    rec.hintState = advanceHintState(rec.hintState, rec as never, p.told, { now: Date.now(), sentBy }) as never;
    return p.carried.filter((h) => h.kind === 'user-away').map((h) => h.text);
  };

  it('says it once per absence, says he is back once, and is silent while he stays', () => {
    const rec: Rec = { claudeSessionId: 'lead-1', output_mode: 'markdown' };
    expect(send(rec, 'lead', { away: false, lastSeenAt: NOW })).toEqual([]);
    const away = { away: true, lastSeenAt: NOW - 40 * MIN };
    const first = send(rec, 'lead', away);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatch(/has not been in this chat since 2026-11-01T14:20Z/);
    // The same absence after a restart that forgot a heartbeat (an earlier "last seen") is not news.
    expect(send(rec, 'lead', { away: true, lastSeenAt: NOW - 90 * MIN })).toEqual([]);
    expect(first[0]).toMatch(/goes to his inbox now with human_inbox_send/);
    expect(first[0]).toMatch(/one thread and his phone buzzes once/);
    expect(send(rec, 'lead', away)).toEqual([]);
    // His own message is presence, whatever the clock said.
    // An answer from the inbox is a person, not the chat: still away, nothing said.
    const p = planHints({ hints: effectiveHints(config), target: { sessionId: rec.claudeSessionId, role: 'lead' }, record: rec as never, config, sentBy: 'person', inChat: false, away });
    expect(p.carried.filter((h) => h.kind === 'user-away')).toEqual([]);
    expect(send(rec, 'lead', away, 'person')).toEqual([USER_BACK_TEXT]);
    expect(send(rec, 'lead', { away: false, lastSeenAt: NOW })).toEqual([]);
    // A new absence is news again.
    expect(send(rec, 'lead', { away: true, lastSeenAt: NOW + 5 * MIN })).toHaveLength(1);
  });

  it('no presence read (a worker, any other task) says nothing', () => {
    const rec: Rec = { claudeSessionId: 'w-1', output_mode: 'markdown' };
    expect(send(rec, 'worker', null)).toEqual([]);
  });
});

const letter = (o: Partial<LetterRecord>): LetterRecord => ({
  id: 'lt-x', subject: 's', type: 'info', bodyFormat: 'markdown', textPreview: '', createdAt: NOW - 60 * MIN,
  read: false, pinned: false, archived: false, thread: [], sender: { sessionId: 's-lead', taskId: 't-lead', host: 'local' }, ...o,
} as LetterRecord);

describe('one thread per absence (planAwaySend)', () => {
  const mark = { taskId: 't-lead', since: NOW - 2 * 60 * MIN };
  const SID = 's-lead';
  it('the first update is a new letter that buzzes; later ones join it, quiet while it is unread', () => {
    expect(planAwaySend({ type: 'info' }, mark, SID, [], NOW)).toEqual({ kind: 'new', mark, quiet: false });
    const thread = letter({ id: 'lt-1', awayThread: mark });
    expect(planAwaySend({ type: 'review' }, mark, SID, [thread], NOW)).toEqual({ kind: 'fold', into: thread });
    expect(planAwaySend({ type: 'completion' }, mark, SID, [{ ...thread, read: true }], NOW)).toMatchObject({ kind: 'fold' });
    // After a restart forgot a heartbeat, "last seen" is earlier: the thread made after it still counts.
    expect(planAwaySend({ type: 'info' }, { ...mark, since: NOW - 5 * 60 * MIN }, SID, [thread], NOW)).toMatchObject({ kind: 'fold' });
  });

  it('a decision is its own letter, quiet while a recent letter of the absence is unread, named in the thread', () => {
    const thread = letter({ id: 'lt-1', awayThread: mark });
    expect(planAwaySend({ type: 'action_required' }, mark, SID, [thread], NOW)).toEqual({ kind: 'new', mark, quiet: true, noteInto: thread });
    expect(planAwaySend({ type: 'action_required' }, mark, SID, [{ ...thread, read: true }], NOW)).toEqual({ kind: 'new', mark, quiet: false, noteInto: { ...thread, read: true } });
    // The night's first letter, unread for hours, does not silence a morning decision.
    const old = { ...thread, createdAt: NOW - DECISION_QUIET_MS - MIN, awayThread: { ...mark, since: NOW - 10 * 60 * MIN } };
    expect(planAwaySend({ type: 'action_required' }, { ...mark, since: NOW - 10 * 60 * MIN }, SID, [old], NOW)).toMatchObject({ kind: 'new', quiet: false });
    // A decision is never the thread an update joins, but its unread state keeps the next one quiet.
    const decision = letter({ id: 'lt-d', type: 'action_required', awayThread: mark });
    expect(planAwaySend({ type: 'info' }, mark, SID, [decision], NOW)).toEqual({ kind: 'new', mark, quiet: true });
  });

  it('he came back (a letter older than his last visit), an archived, settled or day-old thread, or another session starts a new letter', () => {
    const thread = letter({ id: 'lt-1', awayThread: mark });
    expect(planAwaySend({ type: 'info' }, { ...mark, since: NOW - 10 * MIN }, SID, [thread], NOW)).toMatchObject({ kind: 'new', quiet: false });
    expect(planAwaySend({ type: 'info' }, mark, SID, [{ ...thread, archived: true }], NOW)).toMatchObject({ kind: 'new', quiet: false });
    expect(planAwaySend({ type: 'info' }, mark, SID, [{ ...thread, settled: { at: 1, reason: 'x' } as never, read: true }], NOW)).toMatchObject({ kind: 'new' });
    expect(planAwaySend({ type: 'info' }, mark, SID, [{ ...thread, createdAt: NOW - AWAY_THREAD_MAX_MS }], NOW)).toMatchObject({ kind: 'new', quiet: false });
    // A new session of the node: his answers in the old thread would go to the old session.
    expect(planAwaySend({ type: 'info' }, mark, 's-lead-new', [{ ...thread, read: true }], NOW)).toMatchObject({ kind: 'new', quiet: false });
    // Another node's thread is not this one's.
    expect(planAwaySend({ type: 'info' }, mark, SID, [letter({ awayThread: { taskId: 't-main', since: mark.since } })], NOW)).toMatchObject({ kind: 'new', quiet: false });
  });

  it('pinned, mail items and a letter the user asked for stand alone', () => {
    const thread = letter({ id: 'lt-1', awayThread: mark });
    expect(planAwaySend({ type: 'info', pin: true }, mark, SID, [thread], NOW)).toBeNull();
    expect(planAwaySend({ type: 'info', items: [{}] as never }, mark, SID, [thread], NOW)).toBeNull();
    expect(planAwaySend({ type: 'review', user_asked: true }, mark, SID, [thread], NOW)).toBeNull();
    expect(planAwaySend({ type: 'review', userAsked: true }, mark, SID, [thread], NOW)).toBeNull();
  });

  it('the turn text and the decision line', () => {
    expect(foldedTurnText({ subject: 'Deploy is live', text: 'Prod serves abc' })).toBe('Deploy is live: Prod serves abc');
    expect(foldedTurnText({ subject: 'Deploy is live' })).toBe('Deploy is live');
    expect(decisionNoteText(' Pick a layout ')).toBe('Needs your answer: "Pick a layout", in its own letter, where one tap answers it.');
  });

  it('the mark survives a rewrite of the index', () => {
    const raw = { ...letter({ id: 'lt-aaaa-0001' }), awayThread: { taskId: 't-lead', since: 5 } };
    expect(normalizeRecord(raw)?.awayThread).toEqual({ taskId: 't-lead', since: 5 });
    expect(normalizeRecord({ ...raw, awayThread: { taskId: 't-lead', since: 'x' } })?.awayThread).toEqual({ taskId: 't-lead', since: null });
    expect(normalizeRecord({ ...raw, awayThread: { since: 5 } })?.awayThread).toBeUndefined();
  });
});

const task = (o: Partial<Task>): Task => ({ id: 't', title: 'T', phase: 'IN_PROGRESS', status: 'in_progress', project: 'Walnut', ...o } as Task);

const t = (iso: string) => reportTime(Date.parse(iso));

describe('the report (buildMorningReport)', () => {
  const lead = task({ id: 't-lead', title: 'Walnut lead', org_role: 'lead', brief: { text: '### Needs you\n- one', at: '2026-11-01T14:00:00Z' } as never });
  const since = Date.parse('2026-11-01T06:00:00Z');
  const tasks = [
    lead,
    task({ id: 't-ask', title: 'Hosts overview', parent_task_id: 't-lead', phase: 'NEED_ACTION', phase_changed_at: '2026-11-01T07:00:00Z',
      user_status: { state: 'needs', ask: 'Start step one?', source: 'session', checkedAt: '2026-11-01T07:00:00Z',
        askForm: { summary: 'Start step one?', kind: 'single', options: [{ id: 'a', label: 'In settings' }, { id: 'b', label: 'Own page' }] } } as never }),
    task({ id: 't-yes', title: 'Tea order', parent_task_id: 't-lead', phase: 'NEED_ACTION', user_status: { state: 'needs', ask: 'Order it?', askForm: { summary: 'Order it?', kind: 'yes_no' } } as never }),
    task({ id: 't-done', title: 'Shell dollar fix', parent_task_id: 't-lead', phase: 'COMPLETE', status: 'done', completed_at: '2026-11-01T09:00:00Z', result_report: { result: 'Live on prod' } as never }),
    task({ id: 't-old', title: 'Old work', parent_task_id: 't-lead', phase: 'COMPLETE', status: 'done', completed_at: '2026-10-30T09:00:00Z' }),
    task({ id: 't-moved', title: 'Daemon upgrade', parent_task_id: 't-lead', phase: 'WAITING', phase_changed_at: '2026-11-01T10:00:00Z', user_status: { state: 'waiting', waitingOn: 'the CI run' } as never }),
    task({ id: 't-snoozed', title: 'Logo draft', parent_task_id: 't-lead', phase: 'NEED_ACTION', phase_changed_at: '2026-11-01T11:00:00Z', user_status: { state: 'waiting', snoozed: { until: '2026-11-05T09:00:00Z', ask: 'Pick a color?' } } as never }),
    task({ id: 't-elsewhere', title: 'Someone else', project: 'Personal', phase: 'NEED_ACTION', user_status: { state: 'needs', ask: 'x' } as never }),
  ];
  const decision = letter({ id: 'lt-d', type: 'action_required', subject: 'Hosts overview: start?', sender: { sessionId: 's', taskId: 't-ask', host: 'local' }, actions: [{ id: 'a', label: 'Go' }] });

  it('needs with their one-tap answer, done and moved since the time, and the Brief; only the team', () => {
    const r = buildMorningReport(lead, tasks, [decision], since, NOW);
    expect(r.counts).toEqual({ needs: 2, done: 1, moved: 2 });
    expect(r.markdown).toMatch(/## Needs you \(2\)/);
    expect(r.markdown).toContain(`**Hosts overview**: Start step one? (checked ${t('2026-11-01T07:00:00Z')}). Options: In settings / Own page. One tap: the letter "Hosts overview: start?" in your inbox.`);
    expect(r.markdown).toMatch(/\*\*Tea order\*\*: Order it\?\. Yes or no\. Answer in its chat\./);
    expect(r.markdown).toMatch(/\*\*Shell dollar fix\*\*: Live on prod/);
    expect(r.markdown).not.toMatch(/Old work|Someone else/);
    expect(r.markdown).toMatch(/\*\*Daemon upgrade\*\*: waits on the CI run/);
    // A snoozed ask is not asked again before its date.
    expect(r.markdown).toContain(`**Logo draft**: snoozed until ${t('2026-11-05T09:00:00Z')}`);
    expect(r.markdown).not.toMatch(/Pick a color/);
    expect(r.markdown).toContain(`Walnut lead's Brief (written ${t('2026-11-01T14:00:00Z')})`);
    expect(r.subject).toBe(`Report: 2 Needs you, 1 Completed, 2 moved since ${t('2026-11-01T06:00:00Z').slice(11, 16)}`);
    expect(r.taskRefs).toEqual(expect.arrayContaining(['t-ask', 't-yes', 't-done', 't-moved']));
  });

  it('Main reads the whole org; an empty night says so', () => {
    const main = task({ id: 't-main', title: 'Main', org_role: 'main', project: 'Ask Walnut' });
    expect(buildMorningReport(main, [...tasks, main], [], since, NOW).counts.needs).toBe(3);
    const quiet = buildMorningReport(lead, [lead], [], since, NOW);
    expect(quiet.text).toBe('Nothing needs you. 0 done, 0 moved.');
    expect(quiet.markdown).toMatch(/## Needs you \(0\)\n- Nothing\./);
  });

  it('a decision letter with no task needing the user is listed on its own', () => {
    const lone = letter({ id: 'lt-lone', type: 'action_required', subject: 'Rename the project?', sender: { sessionId: 's', taskId: 't-lead', taskTitle: 'Walnut lead', host: 'local' } });
    expect(buildMorningReport(lead, [lead], [lone], since, NOW).markdown).toMatch(/## Other decisions waiting in your inbox \(1\)\n- "Rename the project\?" from Walnut lead: one tap answers it\./);
  });

  it('times read on the server\'s clock with its offset', () => {
    expect(reportTime(Date.parse('2026-11-01T07:00:00Z'))).toMatch(/^2026-11-0[12] \d{2}:\d{2} UTC([+-]\d{1,2}(:\d{2})?)?$/);
  });

  it('when: a time of day is the next one, a duration from now, an ISO time; the past is refused', () => {
    const now = new Date(2026, 10, 1, 23, 30).getTime();
    expect(new Date(parseReportAt('08:00', now)).getDate()).toBe(2);
    expect(new Date(parseReportAt('23:45', now)).getDate()).toBe(1);
    expect(parseReportAt('8h', now)).toBe(now + 8 * 60 * MIN);
    expect(parseReportAt('2026-11-02T16:00:00Z', now)).toBe(Date.parse('2026-11-02T16:00:00Z'));
    expect(() => parseReportAt('2020-01-01T00:00:00Z', now)).toThrow(/not in the future/);
    expect(() => parseReportAt('25:00', now)).toThrow(/time of day/);
    expect(() => parseReportAt('soon', now)).toThrow(/HH:MM/);
  });
});

describe('the rule rides Main\'s and a lead\'s prompt', () => {
  it('Main and a lead have it, a worker does not, and a running session hears it through the notice', () => {
    expect(AWAY_INBOX_LINE).toMatch(/goes to his inbox with human_inbox_send/);
    expect(AWAY_INBOX_LINE).toMatch(/org_report at:<time>/);
    for (const t of [{ org_role: 'main', project: 'Main' }, { org_role: 'lead', project: 'Walnut' }]) {
      expect(defaultInstructions(t)).toContain(AWAY_INBOX_LINE.trim());
      const old = `${WALNUT_PROMPT_MARK}\n` + defaultInstructions(t).split('\n').filter((l) => l.trim() !== AWAY_INBOX_LINE.trim()).join('\n');
      expect(instructionNoticeFor({ appliedAppendSystemPrompt: old } as never, t)).toContain(AWAY_INBOX_LINE.trim());
    }
    expect(defaultInstructions({ project: 'Walnut' })).not.toContain(AWAY_INBOX_LINE.trim());
  });
});

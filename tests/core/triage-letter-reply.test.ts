/**
 * Answering a triage decision letter, and withdrawing one a later run took over (S15).
 *
 * What this file pins:
 *
 *  - the answer goes back to THAT RUN'S session. Every triage run is its own task
 *    and its own session, so "the origin session" is the only address that means
 *    anything — a run that ended hours ago is still the one that knows why it asked.
 *  - a STOPPED session is not a dead one. The idle reaper kills the CLI after a
 *    couple of quiet hours, and a letter is often answered long after that; the
 *    answer rides `sendMessageToSession`, the same rail that cold-`--resume`s a
 *    stopped session (the spawn itself is asserted end to end in
 *    tests/e2e/triage-letters.test.ts).
 *  - ANSWERING SENDS NOTHING OUTWARD. The whole effect of a tap is one message
 *    queued into the run; the run then has to go through mail_request_send /
 *    slack_request_post / mail_unsubscribe_request like before. Pinned three ways:
 *    no network call during the answer, the exact set of bus events it emits, and
 *    the delivered text being a report of the human's choice rather than a command.
 *  - withdrawal retires an EARLIER run's unanswered decisions and leaves alone:
 *    this run's own, an already-answered one, a non-decision letter, and any letter
 *    from another agent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('triage-letter-reply'));

const getSessionByClaudeId = vi.fn();
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: (...args: unknown[]) => getSessionByClaudeId(...args),
}));

const sendMessageToSession = vi.fn(async (_sid: string, _text: string) => ({ id: 'qm-letter-answer' }));
const enqueueMessage = vi.fn(async () => ({ id: 'qm-parked' }));
vi.mock('../../src/core/session-message-queue.js', () => ({
  sendMessageToSession: (...args: unknown[]) => sendMessageToSession(...(args as [string, string])),
  enqueueMessage: (...args: unknown[]) => enqueueMessage(...(args as [])),
}));

vi.mock('../../src/core/notifications/letter-bridge.js', () => ({
  ensureLetterBridge: () => {},
  mirrorLetterReadState: vi.fn(async () => {}),
}));

/**
 * The two outward mechanisms, watched at their real chokepoints: sending mail and
 * posting to Slack both leave this box either over the network (`fetch`, stubbed
 * per case) or by spawning a provider CLI. Neither may happen because a human
 * tapped a button — the RUN has to ask first, through mail_request_send /
 * slack_request_post / mail_unsubscribe_request.
 */
const spawn = vi.hoisted(() => vi.fn());
const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<object>(),
  spawn,
  execFile,
}));

import { bus } from '../../src/core/event-bus.js';
import { answerLetterAndDeliver } from '../../src/core/human-inbox/letter-ops.js';
import {
  answerLetter, getLetter, humanInboxPaths, listLetters, sendLetter,
} from '../../src/core/human-inbox/store.js';
import {
  TRIAGE_SUPERSEDED_NOTE,
  _resetTriageLetterQuotaForTesting,
  withdrawSupersededTriageLetters,
} from '../../src/core/human-inbox/triage-quota.js';
import type { LetterRecord, LetterSender } from '../../src/core/human-inbox/types.js';

const RUN_SID = 'sess-triage-run-now';
const RUN_TASK = 'task-triage-run-now';
const OLD_RUN_SID = 'sess-triage-run-earlier';
const OLD_RUN_TASK = 'task-triage-run-earlier';

function triageSender(sessionId: string, taskId: string): LetterSender {
  return { sessionId, host: 'local', taskId, project: 'Ask Inbox Triage' };
}

/** Both triage runs' tasks are stamped; nothing else is. */
const isTriageTask = async (taskId: string): Promise<boolean> =>
  taskId === RUN_TASK || taskId === OLD_RUN_TASK;

async function decisionLetter(
  sender: LetterSender,
  subject = 'The platform list wants an owner for the migration window',
): Promise<LetterRecord> {
  return await sendLetter({
    subject,
    type: 'action_required',
    markdown: 'Two messages on the platform list ask who owns the migration window.',
    actions: [
      { id: 'make-task', label: 'Make a task' },
      { id: 'reply-for-me', label: 'Reply for me' },
      { id: 'ignore', label: 'Ignore' },
    ],
    sender,
  });
}

/** Every event the bus carried during one call. */
function recordEvents(): { names: string[]; stop: () => void } {
  const names: string[] = [];
  const name = `triage-letter-reply-spy-${Math.random().toString(36).slice(2, 8)}`;
  bus.subscribe(name, (event) => { names.push(event.name); }, { global: true });
  return { names, stop: () => bus.unsubscribe(name) };
}

beforeEach(() => {
  // One inbox per case: the withdraw sweep reads the WHOLE inbox, so a letter left
  // by an earlier case would make the next one's counts a lie.
  fs.rmSync(humanInboxPaths.dir, { recursive: true, force: true });
  _resetTriageLetterQuotaForTesting();
  getSessionByClaudeId.mockReset();
  sendMessageToSession.mockClear();
  enqueueMessage.mockClear();
  spawn.mockClear();
  execFile.mockClear();
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('the human taps a button on a triage decision letter', () => {
  it('delivers the choice into THAT run\'s session', async () => {
    getSessionByClaudeId.mockImplementation(async (sid: string) => (
      sid === RUN_SID
        ? { claudeSessionId: RUN_SID, taskId: RUN_TASK, host: '__local__', process_status: 'idle', project: 'Ask Inbox Triage' }
        : null
    ));
    const letter = await decisionLetter(triageSender(RUN_SID, RUN_TASK));

    const { delivery } = await answerLetterAndDeliver(letter.id, { actionId: 'make-task' });

    expect(delivery).toMatchObject({ status: 'queued', sessionId: RUN_SID });
    expect(sendMessageToSession).toHaveBeenCalledTimes(1);
    const [sid, text, opts] = sendMessageToSession.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(sid).toBe(RUN_SID);
    expect(opts).toMatchObject({ source: 'human-inbox', taskId: RUN_TASK });
    // The run learns which letter and which button, and what to do next.
    expect(text).toContain('[Letter reply]');
    expect(text).toContain(`letter: ${letter.id}`);
    expect(text).toContain('choice: Make a task');
    expect(text).toContain('human_inbox_reply');
  });

  it('a STOPPED run is resumed, not treated as gone', async () => {
    // The record is what decides: 'stopped' is a live address (the transcript is
    // intact and a send cold-resumes it), so the answer must NOT be skipped.
    getSessionByClaudeId.mockResolvedValue({
      claudeSessionId: RUN_SID, taskId: RUN_TASK, host: '__local__',
      process_status: 'stopped', statusReason: 'expected_teardown', project: 'Ask Inbox Triage',
    });
    const letter = await decisionLetter(triageSender(RUN_SID, RUN_TASK), 'A stale decision from this morning');

    const { delivery } = await answerLetterAndDeliver(letter.id, { actionId: 'reply-for-me' });

    expect(delivery.status).toBe('queued');
    expect(delivery.reason).toBeUndefined();
    expect(sendMessageToSession).toHaveBeenCalledTimes(1);
    expect((sendMessageToSession.mock.calls[0] as [string])[0]).toBe(RUN_SID);
  });

  it('sends NOTHING outward: one queued message, no network, no second letter', async () => {
    getSessionByClaudeId.mockResolvedValue({
      claudeSessionId: RUN_SID, taskId: RUN_TASK, host: '__local__', process_status: 'idle',
    });
    const letter = await decisionLetter(triageSender(RUN_SID, RUN_TASK));
    const before = (await listLetters({})).letters.length;

    // Any real send (SMTP, Graph, the Slack API) leaves this box; assert nothing does.
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
    const events = recordEvents();
    try {
      await answerLetterAndDeliver(letter.id, { actionId: 'reply-for-me', freeText: 'Tell them I own it.' });
    } finally {
      events.stop();
    }

    expect(fetchSpy, 'answering a letter must not reach the network').not.toHaveBeenCalled();
    // No provider CLI was spawned either: a Slack post and an SMTP send are the two
    // things a `Reply for me` tap must NOT be able to trigger on its own.
    expect(spawn, 'answering a letter must not spawn a provider').not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    // The whole effect: the answer is announced, and ONE message is queued.
    expect(sendMessageToSession).toHaveBeenCalledTimes(1);
    expect(new Set(events.names)).toEqual(new Set(['human-inbox:answered']));
    // No approval was minted and no letter was sent on the user's behalf: acting on
    // the choice is the run's job, through mail_request_send / slack_request_post.
    expect((await listLetters({})).letters.length).toBe(before);
    const answered = await getLetter(letter.id);
    expect(answered?.answered).toMatchObject({ actionId: 'reply-for-me', label: 'Reply for me' });
  });

  it('a run whose session record is gone keeps the answer and says so', async () => {
    getSessionByClaudeId.mockResolvedValue(null);
    const letter = await decisionLetter(triageSender('sess-triage-reaped', RUN_TASK));
    const { delivery, letter: saved } = await answerLetterAndDeliver(letter.id, { actionId: 'ignore' });
    expect(delivery).toMatchObject({ status: 'skipped', reason: 'origin_session_gone' });
    expect(saved.answered?.actionId).toBe('ignore');
    expect(sendMessageToSession).not.toHaveBeenCalled();
  });
});

describe('a decision a later run has taken over is withdrawn', () => {
  it('retires the earlier run\'s unanswered decisions and keeps this run\'s', async () => {
    const stale = await decisionLetter(triageSender(OLD_RUN_SID, OLD_RUN_TASK), 'Unsubscribe from the weekly digest?');
    const staleToo = await decisionLetter(triageSender(OLD_RUN_SID, OLD_RUN_TASK), 'File the RFC thread under CIS?');
    const mine = await decisionLetter(triageSender(RUN_SID, RUN_TASK), 'Who owns the migration window?');

    const result = await withdrawSupersededTriageLetters({ keepSessionId: RUN_SID, isTriageTask });

    expect(result.withdrawn.sort()).toEqual([stale.id, staleToo.id].sort());
    expect(result.kept).toBe(1);
    expect(result.failed).toBe(0);

    for (const id of [stale.id, staleToo.id]) {
      const after = await getLetter(id);
      expect(after?.answered?.actionId).toBe('withdrawn');
      expect(after?.answered?.freeText).toBe(TRIAGE_SUPERSEDED_NOTE);
      // The thread says why, and the read flag is untouched: nobody looked at it.
      expect(after?.thread.at(-1)?.text).toContain('Withdrawn:');
      expect(after?.read).toBe(false);
    }
    expect((await getLetter(mine.id))?.answered).toBeUndefined();
  });

  it('never touches an answered decision, a non-decision letter, or another agent\'s letter', async () => {
    const answeredDecision = await decisionLetter(triageSender(OLD_RUN_SID, OLD_RUN_TASK), 'Already decided');
    await answerLetter(answeredDecision.id, { actionId: 'ignore' });
    const summaryLetter = await sendLetter({
      subject: 'Triage · 14:10 · 16 items',
      type: 'review',
      markdown: 'Sixteen items; four mattered.',
      sender: triageSender(OLD_RUN_SID, OLD_RUN_TASK),
    });
    const otherAgent = await sendLetter({
      subject: 'The refactor is done',
      type: 'action_required',
      markdown: 'Ship it?',
      actions: [{ id: 'ship', label: 'Ship it' }],
      sender: { sessionId: 'sess-dev-work', host: 'local', taskId: 'task-ordinary-dev-work' },
    });
    const pluginLetter = await sendLetter({
      subject: 'Approve this reply?',
      type: 'action_required',
      markdown: 'Draft ready.',
      actions: [{ id: 'send', label: 'Send it' }],
      sender: { sessionId: 'external', host: 'local', pluginId: 'mail' },
    });
    const stale = await decisionLetter(triageSender(OLD_RUN_SID, OLD_RUN_TASK), 'Still open');

    const result = await withdrawSupersededTriageLetters({ keepSessionId: RUN_SID, isTriageTask });

    expect(result.withdrawn).toEqual([stale.id]);
    expect((await getLetter(summaryLetter.id))?.answered).toBeUndefined();
    expect((await getLetter(otherAgent.id))?.answered).toBeUndefined();
    expect((await getLetter(pluginLetter.id))?.answered).toBeUndefined();
    // The answered one keeps the human's own decision, not a withdrawal.
    expect((await getLetter(answeredDecision.id))?.answered?.actionId).toBe('ignore');
  });

  it('keeps a named letter even from an earlier run, and reports a failure without throwing', async () => {
    const keep = await decisionLetter(triageSender(OLD_RUN_SID, OLD_RUN_TASK), 'Still in play');
    const drop = await decisionLetter(triageSender(OLD_RUN_SID, OLD_RUN_TASK), 'Superseded');

    const kept = await withdrawSupersededTriageLetters({
      keepLetterIds: [keep.id], keepSessionId: RUN_SID, isTriageTask,
      note: 'Handled in the 14:10 run.',
    });
    expect(kept.withdrawn).toEqual([drop.id]);
    expect(kept.kept).toBe(1);
    expect((await getLetter(drop.id))?.answered?.freeText).toBe('Handled in the 14:10 run.');

    const failing = await withdrawSupersededTriageLetters({
      isTriageTask,
      withdraw: async () => { throw new Error('index.json is locked'); },
    });
    expect(failing.withdrawn).toEqual([]);
    expect(failing.failed).toBe(1);
  });

  it('is a no-op on an inbox with no triage decisions in it', async () => {
    const result = await withdrawSupersededTriageLetters({ keepSessionId: RUN_SID, isTriageTask });
    expect(result).toEqual({ withdrawn: [], kept: 0, failed: 0 });
  });
});

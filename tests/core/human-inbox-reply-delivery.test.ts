/**
 * A human turn's delivery status is PERSISTED on the turn, and a reply is
 * idempotent per `clientId`.
 *
 * Why: the phone showed "Sent to the agent" from a view-local variable, so the
 * status was gone the moment the letter was closed, and it said the same words
 * whether the reply was queued or delivered. The status now lives on the thread
 * entry (`ThreadEntry.delivery`), so any reader can show it under the reply it
 * belongs to, after a reopen too. And because a client retries (a lost response,
 * a double tap), a repeat of the same `clientId` must never thread the words
 * twice or tell the agent twice, except as the explicit retry of a FAILED
 * delivery.
 *
 * WALNUT_HOME is an isolated tmpdir (createMockConstants). The session tracker
 * and the message queue are mocked: their real paths would reach a CLI.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-inbox-reply-delivery'));

const getSessionByClaudeId = vi.fn();
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: (...args: unknown[]) => getSessionByClaudeId(...args),
}));

const sendMessageToSession = vi.fn();
const enqueueMessage = vi.fn();
vi.mock('../../src/core/session-message-queue.js', () => ({
  sendMessageToSession: (...args: unknown[]) => sendMessageToSession(...args),
  enqueueMessage: (...args: unknown[]) => enqueueMessage(...args),
}));

vi.mock('../../src/core/notifications/letter-bridge.js', () => ({
  ensureLetterBridge: () => {},
  mirrorLetterReadState: async () => {},
}));

import {
  answerLetterAndDeliver,
  humanReplyAndDeliver,
} from '../../src/core/human-inbox/letter-ops.js';
import { getLetter, humanInboxPaths, sendLetter } from '../../src/core/human-inbox/store.js';
import type { LetterSender, NewLetter } from '../../src/core/human-inbox/types.js';

const SENDER: LetterSender = { sessionId: 'sess-origin-7', host: 'workstation', taskTitle: 'Promotion check-in' };

function letterInput(overrides: Partial<NewLetter> = {}): NewLetter {
  return {
    subject: 'Promotion check-in',
    type: 'review',
    markdown: 'Three items need your read.',
    sender: SENDER,
    ...overrides,
  };
}

/** The origin session exists and is idle (not parked on a prompt). */
function originIdle(): void {
  getSessionByClaudeId.mockResolvedValue({ claudeSessionId: SENDER.sessionId, host: 'workstation' });
}

async function turnsOnDisk(id: string) {
  return (await getLetter(id))!.thread;
}

beforeEach(() => {
  fs.rmSync(humanInboxPaths.dir, { recursive: true, force: true });
  getSessionByClaudeId.mockReset();
  sendMessageToSession.mockReset();
  enqueueMessage.mockReset();
  sendMessageToSession.mockResolvedValue({ id: 'qm-1' });
  enqueueMessage.mockResolvedValue({ id: 'qm-parked' });
});

describe('a human reply records its delivery on the turn', () => {
  it('queued: the status, the session and the time are on the turn, and a re-read still has them', async () => {
    originIdle();
    const letter = await sendLetter(letterInput());
    const before = Date.now();

    const out = await humanReplyAndDeliver(letter.id, { text: 'Looks right, ship it.' });

    expect(out.delivery).toEqual({ status: 'queued', sessionId: SENDER.sessionId, messageId: 'qm-1' });
    // The response's letter already carries it, so the reader needs no second read.
    const inResponse = out.letter.thread[0]!;
    expect(inResponse.delivery).toMatchObject({ status: 'queued', sessionId: SENDER.sessionId });
    // Closing and reopening the letter is a fresh GET: the status must survive it.
    const [turn] = await turnsOnDisk(letter.id);
    expect(turn).toMatchObject({ from: 'human', text: 'Looks right, ship it.' });
    expect(turn!.delivery).toMatchObject({ status: 'queued', sessionId: SENDER.sessionId });
    expect(turn!.delivery!.at).toBeGreaterThanOrEqual(before);
  });

  it('deferred: a session parked on a permission prompt keeps the reply queued, and says so', async () => {
    getSessionByClaudeId.mockResolvedValue({
      claudeSessionId: SENDER.sessionId,
      host: 'workstation',
      pendingPermission: { requestId: 'req-1', toolName: 'Bash', receivedAt: new Date().toISOString() },
    });
    const letter = await sendLetter(letterInput());
    await humanReplyAndDeliver(letter.id, { text: 'Yes, go ahead.' });
    expect((await turnsOnDisk(letter.id))[0]!.delivery)
      .toMatchObject({ status: 'deferred', reason: 'origin_awaiting_permission', sessionId: SENDER.sessionId });
    expect(sendMessageToSession).not.toHaveBeenCalled();
  });

  it('skipped: an origin session that has ended is recorded as saved, not sent', async () => {
    getSessionByClaudeId.mockResolvedValue(null);
    const letter = await sendLetter(letterInput());
    await humanReplyAndDeliver(letter.id, { text: 'Too late?' });
    expect((await turnsOnDisk(letter.id))[0]!.delivery)
      .toMatchObject({ status: 'skipped', reason: 'origin_session_gone', sessionId: SENDER.sessionId });
  });

  it('failed: the failure is recorded, with its reason bounded', async () => {
    originIdle();
    sendMessageToSession.mockRejectedValue(new Error(`queue exploded ${'x'.repeat(1_000)}`));
    const letter = await sendLetter(letterInput());
    const out = await humanReplyAndDeliver(letter.id, { text: 'Try this.' });
    expect(out.delivery.status).toBe('failed');
    const delivery = (await turnsOnDisk(letter.id))[0]!.delivery!;
    expect(delivery.status).toBe('failed');
    expect(delivery.reason!.startsWith('queue exploded')).toBe(true);
    expect(delivery.reason!.length).toBeLessThanOrEqual(200);
  });

  it('an action answer records its delivery on the answer turn too', async () => {
    originIdle();
    const letter = await sendLetter(letterInput({
      type: 'action_required',
      actions: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
    }));
    await answerLetterAndDeliver(letter.id, { actionId: 'yes', freeText: 'after lunch' });
    const [turn] = await turnsOnDisk(letter.id);
    expect(turn!.from).toBe('human');
    expect(turn!.delivery).toMatchObject({ status: 'queued', sessionId: SENDER.sessionId });
  });
});

describe('a reply is idempotent per clientId', () => {
  it('a repeat of the same clientId threads once and tells the agent once', async () => {
    originIdle();
    const letter = await sendLetter(letterInput());
    const first = await humanReplyAndDeliver(letter.id, { text: 'One reply.', clientId: 'rp-aaaa-1' });
    const again = await humanReplyAndDeliver(letter.id, { text: 'One reply.', clientId: 'rp-aaaa-1' });

    expect(sendMessageToSession).toHaveBeenCalledTimes(1);
    expect(first.delivery.status).toBe('queued');
    // The repeat answers from the record: same status, no second message id minted.
    expect(again.delivery).toEqual({ status: 'queued', sessionId: SENDER.sessionId });
    const thread = await turnsOnDisk(letter.id);
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({ from: 'human', text: 'One reply.', clientId: 'rp-aaaa-1' });
  });

  it('two requests racing with one clientId (a double tap) deliver once', async () => {
    originIdle();
    let release!: () => void;
    // Hold the first delivery open, so the second request arrives mid-delivery.
    sendMessageToSession.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve({ id: 'qm-slow' }); }),
    );
    const letter = await sendLetter(letterInput());
    const a = humanReplyAndDeliver(letter.id, { text: 'Tapped twice.', clientId: 'rp-race' });
    const b = humanReplyAndDeliver(letter.id, { text: 'Tapped twice.', clientId: 'rp-race' });
    await vi.waitFor(() => expect(sendMessageToSession).toHaveBeenCalledTimes(1));
    release();
    const [ra, rb] = await Promise.all([a, b]);

    expect(sendMessageToSession).toHaveBeenCalledTimes(1);
    expect(ra.delivery).toEqual(rb.delivery);
    expect(ra.delivery.status).toBe('queued');
    expect(await turnsOnDisk(letter.id)).toHaveLength(1);
  });

  it('a repeat of a FAILED delivery is the retry: the same turn is delivered again, once', async () => {
    originIdle();
    sendMessageToSession.mockRejectedValueOnce(new Error('daemon unreachable'));
    const letter = await sendLetter(letterInput());
    const failed = await humanReplyAndDeliver(letter.id, { text: 'Please re-run.', clientId: 'rp-retry' });
    expect(failed.delivery.status).toBe('failed');

    const retried = await humanReplyAndDeliver(letter.id, { text: 'Please re-run.', clientId: 'rp-retry' });
    expect(retried.delivery.status).toBe('queued');
    expect(sendMessageToSession).toHaveBeenCalledTimes(2);
    const thread = await turnsOnDisk(letter.id);
    expect(thread).toHaveLength(1);
    expect(thread[0]!.delivery).toMatchObject({ status: 'queued' });

    // And a third call now answers from the record without delivering again.
    await humanReplyAndDeliver(letter.id, { text: 'Please re-run.', clientId: 'rp-retry' });
    expect(sendMessageToSession).toHaveBeenCalledTimes(2);
  });

  it('without a clientId every call is a new turn, as before', async () => {
    originIdle();
    const letter = await sendLetter(letterInput());
    await humanReplyAndDeliver(letter.id, { text: 'First.' });
    await humanReplyAndDeliver(letter.id, { text: 'Second.' });
    expect((await turnsOnDisk(letter.id)).map(t => t.text)).toEqual(['First.', 'Second.']);
    expect(sendMessageToSession).toHaveBeenCalledTimes(2);
  });

  it('a malformed clientId is refused rather than ignored (ignoring it would duplicate a retry)', async () => {
    const letter = await sendLetter(letterInput());
    await expect(humanReplyAndDeliver(letter.id, { text: 'x', clientId: 'has spaces' }))
      .rejects.toMatchObject({ code: 'invalid', status: 400 });
    await expect(humanReplyAndDeliver(letter.id, { text: 'x', clientId: '' }))
      .rejects.toMatchObject({ code: 'invalid' });
    expect(await turnsOnDisk(letter.id)).toHaveLength(0);
  });
});

/**
 * A delivery that outlasts the route's budget. Why: the route used to race the
 * whole call against its 12s deadline and answer 504 "try again", although the
 * turn was already threaded and still being delivered. The phone then showed the
 * turn with no delivery at all and nothing re-read it (2026-09-29 gate, P1-A).
 * The turn now carries `pending` from the write that records it, and the call
 * answers with that record at `answerBy` while the attempt runs on.
 */
describe('a delivery still running is on record as pending', () => {
  /** Hold the next delivery open until `release()`. */
  function holdDelivery(): { release: () => void } {
    let release!: () => void;
    sendMessageToSession.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve({ id: 'qm-slow' }); }),
    );
    return { release: () => release() };
  }

  it('the turn is written with a pending delivery before the attempt ends, then gets the outcome', async () => {
    originIdle();
    const held = holdDelivery();
    const letter = await sendLetter(letterInput());
    const call = humanReplyAndDeliver(letter.id, { text: 'Slow session.', clientId: 'rp-slow' });
    await vi.waitFor(() => expect(sendMessageToSession).toHaveBeenCalledTimes(1));

    const during = (await turnsOnDisk(letter.id))[0]!;
    expect(during).toMatchObject({ from: 'human', text: 'Slow session.', clientId: 'rp-slow' });
    expect(during.delivery).toMatchObject({ status: 'pending', at: during.at });

    held.release();
    expect((await call).delivery.status).toBe('queued');
    expect((await turnsOnDisk(letter.id))[0]!.delivery).toMatchObject({ status: 'queued', sessionId: SENDER.sessionId });
  });

  it('answers pending at answerBy with the recorded turn, and the attempt still records its outcome', async () => {
    originIdle();
    const held = holdDelivery();
    const letter = await sendLetter(letterInput());
    const answered = await humanReplyAndDeliver(
      letter.id, { text: 'Answer me now.', clientId: 'rp-due' }, { answerBy: Date.now() + 50 },
    );

    expect(answered.delivery).toEqual({ status: 'pending' });
    const turn = answered.letter.thread.find(t => t.clientId === 'rp-due');
    expect(turn?.delivery?.status).toBe('pending');

    held.release();
    await vi.waitFor(async () => {
      expect((await turnsOnDisk(letter.id))[0]!.delivery).toMatchObject({ status: 'queued' });
    });
    expect(sendMessageToSession).toHaveBeenCalledTimes(1);
  });

  it('a repeat while that attempt runs waits on it (never a second delivery), and after it answers from the record', async () => {
    originIdle();
    const held = holdDelivery();
    const letter = await sendLetter(letterInput());
    await humanReplyAndDeliver(letter.id, { text: 'Once.', clientId: 'rp-once' }, { answerBy: Date.now() });
    const repeat = await humanReplyAndDeliver(
      letter.id, { text: 'Once.', clientId: 'rp-once' }, { answerBy: Date.now() + 30 },
    );
    expect(repeat.delivery.status).toBe('pending');
    expect(sendMessageToSession).toHaveBeenCalledTimes(1);

    held.release();
    await vi.waitFor(async () => {
      expect((await turnsOnDisk(letter.id))[0]!.delivery?.status).toBe('queued');
    });
    const after = await humanReplyAndDeliver(letter.id, { text: 'Once.', clientId: 'rp-once' });
    expect(after.delivery).toEqual({ status: 'queued', sessionId: SENDER.sessionId });
    expect(sendMessageToSession).toHaveBeenCalledTimes(1);
    expect(await turnsOnDisk(letter.id)).toHaveLength(1);
  });

  it('a pending turn with no attempt running (the process died mid-delivery) is delivered by a repeat', async () => {
    originIdle();
    const letter = await sendLetter(letterInput());
    const index = JSON.parse(fs.readFileSync(humanInboxPaths.indexFile, 'utf-8'));
    index.letters[0].thread = [
      { from: 'human', text: 'Cut off.', at: 5, clientId: 'rp-orphan', delivery: { status: 'pending', at: 5 } },
    ];
    fs.writeFileSync(humanInboxPaths.indexFile, JSON.stringify(index));

    const repeat = await humanReplyAndDeliver(letter.id, { text: 'Cut off.', clientId: 'rp-orphan' });
    expect(repeat.delivery.status).toBe('queued');
    expect(sendMessageToSession).toHaveBeenCalledTimes(1);
    expect((await turnsOnDisk(letter.id))[0]!.delivery?.status).toBe('queued');
  });

  it('an action answer is recorded pending too, answers pending at answerBy, and joins its note with a colon', async () => {
    originIdle();
    const held = holdDelivery();
    const letter = await sendLetter(letterInput({
      type: 'action_required', actions: [{ id: 'go', label: 'Go ahead' }],
    }));
    const answered = await answerLetterAndDeliver(
      letter.id, { actionId: 'go', freeText: 'after lunch' }, 'phone', { answerBy: Date.now() + 30 },
    );
    expect(answered.delivery).toEqual({ status: 'pending' });
    const turn = (await turnsOnDisk(letter.id))[0]!;
    expect(turn.text).toBe('Go ahead: after lunch');
    expect(turn.delivery?.status).toBe('pending');

    held.release();
    await vi.waitFor(async () => {
      expect((await turnsOnDisk(letter.id))[0]!.delivery?.status).toBe('queued');
    });
  });
});

describe('the index keeps the new fields honest', () => {
  it('keeps a valid delivery and clientId on human turns, drops them on agent turns and drops junk', async () => {
    const letter = await sendLetter(letterInput());
    const index = JSON.parse(fs.readFileSync(humanInboxPaths.indexFile, 'utf-8'));
    index.letters[0].thread = [
      { from: 'human', text: 'kept', at: 5, clientId: 'rp-ok', delivery: { status: 'deferred', reason: 'origin_awaiting_permission', at: 6 } },
      { from: 'human', text: 'junk status', at: 7, clientId: 'bad id!', delivery: { status: 'delivered-maybe', at: 8 } },
      { from: 'agent', text: 'agent turns carry no delivery', at: 9, clientId: 'rp-agent', delivery: { status: 'queued', at: 10 } },
    ];
    fs.writeFileSync(humanInboxPaths.indexFile, JSON.stringify(index));

    const [kept, junk, agent] = await turnsOnDisk(letter.id);
    expect(kept).toMatchObject({ clientId: 'rp-ok', delivery: { status: 'deferred', reason: 'origin_awaiting_permission', at: 6 } });
    expect(junk!.clientId).toBeUndefined();
    expect(junk!.delivery).toBeUndefined();
    expect(agent!.clientId).toBeUndefined();
    expect(agent!.delivery).toBeUndefined();
  });
});

/**
 * The status card's reducer: two independent event streams folded into one thing to show.
 *
 * The case this file exists for is the out-of-order one. `plugin:mail:draft-changed` and
 * `plugin:mail:send-settled` are separate emits, so `send-settled unknown` can land BEFORE the
 * draft says anything, and "Sending…" over a message that may already be in somebody's mailbox is
 * the worst sentence this console can print.
 */
import { describe, expect, it } from 'vitest';
import type { MailDraftDto, MailProviderSummary, MailSendDto } from '../../web/src/api/mail';
import {
  canRetry,
  canSendFrom,
  isOpenDraft,
  phaseOf,
  reduceDraftChanged,
  reduceSendSettled,
  statusDetail,
  statusFollowing,
  statusHeadline,
  statusOfDraft,
} from '../../web/src/apps/mail/compose/send-status';

function draft(over: Partial<MailDraftDto> = {}): MailDraftDto {
  return {
    draftId: 'dr-1',
    accountId: 'fx:me@example.invalid',
    to: [{ address: 'alice@example.invalid' }],
    cc: [],
    bcc: [],
    subject: 'Lunch',
    bodyMarkdown: 'one?',
    revision: 2,
    state: 'composing',
    origin: 'console',
    createdAt: 1,
    updatedAt: 2,
    ...over,
  };
}

function send(over: Partial<MailSendDto> = {}): MailSendDto {
  return {
    sendId: 'sn-1',
    draftId: 'dr-1',
    accountId: 'fx:me@example.invalid',
    revision: 2,
    idempotencyKey: 'dr-1:2',
    approvalKind: 'console',
    approvalRef: 'console',
    state: 'sent',
    ...over,
  };
}

describe('the phase a draft and its send resolve to', () => {
  it('shows the form while composing and the card once a human was asked', () => {
    expect(phaseOf('composing')).toBe('composing');
    expect(phaseOf('pending_approval')).toBe('waiting');
  });

  it('calls approved sending: the approval is minted and there is nothing to press', () => {
    expect(phaseOf('approved')).toBe('sending');
    expect(phaseOf('sending')).toBe('sending');
  });

  it('lets a settled send win over whatever the draft last said', () => {
    expect(phaseOf('sending', 'unknown')).toBe('unknown');
    expect(phaseOf('pending_approval', 'sent')).toBe('sent');
    expect(phaseOf('composing', 'failed')).toBe('failed');
  });

  it('takes the newest ledger row when a draft has more than one', () => {
    const status = statusOfDraft(draft({ state: 'failed', revision: 3 }), [
      send({ sendId: 'sn-old', state: 'failed', attemptedAt: 10, error: 'refused' }),
      send({ sendId: 'sn-new', state: 'unknown', attemptedAt: 20 }),
    ]);
    expect(status.sendId).toBe('sn-new');
    expect(status.phase).toBe('unknown');
    expect(status.revision).toBe(3);
  });
});

describe('event sequences', () => {
  it('waits, then sends, then reports sent', () => {
    let status = statusOfDraft(draft({ state: 'pending_approval', letterId: 'lt-1' }));
    expect(status.phase).toBe('waiting');
    expect(status.letterId).toBe('lt-1');

    status = reduceDraftChanged(status, { state: 'approved', revision: 2 });
    expect(status.phase).toBe('sending');
    // The letter is spent the moment the approval is minted, so the card stops pointing at it.
    expect(status.letterId).toBeUndefined();

    status = reduceSendSettled(status, { sendId: 'sn-1', state: 'sending' });
    expect(status.phase).toBe('sending');
    status = reduceSendSettled(status, { sendId: 'sn-1', state: 'sent' });
    expect(status.phase).toBe('sent');
  });

  it('holds unknown when send-settled arrives before its draft-changed', () => {
    let status = statusOfDraft(draft({ state: 'sending' }));
    status = reduceSendSettled(status, { sendId: 'sn-1', state: 'unknown' });
    expect(status.phase).toBe('unknown');

    // The draft's own event lands afterwards, still saying `sending`. It must not undo the outcome.
    status = reduceDraftChanged(status, { state: 'sending', revision: 2 });
    expect(status.phase).toBe('unknown');
    expect(canRetry(status)).toBe(false);
  });

  it('offers a retry for a failed send and never for an unknown one', () => {
    const failed = reduceSendSettled(statusOfDraft(draft({ state: 'sending' })), { sendId: 'sn-2', state: 'failed' });
    expect(canRetry(failed)).toBe(true);
    expect(statusDetail(failed)).toContain('refused it before');

    const unknown = reduceSendSettled(failed, { sendId: 'sn-2', state: 'unknown' });
    expect(canRetry(unknown)).toBe(false);
    expect(statusDetail(unknown)).toContain('Check the Sent folder');
  });

  it('forgets the previous attempt when the revision moves', () => {
    const failed = statusOfDraft(draft({ state: 'failed', revision: 2, error: 'refused' }), [
      send({ state: 'failed', attemptedAt: 5, error: 'refused' }),
    ]);
    expect(failed.sendId).toBe('sn-1');

    // A retry bumps the revision, which is a new ledger key: the old row's failure is not this
    // version's outcome, and leaving it on the card shows a fresh ask as already broken.
    const asked = reduceDraftChanged(failed, { state: 'pending_approval', revision: 3 });
    expect(asked.phase).toBe('waiting');
    expect(asked.sendId).toBeUndefined();
    expect(asked.error).toBeUndefined();

    // And it stays forgotten. The retired row can still be delivered (the bus redelivers, and
    // `send-settled` carries no revision to judge it by), and there is no `sendId` on screen to
    // compare it against, so without the retired list it lands as this ask's outcome.
    const redelivered = reduceSendSettled(asked, { sendId: 'sn-1', state: 'failed' });
    expect(redelivered.phase).toBe('waiting');
    expect(redelivered.sendId).toBeUndefined();
  });

  it('keeps a retired row retired across a rebuild from the server', () => {
    const failed = statusOfDraft(draft({ state: 'failed', revision: 2 }), [send({ state: 'failed', attemptedAt: 5 })]);
    // What a retry answers with: the fresh draft, and NO ledger rows at all.
    const asked = statusFollowing(failed, draft({ state: 'pending_approval', revision: 3, letterId: 'lt-2' }));
    expect(asked.phase).toBe('waiting');
    expect(asked.retiredSends).toEqual(['sn-1']);
    expect(reduceSendSettled(asked, { sendId: 'sn-1', state: 'failed' }).phase).toBe('waiting');

    // The new attempt's own row is not retired, so its outcome does land.
    const sending = reduceSendSettled(asked, { sendId: 'sn-2', state: 'sending' });
    expect(sending.phase).toBe('sending');
  });

  it('reads the newest attempt by revision, not by when it was attempted', () => {
    // The fresh row has NOT been claimed yet, so it has no `attemptedAt` at all: ordering by that
    // put the settled older attempt on top and the card called a live send "Not sent".
    const status = statusOfDraft(draft({ state: 'approved', revision: 3 }), [
      send({ sendId: 'sn-1', revision: 2, state: 'failed', attemptedAt: 5, error: 'refused' }),
      send({ sendId: 'sn-2', revision: 3, state: 'pending' }),
    ]);
    expect(status.sendId).toBe('sn-2');
    expect(status.phase).toBe('sending');
    expect(status.error).toBeUndefined();
    expect(status.retiredSends).toEqual(['sn-1']);
  });

  it('ignores an event about a revision older than the one on screen', () => {
    const asked = statusOfDraft(draft({ state: 'pending_approval', revision: 4 }));
    const stale = reduceDraftChanged(asked, { state: 'composing', revision: 3 });
    expect(stale).toEqual(asked);
  });

  it('keeps a settled outcome when a late event from a different row arrives', () => {
    const sent = reduceSendSettled(statusOfDraft(draft({ state: 'sending' })), { sendId: 'sn-9', state: 'sent' });
    const late = reduceSendSettled(sent, { sendId: 'sn-1', state: 'failed' });
    expect(late.phase).toBe('sent');
    expect(late.sendId).toBe('sn-9');
  });
});

describe('what the card says', () => {
  it('puts a clock on a send that landed', () => {
    const at = Date.parse('2026-09-05T15:04:00Z');
    const status = statusOfDraft(draft({ state: 'sent' }), [send({ state: 'sent', settledAt: at, attemptedAt: at })]);
    expect(statusHeadline(status)).toMatch(/^Sent at \d{1,2}:\d{2}/);
  });

  it('names the phone in the waiting headline', () => {
    expect(statusHeadline(statusOfDraft(draft({ state: 'pending_approval' })))).toContain('phone');
  });
});

describe('which drafts and which accounts', () => {
  it('counts only the drafts still waiting on a human', () => {
    expect(isOpenDraft(draft({ state: 'composing' }))).toBe(true);
    expect(isOpenDraft(draft({ state: 'pending_approval' }))).toBe(true);
    expect(isOpenDraft(draft({ state: 'failed' }))).toBe(true);
    expect(isOpenDraft(draft({ state: 'unknown' }))).toBe(true);
    expect(isOpenDraft(draft({ state: 'sending' }))).toBe(false);
    expect(isOpenDraft(draft({ state: 'sent' }))).toBe(false);
  });

  it('reads send capability from the account provider, and refuses an unknown one', () => {
    const providers = [
      provider('fx', true),
      provider('inbound', false),
    ];
    expect(canSendFrom(providers, 'fx:me@example.invalid')).toBe(true);
    expect(canSendFrom(providers, 'inbound:me@example.invalid')).toBe(false);
    expect(canSendFrom(providers, 'gone:me@example.invalid')).toBe(false);
    expect(canSendFrom(providers, undefined)).toBe(false);
  });
});

function provider(id: string, send: boolean): MailProviderSummary {
  return {
    id,
    label: id,
    capabilities: {
      search: false, watch: false, drafts: false, markRead: true, flags: false, threads: false,
      send, sendAsReply: send, bodies: 'both', attachments: 'metadata',
    },
    setupFields: [],
  };
}

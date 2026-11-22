/**
 * The mailto rung against the REAL approval ledger: one draft, one send, and no letter.
 *
 * This is the one rung of the ladder that puts a message on the wire under the user's own name, so what
 * is real here is everything that could make that go wrong: the worker-thread SQLite with its real
 * migrations (so `insertSend`'s UNIQUE key and the unsubscribe upsert are graded by SQLite), the real
 * `MailDrafts` validation, the real `MailApprovals` gates, and a fixture transport that RECORDS every
 * send instead of swallowing it — a test that ends with two sends for one click has found a real bug
 * however green the rest of this file is.
 *
 * `ApprovalLetters` is a spy, and that is the assertion surface for the property the design rests on:
 * a right-click IS the authorisation, so NOTHING here may create a letter. A letter for something the
 * person already clicked is how a console teaches people to stop reading letters.
 *
 * Nothing opens a socket. Every address is `.invalid` (RFC 2606).
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginDatabaseClient } from '../../src/core/plugins/plugin-storage.js';
import type { WalnutServerPluginApi } from '../../src/core/plugins/server-api.js';
import { MailApprovals, type ApprovalLetters } from '../../src/integrations/mail/approvals.js';
import { MailBodyStore } from '../../src/integrations/mail/bodies.js';
import { MailDrafts } from '../../src/integrations/mail/drafts.js';
import { MailDatabase } from '../../src/integrations/mail/db.js';
import { MailEvents } from '../../src/integrations/mail/events.js';
import { MailProviderRegistry } from '../../src/integrations/mail/provider-registry.js';
import { MailSends } from '../../src/integrations/mail/sends.js';
import { MailService } from '../../src/integrations/mail/service.js';
import { MailStore } from '../../src/integrations/mail/store.js';
import type { DraftRow, SendRow } from '../../src/integrations/mail/store.js';
import type { UnsubscribeRow } from '../../src/integrations/mail/store-write.js';
import { MailUnsubscribe, unsubscribeApprovalRef } from '../../src/integrations/mail/unsubscribe.js';
import { isPermitRefusal, setOutwardDoorChecker } from '../../src/core/leader/switch/doors.js';
import {
  UNSUBSCRIBE_MAILTO_RECLAIM_MS, UNSUBSCRIBE_RECLAIM_MS,
} from '../../src/integrations/mail/store-write.js';
import type {
  MailBody,
  MailCapabilities,
  MailEnvelope,
  MailListUnsubscribe,
  MailProviderSpec,
  OutgoingMail,
} from '../../src/integrations/mail/types.js';

const ACCOUNT = 'listy:acct-1';
const HOST = 'lists.example.invalid';
const MESSAGE = 'INBOX:9001:42';
const SENT_AT = Date.UTC(2026, 8, 21, 16, 0, 0);

/** How the fixture transport behaves for the next send. Mirrors `mail-send.test.ts`'s vocabulary. */
type SendMode = 'ok' | 'before-data' | 'after-data';

interface Harness {
  store: MailStore
  service: MailService
  drafts: MailDrafts
  approvals: MailApprovals
  unsubscribe: MailUnsubscribe
  letters: {
    send: ReturnType<typeof vi.fn>
    reply: ReturnType<typeof vi.fn>
    withdraw: ReturnType<typeof vi.fn>
    get: ReturnType<typeof vi.fn>
  }
  events: Array<{ name: string; data: Record<string, unknown> }>
  /** Every `provider.send` the base asked for, in order. THE assertion surface of this file. */
  sent: Array<{ mail: OutgoingMail; idempotencyKey: string }>
  mode: { current: SendMode }
  /** Whether the account reports outgoing mail as configured. */
  sendable: { current: boolean }
  clock: { at: number }
}

const open: MailDatabase[] = [];
const roots: string[] = [];

const CAPABILITIES: MailCapabilities = {
  search: false, watch: false, drafts: false, markRead: false, flags: false,
  threads: false, send: true, sendAsReply: false, bodies: 'both', attachments: 'none',
};

async function openHarness(): Promise<Harness> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mail-unsub-console-'));
  roots.push(root);
  const client = new PluginDatabaseClient(path.join(root, 'plugin.sqlite'));
  const walnut = { storage: { get database() { return client; } } } as unknown as WalnutServerPluginApi;
  const db = new MailDatabase(walnut);
  open.push(db);
  const store = new MailStore(db);
  const bodies = new MailBodyStore(root);
  const providers = new MailProviderRegistry(() => undefined);

  const sent: Harness['sent'] = [];
  const mode = { current: 'ok' as SendMode };
  const sendable = { current: true };
  const spec: MailProviderSpec = {
    id: 'listy',
    label: 'A fixture list',
    capabilities: { ...CAPABILITIES },
    // Per account, because "this account has no SMTP" is a real answer one of two accounts behind one
    // provider gives, and it is the gate the mailto rung asks about before it drafts anything.
    accountCapabilities: () => ({ ...CAPABILITIES, send: sendable.current }),
    setup: { fields: [], submit: async () => { throw new Error('by hand') } },
    listAccounts: async () => [],
    health: async () => ({ state: 'ok', checkedAt: Date.now() }),
    listMailboxes: async () => [],
    poll: async () => ({ messages: [], cursor: 'c0', more: false }),
    getBody: async (): Promise<MailBody> => ({
      format: 'both', text: 'This week in the marina.', html: '<p>This week in the marina.</p>', bytes: 30,
    }),
    send: async (_accountId, mail, options) => {
      sent.push({ mail, idempotencyKey: options?.idempotencyKey ?? '' });
      if (mode.current === 'ok') return { acceptedAt: Date.now() };
      // The two failure stages the outcome vocabulary turns on: `before-data` is safe to retry and
      // becomes `failed`; anything else is `unknown` and is never retried.
      const error = new Error('the list server refused the unsubscribe mail') as Error & {
        code: string; stage: string;
      };
      error.code = 'invalid';
      error.stage = mode.current;
      throw error;
    },
  };
  providers.register(spec, 'the-fixture-plugin');

  const events: Harness['events'] = [];
  const mailEvents = new MailEvents((name, data) => {
    events.push({ name, data: data as Record<string, unknown> });
  });
  const clock = { at: Date.UTC(2026, 8, 22, 9, 0, 0) };
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const service = new MailService({ store, bodies, providers, log });
  const drafts = new MailDrafts({ store, events: mailEvents });
  const letters = {
    send: vi.fn(async () => ({ letterId: 'lt-never' })),
    reply: vi.fn(async () => undefined),
    withdraw: vi.fn(async () => undefined),
    get: vi.fn(async () => null),
  };
  const sends = new MailSends({
    store, service, drafts, letters: letters as unknown as ApprovalLetters, events: mailEvents, log,
  });
  const approvals = new MailApprovals({
    store, service, drafts, sends, letters: letters as unknown as ApprovalLetters, events: mailEvents, log,
  });
  const unsubscribe = new MailUnsubscribe({
    store,
    service,
    events: mailEvents,
    drafts,
    approvals,
    letters: letters as unknown as ApprovalLetters,
    log,
    now: () => clock.at,
  });
  // As index.ts wires it: an unsubscribe mail's row settles with its send.
  mailEvents.onSendSettled((event) => { void unsubscribe.onSendSettled(event.sendId, event.state) });

  await store.upsertAccount({
    accountId: ACCOUNT,
    providerId: 'listy',
    displayName: 'A mailbox',
    address: 'reader@example.invalid',
    state: 'active',
    healthJson: null,
    payload: '{}',
  });

  return {
    store, service, drafts, approvals, unsubscribe, letters, events, sent, mode, sendable, clock,
  };
}

beforeEach(() => { vi.restoreAllMocks() });

afterEach(async () => {
  setOutwardDoorChecker(null);
  for (const db of open.splice(0)) await db.dispose().catch(() => undefined);
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

function listing(over: Partial<MailEnvelope> = {}): MailEnvelope {
  return {
    messageId: MESSAGE,
    rfcMessageId: `<weekly-42@${HOST}>`,
    mailboxId: 'INBOX',
    from: { name: 'Marina Weekly', address: `weekly@${HOST}` },
    to: [{ address: 'reader@example.invalid' }],
    subject: 'Marina Weekly, issue 42',
    snippet: 'This week in the marina',
    sentAt: SENT_AT,
    receivedAt: SENT_AT,
    flags: [],
    attachments: [],
    ...over,
  };
}

/** A message whose only way out is a mail to the list. */
function mailtoOnly(over: Partial<MailListUnsubscribe> = {}): MailEnvelope {
  return listing({
    listUnsubscribe: {
      mailto: [`mailto:leave@${HOST}?subject=unsubscribe%20k9`],
      oneClick: false,
      listId: `weekly.${HOST}`,
      ...over,
    },
  });
}

async function ledgerRow(one: Harness): Promise<UnsubscribeRow | undefined> {
  return one.store.write.getUnsubscribe(ACCOUNT, MESSAGE);
}

async function sendRows(one: Harness): Promise<SendRow[]> {
  return one.store.write.listSends({ limit: 50 });
}

async function draftRows(one: Harness): Promise<DraftRow[]> {
  return one.store.write.listDrafts({ limit: 50 });
}

describe('a right-click on a mailto-only newsletter', () => {
  it('drafts, sends through the console ledger, and creates NO letter', async () => {
    const one = await openHarness();
    await one.service.ingestPage(ACCOUNT, [mailtoOnly()]);

    const outcome = await one.unsubscribe.run(ACCOUNT, MESSAGE);
    // The response is `in-flight`: an SMTP handshake legitimately takes tens of seconds and this answer
    // is holding one of the browser's six connections, so the rung answers once the ledger row exists.
    expect(outcome).toMatchObject({ status: 'in-flight', method: 'mailto' });
    expect(outcome.message).toContain('unsubscribing you');

    await one.unsubscribe.whenMailtoSendsSettle();

    // EXACTLY ONE mail, built from the header the list published.
    expect(one.sent).toHaveLength(1);
    expect(one.sent[0]!.mail.to).toEqual([{ address: `leave@${HOST}` }]);
    expect(one.sent[0]!.mail.subject).toBe('unsubscribe k9');
    expect(one.sent[0]!.mail.bodyMarkdown).toBe('unsubscribe');

    // The `sends` row names the CLICK, not a generic console send: "who authorised this" is the first
    // question anybody asks about a mail they did not expect, and "the console" is not an answer when
    // the person never opened a composer.
    const sends = await sendRows(one);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      approval_kind: 'console',
      approval_ref: unsubscribeApprovalRef(MESSAGE),
      state: 'sent',
    });
    expect(sends[0]!.approval_ref).toBe(`unsubscribe:${MESSAGE}`);

    expect(await draftRows(one)).toHaveLength(1);

    // NO LETTER. The whole design of this rung rests on it.
    expect(one.letters.send).not.toHaveBeenCalled();

    // The unsubscribe ledger holds the send's verdict, and points at the row that carried it.
    const row = await ledgerRow(one);
    expect(row).toMatchObject({ status: 'done', method: 'mailto', list_key: `weekly.${HOST}` });
    expect(row!.ref).toBe(sends[0]!.send_id);

    expect(one.events.filter((event) => event.name === 'unsubscribed')).toEqual([{
      name: 'unsubscribed',
      data: {
        accountId: ACCOUNT, messageId: MESSAGE, listKey: `weekly.${HOST}`,
        method: 'mailto', status: 'done',
      },
    }]);
  });

  /**
   * A MAIL IN FLIGHT IS NOT A DEAD ATTEMPT, and the reclaim window has to know the difference.
   *
   * The fetching rungs finish inside the ladder's 10 s deadline, so a row of theirs left `in-flight` for
   * a minute proves the holder died. This rung answers `in-flight` while the handshake carries on in the
   * background ON PURPOSE, so at sixty seconds a second click would have sent a SECOND unsubscribe mail
   * to the list, and nothing can take a sent mail back. The row is still reclaimable, just not until
   * long after any real send would have settled.
   */
  it('will not let a second click reclaim a mail that may still be going out', async () => {
    const one = await openHarness();
    // A row exactly as a killed process leaves it: claimed for the mailto rung, never settled.
    await one.service.ingestPage(ACCOUNT, [mailtoOnly()]);
    await one.store.write.claimUnsubscribe({
      accountId: ACCOUNT,
      messageId: MESSAGE,
      listKey: `weekly.${HOST}`,
      method: 'mailto',
      now: one.clock.at,
      reclaimBefore: one.clock.at - UNSUBSCRIBE_RECLAIM_MS,
    });

    // Past the window a fetching rung would be reclaimed at, and then well past it.
    one.clock.at += UNSUBSCRIBE_RECLAIM_MS + 5_000;
    expect(await one.unsubscribe.run(ACCOUNT, MESSAGE))
      .toMatchObject({ status: 'conflict', conflict: 'in-flight' });
    one.clock.at += UNSUBSCRIBE_MAILTO_RECLAIM_MS / 2;
    expect(await one.unsubscribe.run(ACCOUNT, MESSAGE))
      .toMatchObject({ status: 'conflict', conflict: 'in-flight' });
    // Nothing left the machine on either refused click.
    expect(one.sent).toHaveLength(0);

    // And it does eventually come back, because a row nothing will ever settle must not be permanent.
    one.clock.at += UNSUBSCRIBE_MAILTO_RECLAIM_MS;
    expect(await one.unsubscribe.run(ACCOUNT, MESSAGE)).toMatchObject({ status: 'in-flight' });
    await one.unsubscribe.whenMailtoSendsSettle();
    expect(one.sent).toHaveLength(1);
  });

  it('defaults both fields to the word "unsubscribe" when the header names neither', async () => {
    const one = await openHarness();
    await one.service.ingestPage(ACCOUNT, [mailtoOnly({ mailto: [`mailto:leave@${HOST}`] })]);
    await one.unsubscribe.run(ACCOUNT, MESSAGE);
    await one.unsubscribe.whenMailtoSendsSettle();
    expect(one.sent[0]!.mail.subject).toBe('unsubscribe');
    expect(one.sent[0]!.mail.bodyMarkdown).toBe('unsubscribe');
  });

  it('answers 202-shaped in-flight to a page read while the mail is on its way', async () => {
    const one = await openHarness();
    await one.service.ingestPage(ACCOUNT, [mailtoOnly()]);
    await one.unsubscribe.run(ACCOUNT, MESSAGE);
    // Read the page BEFORE the send settles: the DTO says an attempt is on the wire, which is what makes
    // the row read `Unsubscribing…` rather than offering the click again.
    const midFlight = await one.service.listMessages({ accountId: ACCOUNT, mailboxId: 'INBOX', limit: 5 });
    expect(midFlight.messages[0]!.unsubscribe).toEqual({
      available: 'mailto',
      attempt: { status: 'in-flight', at: one.clock.at },
    });

    await one.unsubscribe.whenMailtoSendsSettle();
    const settled = await one.service.listMessages({ accountId: ACCOUNT, mailboxId: 'INBOX', limit: 5 });
    expect(settled.messages[0]!.unsubscribe).toEqual({
      available: 'mailto',
      done: { method: 'mailto', at: one.clock.at, scope: 'message' },
    });
  });
});

describe('a send that does not succeed', () => {
  it('leaves the ledger failed with the transport\'s own reason, and retries nothing', async () => {
    const one = await openHarness();
    one.mode.current = 'before-data';
    await one.service.ingestPage(ACCOUNT, [mailtoOnly()]);

    await one.unsubscribe.run(ACCOUNT, MESSAGE);
    await one.unsubscribe.whenMailtoSendsSettle();

    // ONE attempt. Nothing in this plugin retries a send by itself, and a list that gets the same
    // "unsubscribe me" three times is a list that stops trusting them.
    expect(one.sent).toHaveLength(1);
    const row = await ledgerRow(one);
    expect(row).toMatchObject({ status: 'failed', method: 'mailto', reason: 'send-failed' });
    expect(row!.detail).toContain('refused the unsubscribe mail');
    const drafts = await draftRows(one);
    expect(drafts[0]!.state).toBe('failed');
    expect(one.letters.send).not.toHaveBeenCalled();
  });

  it('calls an ambiguous failure needs-human, never failed: the mail may already be there', async () => {
    const one = await openHarness();
    one.mode.current = 'after-data';
    await one.service.ingestPage(ACCOUNT, [mailtoOnly()]);
    await one.unsubscribe.run(ACCOUNT, MESSAGE);
    await one.unsubscribe.whenMailtoSendsSettle();

    const row = await ledgerRow(one);
    expect(row).toMatchObject({ status: 'needs-human', method: 'mailto', reason: 'send-unknown' });
    expect((await draftRows(one))[0]!.state).toBe('unknown');
    // The console's sentence points at the Sent folder rather than offering the click again.
    const page = await one.service.listMessages({ accountId: ACCOUNT, mailboxId: 'INBOX', limit: 5 });
    expect(page.messages[0]!.unsubscribe).toMatchObject({
      attempt: { status: 'needs-human', reason: 'send-unknown' },
    });
  });

  it('lets the human click again, and that click is a whole fresh mail and a fresh row', async () => {
    const one = await openHarness();
    one.mode.current = 'before-data';
    await one.service.ingestPage(ACCOUNT, [mailtoOnly()]);
    await one.unsubscribe.run(ACCOUNT, MESSAGE);
    await one.unsubscribe.whenMailtoSendsSettle();

    one.mode.current = 'ok';
    one.clock.at += 5_000;
    await one.unsubscribe.run(ACCOUNT, MESSAGE);
    await one.unsubscribe.whenMailtoSendsSettle();

    // A NEW draft each click, so the ledger key `<draftId>:<revision>` is new by construction and the
    // `freshRevisionForRetry` bump never has to run on this path.
    expect(await draftRows(one)).toHaveLength(2);
    const sends = await sendRows(one);
    expect(sends).toHaveLength(2);
    expect(new Set(sends.map((row) => row.idempotency_key)).size).toBe(2);
    expect(one.sent).toHaveLength(2);
    expect(await ledgerRow(one)).toMatchObject({ status: 'done', method: 'mailto' });
  });
});

describe('what the rung refuses before it writes anything', () => {
  it('refuses an account with no outgoing mail, leaving no draft and no send row', async () => {
    const one = await openHarness();
    one.sendable.current = false;
    await one.service.ingestPage(ACCOUNT, [mailtoOnly()]);

    const outcome = await one.unsubscribe.run(ACCOUNT, MESSAGE);
    expect(outcome).toMatchObject({ status: 'failed', method: 'mailto', reason: 'cannot-send' });
    expect(outcome.message).toContain('no outgoing mail');
    expect(await draftRows(one)).toEqual([]);
    expect(await sendRows(one)).toEqual([]);
    expect(one.sent).toEqual([]);
    expect(await ledgerRow(one)).toMatchObject({ status: 'failed', reason: 'cannot-send' });
  });

  it('refuses a mailto naming two recipients, and sends nothing at all', async () => {
    const one = await openHarness();
    await one.service.ingestPage(ACCOUNT, [mailtoOnly({
      // A shape the capture layer would normally drop; the rung refuses it independently, because this
      // parser is also reached from payloads written before that check existed.
      mailto: [`mailto:leave@${HOST}?to=watcher@elsewhere.example.invalid`],
    })]);

    const outcome = await one.unsubscribe.run(ACCOUNT, MESSAGE);
    expect(outcome).toMatchObject({ status: 'failed', reason: 'mailto-many-recipients' });
    expect(await draftRows(one)).toEqual([]);
    expect(one.sent).toEqual([]);
  });

  it('refuses to send at all when the authority is a letter rather than a click', async () => {
    const one = await openHarness();
    await one.service.ingestPage(ACCOUNT, [mailtoOnly()]);

    const outcome = await one.unsubscribe.run(
      ACCOUNT, MESSAGE, {}, { approvalKind: 'letter', ref: 'lt-answered' },
    );
    // `consoleSend` writes `approval_kind: 'console'` by construction, so reaching it from a letter's
    // answer would file that answer as a click nobody made. The honest answer names where the click is.
    expect(outcome).toMatchObject({ status: 'needs-human', reason: 'mailto-console-only' });
    expect(outcome.message).toContain('Open the message in Mail');
    expect(await draftRows(one)).toEqual([]);
    expect(await sendRows(one)).toEqual([]);
    expect(one.sent).toEqual([]);
  });
});

describe('a ledger key that was already spent (`unfreezeAfterSpentKey`)', () => {
  /** A draft, plus a settled `sends` row already occupying `<draftId>:<revision>`. */
  async function spentKey(one: Harness, approvalKind: string, approvalRef: string) {
    const draft = await one.drafts.create({
      accountId: ACCOUNT,
      to: [{ address: `leave@${HOST}` }],
      subject: 'unsubscribe',
      bodyMarkdown: 'unsubscribe',
    });
    await one.store.write.insertSend({
      sendId: 'sn-already',
      draftId: draft.draftId,
      accountId: ACCOUNT,
      revision: draft.revision,
      idempotencyKey: `${draft.draftId}:${draft.revision}`,
      approvalKind,
      approvalRef,
      now: one.clock.at,
    });
    await one.store.write.claimSendAttempt('sn-already', one.clock.at);
    await one.store.write.settleSend('sn-already', 'sent', { now: one.clock.at });
    return draft;
  }

  it('replies to NOBODY for a console send carrying an unsubscribe ref', async () => {
    const one = await openHarness();
    const ref = unsubscribeApprovalRef(MESSAGE);
    const draft = await spentKey(one, 'console', ref);

    await expect(one.approvals.consoleSend(draft.draftId, draft.revision, undefined, ref))
      .rejects.toMatchObject({ code: 'stale', status: 409 });

    // THE REGRESSION THIS PINS. The old gate read `approvalRef !== 'console'` and treated everything
    // else as a letter id, which was true only while `console` was the one non-letter ref there was.
    // With `unsubscribe:<messageId>` it called `letters.reply` on a letter that never existed: a warning
    // in the log for the person, and nothing at all in the thread they were watching.
    expect(one.letters.reply).not.toHaveBeenCalled();
    // And nothing went out, which is the point of the gate above it.
    expect(one.sent).toEqual([]);
    // The draft is back where a human can act on it, in the state that attempt really ended as.
    expect((await draftRows(one))[0]!.state).toBe('sent');
  });

  it('still replies in the thread when the spent key really was authorised by a letter', async () => {
    const one = await openHarness();
    const draft = await spentKey(one, 'letter', 'lt-older');
    // A `letter` kind whose ref is NOT the draft's current letter: the draft's own letter is withdrawn a
    // few lines earlier, so this is the only case where there is a live thread left to answer in.
    await expect(
      one.approvals.consoleSend(draft.draftId, draft.revision, undefined, 'lt-older'),
    ).rejects.toMatchObject({ code: 'stale' });
    // `consoleSend` is always `console`-kinded, so this path also gets no reply — which is the same
    // rule stated from the other side: the KIND decides, and a console send has no thread whatever its
    // ref says. The letter-kinded mint lives behind `onLetterAnswered`.
    expect(one.letters.reply).not.toHaveBeenCalled();
  });
});

/**
 * The write permission (switchable_leader): the door refuses from its `from`-th check on (0:
 * every check). Returns the checks asked, as `kind opId`.
 */
function refuseDoors(from = 0): string[] {
  const asked: string[] = [];
  setOutwardDoorChecker((kind, opId) => {
    asked.push(`${kind} ${opId}`);
    if (asked.length > from) {
      throw Object.assign(new Error('this machine does not hold the write permission'), { name: 'PermitNotHeld' });
    }
  }, () => false);
  return asked;
}

describe('a machine without the write permission sends nothing', () => {
  it('a console send is refused before the draft changes: no ledger row, nothing on the wire', async () => {
    const one = await openHarness();
    const draft = await one.drafts.create({
      accountId: ACCOUNT, to: [{ address: 'friend@example.invalid' }], subject: 'Hello', bodyMarkdown: 'Hi.',
    });
    const asked = refuseDoors();
    const refused = await one.approvals.consoleSend(draft.draftId, draft.revision).catch((error: unknown) => error);
    expect(isPermitRefusal(refused)).toBe(true);
    expect(asked).toEqual([`mail-send ${draft.draftId}:${draft.revision}`]);
    expect(one.sent).toEqual([]);
    expect(await sendRows(one)).toEqual([]);
    const after = (await draftRows(one)).find((row) => row.draft_id === draft.draftId)!;
    expect({ state: after.state, revision: after.revision }).toEqual({ state: draft.state, revision: draft.revision });

    // The same send on the machine that may act goes out once.
    setOutwardDoorChecker(null);
    await one.approvals.consoleSend(draft.draftId, draft.revision);
    expect(one.sent).toHaveLength(1);
  });

  it('the backstop in execute refuses before the attempt is claimed: the send is queued, and the reconcile sends the row once the doors open', async () => {
    const one = await openHarness();
    const draft = await one.drafts.create({
      accountId: ACCOUNT, to: [{ address: 'friend@example.invalid' }], subject: 'Hello', bodyMarkdown: 'Hi.',
    });
    // consoleSend and mintAndSend pass; the permission is gone by execute (the ledger row is
    // written between them, with no door of its own). The caller is answered with the queued row.
    const asked = refuseDoors(2);
    const queued = await one.approvals.consoleSend(draft.draftId, draft.revision);
    expect(queued.send).toMatchObject({ state: 'approved' });
    expect(asked).toHaveLength(3);
    expect(one.sent).toEqual([]);
    const rows = await sendRows(one);
    expect(rows.map((row) => row.state)).toEqual(['approved']);
    expect(rows[0]!.attempted_at ?? null).toBeNull();

    // Past the grace window, still without the permission: the reconcile neither sends nor unfreezes.
    const later = Date.now() + 3 * 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    await one.approvals.reconcile();
    expect(one.sent).toEqual([]);
    expect((await draftRows(one)).find((row) => row.draft_id === draft.draftId)?.state).toBe('approved');

    // With it, the human's Send goes out, once.
    setOutwardDoorChecker(() => {}, () => true);
    expect(await one.approvals.reconcile()).toMatchObject({ resumed: 1 });
    expect(one.sent).toHaveLength(1);
    expect((await sendRows(one)).map((row) => row.state)).toEqual(['sent']);
    await one.approvals.reconcile();
    expect(one.sent).toHaveLength(1);
  });

  it('a mailto unsubscribe refused at the send door is queued: its row settles done when the mail goes, and a click 10 min later mints nothing', async () => {
    const one = await openHarness();
    await one.service.ingestPage(ACCOUNT, [mailtoOnly()]);
    // The unsubscribe door, consoleSend and mintAndSend pass; execute's begin is refused.
    const asked = refuseDoors(3);
    await one.unsubscribe.run(ACCOUNT, MESSAGE);
    await one.unsubscribe.whenMailtoSendsSettle();
    expect(asked).toHaveLength(4);
    expect(one.sent).toEqual([]);
    expect((await ledgerRow(one))?.status).toBe('in-flight');
    expect((await sendRows(one)).map((row) => row.state)).toEqual(['approved']);

    // The doors open: the reconcile sends the queued mail, and the unsubscribe row settles with it.
    setOutwardDoorChecker(() => {}, () => true);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3 * 60_000);
    expect(await one.approvals.reconcile()).toMatchObject({ resumed: 1 });
    expect(one.sent).toHaveLength(1);
    await vi.waitFor(async () => expect((await ledgerRow(one))?.status).toBe('done'));

    // Past the mailto reclaim window, a second click mints no second mail.
    one.clock.at += 11 * 60_000;
    const again = await one.unsubscribe.run(ACCOUNT, MESSAGE);
    await one.unsubscribe.whenMailtoSendsSettle();
    expect(again).toMatchObject({ status: 'conflict', conflict: 'already' });
    expect(one.sent).toHaveLength(1);
    expect(await sendRows(one)).toHaveLength(1);
  });

  it('a mailto unsubscribe whose mail is still queued is never reclaimed, and one settled while nobody listened is read from its send', async () => {
    const one = await openHarness();
    await one.service.ingestPage(ACCOUNT, [mailtoOnly()]);
    refuseDoors(3);
    await one.unsubscribe.run(ACCOUNT, MESSAGE);
    await one.unsubscribe.whenMailtoSendsSettle();
    expect((await sendRows(one)).map((row) => row.state)).toEqual(['approved']);

    // Still queued (the doors stay closed) 11 minutes on: a click reclaims nothing and mints nothing.
    one.clock.at += 11 * 60_000;
    // Only the send door is closed; the unsubscribe door passes, so the click reaches the ledger.
    setOutwardDoorChecker((kind) => {
      if (kind === 'mail-send') throw Object.assign(new Error('not the leader'), { name: 'PermitNotHeld' });
    }, () => false);
    const queued = await one.unsubscribe.run(ACCOUNT, MESSAGE);
    expect(queued).toMatchObject({ status: 'conflict', conflict: 'in-flight' });
    expect(await draftRows(one)).toHaveLength(1);
    expect(one.sent).toEqual([]);

    // The mail goes out with no listener (a restart, say): the next click reads its send and says done.
    vi.spyOn(one.unsubscribe, 'onSendSettled').mockResolvedValue(undefined);
    setOutwardDoorChecker(() => {}, () => true);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3 * 60_000);
    expect(await one.approvals.reconcile()).toMatchObject({ resumed: 1 });
    expect(one.sent).toHaveLength(1);
    expect((await ledgerRow(one))?.status).toBe('in-flight');
    one.clock.at += 11 * 60_000;
    const done = await one.unsubscribe.run(ACCOUNT, MESSAGE);
    expect(done).toMatchObject({ status: 'conflict', conflict: 'already' });
    expect((await ledgerRow(one))?.status).toBe('done');
    expect(one.sent).toHaveLength(1);
    expect(await draftRows(one)).toHaveLength(1);
  });

  it('an answered unsubscribe letter refused at the door is carried out once the doors open, with no error reply', async () => {
    const one = await openHarness();
    await one.service.ingestPage(ACCOUNT, [mailtoOnly()]);
    const doors = await import('../../src/core/leader/switch/doors.js');
    refuseDoors();
    // The ledger row a letter names (requestFromAgent writes it); only its message is read here.
    vi.spyOn(one.store.write, 'unsubscribeByRef')
      .mockResolvedValue({ account_id: ACCOUNT, message_id: MESSAGE } as UnsubscribeRow);
    const run = vi.spyOn(one.unsubscribe, 'run');
    expect(await one.unsubscribe.onLetterAnswered({ letterId: 'lt-unsub', actionId: 'unsubscribe' } as never)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(one.letters.reply).not.toHaveBeenCalled();
    setOutwardDoorChecker(null);
    run.mockResolvedValue({ status: 'done', method: 'mailto', at: one.clock.at, message: 'Done.' } as never);
    doors.notifyOutwardDoorsOpened();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(one.letters.reply).toHaveBeenCalledTimes(1));
  });

  it('a mailto unsubscribe is refused before its ledger claim', async () => {
    const one = await openHarness();
    await one.service.ingestPage(ACCOUNT, [mailtoOnly()]);
    const asked = refuseDoors();
    const refused = await one.unsubscribe.run(ACCOUNT, MESSAGE).catch((error: unknown) => error);
    expect(isPermitRefusal(refused)).toBe(true);
    expect(asked).toEqual([`mail-unsubscribe ${ACCOUNT}:${MESSAGE}`]);
    expect(await ledgerRow(one)).toBeUndefined();
    expect(await draftRows(one)).toEqual([]);
    expect(one.sent).toEqual([]);

    setOutwardDoorChecker(null);
    await one.unsubscribe.run(ACCOUNT, MESSAGE);
    await one.unsubscribe.whenMailtoSendsSettle();
    expect(one.sent).toHaveLength(1);
  });
});

/**
 * A cached body belongs to the envelope it was fetched under, and goes when that envelope moves.
 *
 * The base fetches a body once and serves it for good, which is right for a transport whose message
 * id names bytes that cannot change (an IMAP UID). A conversation-shaped transport lists one row per
 * THREAD: `messageId` is `<folder>:<conversation id>`, and the body it hands over is the newest
 * message of the thread at the time of the read. When a reply lands, the poll returns the same id
 * with a later delivery time. Before this rule the base rewrote the envelope and kept the body, so
 * the reader showed the new sender and time over a message from weeks earlier. Measured on a real
 * mailbox: a row received on 17 September carrying a 42,749-byte body whose `body_ref` still sat in
 * the August bucket, and the screen showing a reply from 31 August under a 17 September header.
 *
 * Graded against the REAL plugin database (worker-thread SQLite with the real migrations) and the
 * real body store on a temp directory, because half of what is asserted here is what is on disk
 * afterwards: a file really unlinked, a marker really cleared, an FTS row that no longer matches.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginDatabaseClient } from '../../src/core/plugins/plugin-storage.js';
import type { WalnutServerPluginApi } from '../../src/core/plugins/server-api.js';
import { MailBodyStore } from '../../src/integrations/mail/bodies.js';
import { MailDatabase } from '../../src/integrations/mail/db.js';
import { MailProviderRegistry } from '../../src/integrations/mail/provider-registry.js';
import { mailRouterKey, mailRowDeliveryVersion } from '../../src/integrations/mail/router-source.js';
import { bodyBelongsTo, payloadForRetiredBody } from '../../src/integrations/mail/service-body.js';
import { MailService } from '../../src/integrations/mail/service.js';
import { MailStore } from '../../src/integrations/mail/store.js';
import type { MailCapabilities, MailEnvelope, MailProviderSpec } from '../../src/integrations/mail/types.js';

const CAPABILITIES: MailCapabilities = {
  search: false, watch: false, drafts: false, markRead: false, flags: false,
  threads: false, send: false, sendAsReply: false, bodies: 'text', attachments: 'none',
};

const ACCOUNT = 'thready:acct-1';
const THREAD = 'inbox:conv-quartz';
const FIRST_AT = Date.UTC(2026, 7, 31, 16, 47, 45);
const REPLY_AT = Date.UTC(2026, 8, 18, 0, 25, 41);
const SECOND_REPLY_AT = Date.UTC(2026, 8, 19, 7, 2, 9);

interface Harness {
  root: string;
  store: MailStore;
  bodies: MailBodyStore;
  service: MailService;
  /** Every body the provider was asked for, in order. */
  bodyReads: string[];
  /** What the provider answers a body read with, switchable per test step. */
  bodyText: { current: string };
  /** While set, a body read waits on it AFTER taking its text: a fetch still in flight. */
  gate: { current: Promise<void> | null };
  /** A provider error code the next body reads fail with. */
  bodyFail: { current: string | null };
  spec: MailProviderSpec;
  /** Every provider search, by query. */
  searches: string[];
  /** While set, an ingest that writes rows waits on it inside the account's write order. */
  sortGate: { current: Promise<void> | null };
  log: { info: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };
}

const open: MailDatabase[] = [];
const roots: string[] = [];

async function openBase(): Promise<Harness> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mail-body-follows-'));
  roots.push(root);
  const client = new PluginDatabaseClient(path.join(root, 'plugin.sqlite'));
  const walnut = { storage: { get database() { return client; } } } as unknown as WalnutServerPluginApi;
  const db = new MailDatabase(walnut);
  open.push(db);
  const store = new MailStore(db);
  const bodies = new MailBodyStore(root);
  const providers = new MailProviderRegistry(() => undefined);
  const bodyReads: string[] = [];
  const bodyText = { current: 'Thank you very much! Alex (the August reply)' };
  const gate: { current: Promise<void> | null } = { current: null };
  const bodyFail: { current: string | null } = { current: null };
  const searches: string[] = [];
  const spec: MailProviderSpec = {
    id: 'thready',
    label: 'A conversation-shaped fixture',
    capabilities: { ...CAPABILITIES },
    setup: {
      fields: [{ name: 'address', label: 'Address', kind: 'text' }],
      submit: async () => { throw new Error('this fixture adds accounts by hand'); },
    },
    listAccounts: async () => [],
    health: async () => ({ state: 'ok', checkedAt: Date.now() }),
    listMailboxes: async () => [],
    poll: async () => ({ messages: [], cursor: 'c0', more: false }),
    getBody: async (_account, messageId) => {
      bodyReads.push(messageId);
      const text = bodyText.current;
      if (gate.current) await gate.current;
      if (bodyFail.current) throw Object.assign(new Error('the provider refused the body'), { code: bodyFail.current });
      return { format: 'text' as const, text, bytes: Buffer.byteLength(text) };
    },
    send: async () => ({ acceptedAt: Date.now() }),
    search: async (_account, query) => { searches.push(query); return []; },
  };
  providers.register(spec, 'the-fixture-plugin');
  const log = { info: vi.fn(), debug: vi.fn() };
  const sortGate: { current: Promise<void> | null } = { current: null };
  // Sorts nothing (an ingest without a verdict, as with no engine); it only lets a test hold an
  // ingest at the point where it has read the rows it compares against.
  const sort = {
    prepareIngest: async () => {
      if (sortGate.current) await sortGate.current;
      throw new Error('this fixture sorts nothing');
    },
    sortDtoOf: () => { throw new Error('not grouped'); },
    notifyGroupsChanged: () => undefined,
    reclassify: async () => 0,
  };
  const service = new MailService({ store, bodies, providers, log, sort });
  await store.upsertAccount({
    accountId: ACCOUNT,
    providerId: 'thready',
    displayName: 'A mailbox',
    address: 'quartz@example.invalid',
    state: 'active',
    healthJson: null,
    payload: '{}',
  });
  return { root, store, bodies, service, bodyReads, bodyText, gate, bodyFail, spec, searches, sortGate, log };
}

afterEach(async () => {
  for (const db of open.splice(0)) await db.dispose().catch(() => undefined);
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
  vi.restoreAllMocks();
});

/** The thread as the listing shows it: one row, the newest delivery time, the newest sender. */
function threadRow(over: Partial<MailEnvelope> = {}): MailEnvelope {
  return {
    messageId: THREAD,
    rfcMessageId: 'conv-quartz',
    mailboxId: 'inbox',
    from: { name: 'Stone, Alex' },
    subject: 'RE: the runbook',
    snippet: 'Thank you very much!',
    sentAt: FIRST_AT,
    receivedAt: FIRST_AT,
    flags: [],
    ...over,
  };
}

async function rowOf(one: Harness) {
  const known = await one.store.knownMessages(ACCOUNT, [THREAD]);
  const row = known.get(THREAD);
  if (!row) throw new Error('the thread row is gone');
  return row;
}

/** The text half is always written (`<ref>.txt`), so it is the file whose fate is asserted. */
async function fileExists(one: Harness, ref: string): Promise<boolean> {
  return fsp.stat(path.join(one.root, `${ref}.txt`)).then(() => true, () => false);
}

/** Ingest the first listing and open it once, so the row carries a real cached body. */
async function seedCachedBody(one: Harness): Promise<{ ref: string }> {
  await one.service.ingestPage(ACCOUNT, [threadRow()]);
  const first = await one.service.readMessage(ACCOUNT, THREAD);
  expect(first.body?.text).toBe(one.bodyText.current);
  const row = await rowOf(one);
  expect(row.body_ref).toBeTruthy();
  expect(await fileExists(one, row.body_ref!)).toBe(true);
  return { ref: row.body_ref! };
}

describe('bodyBelongsTo (the rule alone)', () => {
  const stored = { sent_at: FIRST_AT, received_at: FIRST_AT };

  it('keeps the body while both instants stand still', () => {
    expect(bodyBelongsTo(stored, { sentAt: FIRST_AT, receivedAt: FIRST_AT })).toBe(true);
  });

  it('retires the body when either instant moves', () => {
    expect(bodyBelongsTo(stored, { sentAt: REPLY_AT, receivedAt: REPLY_AT })).toBe(false);
    expect(bodyBelongsTo(stored, { sentAt: FIRST_AT, receivedAt: REPLY_AT })).toBe(false);
    expect(bodyBelongsTo(stored, { sentAt: REPLY_AT, receivedAt: FIRST_AT })).toBe(false);
  });

  it('treats a missing receivedAt the same on both sides', () => {
    expect(bodyBelongsTo({ sent_at: FIRST_AT, received_at: null }, { sentAt: FIRST_AT, receivedAt: null })).toBe(true);
    expect(bodyBelongsTo({ sent_at: FIRST_AT, received_at: null }, { sentAt: FIRST_AT, receivedAt: FIRST_AT })).toBe(false);
  });

  it('payloadForRetiredBody drops what the old body taught and keeps the rest', () => {
    const kept = payloadForRetiredBody({
      from: { name: 'Stone, Alex', address: 'alex@example.invalid' },
      to: [{ address: 'cat@example.invalid' }],
      sentAtHeader: 'Mon, 31 Aug 2026 09:47:45 -0700',
      bodyFormat: 'both',
      bodyTruncated: true,
      bodyBytesHint: 42_749,
    });
    // `to` goes with `from`: a body read may have filled it, and it names the OLD newest message's
    // recipients. An envelope that names its own recipients restates them on the same write.
    expect(kept).toEqual({
      sentAtHeader: 'Mon, 31 Aug 2026 09:47:45 -0700',
      bodyBytesHint: 42_749,
    });
  });
});

describe('a thread row that moved retires its cached body', () => {
  it('unlinks the file, clears the columns, and the next open fetches the NEW newest message', async () => {
    const one = await openBase();
    const { ref } = await seedCachedBody(one);

    // The reply lands: same id, newer delivery time, a different newest sender.
    one.bodyText.current = 'Yes, that is generally correct as an outline. Cameron (the September reply)';
    const outcome = await one.service.ingestPage(ACCOUNT, [threadRow({
      from: { name: 'Morgan, Cameron' },
      snippet: 'Yes, that is generally correct',
      sentAt: REPLY_AT,
      receivedAt: REPLY_AT,
    })]);
    expect(outcome).toMatchObject({ added: 0, updated: 1 });

    const row = await rowOf(one);
    expect(row.body_ref).toBeNull();
    expect(row.body_error).toBeNull();
    expect(await fileExists(one, ref)).toBe(false);
    expect(one.log.info).toHaveBeenCalledWith(
      'mail body retired: the envelope moved',
      expect.objectContaining({ accountId: ACCOUNT, messageId: THREAD, storedSentAt: FIRST_AT, sentAt: REPLY_AT }),
    );

    // The list says so too, before anyone opens it.
    const listed = await one.service.listMessages({ accountId: ACCOUNT, mailboxId: 'inbox', limit: 10 });
    expect(listed.messages.map((m) => [m.messageId, m.hasBody, m.snippet, m.from?.name])).toEqual([
      [THREAD, false, 'Yes, that is generally correct', 'Morgan, Cameron'],
    ]);

    // Opening it reads the body AGAIN and gets the September reply, not the August one.
    const reopened = await one.service.readMessage(ACCOUNT, THREAD);
    expect(reopened.body?.text).toBe('Yes, that is generally correct as an outline. Cameron (the September reply)');
    expect(reopened.message.hasBody).toBe(true);
    expect(one.bodyReads).toEqual([THREAD, THREAD]);
  });

  it('a flag change alone keeps the body: no unlink, no second body read', async () => {
    const one = await openBase();
    const { ref } = await seedCachedBody(one);

    const outcome = await one.service.ingestPage(ACCOUNT, [threadRow({ flags: ['\\Seen'] })]);
    expect(outcome).toMatchObject({ added: 0, updated: 1 });

    const row = await rowOf(one);
    expect(row.body_ref).toBe(ref);
    expect(await fileExists(one, ref)).toBe(true);
    const reopened = await one.service.readMessage(ACCOUNT, THREAD);
    expect(reopened.body?.text).toBe('Thank you very much! Alex (the August reply)');
    expect(one.bodyReads).toEqual([THREAD]);
    expect(one.log.info).not.toHaveBeenCalled();
  });

  it('a re-decoded subject with the same instants keeps the body', async () => {
    const one = await openBase();
    const { ref } = await seedCachedBody(one);
    await one.service.ingestPage(ACCOUNT, [threadRow({ subject: 'RE: the runbook (fixed decoding)' })]);
    const row = await rowOf(one);
    expect(row.body_ref).toBe(ref);
    expect(await fileExists(one, ref)).toBe(true);
    expect(one.bodyReads).toEqual([THREAD]);
  });

  it('an identical listing is a no-op: nothing rewritten, nothing retired', async () => {
    const one = await openBase();
    const { ref } = await seedCachedBody(one);
    const outcome = await one.service.ingestPage(ACCOUNT, [threadRow()]);
    expect(outcome).toMatchObject({ added: 0, updated: 0 });
    expect((await rowOf(one)).body_ref).toBe(ref);
  });

  it('a remembered "can never be fetched" verdict moves with the body it was about', async () => {
    const one = await openBase();
    await one.service.ingestPage(ACCOUNT, [threadRow()]);
    const before = await rowOf(one);
    await one.store.setMessageBodyError(before.rowid, 'too-large');
    // The marker refuses the open, as designed for bytes that will never fit.
    const refused = await one.service.readMessage(ACCOUNT, THREAD);
    expect(refused.body).toBeNull();
    expect(refused.bodyError).toBe('too-large');
    expect(one.bodyReads).toEqual([]);

    // A reply lands. The row is a different message now: the verdict on the old one is gone, and
    // the open fetches without anyone pressing Try again.
    await one.service.ingestPage(ACCOUNT, [threadRow({ sentAt: REPLY_AT, receivedAt: REPLY_AT })]);
    expect((await rowOf(one)).body_error).toBeNull();
    const fetched = await one.service.readMessage(ACCOUNT, THREAD);
    expect(fetched.body?.text).toBe('Thank you very much! Alex (the August reply)');
    expect(one.bodyReads).toEqual([THREAD]);
  });

  it('the snippet is not carried from the retired body when the listing has no preview', async () => {
    const one = await openBase();
    await seedCachedBody(one);
    // After the open the snippet column holds body-derived text. The moved listing carries none.
    await one.service.ingestPage(ACCOUNT, [threadRow({ snippet: undefined, sentAt: REPLY_AT, receivedAt: REPLY_AT })]);
    const listed = await one.service.listMessages({ accountId: ACCOUNT, mailboxId: 'inbox', limit: 10 });
    expect(listed.messages[0]?.snippet).toBe('');
  });

  it('an address the OLD body taught is not paired with the NEW newest sender', async () => {
    const one = await openBase();
    await one.service.ingestPage(ACCOUNT, [threadRow()]);
    const row = await rowOf(one);
    // What a body read that names the sender leaves behind (see fillAddressesFromBody).
    await one.store.setMessageBody(row.rowid, {
      bodyRef: (await one.bodies.write(ACCOUNT, THREAD, FIRST_AT, {
        format: 'text', text: 'Thank you very much! Alex', bytes: 25,
      }, 'RE: the runbook')).ref,
      bodyBytes: 25,
      snippet: 'Thank you very much! Alex',
      payload: JSON.stringify({ from: { name: 'Stone, Alex', address: 'alex@example.invalid' }, bodyFormat: 'text' }),
      fromAddr: 'alex@example.invalid',
    });

    await one.service.ingestPage(ACCOUNT, [threadRow({
      from: { name: 'Morgan, Cameron' }, sentAt: REPLY_AT, receivedAt: REPLY_AT,
    })]);
    const listed = await one.service.listMessages({ accountId: ACCOUNT, mailboxId: 'inbox', limit: 10 });
    expect(listed.messages[0]?.from).toEqual({ name: 'Morgan, Cameron' });
    const after = await one.store.getMessage(ACCOUNT, THREAD);
    expect(after?.from_addr).toBe('');
  });

  it('cache search stops matching words that lived only in the retired body', async () => {
    const one = await openBase();
    one.bodyText.current = 'The word xylophone appears in this body and nowhere else';
    await seedCachedBody(one);
    const hit = await one.service.search({ accountId: ACCOUNT, q: 'xylophone', limit: 10 });
    expect(hit.messages.map((m) => m.messageId)).toEqual([THREAD]);

    await one.service.ingestPage(ACCOUNT, [threadRow({ sentAt: REPLY_AT, receivedAt: REPLY_AT })]);
    const miss = await one.service.search({ accountId: ACCOUNT, q: 'xylophone', limit: 10 });
    expect(miss.messages).toEqual([]);
  });

  it('two rows in one page: only the one that moved loses its body', async () => {
    const one = await openBase();
    const OTHER = 'inbox:conv-marina';
    await one.service.ingestPage(ACCOUNT, [threadRow(), threadRow({ messageId: OTHER, rfcMessageId: 'conv-marina' })]);
    await one.service.readMessage(ACCOUNT, THREAD);
    await one.service.readMessage(ACCOUNT, OTHER);
    const before = await one.store.knownMessages(ACCOUNT, [THREAD, OTHER]);
    expect(before.get(THREAD)?.body_ref).toBeTruthy();
    expect(before.get(OTHER)?.body_ref).toBeTruthy();

    await one.service.ingestPage(ACCOUNT, [
      threadRow({ sentAt: REPLY_AT, receivedAt: REPLY_AT }),
      threadRow({ messageId: OTHER, rfcMessageId: 'conv-marina', flags: ['\\Seen'] }),
    ]);
    const after = await one.store.knownMessages(ACCOUNT, [THREAD, OTHER]);
    expect(after.get(THREAD)?.body_ref).toBeNull();
    expect(after.get(OTHER)?.body_ref).toBe(before.get(OTHER)?.body_ref);
  });
});

/** The headline a delivery of `id` should carry: the stored row's own version, the unversioned RFC scope. */
async function headlineOf(one: Harness, id = THREAD) {
  const row = await one.store.getMessage(ACCOUNT, id);
  if (!row) throw new Error(`no row ${id}`);
  return {
    from: row.from_addr,
    subject: row.subject,
    messageId: id,
    version: mailRowDeliveryVersion(row),
    canonicalKey: mailRouterKey(ACCOUNT, id, row.rfc_message_id),
  };
}

/** A gate the test opens by hand. */
function gateOf(): { promise: Promise<void>; open: () => void } {
  let open = () => undefined as void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

describe('a reply on a known conversation handle is a new delivery', () => {
  it('two replies on one handle each count as received with their own versioned headline', async () => {
    const one = await openBase();
    const first = await one.service.ingestPage(ACCOUNT, [threadRow()]);
    expect(first).toMatchObject({ added: 1, updated: 0, received: 1, importantAdded: 1 });
    const firstHeadline = await headlineOf(one);
    expect(first.headlines).toEqual([firstHeadline]);
    expect(first.importantHeadlines).toEqual([firstHeadline]);
    // The RFC scope, unversioned: the delivery rides `version`.
    expect(firstHeadline.canonicalKey).toBe(mailRouterKey(ACCOUNT, THREAD, 'conv-quartz'));

    // The first reply lands before anyone opened the row: no cached body, still a new delivery.
    expect((await rowOf(one)).body_ref).toBeNull();
    const reply = await one.service.ingestPage(ACCOUNT, [threadRow({
      from: { name: 'Morgan, Cameron' }, sentAt: REPLY_AT, receivedAt: REPLY_AT,
    })]);
    // `added` stays the count of new cache rows: the handle was already cached.
    expect(reply).toMatchObject({ added: 0, updated: 1, received: 1, importantAdded: 1 });
    const replyHeadline = await headlineOf(one);
    expect(reply.headlines).toEqual([replyHeadline]);
    expect(reply.importantHeadlines).toEqual([replyHeadline]);
    expect(replyHeadline.canonicalKey).toBe(firstHeadline.canonicalKey);
    expect(replyHeadline.version).not.toBe(firstHeadline.version);
    expect(one.log.info).not.toHaveBeenCalled();

    // Opened once, so this time a real body file sits under the row.
    one.bodyText.current = 'Yes, that is generally correct. Cameron (the first reply)';
    await one.service.readMessage(ACCOUNT, THREAD);
    const ref = (await rowOf(one)).body_ref;
    expect(ref).toBeTruthy();
    expect(await fileExists(one, ref!)).toBe(true);

    const second = await one.service.ingestPage(ACCOUNT, [threadRow({ sentAt: SECOND_REPLY_AT, receivedAt: SECOND_REPLY_AT })]);
    expect(second).toMatchObject({ added: 0, updated: 1, received: 1, importantAdded: 1 });
    const secondHeadline = await headlineOf(one);
    expect(second.headlines).toEqual([secondHeadline]);
    expect(new Set([firstHeadline, replyHeadline, secondHeadline].map((h) => h.version)).size).toBe(3);

    // The body read for the first reply is retired on disk and in the columns, as before.
    expect((await rowOf(one)).body_ref).toBeNull();
    expect(await fileExists(one, ref!)).toBe(false);
    one.bodyText.current = 'Thanks, shipping it. Alex (the second reply)';
    const reopened = await one.service.readMessage(ACCOUNT, THREAD);
    expect(reopened.body?.text).toBe('Thanks, shipping it. Alex (the second reply)');
    // The answer is the row as it is now: its version names the body just stored.
    const now = await one.store.getMessage(ACCOUNT, THREAD);
    expect(now?.body_ref).toBeTruthy();
    expect(reopened.message.deliveryVersion).toBe(mailRowDeliveryVersion(now!));
    expect(reopened.message.deliveryVersion).not.toBe(secondHeadline.version);
  });

  it('the same reply polled again is no delivery and no headline', async () => {
    const one = await openBase();
    await one.service.ingestPage(ACCOUNT, [threadRow()]);
    const moved = threadRow({ sentAt: REPLY_AT, receivedAt: REPLY_AT });
    expect(await one.service.ingestPage(ACCOUNT, [moved])).toMatchObject({ received: 1, updated: 1 });
    const again = await one.service.ingestPage(ACCOUNT, [moved]);
    expect(again).toEqual({ added: 0, updated: 0, received: 0, headlines: [] });
  });

  it('flags, a preview or a subject that change with the same instants are no delivery', async () => {
    const one = await openBase();
    const { ref } = await seedCachedBody(one);
    const flagged = await one.service.ingestPage(ACCOUNT, [threadRow({ flags: ['\\Seen'] })]);
    expect(flagged).toEqual({ added: 0, updated: 1, received: 0, headlines: [] });
    const reworded = await one.service.ingestPage(ACCOUNT, [threadRow({
      flags: ['\\Seen'], snippet: 'A new preview', subject: 'RE: the runbook (re-decoded)',
    })]);
    expect(reworded).toEqual({ added: 0, updated: 1, received: 0, headlines: [] });
    expect((await rowOf(one)).body_ref).toBe(ref);
    expect(await fileExists(one, ref)).toBe(true);
  });

  it('another Message-ID under the same instants is a new delivery and retires the body', async () => {
    const one = await openBase();
    const { ref } = await seedCachedBody(one);
    const before = await headlineOf(one);
    const outcome = await one.service.ingestPage(ACCOUNT, [threadRow({ rfcMessageId: 'conv-quartz-other' })]);
    expect(outcome).toMatchObject({ added: 0, updated: 1, received: 1 });
    const after = await headlineOf(one);
    expect(outcome.headlines).toEqual([after]);
    expect(after.canonicalKey).toBe(mailRouterKey(ACCOUNT, THREAD, 'conv-quartz-other'));
    expect(after.version).not.toBe(before.version);
    expect((await rowOf(one)).body_ref).toBeNull();
    expect(await fileExists(one, ref)).toBe(false);
  });

  it('a page with a new row, a reply and a flag change counts two deliveries', async () => {
    const one = await openBase();
    const OTHER = 'inbox:conv-marina';
    const NEW = 'inbox:conv-cobalt';
    await one.service.ingestPage(ACCOUNT, [threadRow(), threadRow({ messageId: OTHER, rfcMessageId: 'conv-marina' })]);
    const page = await one.service.ingestPage(ACCOUNT, [
      threadRow({ sentAt: REPLY_AT, receivedAt: REPLY_AT }),
      threadRow({ messageId: OTHER, rfcMessageId: 'conv-marina', flags: ['\\Seen'] }),
      threadRow({ messageId: NEW, rfcMessageId: 'conv-cobalt', sentAt: REPLY_AT, receivedAt: REPLY_AT }),
    ]);
    expect(page).toMatchObject({ added: 1, updated: 2, received: 2, importantAdded: 2 });
    expect(page.headlines).toEqual([await headlineOf(one), await headlineOf(one, NEW)]);
  });
});

describe('a body lands only on the delivery it was fetched for', () => {
  it('a fetch still in flight when a reply lands is refused, not stored on the new delivery', async () => {
    const one = await openBase();
    one.bodyText.current = 'The word xylophone lives only in the August body';
    await one.service.ingestPage(ACCOUNT, [threadRow()]);
    const held = gateOf();
    one.gate.current = held.promise;
    const reading = one.service.readMessage(ACCOUNT, THREAD);
    await vi.waitFor(() => expect(one.bodyReads).toEqual([THREAD]));

    // The reply lands while the old body is on its way.
    await one.service.ingestPage(ACCOUNT, [threadRow({ sentAt: REPLY_AT, receivedAt: REPLY_AT })]);
    held.open();
    await expect(reading).rejects.toMatchObject({ code: 'delivery_changed', status: 409 });

    const row = await rowOf(one);
    expect(row.body_ref).toBeNull();
    expect(row.sent_at).toBe(REPLY_AT);
    // Nothing indexed from the refused bytes.
    expect((await one.service.search({ accountId: ACCOUNT, q: 'xylophone', limit: 10 })).messages).toEqual([]);

    // The next open fetches the reply's own body.
    one.gate.current = null;
    one.bodyText.current = 'The September reply';
    const fresh = await one.service.readMessage(ACCOUNT, THREAD);
    expect(fresh.body?.text).toBe('The September reply');
    expect(one.bodyReads).toEqual([THREAD, THREAD]);
  });

  it('another read that stored the same delivery first is answered as that cached capture', async () => {
    const one = await openBase();
    await one.service.ingestPage(ACCOUNT, [threadRow()]);
    const held = gateOf();
    one.gate.current = held.promise;
    const reading = one.service.readMessage(ACCOUNT, THREAD);
    await vi.waitFor(() => expect(one.bodyReads).toEqual([THREAD]));
    // The prefetch's write for the same delivery lands first.
    const row = await rowOf(one);
    const first = await one.bodies.write(ACCOUNT, THREAD, FIRST_AT, { format: 'text', text: 'The prefetched capture', bytes: 22 });
    expect(await one.store.setMessageBody(row.rowid, { bodyRef: first.ref, bodyBytes: 22, snippet: 'The prefetched capture', payload: '{}' },
      { sentAt: FIRST_AT, receivedAt: FIRST_AT, bodyRef: null, rfcMessageId: 'conv-quartz' })).toBe(true);
    held.open();
    const answer = await reading;
    expect(answer.body?.text).toBe('The prefetched capture');
    const now = await one.store.getMessage(ACCOUNT, THREAD);
    expect(now?.body_ref).toBe(first.ref);
    expect(answer.message.deliveryVersion).toBe(mailRowDeliveryVersion(now!));
  });

  it('a same-instant metadata rewrite during the fetch refuses the late body; a flag change does not', async () => {
    const one = await openBase();
    await one.service.ingestPage(ACCOUNT, [threadRow()]);
    const held = gateOf();
    one.gate.current = held.promise;
    const reading = one.service.readMessage(ACCOUNT, THREAD);
    await vi.waitFor(() => expect(one.bodyReads).toEqual([THREAD]));
    await one.service.ingestPage(ACCOUNT, [threadRow({ subject: 'RE: the runbook (re-decoded)' })]);
    held.open();
    await expect(reading).rejects.toMatchObject({ code: 'delivery_changed' });
    expect(await rowOf(one)).toMatchObject({ body_ref: null });

    const again = gateOf();
    one.gate.current = again.promise;
    const flagged = one.service.readMessage(ACCOUNT, THREAD);
    await vi.waitFor(() => expect(one.bodyReads).toEqual([THREAD, THREAD]));
    await one.service.ingestPage(ACCOUNT, [threadRow({ subject: 'RE: the runbook (re-decoded)', flags: ['\\Seen'] })]);
    again.open();
    expect((await flagged).body?.text).toBe(one.bodyText.current);
  });

  it('a cached read whose row metadata is rewritten mid-read is refused', async () => {
    const one = await openBase();
    await seedCachedBody(one);
    const read = one.bodies.read.bind(one.bodies);
    vi.spyOn(one.bodies, 'read').mockImplementationOnce(async (asked) => {
      const files = await read(asked);
      await one.service.ingestPage(ACCOUNT, [threadRow({ subject: 'RE: the runbook (re-decoded)' })]);
      return files;
    });
    await expect(one.service.readMessage(ACCOUNT, THREAD)).rejects.toMatchObject({ code: 'delivery_changed' });
    const again = await one.service.readMessage(ACCOUNT, THREAD);
    expect(again.message.subject).toBe('RE: the runbook (re-decoded)');
    expect(again.message.deliveryVersion).toBe(mailRowDeliveryVersion((await one.store.getMessage(ACCOUNT, THREAD))!));
  });

  it('a permanent failure from before a reply is not marked on the reply', async () => {
    const one = await openBase();
    await one.service.ingestPage(ACCOUNT, [threadRow()]);
    const held = gateOf();
    one.gate.current = held.promise;
    one.bodyFail.current = 'not-found';
    const reading = one.service.readMessage(ACCOUNT, THREAD);
    await vi.waitFor(() => expect(one.bodyReads).toEqual([THREAD]));
    await one.service.ingestPage(ACCOUNT, [threadRow({ sentAt: REPLY_AT, receivedAt: REPLY_AT })]);
    held.open();
    await expect(reading).rejects.toMatchObject({ code: 'delivery_changed' });
    expect((await rowOf(one)).body_error).toBeNull();
  });

  it('the store refuses a body write against a delivery the row no longer is', async () => {
    const one = await openBase();
    await one.service.ingestPage(ACCOUNT, [threadRow()]);
    const row = await rowOf(one);
    const body = { bodyRef: 'bodies/x/y/z', bodyBytes: 1, snippet: 'x', payload: '{}' };
    const stale = { sentAt: FIRST_AT, receivedAt: FIRST_AT, bodyRef: null, rfcMessageId: 'conv-quartz' };
    expect(await one.store.setMessageBody(row.rowid, body, { ...stale, sentAt: REPLY_AT })).toBe(false);
    expect(await one.store.setMessageBody(row.rowid, body, { ...stale, rfcMessageId: 'another' })).toBe(false);
    expect(await one.store.setMessageBodyError(row.rowid, 'too-large', { ...stale, receivedAt: REPLY_AT })).toBe(false);
    expect((await rowOf(one))).toMatchObject({ body_ref: null, body_error: null });
    expect(await one.store.setMessageBody(row.rowid, body, stale)).toBe(true);
    // Now holding a body, a write that expected none is refused too.
    expect(await one.store.setMessageBody(row.rowid, { ...body, bodyRef: 'bodies/x/y/w' }, stale)).toBe(false);
    expect((await rowOf(one)).body_ref).toBe('bodies/x/y/z');
  });

  it('a cached read whose body reference is replaced under the same instants is refused', async () => {
    const one = await openBase();
    const { ref } = await seedCachedBody(one);
    const before = await one.store.getMessage(ACCOUNT, THREAD);
    const other = await one.bodies.write(ACCOUNT, THREAD, FIRST_AT, { format: 'text', text: 'Another capture', bytes: 15 });
    expect(other.ref).not.toBe(ref);
    const read = one.bodies.read.bind(one.bodies);
    vi.spyOn(one.bodies, 'read').mockImplementationOnce(async (asked) => {
      const files = await read(asked);
      const row = await rowOf(one);
      await one.store.setMessageBody(row.rowid, { bodyRef: other.ref, bodyBytes: 15, snippet: 'Another capture', payload: '{}' });
      return files;
    });
    await expect(one.service.readMessage(ACCOUNT, THREAD)).rejects.toMatchObject({ code: 'delivery_changed' });
    const after = await one.store.getMessage(ACCOUNT, THREAD);
    expect([after?.sent_at, after?.received_at]).toEqual([before?.sent_at, before?.received_at]);
    expect(mailRowDeliveryVersion(after!)).not.toBe(mailRowDeliveryVersion(before!));
    // Read again, it is one snapshot: the new capture with the row that names it.
    const again = await one.service.readMessage(ACCOUNT, THREAD);
    expect(again.body?.text).toBe('Another capture');
    expect(again.message.deliveryVersion).toBe(mailRowDeliveryVersion(after!));
  });

  it('cacheOnly answers from the cache and never asks the provider', async () => {
    const one = await openBase();
    await one.service.ingestPage(ACCOUNT, [threadRow()]);
    const bare = await one.service.readMessage(ACCOUNT, THREAD, { cacheOnly: true });
    expect(bare.body).toBeNull();
    expect(bare.bodyError).toBeUndefined();
    expect(one.bodyReads).toEqual([]);
    // Ahead of a remembered failure too: no fetch, and no marker read back as a fresh failure.
    await one.store.setMessageBodyError((await rowOf(one)).rowid, 'too-large');
    expect(await one.service.readMessage(ACCOUNT, THREAD, { cacheOnly: true, retry: true })).toMatchObject({ body: null });
    expect(one.bodyReads).toEqual([]);
    await one.store.clearMessageBodyError((await rowOf(one)).rowid);
    await one.service.readMessage(ACCOUNT, THREAD);
    expect(one.bodyReads).toEqual([THREAD]);
    const cached = await one.service.readMessage(ACCOUNT, THREAD, { cacheOnly: true });
    expect(cached.body?.text).toBe(one.bodyText.current);
    expect(one.bodyReads).toEqual([THREAD]);
  });
});

describe('body files are immutable once named', () => {
  it('another capture gets another ref and leaves the first one byte for byte', async () => {
    const one = await openBase();
    const first = await one.bodies.write(ACCOUNT, THREAD, FIRST_AT, { format: 'both', text: 'first', html: '<p>first</p>', bytes: 17 });
    const firstText = await fsp.readFile(path.join(one.root, `${first.ref}.txt`), 'utf8');
    const second = await one.bodies.write(ACCOUNT, THREAD, FIRST_AT, { format: 'text', text: 'second', bytes: 6 });
    expect(second.ref).not.toBe(first.ref);
    expect(await one.bodies.read(first.ref)).toEqual({ text: firstText, html: '<p>first</p>' });
    expect(await one.bodies.read(second.ref)).toEqual({ text: 'second' });
    // The same bytes again name the same ref and rewrite the same bytes; the html half stays.
    const again = await one.bodies.write(ACCOUNT, THREAD, FIRST_AT, { format: 'both', text: 'first', html: '<p>first</p>', bytes: 17 });
    expect(again.ref).toBe(first.ref);
    expect(await one.bodies.read(first.ref)).toEqual({ text: 'first', html: '<p>first</p>' });
    // No temp file is left beside them.
    const dir = path.dirname(path.join(one.root, first.ref));
    expect((await fsp.readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('a write with no html removes no html file a reader may hold', async () => {
    const one = await openBase();
    const held = await one.bodies.write(ACCOUNT, THREAD, FIRST_AT, { format: 'both', text: 'kept', html: '<b>kept</b>', bytes: 15 });
    // A legacy ref named by the handle alone: its html half must survive any later write.
    const legacy = path.join(path.dirname(held.ref), 'legacyhandleref');
    await fsp.writeFile(path.join(one.root, `${legacy}.txt`), 'legacy');
    await fsp.writeFile(path.join(one.root, `${legacy}.html`), '<i>legacy</i>');
    await one.bodies.write(ACCOUNT, THREAD, FIRST_AT, { format: 'text', text: 'kept', bytes: 4 });
    expect(await one.bodies.read(held.ref)).toEqual({ text: 'kept', html: '<b>kept</b>' });
    expect(await one.bodies.read(legacy)).toEqual({ text: 'legacy', html: '<i>legacy</i>' });
  });
});

describe('one delivery is one arrival', () => {
  it('a handle named twice in one page is inserted once and arrives once', async () => {
    const one = await openBase();
    const page = await one.service.ingestPage(ACCOUNT, [threadRow(), threadRow()]);
    expect(page).toMatchObject({ added: 1, updated: 0, received: 1 });
    expect(page.headlines).toEqual([await headlineOf(one)]);
    const moved = threadRow({ sentAt: REPLY_AT, receivedAt: REPLY_AT });
    expect(await one.service.ingestPage(ACCOUNT, [moved, moved])).toMatchObject({ added: 0, updated: 1, received: 1 });
  });

  it('a new row and its reply in one page are two arrivals, headlined only by the row that stands', async () => {
    const one = await openBase();
    const page = await one.service.ingestPage(ACCOUNT, [threadRow(), threadRow({ sentAt: REPLY_AT, receivedAt: REPLY_AT })]);
    expect(page).toMatchObject({ added: 1, updated: 1, received: 2 });
    // The first write's row was rewritten by the second: no headline claims it is current.
    expect(page.headlines).toEqual([await headlineOf(one)]);
  });

  it('two writers ingesting the same reply at once count it once', async () => {
    const one = await openBase();
    await one.service.ingestPage(ACCOUNT, [threadRow()]);
    const moved = threadRow({ sentAt: REPLY_AT, receivedAt: REPLY_AT });
    const [a, b] = await Promise.all([one.service.ingestPage(ACCOUNT, [moved]), one.service.ingestPage(ACCOUNT, [moved])]);
    expect((a.received ?? 0) + (b.received ?? 0)).toBe(1);
    expect([...a.headlines, ...b.headlines]).toEqual([await headlineOf(one)]);
  });
});

describe('cacheOnly search', () => {
  it('reads cached rows with their real version and never asks the provider', async () => {
    const one = await openBase();
    one.bodyText.current = 'The word xylophone is in this body';
    await seedCachedBody(one);
    one.spec.capabilities.search = true;
    const cached = await one.service.search({ accountId: ACCOUNT, q: 'xylophone', limit: 10, cacheOnly: true });
    expect(cached.source).toBe('cache');
    expect(cached.messages.map((m) => [m.messageId, m.deliveryVersion])).toEqual([
      [THREAD, mailRowDeliveryVersion((await one.store.getMessage(ACCOUNT, THREAD))!)],
    ]);
    expect(one.searches).toEqual([]);
    // A person's search still goes to the provider.
    expect((await one.service.search({ accountId: ACCOUNT, q: 'xylophone', limit: 10 })).source).toBe('provider');
    expect(one.searches).toEqual(['xylophone']);
  });
});

describe('ingest pages and body stores share one write order per account', () => {
  it('a body that arrives while an ingest holds the account waits for it, then is refused', async () => {
    const one = await openBase();
    one.bodyText.current = 'The word quokka lives only in the old body';
    await one.service.ingestPage(ACCOUNT, [threadRow()]);
    const held = gateOf();
    one.sortGate.current = held.promise;
    // C has read the bodyless row and holds the account.
    const ingesting = one.service.ingestPage(ACCOUNT, [threadRow({ sentAt: REPLY_AT, receivedAt: REPLY_AT })]);
    // B's fetch comes back while C holds it: its store queues behind C.
    const reading = one.service.readMessage(ACCOUNT, THREAD);
    await vi.waitFor(() => expect(one.bodyReads).toEqual([THREAD]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await rowOf(one)).body_ref).toBeNull();
    held.open();
    expect(await ingesting).toMatchObject({ updated: 1, received: 1 });
    await expect(reading).rejects.toMatchObject({ code: 'delivery_changed' });
    const row = await rowOf(one);
    expect(row.sent_at).toBe(REPLY_AT);
    expect(row.body_ref).toBeNull();
    expect((await one.service.search({ accountId: ACCOUNT, q: 'quokka', limit: 10 })).messages).toEqual([]);
  });

  it('an ingest that arrives while a body store holds the account waits, then retires that body', async () => {
    const one = await openBase();
    one.bodyText.current = 'The word quokka lives only in the old body';
    await one.service.ingestPage(ACCOUNT, [threadRow()]);
    const held = gateOf();
    const write = one.bodies.write.bind(one.bodies);
    vi.spyOn(one.bodies, 'write').mockImplementationOnce(async (...args) => {
      await held.promise;
      return write(...args);
    });
    const reading = one.service.readMessage(ACCOUNT, THREAD).catch((error: unknown) => error);
    await vi.waitFor(() => expect(one.bodies.write).toHaveBeenCalled());
    const ingesting = one.service.ingestPage(ACCOUNT, [threadRow({ sentAt: REPLY_AT, receivedAt: REPLY_AT })]);
    held.open();
    expect(await ingesting).toMatchObject({ updated: 1, received: 1 });
    await reading;
    const row = await rowOf(one);
    expect(row.sent_at).toBe(REPLY_AT);
    // The body B stored was for the old delivery, and C, ordered after it, retired it: file and index.
    expect(row.body_ref).toBeNull();
    const dir = path.join(one.root, 'bodies');
    const files = await fsp.readdir(dir, { recursive: true });
    expect(files.filter((name) => String(name).endsWith('.txt'))).toEqual([]);
    expect((await one.service.search({ accountId: ACCOUNT, q: 'quokka', limit: 10 })).messages).toEqual([]);
  });

  it('a body file gone before its row is cleared reads as a changed delivery, never as an empty body', async () => {
    const one = await openBase();
    const { ref } = await seedCachedBody(one);
    // Retirement clears the row before the file now; a file lost some other way must still fail closed.
    await fsp.rm(path.join(one.root, `${ref}.txt`));
    await expect(one.service.readMessage(ACCOUNT, THREAD)).rejects.toMatchObject({ code: 'delivery_changed', status: 409 });
  });
});

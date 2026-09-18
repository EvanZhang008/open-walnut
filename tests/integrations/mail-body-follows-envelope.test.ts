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

interface Harness {
  root: string;
  store: MailStore;
  bodies: MailBodyStore;
  service: MailService;
  /** Every body the provider was asked for, in order. */
  bodyReads: string[];
  /** What the provider answers a body read with, switchable per test step. */
  bodyText: { current: string };
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
  const bodyText = { current: 'Thank you very much! Evan (the August reply)' };
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
      return { format: 'text' as const, text, bytes: Buffer.byteLength(text) };
    },
    send: async () => ({ acceptedAt: Date.now() }),
  };
  providers.register(spec, 'the-fixture-plugin');
  const log = { info: vi.fn(), debug: vi.fn() };
  const service = new MailService({ store, bodies, providers, log });
  await store.upsertAccount({
    accountId: ACCOUNT,
    providerId: 'thready',
    displayName: 'A mailbox',
    address: 'quartz@example.invalid',
    state: 'active',
    healthJson: null,
    payload: '{}',
  });
  return { root, store, bodies, service, bodyReads, bodyText, log };
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
    from: { name: 'Zhang, Evan' },
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
      from: { name: 'Zhang, Evan', address: 'evan@example.invalid' },
      to: [{ address: 'cat@example.invalid' }],
      sentAtHeader: 'Mon, 31 Aug 2026 09:47:45 -0700',
      bodyFormat: 'both',
      bodyTruncated: true,
      bodyBytesHint: 42_749,
    });
    expect(kept).toEqual({
      to: [{ address: 'cat@example.invalid' }],
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
    one.bodyText.current = 'Yes, that is generally correct as an outline. Matthew (the September reply)';
    const outcome = await one.service.ingestPage(ACCOUNT, [threadRow({
      from: { name: 'Reilly, Matthew' },
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
      [THREAD, false, 'Yes, that is generally correct', 'Reilly, Matthew'],
    ]);

    // Opening it reads the body AGAIN and gets the September reply, not the August one.
    const reopened = await one.service.readMessage(ACCOUNT, THREAD);
    expect(reopened.body?.text).toBe('Yes, that is generally correct as an outline. Matthew (the September reply)');
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
    expect(reopened.body?.text).toBe('Thank you very much! Evan (the August reply)');
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
    expect(fetched.body?.text).toBe('Thank you very much! Evan (the August reply)');
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
        format: 'text', text: 'Thank you very much! Evan', bytes: 25,
      }, 'RE: the runbook')).ref,
      bodyBytes: 25,
      snippet: 'Thank you very much! Evan',
      payload: JSON.stringify({ from: { name: 'Zhang, Evan', address: 'evan@example.invalid' }, bodyFormat: 'text' }),
      fromAddr: 'evan@example.invalid',
    });

    await one.service.ingestPage(ACCOUNT, [threadRow({
      from: { name: 'Reilly, Matthew' }, sentAt: REPLY_AT, receivedAt: REPLY_AT,
    })]);
    const listed = await one.service.listMessages({ accountId: ACCOUNT, mailboxId: 'inbox', limit: 10 });
    expect(listed.messages[0]?.from).toEqual({ name: 'Reilly, Matthew' });
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

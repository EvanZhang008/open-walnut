/**
 * How mail that was already cached learns it can be unsubscribed from.
 *
 * `envelopeHashOf` deliberately ignores `listUnsubscribe`, which is what keeps the upgrade free: no
 * tick rewrites a mailbox to backfill the field. The price is that an old row can only learn the
 * headers from the one place they are still readable, its own raw source, so a BODY FETCH is the
 * backfill — and the response that fetched it has to carry the answer, or the console that just
 * opened the newsletter would still show no unsubscribe option until the next list.
 *
 * Graded against the REAL plugin database (worker-thread SQLite, real migrations) and the real body
 * store on a temp directory, because the interesting half is what is written down: a payload blob
 * that survives a re-poll, a retire that takes only what the body taught, and a re-ingest that costs
 * no write at all.
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
import { parseJson, type MessagePayload } from '../../src/integrations/mail/service-dto.js';
import { MailService } from '../../src/integrations/mail/service.js';
import { MailStore } from '../../src/integrations/mail/store.js';
import type {
  MailBody,
  MailCapabilities,
  MailEnvelope,
  MailListUnsubscribe,
  MailProviderSpec,
} from '../../src/integrations/mail/types.js';

const CAPABILITIES: MailCapabilities = {
  search: false, watch: false, drafts: false, markRead: false, flags: false,
  threads: false, send: false, sendAsReply: false, bodies: 'both', attachments: 'none',
};

const ACCOUNT = 'listy:acct-1';
const MESSAGE = 'INBOX:9001:42';
const SENT_AT = Date.UTC(2026, 8, 21, 16, 0, 0);
const LATER = Date.UTC(2026, 8, 22, 16, 0, 0);

const HEADERS: MailListUnsubscribe = {
  https: ['https://lists.example.invalid/u/abc'],
  mailto: ['mailto:leave@lists.example.invalid'],
  oneClick: true,
  listId: 'weekly.lists.example.invalid',
};

interface Harness {
  root: string;
  store: MailStore;
  bodies: MailBodyStore;
  service: MailService;
  bodyReads: string[];
  /** What the provider's BODY reports about leaving the list. Switchable per step. */
  bodyOffers: { current: MailListUnsubscribe | undefined };
}

const open: MailDatabase[] = [];
const roots: string[] = [];

async function openBase(): Promise<Harness> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mail-unsub-backfill-'));
  roots.push(root);
  const client = new PluginDatabaseClient(path.join(root, 'plugin.sqlite'));
  const walnut = { storage: { get database() { return client; } } } as unknown as WalnutServerPluginApi;
  const db = new MailDatabase(walnut);
  open.push(db);
  const store = new MailStore(db);
  const bodies = new MailBodyStore(root);
  const providers = new MailProviderRegistry(() => undefined);
  const bodyReads: string[] = [];
  const bodyOffers: { current: MailListUnsubscribe | undefined } = { current: undefined };
  const spec: MailProviderSpec = {
    id: 'listy',
    label: 'A fixture whose listing predates the List-* headers',
    capabilities: { ...CAPABILITIES },
    setup: {
      fields: [{ name: 'address', label: 'Address', kind: 'text' }],
      submit: async () => { throw new Error('this fixture adds accounts by hand'); },
    },
    listAccounts: async () => [],
    health: async () => ({ state: 'ok', checkedAt: Date.now() }),
    listMailboxes: async () => [],
    poll: async () => ({ messages: [], cursor: 'c0', more: false }),
    getBody: async (_account, messageId): Promise<MailBody> => {
      bodyReads.push(messageId);
      const html = '<p>This week in the marina. <a href="https://lists.example.invalid/u/abc">Unsubscribe</a></p>';
      return {
        format: 'both',
        text: 'This week in the marina. Unsubscribe.',
        html,
        bytes: Buffer.byteLength(html),
        ...(bodyOffers.current ? { listUnsubscribe: bodyOffers.current } : {}),
      };
    },
    send: async () => ({ acceptedAt: Date.now() }),
  };
  providers.register(spec, 'the-fixture-plugin');
  const service = new MailService({ store, bodies, providers, log: { info: vi.fn(), debug: vi.fn() } });
  await store.upsertAccount({
    accountId: ACCOUNT,
    providerId: 'listy',
    displayName: 'A mailbox',
    address: 'reader@example.invalid',
    state: 'active',
    healthJson: null,
    payload: '{}',
  });
  return { root, store, bodies, service, bodyReads, bodyOffers };
}

afterEach(async () => {
  for (const db of open.splice(0)) await db.dispose().catch(() => undefined);
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
  vi.restoreAllMocks();
});

/** The listing, which by default says nothing at all about unsubscribing. */
function listingRow(over: Partial<MailEnvelope> = {}): MailEnvelope {
  return {
    messageId: MESSAGE,
    rfcMessageId: '<weekly-42@lists.example.invalid>',
    mailboxId: 'INBOX',
    from: { name: 'Marina Weekly', address: 'weekly@lists.example.invalid' },
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

async function storedPayload(one: Harness): Promise<MessagePayload> {
  const row = await one.store.getMessage(ACCOUNT, MESSAGE);
  if (!row) throw new Error('the message row is gone');
  return parseJson<MessagePayload>(row.payload, {});
}

async function listed(one: Harness) {
  const page = await one.service.listMessages({ accountId: ACCOUNT, mailboxId: 'INBOX', limit: 10 });
  return page.messages[0];
}

describe('a message cached before Walnut asked for the headers', () => {
  it('learns them on the first body fetch, and THAT response already carries the answer', async () => {
    const one = await openBase();
    await one.service.ingestPage(ACCOUNT, [listingRow()]);

    // Nothing yet, and nothing pretending: no key at all, which a console reads as 'none'.
    expect((await listed(one))?.unsubscribe).toBeUndefined();
    expect((await storedPayload(one)).listUnsubscribe).toBeUndefined();

    one.bodyOffers.current = HEADERS;
    const read = await one.service.readMessage(ACCOUNT, MESSAGE);

    // The read that FETCHED the body answers with it. Without this the row was read before the body
    // arrived, so the very response that learned the headers would still say there are none.
    expect(read.message.unsubscribe).toEqual({ available: 'one-click' });
    expect(read.body?.format).toBe('both');
    expect((await storedPayload(one)).listUnsubscribe).toEqual(HEADERS);
    // And the list says so from now on, with no further body read.
    expect((await listed(one))?.unsubscribe).toEqual({ available: 'one-click' });
    expect(one.bodyReads).toEqual([MESSAGE]);
  });

  it('keeps it through a poll that rewrites the row for something else entirely', async () => {
    const one = await openBase();
    await one.service.ingestPage(ACCOUNT, [listingRow()]);
    one.bodyOffers.current = HEADERS;
    await one.service.readMessage(ACCOUNT, MESSAGE);

    // A flag flips and the subject is re-decoded: two ordinary reasons a row is rewritten, and the
    // poll that does it knows nothing about the headers a body read taught.
    const outcome = await one.service.ingestPage(ACCOUNT, [listingRow({
      flags: ['\\Seen'],
      subject: 'Marina Weekly, issue 42 (fixed decoding)',
    })]);
    expect(outcome).toMatchObject({ added: 0, updated: 1 });
    expect((await storedPayload(one)).listUnsubscribe).toEqual(HEADERS);
    expect((await listed(one))?.unsubscribe).toEqual({ available: 'one-click' });
    // The body was never re-fetched, so this really is the carried-forward blob.
    expect(one.bodyReads).toEqual([MESSAGE]);
  });

  it('is not erased by a later body read that reports none', async () => {
    const one = await openBase();
    await one.service.ingestPage(ACCOUNT, [listingRow({ listUnsubscribe: HEADERS })]);
    expect((await listed(one))?.unsubscribe).toEqual({ available: 'one-click' });

    // The row moves in time, so its body is retired and fetched again — this time from a provider
    // that cannot name the headers. Gap fill only: what the listing supplied stands.
    one.bodyOffers.current = HEADERS;
    await one.service.readMessage(ACCOUNT, MESSAGE);
    one.bodyOffers.current = undefined;
    await one.service.ingestPage(ACCOUNT, [listingRow({ listUnsubscribe: HEADERS, sentAt: LATER, receivedAt: LATER })]);
    await one.service.readMessage(ACCOUNT, MESSAGE);

    expect((await storedPayload(one)).listUnsubscribe).toEqual(HEADERS);
    expect(one.bodyReads).toEqual([MESSAGE, MESSAGE]);
  });

  it('is not overwritten by a body read that reports a DIFFERENT one', async () => {
    const one = await openBase();
    await one.service.ingestPage(ACCOUNT, [listingRow({ listUnsubscribe: HEADERS })]);
    one.bodyOffers.current = { https: ['https://lists.example.invalid/u/rotated'], oneClick: false };
    await one.service.readMessage(ACCOUNT, MESSAGE);
    expect((await storedPayload(one)).listUnsubscribe).toEqual(HEADERS);
    expect((await listed(one))?.unsubscribe).toEqual({ available: 'one-click' });
  });
});

describe('the cache as a whole', () => {
  it('costs no write when the same page is polled again', async () => {
    const one = await openBase();
    const page = [listingRow({ listUnsubscribe: HEADERS })];
    expect(await one.service.ingestPage(ACCOUNT, page)).toMatchObject({ added: 1, updated: 0 });

    const before = await one.store.getMessage(ACCOUNT, MESSAGE);
    // The same envelope, hashed the same way, is a no-op: the new field is not in the hash, which is
    // exactly why an upgrade does not rewrite a 5,000-row mailbox.
    expect(await one.service.ingestPage(ACCOUNT, page)).toMatchObject({ added: 0, updated: 0 });
    expect(await one.store.getMessage(ACCOUNT, MESSAGE)).toEqual(before);

    // And a provider that only NOW starts reporting the headers still costs nothing, because the
    // hash cannot see the difference.
    expect(await one.service.ingestPage(ACCOUNT, [listingRow()])).toMatchObject({ added: 0, updated: 0 });
    expect((await storedPayload(one)).listUnsubscribe).toEqual(HEADERS);
  });

  it('retires the scraped link with the body, and keeps the headers', async () => {
    const one = await openBase();
    await one.service.ingestPage(ACCOUNT, [listingRow({ listUnsubscribe: HEADERS })]);
    one.bodyOffers.current = HEADERS;
    await one.service.readMessage(ACCOUNT, MESSAGE);

    // What the ladder slice's html reading leaves behind, written the way `storeBody` writes it.
    const row = await one.store.getMessage(ACCOUNT, MESSAGE);
    await one.store.setMessageBody(row!.rowid, {
      bodyRef: row!.body_ref!,
      bodyBytes: row!.body_bytes ?? 0,
      snippet: row!.snippet,
      payload: JSON.stringify({
        ...(await storedPayload(one)),
        listUnsubscribe: { ...HEADERS, bodyLink: 'https://lists.example.invalid/u/abc', bodyCandidates: 2 },
      }),
    });

    // The row moves in time: a different message now, so the body it described goes.
    await one.service.ingestPage(ACCOUNT, [listingRow({ listUnsubscribe: HEADERS, sentAt: LATER, receivedAt: LATER })]);
    const after = await storedPayload(one);
    expect(after.listUnsubscribe).toEqual(HEADERS);
    expect(after.listUnsubscribe?.bodyLink).toBeUndefined();
    expect(after.listUnsubscribe?.bodyCandidates).toBeUndefined();
  });

  it('falls back to the footer link for a provider that never mentions the headers', async () => {
    // The external read-only transport: no headers in the listing, none in the body either. Before its
    // body is read there is nothing at all, which is honest. The read is where the base scrapes the
    // markup it just stored (the ladder slice's `unsubscribeFromBodyHtml`), and that scraped link is
    // the ONLY way out such an account ever has — so `available` becomes `link` and nothing is
    // invented beyond what the sender's own footer says.
    const one = await openBase();
    await one.service.ingestPage(ACCOUNT, [listingRow()]);
    expect((await listed(one))?.unsubscribe).toBeUndefined();

    const read = await one.service.readMessage(ACCOUNT, MESSAGE);
    expect(read.body?.text).toContain('This week in the marina');
    expect(read.message.unsubscribe).toEqual({ available: 'link' });
    expect((await storedPayload(one)).listUnsubscribe).toEqual({
      oneClick: false,
      bodyLink: 'https://lists.example.invalid/u/abc',
      bodyCandidates: 1,
    });
    expect((await listed(one))?.unsubscribe).toEqual({ available: 'link' });
  });
});

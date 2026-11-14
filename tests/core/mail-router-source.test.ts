/**
 * The mail router source reads ONLY the local mail cache: the real plugin SQLite (worker-thread
 * client, real migrations) and the real body store, both in this file's own mkdtemp directory.
 * No provider is registered or reachable: a body the cache does not hold is reported as absent,
 * never fetched, and nothing the router reads changes the message's flags.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginDatabaseClient } from '../../src/core/plugins/plugin-storage.js';
import type { WalnutServerPluginApi } from '../../src/core/plugins/server-api.js';
import { currentRouterSources, readRouterItem, readRouterItemForDelivery, registerRouterSource, resolveRouterItem } from '../../src/core/router/source-registry.js';
import type { RouterSource } from '../../src/core/router/types.js';
import { MailBodyStore } from '../../src/integrations/mail/bodies.js';
import { MailDatabase } from '../../src/integrations/mail/db.js';
import { mailRouterKey, mailRowDeliveryVersion, registerMailRouterSource } from '../../src/integrations/mail/router-source.js';
import { MailStore, type MessageWrite } from '../../src/integrations/mail/store.js';

const ACCOUNT_A = 'desk@marina.example.invalid';
const ACCOUNT_B = 'workshop@marina.example.invalid';
const SENT = Date.UTC(2026, 9, 20, 15, 0, 0);
const RFC_A = '<a-10@marina.example.invalid>';
const NOW = Date.UTC(2026, 9, 21, 9, 0, 0);

interface Cache {
  root: string;
  db: MailDatabase;
  store: MailStore;
  bodies: MailBodyStore;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  // Newest first: the registration goes before the database and the directory it reads.
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function openCache(fetchBody?: (cache: Cache, account: string, message: string) => Promise<void>): Promise<Cache> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mail-router-source-'));
  cleanups.push(() => fsp.rm(root, { recursive: true, force: true }).catch(() => undefined));
  const client = new PluginDatabaseClient(path.join(root, 'plugin.sqlite'));
  const walnut = { storage: { get database() { return client; } } } as unknown as WalnutServerPluginApi;
  const db = new MailDatabase(walnut);
  cleanups.push(() => db.dispose().catch(() => undefined));
  const store = new MailStore(db);
  const bodies = new MailBodyStore(root);
  for (const accountId of [ACCOUNT_A, ACCOUNT_B]) {
    await store.upsertAccount({
      accountId, providerId: 'fixture', displayName: accountId, address: accountId,
      state: 'active', healthJson: null, payload: '{}',
    });
  }
  const cache: Cache = { root, db, store, bodies };
  const dispose = registerMailRouterSource(store, bodies, fetchBody ? { fetchBody: (account, message) => fetchBody(cache, account, message) } : {});
  cleanups.push(dispose);
  return cache;
}

function envelope(over: Partial<MessageWrite> = {}): MessageWrite {
  return {
    accountId: ACCOUNT_A,
    messageId: 'INBOX:1:10',
    rfcMessageId: '<a-10@marina.example.invalid>',
    mailboxId: 'INBOX',
    threadId: 'thread-a',
    fromAddr: 'pat@marina.example.invalid',
    subject: 'Invoice for October',
    snippet: 'Please review the invoice',
    sentAt: SENT,
    receivedAt: SENT,
    flagsJson: '[]',
    attachmentsJson: '[]',
    payload: '{}',
    envelopeHash: 'hash-a-10',
    ...over,
  };
}

type Body = { text?: string; html?: string };

/** The real body store's write for one message: the ref is content-addressed. */
async function storeBody(cache: Cache, write: MessageWrite, body: Body) {
  const format = body.text !== undefined && body.html !== undefined ? 'both' : body.html !== undefined ? 'html' : 'text';
  return cache.bodies.write(write.accountId, write.messageId, write.sentAt, {
    format, ...body, bytes: Buffer.byteLength(`${body.text ?? ''}${body.html ?? ''}`),
  }, write.subject);
}

interface Seeded {
  rowid: number;
  /** The body ref the seed stored on the row, null when it stored no body. */
  ref: string | null;
  /** The exact source of what the seed stored: the version of the cached row as it now is. */
  source: RouterSource & { version: string };
}

/** The delivery version of a cached row as the store holds it now. */
async function versionNow(cache: Cache, account: string, message: string): Promise<string> {
  const row = await cache.store.getMessage(account, message);
  if (!row) throw new Error(`fixture row ${account} ${message} is missing`);
  return mailRowDeliveryVersion(row);
}

/** One cached message, with its body written to the real body store when `body` is given. */
async function seed(cache: Cache, over: Partial<MessageWrite>, body?: Body): Promise<Seeded> {
  const write = envelope(over);
  const rowid = await cache.store.insertMessage(write, NOW);
  let ref: string | null = null;
  if (body) {
    const stored = await storeBody(cache, write, body);
    await cache.store.setMessageBody(rowid, { bodyRef: stored.ref, bodyBytes: stored.bytes, snippet: write.snippet, payload: '{}' });
    ref = stored.ref;
  }
  return { rowid, ref, source: source(write.accountId, write.messageId, await versionNow(cache, write.accountId, write.messageId)) };
}

/** Another body for a cached row, its envelope (times included) untouched. Answers the new ref. */
async function replaceBody(cache: Cache, rowid: number, text: string, over: Partial<MessageWrite> = {}): Promise<string> {
  const write = envelope(over);
  const stored = await storeBody(cache, write, { text });
  await cache.store.setMessageBody(rowid, { bodyRef: stored.ref, bodyBytes: stored.bytes, snippet: write.snippet, payload: '{}' });
  return stored.ref;
}

const source = (account: string, message: string, version: string) => ({ kind: 'mail' as const, account, message, version });
const unversioned = (account: string, message: string): RouterSource => ({ kind: 'mail', account, message });

async function flagState(cache: Cache, rowid: number) {
  return cache.db.get<Record<string, unknown>>('SELECT flags_json, seen, updated_at FROM messages WHERE rowid = ?', [rowid]);
}

describe('mail router source: exact cached message', () => {
  it('reads the exact account and message: metadata and the cached body', async () => {
    const cache = await openCache();
    const seeded = await seed(cache, {}, { text: 'BODY_A_CANARY plain', html: '<p>BODY_A_CANARY html</p>' });
    expect(seeded.ref).toBeTruthy();
    // The adapter's own source for the handle is the one the seed recorded, body ref included.
    expect((await resolveRouterItem(unversioned(ACCOUNT_A, 'INBOX:1:10'))).source).toEqual(seeded.source);

    const item = await resolveRouterItem(seeded.source);
    expect(item).toEqual({
      source: seeded.source,
      key: mailRouterKey(ACCOUNT_A, 'INBOX:1:10', '', seeded.source.version),
      scopeKey: mailRouterKey(ACCOUNT_A, 'INBOX:1:10', '<a-10@marina.example.invalid>'),
      threadKey: 'thread-a',
      sender: 'pat@marina.example.invalid',
      subject: 'Invoice for October',
      preview: 'Please review the invoice',
    });

    const content = await readRouterItem(seeded.source);
    expect(content.item).toEqual(item);
    expect(content.body).toEqual({ text: 'BODY_A_CANARY plain', html: '<p>BODY_A_CANARY html</p>' });
    expect(content.bodyAvailable).toBe(true);
    expect(content.attachmentsAvailable).toBe(false);
    expect(content.attachments).toEqual([]);
  });

  it('keys a message with no RFC id by its cache id, still per account', async () => {
    const cache = await openCache();
    const seeded = await seed(cache, { rfcMessageId: '', threadId: null });
    const item = await resolveRouterItem(seeded.source);
    expect(item.key).toBe(mailRouterKey(ACCOUNT_A, 'INBOX:1:10', '', seeded.source.version));
    expect(item.scopeKey).toBe(mailRouterKey(ACCOUNT_A, 'INBOX:1:10'));
    expect(item.key).not.toBe(mailRouterKey(ACCOUNT_B, 'INBOX:1:10', '', seeded.source.version));
    expect(item).not.toHaveProperty('threadKey');
  });

  it('never crosses accounts: the same message id in another account is that account\'s message', async () => {
    const cache = await openCache();
    const seededA = await seed(cache, {}, { text: 'BODY_A_CANARY' });
    const seededB = await seed(cache, {
      accountId: ACCOUNT_B, rfcMessageId: '<b-10@marina.example.invalid>', subject: 'Workshop rota',
      envelopeHash: 'hash-b-10',
    }, { text: 'BODY_B_CANARY' });
    await seed(cache, { accountId: ACCOUNT_B, messageId: 'INBOX:1:77', rfcMessageId: '<b-77@marina.example.invalid>', envelopeHash: 'hash-b-77' },
      { text: 'ONLY_B_CANARY' });

    const a = await readRouterItem(seededA.source);
    const b = await readRouterItem(seededB.source);
    expect(a.body?.text).toBe('BODY_A_CANARY');
    expect(b.body?.text).toBe('BODY_B_CANARY');
    expect(b.item.subject).toBe('Workshop rota');
    expect(a.item.key).not.toBe(b.item.key);
    const VERSION = seededA.source.version;

    // A message only account B holds is absent under account A; no folding of the account either.
    await expect(readRouterItem(source(ACCOUNT_A, 'INBOX:1:77', VERSION))).rejects.toThrow('not in the mail cache');
    await expect(resolveRouterItem(source(ACCOUNT_A, 'INBOX:1:77', VERSION))).rejects.toThrow('not in the mail cache');
    await expect(readRouterItem(source(ACCOUNT_A.toUpperCase(), 'INBOX:1:10', VERSION))).rejects.toThrow('not in the mail cache');
    await expect(readRouterItem(source(` ${ACCOUNT_A}`, 'INBOX:1:10', VERSION))).rejects.toThrow('not in the mail cache');
    await expect(readRouterItem(source(ACCOUNT_A, 'INBOX:1:99', VERSION))).rejects.toThrow('not in the mail cache');
  });
});

describe('mail router source: a reused RFC id is not the same delivery', () => {
  it('two cached messages with one RFC id keep their own key and body, and share only the scope key', async () => {
    const cache = await openCache();
    const rfc = '<shared@marina.example.invalid>';
    const one = await seed(cache, { rfcMessageId: rfc }, { text: 'FIRST_BODY_CANARY' });
    const two = await seed(cache, { messageId: 'INBOX:1:11', rfcMessageId: rfc, subject: 'Same id, other mail', envelopeHash: 'hash-a-11' },
      { text: 'SECOND_BODY_CANARY' });
    // Same sent and received times; the stored bodies differ, so the delivery versions do too.
    expect(one.ref).not.toBe(two.ref);
    expect(one.source.version).not.toBe(two.source.version);
    const first = await readRouterItem(one.source);
    const second = await readRouterItem(two.source);
    expect(first.item.key).toBe(mailRouterKey(ACCOUNT_A, 'INBOX:1:10', '', one.source.version));
    expect(second.item.key).toBe(mailRouterKey(ACCOUNT_A, 'INBOX:1:11', '', two.source.version));
    expect(first.item.key).not.toBe(second.item.key);
    expect(first.item.scopeKey).toBe(mailRouterKey(ACCOUNT_A, 'INBOX:1:10', rfc));
    expect(second.item.scopeKey).toBe(first.item.scopeKey);
    expect(first.body?.text).toBe('FIRST_BODY_CANARY');
    expect(second.body?.text).toBe('SECOND_BODY_CANARY');
  });

  it('the registry refuses an adapter\'s scope key that is empty, too long, not text or holds control characters', async () => {
    for (const scopeKey of ['', 'x'.repeat(2049), 7, 'line\nbreak']) {
      const dispose = registerRouterSource('wechat', {
        resolve: async (src) => ({ source: src, key: 'k', scopeKey, sender: '', subject: '' }) as never,
        read: async (src) => ({ item: { source: src, key: 'k', scopeKey, sender: '', subject: '' }, body: null, bodyAvailable: false, attachments: [], attachmentsAvailable: false }) as never,
      });
      try {
        const src = { kind: 'wechat' as const, account: 'room', message: 'm1' };
        await expect(resolveRouterItem(src)).rejects.toThrow('scope key');
        await expect(readRouterItem(src)).rejects.toThrow('scope key');
      } finally { dispose(); }
    }
  });
});

describe('mail router source: mutable message handles', () => {
  it('separates two deliveries under one handle and refuses an old or missing version', async () => {
    const cache = await openCache();
    const seeded = await seed(cache, {}, { text: 'FIRST_DELIVERY_CANARY' });
    const first = await resolveRouterItem(seeded.source);
    await cache.store.updateMessage(seeded.rowid, envelope({ sentAt: SENT + 1000, receivedAt: SENT + 1000, envelopeHash: 'second' }), NOW + 1000);
    const current = await resolveRouterItem(unversioned(ACCOUNT_A, 'INBOX:1:10'));
    // The envelope moved and the row kept its body ref.
    expect((await cache.store.getMessage(ACCOUNT_A, 'INBOX:1:10'))?.body_ref).toBe(seeded.ref);
    expect(current.source.version).toBe(await versionNow(cache, ACCOUNT_A, 'INBOX:1:10'));
    expect((await resolveRouterItem(current.source)).key).toBe(current.key);
    expect(current.key).not.toBe(first.key);
    expect(current.scopeKey).toBe(first.scopeKey);
    await expect(readRouterItem(first.source)).rejects.toMatchObject({ code: 'source_changed' });
    await expect(resolveRouterItem(first.source)).rejects.toMatchObject({ code: 'source_changed' });
    await expect(readRouterItem(unversioned(ACCOUNT_A, 'INBOX:1:10'))).rejects.toMatchObject({ code: 'source_changed' });
  });

  it('same times, a changed cached body is a new delivery: the old version reads source_changed', async () => {
    const cache = await openCache();
    const old = await seed(cache, {}, { text: 'OLD_BODY_CANARY' });
    // The ref is content-addressed: the same content lands on the same ref.
    expect((await storeBody(cache, envelope(), { text: 'OLD_BODY_CANARY' })).ref).toBe(old.ref);
    const fresh = await replaceBody(cache, old.rowid, 'NEW_BODY_CANARY');
    expect(fresh).not.toBe(old.ref);

    const current = (await resolveRouterItem(unversioned(ACCOUNT_A, 'INBOX:1:10'))).source;
    const row = await cache.store.getMessage(ACCOUNT_A, 'INBOX:1:10');
    // Only the body ref moved: same times, same RFC id, same metadata.
    expect(row).toMatchObject({ sent_at: SENT, received_at: SENT, rfc_message_id: RFC_A, subject: 'Invoice for October', body_ref: fresh });
    expect(current.version).toBe(mailRowDeliveryVersion(row!));
    expect(current.version).not.toBe(old.source.version);
    await expect(readRouterItem(old.source)).rejects.toMatchObject({ code: 'source_changed' });
    await expect(resolveRouterItem(old.source)).rejects.toMatchObject({ code: 'source_changed' });

    const content = await readRouterItem(current);
    expect(content.body?.text).toBe('NEW_BODY_CANARY');
    expect(content.item.key).toBe(mailRouterKey(ACCOUNT_A, 'INBOX:1:10', '', current.version));
    expect(content.item.key).not.toBe(mailRouterKey(ACCOUNT_A, 'INBOX:1:10', '', old.source.version));
    // The scope key carries no version: the new body stays under the RFC restriction.
    expect(content.item.scopeKey).toBe(mailRouterKey(ACCOUNT_A, 'INBOX:1:10', RFC_A));
    // The confirmed snapshot was never overwritten in place.
    expect((await cache.bodies.read(old.ref!)).text).toBe('OLD_BODY_CANARY');
  });

  it('same times, same RFC id and body, changed metadata: a new delivery, the old version is refused', async () => {
    const dto = await fsp.readFile(new URL('../../src/integrations/mail/service-dto.ts', import.meta.url), 'utf8');
    const fields = [...dto.split('export interface MessagePayload {')[1]!.split('\n}')[0]!.matchAll(/^  (\w+)\??:/gm)]
      .map(match => match[1]!).filter(field => !['bodyBytesHint', 'bodyFormat', 'bodyTruncated', 'listUnsubscribe', 'bulkHeaders'].includes(field));
    const changes: Array<Partial<MessageWrite>> = [
      { subject: 'Invoice for October, corrected' },
      { fromAddr: 'lee@marina.example.invalid' }, { threadId: 'thread-b' },
      { attachmentsJson: JSON.stringify([{ filename: 'invoice.pdf' }]) },
      ...[...fields, 'futureContentField'].map((field) => ({ payload: JSON.stringify({ [field]: 'changed' }) })),
      { payload: '{"v":2}' }, { payload: 'invalid-json' },
    ];
    for (const change of changes) {
      const cache = await openCache();
      const old = await seed(cache, {}, { text: 'SAME_BODY_CANARY' });
      await cache.store.updateMessage(old.rowid, envelope({ ...change, envelopeHash: 'changed' }), NOW + 1000);
      const row = await cache.store.getMessage(ACCOUNT_A, 'INBOX:1:10');
      expect(row).toMatchObject({ sent_at: SENT, received_at: SENT, rfc_message_id: RFC_A, body_ref: old.ref });
      const current = (await resolveRouterItem(unversioned(ACCOUNT_A, 'INBOX:1:10'))).source;
      expect(current.version).toBe(mailRowDeliveryVersion(row!));
      expect(current.version).not.toBe(old.source.version);
      await expect(readRouterItem(old.source)).rejects.toMatchObject({ code: 'source_changed' });
      await expect(resolveRouterItem(old.source)).rejects.toMatchObject({ code: 'source_changed' });
      expect((await readRouterItem(current)).body?.text).toBe('SAME_BODY_CANARY');
    }
  });

  it('keeps a stored delivery through derived previews, cache fields and JSON object ordering', async () => {
    const cache = await openCache();
    const attachments = [{ filename: 'invoice.pdf', mimeType: 'application/pdf', bytes: 10 }];
    const content = { from: { address: 'pat@marina.example.invalid', name: 'Pat' }, references: ['ref-a', 'ref-b'] };
    const seeded = await seed(cache, { attachmentsJson: JSON.stringify(attachments) }, { text: 'STABLE_BODY_CANARY' });
    await cache.store.updateMessage(seeded.rowid, envelope({ payload: JSON.stringify(content), attachmentsJson: JSON.stringify(attachments) }), NOW);
    const confirmed = source(ACCOUNT_A, 'INBOX:1:10', await versionNow(cache, ACCOUNT_A, 'INBOX:1:10'));
    const cacheChanges = {
      bodyBytesHint: 100, bodyFormat: 'both', bodyTruncated: true,
      listUnsubscribe: { bodyLink: 'https://example.invalid/leave' }, bulkHeaders: { precedence: 'bulk' },
    };
    for (const [field, value] of Object.entries(cacheChanges)) {
      await cache.store.updateMessage(seeded.rowid, envelope({
        snippet: `Short envelope preview ${field}`, flagsJson: '["\\\\Seen"]',
        attachmentsJson: '[{ "bytes": 10, "mimeType": "application/pdf", "filename": "invoice.pdf" }]',
        payload: JSON.stringify({ [field]: value, references: ['ref-a', 'ref-b'], from: { name: 'Pat', address: 'pat@marina.example.invalid' } }),
      }), NOW + 1000);
      expect(await versionNow(cache, ACCOUNT_A, 'INBOX:1:10')).toBe(confirmed.version);
      expect(await currentRouterSources([confirmed])).toEqual([confirmed]);
      expect((await readRouterItem(confirmed)).body?.text).toBe('STABLE_BODY_CANARY');
    }
    await cache.store.updateMessage(seeded.rowid, envelope({
      attachmentsJson: JSON.stringify(attachments), payload: JSON.stringify({ ...content, references: ['ref-b', 'ref-a'] }),
    }), NOW + 2000);
    await expect(readRouterItem(confirmed)).rejects.toMatchObject({ code: 'source_changed' });
  });

  it('keeps uncached previews content-sensitive and refuses reordered attachment lists', async () => {
    const cache = await openCache();
    const first = await seed(cache, { attachmentsJson: '[{"filename":"a.pdf"},{"filename":"b.pdf"}]' });
    await cache.store.updateMessage(first.rowid, envelope({
      snippet: 'A changed preview without a stored body', attachmentsJson: '[{"filename":"a.pdf"},{"filename":"b.pdf"}]',
    }), NOW + 1000);
    await expect(resolveRouterItem(first.source)).rejects.toMatchObject({ code: 'source_changed' });
    const preview = source(ACCOUNT_A, 'INBOX:1:10', await versionNow(cache, ACCOUNT_A, 'INBOX:1:10'));
    await cache.store.updateMessage(first.rowid, envelope({
      snippet: 'A changed preview without a stored body', attachmentsJson: '[{"filename":"b.pdf"},{"filename":"a.pdf"}]',
    }), NOW + 2000);
    await expect(resolveRouterItem(preview)).rejects.toMatchObject({ code: 'source_changed' });
  });

  it('a flag change keeps the delivery: the confirmed version still reads', async () => {
    const cache = await openCache();
    const seeded = await seed(cache, {}, { text: 'FLAGGED_BODY_CANARY' });
    await cache.store.setMessageFlags(seeded.rowid, '["\\\\Seen","\\\\Flagged"]', NOW + 1000);
    expect(await flagState(cache, seeded.rowid)).toMatchObject({ seen: 1 });
    expect(await versionNow(cache, ACCOUNT_A, 'INBOX:1:10')).toBe(seeded.source.version);
    expect((await readRouterItem(seeded.source)).body?.text).toBe('FLAGGED_BODY_CANARY');
  });

  it('refuses a delivery that changes while the cached body is being read', async () => {
    const cache = await openCache();
    const seeded = await seed(cache, {}, { text: 'OLD_DELIVERY_CANARY' });
    const read = cache.bodies.read.bind(cache.bodies);
    const spy = vi.spyOn(cache.bodies, 'read').mockImplementation(async (ref) => {
      const body = await read(ref);
      await cache.store.updateMessage(seeded.rowid, envelope({ sentAt: SENT + 1000, receivedAt: SENT + 1000, envelopeHash: 'late' }), NOW + 1000);
      return body;
    });
    try {
      await expect(readRouterItem(seeded.source)).rejects.toMatchObject({ code: 'source_changed' });
    } finally { spy.mockRestore(); }
  });

  it('refuses the old snapshot when the cached body is replaced while it is read, and changes no flag', async () => {
    const cache = await openCache();
    const seeded = await seed(cache, { flagsJson: '["\\\\Flagged"]' }, { text: 'OLD_SNAPSHOT_CANARY' });
    const flagsBefore = await flagState(cache, seeded.rowid);
    expect(flagsBefore).toMatchObject({ seen: 0 });
    const read = cache.bodies.read.bind(cache.bodies);
    let swapped = '';
    const spy = vi.spyOn(cache.bodies, 'read').mockImplementation(async (ref) => {
      const body = await read(ref);
      // Same times: only the body ref moves.
      if (!swapped) swapped = await replaceBody(cache, seeded.rowid, 'NEW_SNAPSHOT_CANARY');
      return body;
    });
    try {
      await expect(readRouterItem(seeded.source)).rejects.toMatchObject({ code: 'source_changed' });
    } finally { spy.mockRestore(); }
    expect(swapped).toBeTruthy();
    expect(swapped).not.toBe(seeded.ref);
    expect(await flagState(cache, seeded.rowid)).toEqual(flagsBefore);
    const current = (await resolveRouterItem(unversioned(ACCOUNT_A, 'INBOX:1:10'))).source;
    expect(current.version).toBe(await versionNow(cache, ACCOUNT_A, 'INBOX:1:10'));
    expect((await readRouterItem(current)).body?.text).toBe('NEW_SNAPSHOT_CANARY');
  });
});

describe('mail router source: cache only, no provider', () => {
  it('reports a body the cache does not hold as null and unavailable', async () => {
    const cache = await openCache();
    const seeded = await seed(cache, {});
    // No stored body: the row's body ref is null, and the version is the row's own.
    expect(seeded.ref).toBeNull();
    const row = await cache.store.getMessage(ACCOUNT_A, 'INBOX:1:10');
    expect(row?.body_ref).toBeNull();
    expect(seeded.source.version).toBe(mailRowDeliveryVersion(row!));
    expect((await resolveRouterItem(unversioned(ACCOUNT_A, 'INBOX:1:10'))).source).toEqual(seeded.source);
    const content = await readRouterItem(seeded.source);
    expect(content.body).toBeNull();
    expect(content.bodyAvailable).toBe(false);
    expect(content.item.subject).toBe('Invoice for October');
  });

  it('a delivery read fetches a body the cache does not hold yet and hands it over, though the version moved', async () => {
    const asked: string[] = [];
    const cache = await openCache(async (at, account, message) => {
      asked.push(`${account} ${message}`);
      const row = (await at.store.getMessage(account, message))!;
      await replaceBody(at, row.rowid, 'FETCHED_BODY_CANARY');
    });
    const seeded = await seed(cache, {});
    const content = await readRouterItemForDelivery(seeded.source);
    expect(asked).toEqual([`${ACCOUNT_A} INBOX:1:10`]);
    expect(content.bodyAvailable).toBe(true);
    expect(content.body?.text).toBe('FETCHED_BODY_CANARY');
    // The cache-only read never fetches.
    asked.length = 0;
    const other = await seed(cache, { messageId: 'INBOX:1:11', rfcMessageId: '<a-11@marina.example.invalid>', envelopeHash: 'hash-a-11' });
    expect((await readRouterItem(other.source)).bodyAvailable).toBe(false);
    expect(asked).toEqual([]);
  });

  it('a delivery read fetches nothing for a cached body or one the provider refused for good', async () => {
    const asked: string[] = [];
    const cache = await openCache(async (_at, account, message) => { asked.push(`${account} ${message}`); });
    const cached = await seed(cache, {}, { text: 'CACHED' });
    expect((await readRouterItemForDelivery(cached.source)).body?.text).toBe('CACHED');
    const refused = await seed(cache, { messageId: 'INBOX:1:12', rfcMessageId: '<a-12@marina.example.invalid>', envelopeHash: 'hash-a-12' });
    await cache.store.setMessageBodyError(refused.rowid, 'too-large');
    const content = await readRouterItemForDelivery({ ...refused.source, version: await versionNow(cache, ACCOUNT_A, 'INBOX:1:12') });
    expect(content.bodyAvailable).toBe(false);
    expect(asked).toEqual([]);
  });

  it('a delivery read whose fetch failed, or met another delivery, hands over the confirmed copy as cached', async () => {
    let mode: 'fail' | 'other' = 'fail';
    const cache = await openCache(async (at, account, message) => {
      if (mode === 'fail') throw new Error('provider down');
      const row = (await at.store.getMessage(account, message))!;
      await replaceBody(at, row.rowid, 'ANOTHER_DELIVERY');
      await at.db.run('UPDATE messages SET subject = ? WHERE rowid = ?', ['A different subject', row.rowid]);
    });
    const seeded = await seed(cache, {});
    const failed = await readRouterItemForDelivery(seeded.source);
    expect(failed.bodyAvailable).toBe(false);
    expect(failed.item.subject).toBe('Invoice for October');
    mode = 'other';
    // The confirmed copy is gone from the cache (a later delivery replaced it): no content is handed over as its.
    await expect(readRouterItemForDelivery(seeded.source)).rejects.toMatchObject({ code: 'source_changed' });
  });

  it('reports a body that can never be fetched as null, without trying', async () => {
    const cache = await openCache();
    const seeded = await seed(cache, {});
    await cache.store.setMessageBodyError(seeded.rowid, 'too_large');
    const content = await readRouterItem(seeded.source);
    expect(content.body).toBeNull();
    expect(content.bodyAvailable).toBe(false);
  });

  it('refuses a confirmed body whose files disappeared without fetching or changing flags', async () => {
    const cache = await openCache();
    const seeded = await seed(cache, {}, { text: 'GONE_CANARY' });
    const before = await flagState(cache, seeded.rowid);
    await fsp.rm(path.join(cache.root, 'bodies'), { recursive: true, force: true });
    await expect(readRouterItem(seeded.source)).rejects.toMatchObject({ code: 'source_changed' });
    expect(await flagState(cache, seeded.rowid)).toEqual(before);
  });

  it.each(['text', 'html', 'both'] as const)('refuses missing or altered halves of a confirmed %s body', async (format) => {
    for (const mutation of ['remove-text', 'remove-html', 'replace-text', 'replace-html']) {
      const cache = await openCache();
      const body = format === 'text' ? { text: 'TEXT_CANARY' }
        : format === 'html' ? { html: '<p>HTML_CANARY</p>' }
        : { text: 'TEXT_CANARY', html: '<p>HTML_CANARY</p>' };
      const seeded = await seed(cache, {}, body);
      const half = mutation.endsWith('text') ? 'txt' : 'html';
      if (format === 'text' && mutation === 'remove-html') continue;
      const file = path.join(cache.root, `${seeded.ref}.${half}`);
      if (mutation.startsWith('remove')) await fsp.rm(file, { force: true });
      else await fsp.writeFile(file, 'ALTERED_CANARY');
      await expect(readRouterItem(seeded.source)).rejects.toMatchObject({ code: 'source_changed' });
    }
  });

  it('accepts an intact empty body and verifies its exact account and message', async () => {
    const cache = await openCache();
    const seeded = await seed(cache, {}, { text: '' });
    expect((await readRouterItem(seeded.source)).body).toEqual({ text: '' });
    await expect(cache.bodies.read(seeded.ref!, { accountId: ACCOUNT_B, messageId: seeded.source.message })).rejects.toThrow('changed');
    await expect(cache.bodies.read(seeded.ref!, { accountId: ACCOUNT_A, messageId: 'other' })).rejects.toThrow('changed');
  });

  it('takes only the mail store and the body store, and imports no provider, service or sync path', async () => {
    expect(registerMailRouterSource.length).toBe(2);
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/integrations/mail/router-source.ts');
    const text = await fsp.readFile(file, 'utf8');
    const imports = [...text.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gms)].map((m) => m[1]).sort();
    expect(imports).toEqual([
      '../../core/router/source-registry.js',
      '../../core/router/types.js',
      './bodies.js',
      './store.js',
      'node:crypto',
    ]);
    expect(text).not.toMatch(/\bgetBody\b|\bproviders?\.\w|readMessage\(|\bfetch\(/);
  });

  it('every production body reader validates the exact account and message snapshot', async () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/integrations/mail');
    const readers: string[] = [];
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const code = (await fsp.readFile(path.join(dir, entry.name), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
      if (!/\bbodies\.read\(/.test(code)) continue;
      readers.push(entry.name);
      const calls = [...code.matchAll(/\bbodies\.read\(([^\n;]+)/g)].map((one) => one[1]);
      for (const call of calls) {
        expect(call, entry.name).toContain('accountId: row.account_id');
        expect(call, entry.name).toContain('messageId: row.message_id');
      }
    }
    expect(readers.sort()).toEqual(['router-source.ts', 'service.ts']);
  });
});

describe('mail router source: attachments and flags', () => {
  it('returns attachment metadata only, never ids or content, and says content is unavailable', async () => {
    const cache = await openCache();
    const seeded = await seed(cache, {
      attachmentsJson: JSON.stringify([
        { id: 'part-2', filename: 'invoice.pdf', mimeType: 'application/pdf', bytes: 1234, content: 'ATTACHMENT_CONTENT_CANARY' },
        { id: 'part-3', filename: 42, mimeType: 'image/png', data: 'ATTACHMENT_DATA_CANARY' },
        { bytes: '9' },
      ]),
    }, { text: 'see attached' });
    const content = await readRouterItem(seeded.source);
    expect(content.attachments).toEqual([
      { filename: 'invoice.pdf', mimeType: 'application/pdf', bytes: 1234 },
      { mimeType: 'image/png' },
      {},
    ]);
    expect(content.attachmentsAvailable).toBe(false);
    const text = JSON.stringify(content);
    expect(text).not.toContain('ATTACHMENT_CONTENT_CANARY');
    expect(text).not.toContain('ATTACHMENT_DATA_CANARY');
    expect(text).not.toContain('part-2');
  });

  it('reads damaged attachment metadata as none instead of failing or fetching', async () => {
    const cache = await openCache();
    const seeded = await seed(cache, { attachmentsJson: '{not json' }, { text: 'still readable' });
    const content = await readRouterItem(seeded.source);
    expect(content.attachments).toEqual([]);
    expect(content.attachmentsAvailable).toBe(false);
    expect(content.body?.text).toBe('still readable');
  });

  it('changes no flag, read state or row when the router resolves and reads an unread message', async () => {
    const cache = await openCache();
    const seeded = await seed(cache, { flagsJson: '["\\\\Flagged"]' }, { text: 'unread body' });
    const before = await cache.store.getMessage(ACCOUNT_A, 'INBOX:1:10');
    const flagsBefore = await flagState(cache, seeded.rowid);
    expect(flagsBefore).toMatchObject({ seen: 0 });

    await resolveRouterItem(seeded.source);
    await readRouterItem(seeded.source);
    await readRouterItem(seeded.source);

    expect(await flagState(cache, seeded.rowid)).toEqual(flagsBefore);
    expect(await cache.store.getMessage(ACCOUNT_A, 'INBOX:1:10')).toEqual(before);
  });
});

describe('mail router source: which confirmed snapshots are still current', () => {
  it('a later reply, a body change or a lost row makes the old snapshot not current; the new version is', async () => {
    const cache = await openCache();
    const replied = await seed(cache, {}, { text: 'FIRST_CANARY' });
    const rebodied = await seed(cache, { messageId: 'INBOX:1:11', rfcMessageId: '<a-11@marina.example.invalid>', envelopeHash: 'hash-a-11' }, { text: 'OLD_CANARY' });
    const kept = await seed(cache, { messageId: 'INBOX:1:12', rfcMessageId: '<a-12@marina.example.invalid>', envelopeHash: 'hash-a-12' });
    const asked = [replied.source, rebodied.source, kept.source, source(ACCOUNT_A, 'INBOX:1:99', 'never-cached'), unversioned(ACCOUNT_A, 'INBOX:1:12')];
    expect(await currentRouterSources(asked)).toEqual([replied.source, rebodied.source, kept.source]);

    await cache.store.updateMessage(replied.rowid, envelope({ sentAt: SENT + 1000, receivedAt: SENT + 1000, envelopeHash: 'reply' }), NOW + 1000);
    await replaceBody(cache, rebodied.rowid, 'NEW_CANARY', { messageId: 'INBOX:1:11' });
    const next = [
      source(ACCOUNT_A, 'INBOX:1:10', await versionNow(cache, ACCOUNT_A, 'INBOX:1:10')),
      source(ACCOUNT_A, 'INBOX:1:11', await versionNow(cache, ACCOUNT_A, 'INBOX:1:11')),
    ];
    expect(await currentRouterSources([...asked, ...next])).toEqual([kept.source, ...next]);
  });

  it('checks 200 items across accounts with one cache query per account, no single-row lookup, body read or write', async () => {
    const cache = await openCache();
    const sources: RouterSource[] = [];
    for (let i = 0; i < 200; i++) {
      const accountId = i % 2 ? ACCOUNT_B : ACCOUNT_A;
      const seeded = await seed(cache, { accountId, messageId: `INBOX:2:${i}`, rfcMessageId: `<b-${i}@marina.example.invalid>`, envelopeHash: `hash-${i}` });
      sources.push(seeded.source);
    }
    // The same message id under the other account is that account's message, never this one's version.
    sources.push(source(ACCOUNT_A, 'INBOX:2:1', sources[1]!.version!));
    const before = await cache.db.all('SELECT * FROM messages ORDER BY rowid');
    const batch = vi.spyOn(cache.store, 'messagesByIds');
    const single = vi.spyOn(cache.store, 'getMessage');
    const body = vi.spyOn(cache.bodies, 'read');
    try {
      expect(await currentRouterSources(sources)).toEqual(sources.slice(0, 200));
      expect(batch.mock.calls.map(([account, ids]) => [account, ids.length]).sort()).toEqual([[ACCOUNT_A, 101], [ACCOUNT_B, 100]]);
      expect(single).not.toHaveBeenCalled();
      expect(body).not.toHaveBeenCalled();
    } finally { batch.mockRestore(); single.mockRestore(); body.mockRestore(); }
    expect(await cache.db.all('SELECT * FROM messages ORDER BY rowid')).toEqual(before);
  });

  it('a cache read that fails is unavailable, never an empty answer', async () => {
    const cache = await openCache();
    const seeded = await seed(cache, {});
    const spy = vi.spyOn(cache.store, 'messagesByIds').mockRejectedValue(new Error('database is locked'));
    try {
      await expect(currentRouterSources([seeded.source])).rejects.toMatchObject({ code: 'source_unavailable' });
    } finally { spy.mockRestore(); }
    expect(await currentRouterSources([seeded.source])).toEqual([seeded.source]);
  });
});

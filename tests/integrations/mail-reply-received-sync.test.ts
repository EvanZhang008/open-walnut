/**
 * A reply on a conversation-shaped handle is announced as new mail by the poll loop.
 *
 * A conversation transport lists one row per thread, so a reply comes back as the SAME message id
 * with later delivery instants: an `updated` cache row, never an `added` one. `messages-received`
 * used to count `added`, so every reply on a known thread was silent. Driven through `MailSync` with
 * the real service, store and body store on a temp directory, and a fixture provider whose listing
 * the test controls; only the plugin host and the event sink are stand-ins.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginDatabaseClient } from '../../src/core/plugins/plugin-storage.js';
import type { WalnutServerPluginApi } from '../../src/core/plugins/server-api.js';
import { MailBodyStore } from '../../src/integrations/mail/bodies.js';
import { MailDatabase } from '../../src/integrations/mail/db.js';
import type { MailHeadline } from '../../src/integrations/mail/events.js';
import { MailProviderRegistry } from '../../src/integrations/mail/provider-registry.js';
import { mailRouterKey, mailRowDeliveryVersion } from '../../src/integrations/mail/router-source.js';
import { MailService } from '../../src/integrations/mail/service.js';
import { MailStore } from '../../src/integrations/mail/store.js';
import { MailSync, type MailSyncHost } from '../../src/integrations/mail/sync.js';
import type { MailEnvelope, MailProviderSpec } from '../../src/integrations/mail/types.js';

const ACCOUNT = 'thready:acct-1';
const THREAD = 'inbox:conv-quartz';
const FIRST_AT = Date.UTC(2026, 7, 31, 16, 47, 45);
const REPLY_AT = Date.UTC(2026, 8, 18, 0, 25, 41);
const SECOND_REPLY_AT = Date.UTC(2026, 8, 19, 7, 2, 9);

const open: Array<{ db: MailDatabase; sync: MailSync }> = [];
const roots: string[] = [];

afterEach(async () => {
  for (const one of open.splice(0)) {
    await one.sync.stop();
    await one.db.dispose().catch(() => undefined);
  }
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

function threadRow(over: Partial<MailEnvelope> = {}): MailEnvelope {
  return {
    messageId: THREAD,
    rfcMessageId: 'conv-quartz',
    mailboxId: 'inbox',
    from: { name: 'Stone, Alex', address: 'alex@example.invalid' },
    subject: 'RE: the runbook',
    snippet: 'Thank you very much!',
    sentAt: FIRST_AT,
    receivedAt: FIRST_AT,
    flags: [],
    ...over,
  };
}

async function harness() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mail-reply-received-'));
  roots.push(root);
  const client = new PluginDatabaseClient(path.join(root, 'plugin.sqlite'));
  const walnut = { storage: { get database() { return client; } } } as unknown as WalnutServerPluginApi;
  const db = new MailDatabase(walnut);
  const store = new MailStore(db);
  const bodies = new MailBodyStore(root);
  const providers = new MailProviderRegistry(() => undefined);
  const listing: { current: MailEnvelope[] } = { current: [threadRow()] };
  const bodyText = { current: 'Thank you very much! Alex (the August message)' };
  const spec: MailProviderSpec = {
    id: 'thready',
    label: 'A conversation-shaped fixture',
    capabilities: {
      search: false, watch: false, drafts: false, markRead: false, flags: false,
      threads: false, send: false, sendAsReply: false, bodies: 'text', attachments: 'none',
    },
    setup: {
      fields: [{ name: 'address', label: 'Address', kind: 'text' }],
      submit: async () => { throw new Error('this fixture adds accounts by hand'); },
    },
    listAccounts: async () => [],
    health: async () => ({ state: 'ok', checkedAt: Date.now() }),
    listMailboxes: async () => [{ mailboxId: 'inbox', name: 'Inbox', role: 'inbox', unread: 0, total: 1 }],
    poll: async () => ({ messages: listing.current, cursor: 'c1', more: false }),
    getBody: async () => {
      const text = bodyText.current;
      return { format: 'text' as const, text, bytes: Buffer.byteLength(text) };
    },
    send: async () => ({ acceptedAt: Date.now() }),
  };
  providers.register(spec, 'the-fixture-plugin');
  const service = new MailService({ store, bodies, providers });
  await store.upsertAccount({
    accountId: ACCOUNT, providerId: 'thready', displayName: 'A mailbox',
    address: 'quartz@example.invalid', state: 'active', healthJson: null, payload: '{}',
  });

  const received: Array<{ count: number; headlines: MailHeadline[]; importantAdded: number }> = [];
  /** The row's version at the moment each event went out, read in the same DB order as the event. */
  const versionsAtEmit: Array<Promise<string | undefined>> = [];
  const completed: Array<{ added: number; updated: number }> = [];
  const host = {
    replica: false,
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    config: { get: async () => ({}), onChange: () => ({ dispose: () => undefined }) },
    timers: { interval: () => ({ dispose: () => undefined }), timeout: () => ({ dispose: () => undefined }) },
    notifications: { error: async () => undefined, recover: async () => undefined },
  } satisfies MailSyncHost;
  const sync = new MailSync({
    walnut: host as never,
    store,
    service,
    retention: {
      retain: async () => ({ messagesDeleted: 0, bodiesDropped: 0, incomplete: false }),
      resetContainer: async () => undefined,
    } as never,
    events: {
      syncCompleted: (event: { added: number; updated: number }) => { completed.push({ added: event.added, updated: event.updated }) },
      messagesReceived: (_account: string, count: number, headlines: MailHeadline[], importantAdded: number) => {
        // The real sink's own rule (events.ts): a tick with nothing new says nothing.
        if (count <= 0 && importantAdded <= 0) return;
        received.push({ count, headlines, importantAdded });
        versionsAtEmit.push(store.getMessage(ACCOUNT, THREAD).then((row) => (row ? mailRowDeliveryVersion(row) : undefined)));
      },
      accountHealth: () => undefined,
      mailboxCounts: () => undefined,
    } as never,
  });
  open.push({ db, sync });
  return { store, bodies, root, sync, listing, bodyText, received, completed, versionsAtEmit };
}

/** A reply's headline; its version is checked against the row as it stood when the event went out. */
function headline() {
  return {
    from: 'alex@example.invalid',
    subject: 'RE: the runbook',
    messageId: THREAD,
    version: expect.stringMatching(/^[0-9a-f]{64}$/),
    // The RFC scope, unversioned: the delivery rides `version`.
    canonicalKey: mailRouterKey(ACCOUNT, THREAD, 'conv-quartz'),
  };
}

describe('a reply on a known thread handle reaches messages-received', () => {
  it('counts each reply once, keeps added/updated for sync-completed, and is quiet on a repeat or a flag change', async () => {
    const mail = await harness();

    // Tick 1 is the backfill: the row is added, nothing announced, and the body is prefetched.
    await mail.sync.runTick({ force: true });
    expect(mail.received).toEqual([]);
    expect(mail.completed).toEqual([{ added: 1, updated: 0 }]);
    const firstRef = (await mail.store.knownMessages(ACCOUNT, [THREAD])).get(THREAD)?.body_ref;
    expect(firstRef).toBeTruthy();

    // The reply lands on the same handle.
    mail.listing.current = [threadRow({ sentAt: REPLY_AT, receivedAt: REPLY_AT, snippet: 'Yes, correct' })];
    mail.bodyText.current = 'Yes, that is generally correct. Cameron (the reply)';
    await mail.sync.runTick({ force: true });
    expect(mail.completed.at(-1)).toEqual({ added: 0, updated: 1 });
    expect(mail.received).toEqual([{ count: 1, headlines: [headline()], importantAdded: 1 }]);
    // The August body went from disk; the prefetch read the reply's.
    expect(await fsp.stat(path.join(mail.root, `${firstRef}.txt`)).then(() => true, () => false)).toBe(false);

    // The same reply polled again: nothing new.
    await mail.sync.runTick({ force: true });
    expect(mail.completed.at(-1)).toEqual({ added: 0, updated: 0 });
    expect(mail.received).toHaveLength(1);

    // A flag change with the same instants: the row is rewritten, and it is still no new mail.
    mail.listing.current = [threadRow({ sentAt: REPLY_AT, receivedAt: REPLY_AT, snippet: 'Yes, correct', flags: ['\\Seen'] })];
    await mail.sync.runTick({ force: true });
    expect(mail.completed.at(-1)).toEqual({ added: 0, updated: 1 });
    expect(mail.received).toHaveLength(1);

    // A second reply is its own delivery with its own version.
    mail.listing.current = [threadRow({ sentAt: SECOND_REPLY_AT, receivedAt: SECOND_REPLY_AT })];
    await mail.sync.runTick({ force: true });
    expect(mail.received).toEqual([
      { count: 1, headlines: [headline()], importantAdded: 1 },
      { count: 1, headlines: [headline()], importantAdded: 1 },
    ]);
    expect(mail.received[0]?.headlines[0]?.version).not.toBe(mail.received[1]?.headlines[0]?.version);
    // Each event names the exact snapshot it announced: the prefetch runs only after it.
    const atEmit = await Promise.all(mail.versionsAtEmit);
    expect(atEmit).toEqual(mail.received.map((one) => one.headlines[0]?.version));
  });
});

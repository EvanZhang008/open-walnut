/**
 * A provider retiring the identity of everything the base cached from it (contract 1.8.0).
 *
 * The base keys its cache by `messageId`. When a provider changes what a handle means (the case that
 * forced this: a conversation api whose rows were keyed by thread id, so one thread with an unread
 * item in the Inbox and a copy in Sent collapsed into ONE row that flipped folder on every poll and
 * lost the unread), every row written under the old scheme becomes a ghost no poll matches again.
 * `MailProviderSpec.identityRevision` is how the provider says so, and these cases grade the base's
 * half of it: the rows go, the files go, the cursors go, the meta row is written last and survives.
 *
 * A real plugin database and a real body store on a temp directory, for the same reason the body
 * revision cases use them: everything graded here is about what is on disk afterwards.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginDatabaseClient } from '../../src/core/plugins/plugin-storage.js';
import type { WalnutServerPluginApi } from '../../src/core/plugins/server-api.js';
import type { MailBaseApi } from '../../src/integrations/mail/api.js';
import { createMailBaseApi } from '../../src/integrations/mail/api.js';
import { MailBodyStore } from '../../src/integrations/mail/bodies.js';
import { MailDatabase } from '../../src/integrations/mail/db.js';
import { MailEvents } from '../../src/integrations/mail/events.js';
import {
  identityRevisionMetaKey,
  reconcileIdentityRevision,
  type IdentityRevisionResult,
} from '../../src/integrations/mail/identity-revision.js';
import { MailProviderRegistry } from '../../src/integrations/mail/provider-registry.js';
import { MailStore } from '../../src/integrations/mail/store.js';
import type { MailCapabilities, MailProviderSpec } from '../../src/integrations/mail/types.js';

const CAPABILITIES: MailCapabilities = {
  search: false, watch: false, drafts: false, markRead: false, flags: false,
  threads: false, send: false, sendAsReply: false, bodies: 'text', attachments: 'none',
};

interface Harness {
  root: string;
  db: MailDatabase;
  store: MailStore;
  bodies: MailBodyStore;
  api: MailBaseApi;
  scheduled: Array<() => void>;
  sweeps: IdentityRevisionResult[];
  runDeferred(): Promise<void>;
}

const open: MailDatabase[] = [];
const roots: string[] = [];

async function openBase(existingRoot?: string): Promise<Harness> {
  const root = existingRoot ?? await fsp.mkdtemp(path.join(os.tmpdir(), 'mail-identity-revision-'));
  if (!existingRoot) roots.push(root);
  const client = new PluginDatabaseClient(path.join(root, 'plugin.sqlite'));
  const walnut = {
    storage: { get database() { return client; } },
  } as unknown as WalnutServerPluginApi;
  const db = new MailDatabase(walnut);
  open.push(db);

  const store = new MailStore(db);
  const bodies = new MailBodyStore(root);
  const providers = new MailProviderRegistry(() => undefined);
  const events = new MailEvents(() => undefined);

  const scheduled: Array<() => void> = [];
  const sweeps: IdentityRevisionResult[] = [];
  const inflight: Array<Promise<unknown>> = [];
  const api = createMailBaseApi({
    providers,
    events,
    sync: {} as never,
    accounts: async () => [],
    caller: () => 'a-provider-plugin',
    adopt: async () => [],
    bodyRevision: async () => undefined,
    identityRevision: (providerId, revision) => {
      const work = reconcileIdentityRevision({ store, bodies }, providerId, revision);
      inflight.push(work.then((result) => { sweeps.push(result); }));
      return work.then(() => undefined);
    },
    defer: (run) => { scheduled.push(run); },
  });

  return {
    root, db, store, bodies, api, scheduled, sweeps,
    runDeferred: async () => {
      for (const run of scheduled.splice(0)) run();
      await Promise.all(inflight.splice(0));
    },
  };
}

afterEach(async () => {
  for (const db of open.splice(0)) await db.dispose().catch(() => undefined);
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
  vi.restoreAllMocks();
});

/** One setup field, so the only thing registering can schedule is a revision sweep. */
function fixtureProvider(id: string, identityRevision?: string): MailProviderSpec {
  return {
    id,
    label: id,
    capabilities: { ...CAPABILITIES },
    ...(identityRevision === undefined ? {} : { identityRevision }),
    setup: {
      fields: [{ name: 'address', label: 'Address', kind: 'text' }],
      submit: async () => { throw new Error('this fixture adds accounts by hand'); },
    },
    listAccounts: async () => [],
    health: async () => ({ state: 'ok', checkedAt: Date.now() }),
    listMailboxes: async () => [],
    poll: async () => ({ messages: [], cursor: 'c0', more: false }),
    getBody: async () => ({ format: 'text', text: 'a body', bytes: 6 }),
    send: async () => ({ acceptedAt: Date.now() }),
  };
}

async function seedAccount(one: Harness, accountId: string): Promise<void> {
  await one.store.upsertAccount({
    accountId,
    providerId: accountId.slice(0, accountId.indexOf(':')),
    displayName: 'A mailbox',
    address: 'quartz@example.invalid',
    state: 'active',
    healthJson: null,
    payload: '{}',
  });
  for (const mailboxId of ['inbox', 'sent']) {
    await one.store.upsertMailbox({ accountId, mailboxId, name: mailboxId, role: mailboxId, unread: 0, total: 0 });
    await one.store.setMailboxCursor(accountId, mailboxId, `cursor-${mailboxId}`, Date.UTC(2026, 0, 12));
  }
}

async function seedMessage(one: Harness, accountId: string, messageId: string, mailboxId = 'inbox'): Promise<number> {
  return one.store.insertMessage({
    accountId,
    messageId,
    rfcMessageId: `<${messageId}@example.invalid>`,
    mailboxId,
    threadId: null,
    fromAddr: 'quartz@example.invalid',
    subject: 'The runbook',
    snippet: 'what the envelope previewed',
    sentAt: Date.UTC(2026, 0, 12, 9, 0, 0),
    receivedAt: null,
    flagsJson: '[]',
    attachmentsJson: '[]',
    payload: JSON.stringify({ from: { address: 'quartz@example.invalid' } }),
    envelopeHash: `hash-${messageId}`,
  }, Date.UTC(2026, 0, 12, 9, 0, 0));
}

async function seedStoredBody(one: Harness, accountId: string, messageId: string): Promise<string> {
  const rowid = await seedMessage(one, accountId, messageId);
  const stored = await one.bodies.write(accountId, messageId, Date.UTC(2026, 0, 12, 9, 0, 0), {
    format: 'text', text: `body of ${messageId}`, bytes: 20,
  }, 'The runbook');
  await one.store.setMessageBody(rowid, {
    bodyRef: stored.ref, bodyBytes: stored.bytes, snippet: stored.snippet,
    payload: JSON.stringify({ bodyFormat: stored.format }),
  });
  return stored.ref;
}

async function exists(one: Harness, ref: string): Promise<boolean> {
  return fsp.stat(path.join(one.root, `${ref}.txt`)).then(() => true, () => false);
}

async function cursorsOf(one: Harness, accountId: string): Promise<Array<[string, string | null, number | null]>> {
  return (await one.store.listMailboxes(accountId)).map((row) => [row.mailbox_id, row.cursor, row.last_sync_at]);
}

describe('a changed identity revision', () => {
  it('drops every cached row, its body file and index entry, forgets the cursors, and records the revision last', async () => {
    const one = await openBase();
    await seedAccount(one, 'fake:one');
    const ref = await seedStoredBody(one, 'fake:one', 'thread-1');
    await seedMessage(one, 'fake:one', 'thread-2', 'sent');
    await one.store.indexMessage(1, { subject: 'The runbook', fromAddr: 'quartz', snippet: '', bodyText: 'body of thread-1' });
    expect(await one.db.all('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?', ['runbook'])).toHaveLength(1);

    // The provider ships the re-keying: thread ids become thread-in-folder ids.
    one.api.registerProvider(fixtureProvider('fake', 'folder-scoped-1'));
    expect(one.scheduled).toHaveLength(1);
    await one.runDeferred();

    expect(await one.store.countMessages('fake:one')).toBe(0);
    expect(await exists(one, ref)).toBe(false);
    expect(await one.db.all('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?', ['runbook'])).toEqual([]);
    // Cursors gone and sync times zeroed: the next poll walks each mailbox from the top.
    expect(await cursorsOf(one, 'fake:one')).toEqual([['inbox', null, 0], ['sent', null, 0]]);
    // The account and its mailboxes stay: what the provider says about them arrives every tick anyway.
    expect((await one.store.listMailboxes('fake:one')).map((row) => row.name)).toEqual(['inbox', 'sent']);
    expect(await one.store.tasks.getMeta(identityRevisionMetaKey('fake'))).toBe('folder-scoped-1');
    expect(one.sweeps).toEqual([{ swept: true, accounts: 1, messages: 2, mailboxes: 2 }]);
  });

  it('does nothing when the provider registers again with the same revision, and never without one', async () => {
    const one = await openBase();
    await seedAccount(one, 'fake:one');
    await seedMessage(one, 'fake:one', 'thread-1');

    const handle = one.api.registerProvider(fixtureProvider('fake', 'folder-scoped-1'));
    await one.runDeferred();
    expect(await one.store.countMessages('fake:one')).toBe(0);
    await seedMessage(one, 'fake:one', 'inbox:thread-1');

    handle.dispose();
    one.api.registerProvider(fixtureProvider('fake', 'folder-scoped-1'));
    await one.runDeferred();
    // A same-revision re-registration (every reload, every boot) must never cost a re-list.
    expect(await one.store.countMessages('fake:one')).toBe(1);
    expect(one.sweeps.filter((sweep) => sweep.swept)).toHaveLength(1);

    const plain = await openBase();
    await seedAccount(plain, 'fake:one');
    await seedMessage(plain, 'fake:one', 'thread-1');
    plain.api.registerProvider(fixtureProvider('fake'));
    // Not even armed: a provider whose handles never changed opens no database on registration.
    expect(plain.scheduled).toEqual([]);
    expect(await plain.store.countMessages('fake:one')).toBe(1);
    expect(await plain.store.tasks.getMeta(identityRevisionMetaKey('fake'))).toBeUndefined();
  });

  it('wipes only the accounts of the provider whose revision moved', async () => {
    const one = await openBase();
    await seedAccount(one, 'fake:one');
    await seedAccount(one, 'other:one');
    await seedMessage(one, 'fake:one', 'thread-1');
    const otherRef = await seedStoredBody(one, 'other:one', 'thread-1');

    one.api.registerProvider(fixtureProvider('fake', 'folder-scoped-1'));
    one.api.registerProvider(fixtureProvider('other', 'other-1'));
    await one.runDeferred();

    // Both swept once (both revisions were new), but each only over its own accounts.
    expect(await one.store.countMessages('fake:one')).toBe(0);
    expect(await one.store.countMessages('other:one')).toBe(0);
    expect(await exists(one, otherRef)).toBe(false);
    expect(one.sweeps.map((sweep) => [sweep.accounts, sweep.messages])).toEqual([[1, 1], [1, 1]]);
    expect(await one.store.tasks.getMeta(identityRevisionMetaKey('other'))).toBe('other-1');
  });

  it('remembers the revision across a restart, so a reboot is not a re-list of every mailbox', async () => {
    const first = await openBase();
    await seedAccount(first, 'fake:one');
    first.api.registerProvider(fixtureProvider('fake', 'folder-scoped-1'));
    await first.runDeferred();
    await seedMessage(first, 'fake:one', 'inbox:thread-1');
    await first.store.setMailboxCursor('fake:one', 'inbox', 'cursor-after', Date.UTC(2026, 0, 13));
    await first.db.dispose();

    const next = await openBase(first.root);
    next.api.registerProvider(fixtureProvider('fake', 'folder-scoped-1'));
    await next.runDeferred();

    expect(next.sweeps).toEqual([{ swept: false, accounts: 0, messages: 0, mailboxes: 0 }]);
    expect(await next.store.countMessages('fake:one')).toBe(1);
    expect((await cursorsOf(next, 'fake:one'))[0]).toEqual(['inbox', 'cursor-after', Date.UTC(2026, 0, 13)]);
  });

  it('walks 450 rows in pages rather than one statement, and removes every body file', async () => {
    const one = await openBase();
    await seedAccount(one, 'fake:one');
    const refs: string[] = [];
    for (let index = 0; index < 450; index += 1) {
      refs.push(await seedStoredBody(one, 'fake:one', `thread-${index}`));
    }
    one.api.registerProvider(fixtureProvider('fake', 'folder-scoped-1'));
    const paged = vi.spyOn(one.store, 'rowsForAccount');

    await one.runDeferred();

    expect(one.sweeps).toEqual([{ swept: true, accounts: 1, messages: 450, mailboxes: 2 }]);
    // 200 + 200 + 50: a page at a time, and the short page ends it.
    expect(paged.mock.calls.map(([, limit]) => limit)).toEqual([200, 200, 200]);
    expect(await one.store.countMessages('fake:one')).toBe(0);
    const stillThere: string[] = [];
    for (const ref of refs) if (await exists(one, ref)) stillThere.push(ref);
    expect(stillThere).toEqual([]);
  }, 60_000);
});

/**
 * A provider retiring the bodies the base cached from it (contract 1.7.0).
 *
 * The base caches every fetched body on disk and serves it forever, which is right for bytes that
 * cannot change. The provider's own READING of those bytes does change: a helper that decoded every
 * message as the wrong charset is fixed, and every body fetched before the fix stays wrong in the
 * cache, because no read path ever asks for one it already has. `MailProviderSpec.bodyRevision` is
 * how a provider says so, and these cases grade the base's half of it.
 *
 * Graded against a REAL plugin database (the worker-thread SQLite the plugin runs on, with the real
 * migrations) and the real body store on a temp directory, because the properties here are all about
 * what is on disk afterwards: a row whose `body_ref` is gone, a file that is really unlinked, a meta
 * row that survives a restart. A fake store could not tell those apart from "the sweep said it did
 * it". No server is booted: the sweep never touches HTTP.
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
import {
  bodyRevisionMetaKey,
  reconcileBodyRevision,
  type BodyRevisionResult,
} from '../../src/integrations/mail/body-revision.js';
import { MailDatabase } from '../../src/integrations/mail/db.js';
import { MailEvents } from '../../src/integrations/mail/events.js';
import { MailProviderRegistry } from '../../src/integrations/mail/provider-registry.js';
import { MailService } from '../../src/integrations/mail/service.js';
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
  service: MailService;
  providers: MailProviderRegistry;
  api: MailBaseApi;
  /** What `defer` was handed, in order. The base never runs a sweep inside registerProvider. */
  scheduled: Array<() => void>;
  /** Every sweep that has finished, so a test can state the counts it walked. */
  sweeps: BodyRevisionResult[];
  /** Run what is scheduled and wait for the sweeps it starts. */
  runDeferred(): Promise<void>;
}

const open: MailDatabase[] = [];
const roots: string[] = [];

/**
 * The base over one directory: a real plugin database, the real body store, and the real sweep
 * wired the way index.ts wires it.
 *
 * `root` is reusable on purpose. Calling this twice over the same directory is exactly the restart
 * case: a new database handle and a new service over the same file and the same body files.
 */
async function openBase(existingRoot?: string): Promise<Harness> {
  const root = existingRoot ?? await fsp.mkdtemp(path.join(os.tmpdir(), 'mail-body-revision-'));
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
  const service = new MailService({ store, bodies, providers });

  const scheduled: Array<() => void> = [];
  const sweeps: BodyRevisionResult[] = [];
  const inflight: Array<Promise<unknown>> = [];
  const api = createMailBaseApi({
    providers,
    events,
    sync: {} as never,
    accounts: async () => [],
    caller: () => 'a-provider-plugin',
    adopt: async () => [],
    bodyRevision: (providerId, revision) => {
      const work = reconcileBodyRevision({ store, bodies }, providerId, revision);
      inflight.push(work.then((result) => { sweeps.push(result); }));
      return work.then(() => undefined);
    },
    defer: (run) => { scheduled.push(run); },
  });

  return {
    root,
    db,
    store,
    bodies,
    service,
    providers,
    api,
    scheduled,
    sweeps,
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

/**
 * A provider with ONE setup field, so the only thing it can schedule is the revision sweep.
 *
 * A field-less provider is swept for accounts as well (contract 1.6.0), which is a second deferred
 * job and would blur every "what did registering arm" assertion below. The provider this feature
 * was built for declares a field too.
 */
function fixtureProvider(id: string, text: () => string, bodyRevision?: string): {
  spec: MailProviderSpec;
  getBody: ReturnType<typeof vi.fn>;
} {
  const getBody = vi.fn(async () => {
    const value = text();
    return { format: 'text' as const, text: value, bytes: Buffer.byteLength(value) };
  });
  return {
    spec: {
      id,
      label: id,
      capabilities: { ...CAPABILITIES },
      ...(bodyRevision === undefined ? {} : { bodyRevision }),
      setup: {
        fields: [{ name: 'address', label: 'Address', kind: 'text' }],
        submit: async () => { throw new Error('this fixture adds accounts by hand'); },
      },
      listAccounts: async () => [],
      health: async () => ({ state: 'ok', checkedAt: Date.now() }),
      listMailboxes: async () => [],
      poll: async () => ({ messages: [], cursor: 'c0', more: false }),
      getBody,
      send: async () => ({ acceptedAt: Date.now() }),
    },
    getBody,
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
}

async function seedMessage(one: Harness, accountId: string, messageId: string): Promise<number> {
  return one.store.insertMessage({
    accountId,
    messageId,
    rfcMessageId: `<${messageId}@example.invalid>`,
    mailboxId: 'INBOX',
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

/** A stored body without going through a provider: what the bulk case needs 450 of. */
async function seedStoredBody(one: Harness, accountId: string, messageId: string, text: string): Promise<string> {
  const rowid = await seedMessage(one, accountId, messageId);
  const stored = await one.bodies.write(accountId, messageId, Date.UTC(2026, 0, 12, 9, 0, 0), {
    format: 'text', text, bytes: Buffer.byteLength(text),
  }, 'The runbook');
  await one.store.setMessageBody(rowid, {
    bodyRef: stored.ref,
    bodyBytes: stored.bytes,
    snippet: stored.snippet,
    payload: JSON.stringify({ bodyFormat: stored.format, bodyTruncated: stored.truncated }),
  });
  return stored.ref;
}

async function bodyRefOf(one: Harness, accountId: string, messageId: string): Promise<string | null> {
  return (await one.store.getMessage(accountId, messageId))?.body_ref ?? null;
}

async function exists(one: Harness, ref: string): Promise<boolean> {
  return fsp.stat(path.join(one.root, `${ref}.txt`)).then(() => true, () => false);
}

describe('a changed body revision', () => {
  it('clears every cached body once, keeps the envelope, and serves the repaired body next open', async () => {
    const one = await openBase();
    await seedAccount(one, 'fake:one');
    await seedMessage(one, 'fake:one', 'm-1');
    let text = 'body v1';

    const before = fixtureProvider('fake', () => text, 'repair-1');
    const handle = one.api.registerProvider(before.spec);
    // Registering only SCHEDULES: the sweep opens the cache, and a plugin has 20 seconds in total.
    expect(one.scheduled).toHaveLength(1);
    await one.runDeferred();

    const read = await one.service.readMessage('fake:one', 'm-1');
    expect(read.body?.text).toBe('body v1');
    expect(before.getBody).toHaveBeenCalledTimes(1);
    const ref = await bodyRefOf(one, 'fake:one', 'm-1');
    expect(ref).toBeTruthy();
    expect(await exists(one, ref!)).toBe(true);

    // The provider ships its fix: a new revision, and a body that now decodes correctly.
    handle.dispose();
    text = 'body v2';
    const after = fixtureProvider('fake', () => text, 'repair-2');
    one.api.registerProvider(after.spec);
    expect(one.scheduled).toHaveLength(1);
    await one.runDeferred();

    const row = (await one.store.getMessage('fake:one', 'm-1'))!;
    expect(row.body_ref).toBeNull();
    expect(row.body_bytes).toBeNull();
    // The ENVELOPE is untouched, which is what keeps the message in every list it was in.
    expect(row.subject).toBe('The runbook');
    expect(row.rfc_message_id).toBe('<m-1@example.invalid>');
    expect(await exists(one, ref!)).toBe(false);
    expect(await one.store.tasks.getMeta(bodyRevisionMetaKey('fake'))).toBe('repair-2');
    expect(one.sweeps).toEqual([
      { swept: true, accounts: 1, bodies: 0 },
      { swept: true, accounts: 1, bodies: 1 },
    ]);

    // One lazy re-fetch, on the next open, and the human sees the repaired text.
    const again = await one.service.readMessage('fake:one', 'm-1');
    expect(again.body?.text).toBe('body v2');
    expect(after.getBody).toHaveBeenCalledTimes(1);
    expect(await bodyRefOf(one, 'fake:one', 'm-1')).toBe(ref);
  });

  it('does nothing at all when the provider registers again with the same revision', async () => {
    const one = await openBase();
    await seedAccount(one, 'fake:one');
    await seedMessage(one, 'fake:one', 'm-1');

    const before = fixtureProvider('fake', () => 'body v1', 'repair-1');
    const handle = one.api.registerProvider(before.spec);
    await one.runDeferred();
    await one.service.readMessage('fake:one', 'm-1');
    const ref = await bodyRefOf(one, 'fake:one', 'm-1');

    handle.dispose();
    const again = fixtureProvider('fake', () => 'body v2', 'repair-1');
    one.api.registerProvider(again.spec);
    await one.runDeferred();

    expect(await bodyRefOf(one, 'fake:one', 'm-1')).toBe(ref);
    expect(await exists(one, ref!)).toBe(true);
    // The cached body is still served, so the provider is never asked again: an unchanged revision
    // must not cost a re-fetch of the whole mailbox.
    const read = await one.service.readMessage('fake:one', 'm-1');
    expect(read.body?.text).toBe('body v1');
    expect(again.getBody).not.toHaveBeenCalled();
    expect(one.sweeps.filter((sweep) => sweep.swept)).toHaveLength(1);
  });

  it('never sweeps for a provider that declares no revision, however often it re-registers', async () => {
    const one = await openBase();
    await seedAccount(one, 'fake:one');
    await seedMessage(one, 'fake:one', 'm-1');

    const before = fixtureProvider('fake', () => 'body v1');
    const handle = one.api.registerProvider(before.spec);
    // Nothing is even armed: a provider whose decoding never changed must not open the cache on
    // every registration to be told there is nothing to do.
    expect(one.scheduled).toEqual([]);
    await one.service.readMessage('fake:one', 'm-1');
    const ref = await bodyRefOf(one, 'fake:one', 'm-1');

    handle.dispose();
    const again = fixtureProvider('fake', () => 'body v2');
    one.api.registerProvider(again.spec);
    expect(one.scheduled).toEqual([]);
    await one.runDeferred();

    expect(await bodyRefOf(one, 'fake:one', 'm-1')).toBe(ref);
    expect(await exists(one, ref!)).toBe(true);
    expect(await one.store.tasks.getMeta(bodyRevisionMetaKey('fake'))).toBeUndefined();
    expect(one.sweeps).toEqual([]);
  });

  it('clears only the accounts of the provider whose revision moved', async () => {
    const one = await openBase();
    await seedAccount(one, 'fake:one');
    await seedAccount(one, 'other:one');
    await seedMessage(one, 'fake:one', 'm-1');
    await seedMessage(one, 'other:one', 'm-1');

    const fake = fixtureProvider('fake', () => 'body v1', 'repair-1');
    const other = fixtureProvider('other', () => 'other body', 'other-1');
    const fakeHandle = one.api.registerProvider(fake.spec);
    one.api.registerProvider(other.spec);
    await one.runDeferred();
    await one.service.readMessage('fake:one', 'm-1');
    await one.service.readMessage('other:one', 'm-1');
    const fakeRef = await bodyRefOf(one, 'fake:one', 'm-1');
    const otherRef = await bodyRefOf(one, 'other:one', 'm-1');

    fakeHandle.dispose();
    one.api.registerProvider(fixtureProvider('fake', () => 'body v2', 'repair-2').spec);
    await one.runDeferred();

    expect(await bodyRefOf(one, 'fake:one', 'm-1')).toBeNull();
    expect(await exists(one, fakeRef!)).toBe(false);
    // The other provider's account is not this provider's business, and its meta row is its own.
    expect(await bodyRefOf(one, 'other:one', 'm-1')).toBe(otherRef);
    expect(await exists(one, otherRef!)).toBe(true);
    expect(await one.store.tasks.getMeta(bodyRevisionMetaKey('other'))).toBe('other-1');
    expect(one.sweeps.at(-1)).toEqual({ swept: true, accounts: 1, bodies: 1 });
  });

  it('remembers the revision across a restart, so a reboot is not a re-fetch of every body', async () => {
    const first = await openBase();
    await seedAccount(first, 'fake:one');
    await seedMessage(first, 'fake:one', 'm-1');
    first.api.registerProvider(fixtureProvider('fake', () => 'body v1', 'repair-1').spec);
    await first.runDeferred();
    await first.service.readMessage('fake:one', 'm-1');
    const ref = await bodyRefOf(first, 'fake:one', 'm-1');
    await first.db.dispose();

    // The same directory, a new database handle and a new service: what the next boot has.
    const next = await openBase(first.root);
    const after = fixtureProvider('fake', () => 'body v2', 'repair-1');
    next.api.registerProvider(after.spec);
    await next.runDeferred();

    expect(next.sweeps).toEqual([{ swept: false, accounts: 0, bodies: 0 }]);
    expect(await bodyRefOf(next, 'fake:one', 'm-1')).toBe(ref);
    expect(await exists(next, ref!)).toBe(true);
    const read = await next.service.readMessage('fake:one', 'm-1');
    expect(read.body?.text).toBe('body v1');
    expect(after.getBody).not.toHaveBeenCalled();
  });

  it('walks 450 cached bodies in pages rather than one statement, and clears all of them', async () => {
    const one = await openBase();
    await seedAccount(one, 'fake:one');
    const refs: string[] = [];
    for (let index = 0; index < 450; index += 1) {
      refs.push(await seedStoredBody(one, 'fake:one', `m-${index}`, `body v1 number ${index}`));
    }
    one.api.registerProvider(fixtureProvider('fake', () => 'body v2', 'repair-1').spec);
    const paged = vi.spyOn(one.store, 'bodiedForAccount');

    await one.runDeferred();

    expect(one.sweeps).toEqual([{ swept: true, accounts: 1, bodies: 450 }]);
    // 200 + 200 + 50: a page at a time, and the short page is what ends it. One giant SELECT would
    // be a single call, and an account with 50,000 bodies is the case this shape exists for.
    expect(paged.mock.calls.map(([, limit]) => limit)).toEqual([200, 200, 200]);
    expect(await one.store.bodiedForAccount('fake:one', 500)).toEqual([]);
    const stillThere: string[] = [];
    for (const ref of refs) if (await exists(one, ref)) stillThere.push(ref);
    expect(stillThere).toEqual([]);
    // Every envelope is still a row, which is the whole difference between this and retention.
    expect(await one.store.countMessages('fake:one')).toBe(450);
  }, 60_000);
});

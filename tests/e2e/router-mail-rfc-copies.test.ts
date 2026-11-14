/**
 * Two cached mails that carry one RFC Message-ID (a sender chooses it), on a real server: the real
 * mail cache and its real router adapter, the real account intake (confirmAccountArrivals) and the
 * real ledger and delivered text. Only the session send is a stand-in; nothing starts a model, and
 * every file lives in this test's own mocked WALNUT_HOME. All names are invented.
 *
 * Since 2026-11-14 a bound mailbox's new mail enters its router as open items and the router hands
 * each straight to its owner: no person confirms items, and the owner is ordinary work.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-router-mail-rfc'));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { addTask, updateTaskRaw } from '../../src/core/task-manager.js';
import { readRouterAreas, updateRouterAreas } from '../../src/core/router/areas.js';
import { confirmAccountArrivals } from '../../src/core/router/account-intake.js';
import { resolveRouterItem } from '../../src/core/router/source-registry.js';
import { disposeRouterStores, routerStore } from '../../src/core/router/runtime.js';
import { routeItem } from '../../src/core/router/service.js';
import type { RouterRoute, RouterSource } from '../../src/core/router/types.js';
import { PluginDatabaseClient } from '../../src/core/plugins/plugin-storage.js';
import type { WalnutServerPluginApi } from '../../src/core/plugins/server-api.js';
import { MailBodyStore } from '../../src/integrations/mail/bodies.js';
import { MailDatabase } from '../../src/integrations/mail/db.js';
import { mailRouterKey, mailRowDeliveryVersion, registerMailRouterSource } from '../../src/integrations/mail/router-source.js';
import { MailStore, type MessageWrite } from '../../src/integrations/mail/store.js';

const ACCOUNT = 'desk@marina.example.invalid';
const RFC = '<reused@sender.example.invalid>';
const SENT_AT = 1_760_000_000_000;
// Each exact source is the one the cache holds after seeding: the version of its cached row
// (times, RFC id, metadata, body ref), so two mails with the same times still have two versions.
let FIRST: RouterSource;
let SECOND: RouterSource;
const unversioned = (source: RouterSource): RouterSource => ({ kind: source.kind, account: source.account, message: source.message });

let db: MailDatabase | undefined;
let cacheStore: MailStore;
let cacheBodies: MailBodyStore;
let stopSource = () => {};
const ids = { router: '', a: '', b: '' };
const sent: Array<{ route: RouterRoute; text: string }> = [];

const route = (source: RouterSource, taskId: string) => routeItem(
  { source, taskId, reason: 'Dock invoices go to this desk.', byTaskId: ids.router, text: 'Please check this invoice.' },
  { send: async (r, text) => { sent.push({ route: r, text }); } },
);
const openSources = async () => ((await readRouterAreas(WALNUT_HOME)).openItems ?? []).map((one) => one.source);

const mailWrite = (message: string, over: Partial<MessageWrite> = {}): MessageWrite => ({
  accountId: ACCOUNT, messageId: message, rfcMessageId: RFC, mailboxId: 'INBOX', threadId: 'thread-1',
  fromAddr: 'pat@sender.example.invalid', subject: `Invoice ${message}`, snippet: 'Invoice', sentAt: SENT_AT,
  receivedAt: SENT_AT, flagsJson: '[]', attachmentsJson: '[]', payload: '{}', envelopeHash: `hash-${message}`, ...over,
});

/** The delivery version of a cached row as the store holds it now. */
async function versionNow(message: string): Promise<string> {
  const row = await cacheStore.getMessage(ACCOUNT, message);
  if (!row) throw new Error(`fixture row ${message} is missing`);
  return mailRowDeliveryVersion(row);
}

/** One cached mail with its body; answers the exact source of the row it stored. */
async function seedMail(store: MailStore, bodies: MailBodyStore, message: string, text: string): Promise<RouterSource> {
  const write = mailWrite(message);
  const rowid = await store.insertMessage(write, Date.now());
  const stored = await bodies.write(ACCOUNT, message, write.sentAt, { format: 'text', text, bytes: Buffer.byteLength(text) }, write.subject);
  await store.setMessageBody(rowid, { bodyRef: stored.ref, bodyBytes: stored.bytes, snippet: 'Invoice', payload: '{}' });
  return { kind: 'mail', account: ACCOUNT, message, version: await versionNow(message) };
}

beforeAll(async () => {
  await startServer({ port: 0, dev: true });
  ids.router = (await addTask({ title: 'Personal router', project: 'Dock' })).task.id;
  // The owners are ordinary tasks: no area, no mark, no session profile.
  ids.a = (await addTask({ title: 'Invoice desk A', project: 'Dock' })).task.id;
  ids.b = (await addTask({ title: 'Invoice desk B', project: 'Dock' })).task.id;
  await updateRouterAreas(WALNUT_HOME, () => ({
    version: 1,
    areas: [{ id: 'personal', name: 'Personal', host: '__local__', taskIds: [ids.router], sources: [{ kind: 'mail', account: ACCOUNT }] }],
    routers: [{ taskId: ids.router, areaId: 'personal', paused: false }],
    items: [],
    accountBindings: [{ kind: 'mail', account: ACCOUNT, areaId: 'personal', boundAt: 1 }],
  }));
  await updateTaskRaw(ids.router, { org_role: 'router', router_area_id: 'personal', router_paused: false }, { source: 'router-areas', emitEvent: false });

  const root = path.join(WALNUT_HOME, 'rfc-mail-cache');
  await fs.mkdir(root, { recursive: true });
  const client = new PluginDatabaseClient(path.join(root, 'plugin.sqlite'));
  db = new MailDatabase({ storage: { get database() { return client; } } } as unknown as WalnutServerPluginApi);
  const store = new MailStore(db);
  const bodies = new MailBodyStore(root);
  cacheStore = store;
  cacheBodies = bodies;
  await store.upsertAccount({ accountId: ACCOUNT, providerId: 'fixture', displayName: ACCOUNT, address: ACCOUNT, state: 'active', healthJson: null, payload: '{}' });
  FIRST = await seedMail(store, bodies, 'INBOX:1:10', 'FIRST_BODY_CANARY');
  SECOND = await seedMail(store, bodies, 'INBOX:1:11', 'SECOND_BODY_CANARY');
  // Registered after boot, so this cache (not a plugin's empty one) answers for the mail kind.
  stopSource = registerMailRouterSource(store, bodies);
  for (const source of [FIRST, SECOND]) expect((await resolveRouterItem(unversioned(source))).source).toEqual(source);
  expect((await resolveRouterItem(FIRST)).key).toBe(mailRouterKey(ACCOUNT, FIRST.message, '', FIRST.version));
});

afterAll(async () => {
  try {
    stopSource();
    await disposeRouterStores();
    await db?.dispose().catch(() => undefined);
    await stopServer();
  } finally {
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  }
});

describe('one RFC id on two cached mails', () => {
  it('enters the first copy as an open item under the RFC key, and not the second copy: one decision per mail', async () => {
    // Same sent and received times, different stored bodies: two delivery versions, one scope key.
    expect(FIRST.version).not.toBe(SECOND.version);
    const [one, two] = [await resolveRouterItem(FIRST), await resolveRouterItem(SECOND)];
    expect(one.scopeKey).toBe(mailRouterKey(ACCOUNT, FIRST.message, RFC));
    expect(two.scopeKey).toBe(one.scopeKey);
    expect(await confirmAccountArrivals([FIRST], WALNUT_HOME)).toEqual([FIRST]);
    expect(await confirmAccountArrivals([SECOND], WALNUT_HOME)).toEqual([]);
    const open = (await readRouterAreas(WALNUT_HOME)).openItems ?? [];
    expect(open).toEqual([{ source: FIRST, areaId: 'personal', canonicalKey: one.scopeKey }]);
    // Entering the same arrival again changes nothing.
    expect(await confirmAccountArrivals([FIRST], WALNUT_HOME)).toEqual([]);
    expect(await openSources()).toEqual([FIRST]);
  });

  it('hands the open item to an ordinary task with its own original text and reference; a repeat returns its receipt', async () => {
    const first = await route(FIRST, ids.a);
    expect(first).toMatchObject({ fresh: true, route: { status: 'routed', taskId: ids.a, key: mailRouterKey(ACCOUNT, FIRST.message, '', FIRST.version) } });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('FIRST_BODY_CANARY');
    expect(sent[0]!.text).not.toContain('SECOND_BODY_CANARY');
    expect(sent[0]!.text).toContain(`mail_read ${JSON.stringify({ account: ACCOUNT, message: FIRST.message })}`);
    expect((await routerStore('personal').getSource(FIRST))?.key).toBe(first.route.key);
    const again = await route(FIRST, ids.b);
    expect(again).toMatchObject({ fresh: false, route: { taskId: ids.a, messageId: first.route.messageId } });
    expect(sent).toHaveLength(1);
  });

  it('a copy the router never got is refused: it is no item of the area', async () => {
    await expect(route(SECOND, ids.b)).rejects.toMatchObject({ code: 'area_unassigned' });
    expect(await routerStore('personal').getSource(SECOND)).toBeUndefined();
    expect(sent).toHaveLength(1);
  });

  it('a later reply under one handle is a new arrival with its own receipt and body; the old receipt stays', async () => {
    const old = await cacheStore.getMessage(ACCOUNT, FIRST.message);
    const instant = old!.sent_at + 1000;
    await cacheBodies.remove(old!.body_ref!);
    await cacheStore.retireMessageBody(old!.rowid);
    // A reply carries its own RFC Message-ID.
    await cacheStore.updateMessage(old!.rowid, mailWrite(FIRST.message, {
      rfcMessageId: '<reply@sender.example.invalid>', subject: 'New reply', snippet: 'New reply', sentAt: instant, receivedAt: instant, envelopeHash: 'new-reply',
    }), Date.now());
    const held = await cacheBodies.write(ACCOUNT, FIRST.message, instant, { format: 'text', text: 'NEW_REPLY_CANARY', bytes: 16 }, 'New reply');
    await cacheStore.setMessageBody(old!.rowid, { bodyRef: held.ref, bodyBytes: held.bytes, snippet: 'New reply', payload: '{}' });
    const current = (await resolveRouterItem(unversioned(FIRST))).source;
    expect(current.version).toBe(await versionNow(FIRST.message));
    expect(current.version).not.toBe(FIRST.version);
    expect(await routerStore('personal').getSource(current)).toBeUndefined();
    // The replaced delivery is no longer current: entering it again writes nothing.
    expect(await confirmAccountArrivals([FIRST], WALNUT_HOME)).toEqual([]);
    expect(await confirmAccountArrivals([current], WALNUT_HOME)).toEqual([current]);
    const result = await route(current, ids.a);
    expect(result.route).toMatchObject({ status: 'routed', key: mailRouterKey(ACCOUNT, FIRST.message, '', current.version) });
    expect(result.route.messageId).not.toBe(sent[0]!.route.messageId);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.text).toContain('NEW_REPLY_CANARY');
    expect(sent[1]!.text).not.toContain('FIRST_BODY_CANARY');
    // The old receipt stays on record under its own delivery.
    expect(await routerStore('personal').getSource(FIRST)).toMatchObject({ source: FIRST, key: mailRouterKey(ACCOUNT, FIRST.message, '', FIRST.version) });
  });
});

/**
 * Two cached mails that carry one RFC Message-ID (a sender chooses it) are two deliveries, on a real
 * server: the real mail cache and its real router adapter, the real /router/assign and /router/item
 * routes, the real ledger. Only the session send is a stand-in; nothing starts a model, and every
 * file lives in this test's own mocked WALNUT_HOME. All names are invented.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-router-mail-rfc'));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { addTask, updateTaskRaw } from '../../src/core/task-manager.js';
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js';
import { readRouterAreas, updateRouterAreas } from '../../src/core/router/areas.js';
import { routerAreaProfile } from '../../src/core/router/session-policy.js';
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
let THIRD: RouterSource;
const unversioned = (source: RouterSource): RouterSource => ({ kind: source.kind, account: source.account, message: source.message });

let base = '';
let db: MailDatabase | undefined;
let cacheStore: MailStore;
let cacheBodies: MailBodyStore;
let stopSource = () => {};
const ids = { router: '', a: '', b: '', workRouter: '' };
const sids = { a: randomUUID(), b: randomUUID() };
const sent: RouterRoute[] = [];

const post = (p: string, body: unknown) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const readItem = (source: RouterSource, sid: string) => fetch(`${base}/api/v1/router/item?${new URLSearchParams({ ...source })}`, { headers: { 'x-walnut-caller-sid': sid } });
const route = (source: RouterSource, taskId: string) => routeItem(
  { source, taskId, reason: 'Dock invoices go to this desk.', byTaskId: ids.router, text: 'Please check this invoice.' },
  { send: async (r) => { sent.push(r); } },
);

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
  const server = await startServer({ port: 0, dev: true });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ids.router = (await addTask({ title: 'Personal router', project: 'Dock' })).task.id;
  ids.a = (await addTask({ title: 'Invoice desk A', project: 'Dock' })).task.id;
  ids.b = (await addTask({ title: 'Invoice desk B', project: 'Dock' })).task.id;
  ids.workRouter = (await addTask({ title: 'Work router', project: 'Workshop' })).task.id;
  await updateRouterAreas(WALNUT_HOME, () => ({
    version: 1,
    areas: [
      { id: 'personal', name: 'Personal', host: '__local__', taskIds: [ids.router, ids.a, ids.b], sources: [{ kind: 'mail', account: ACCOUNT }] },
      { id: 'work', name: 'Work', host: '__local__', taskIds: [ids.workRouter], sources: [] },
    ],
    routers: [{ taskId: ids.router, areaId: 'personal', paused: false }, { taskId: ids.workRouter, areaId: 'work', paused: false }],
    items: [],
  }));
  await updateTaskRaw(ids.router, { org_role: 'router', router_area_id: 'personal', router_paused: false }, { source: 'router-areas', emitEvent: false });
  await updateTaskRaw(ids.workRouter, { org_role: 'router', router_area_id: 'work', router_paused: false }, { source: 'router-areas', emitEvent: false });
  for (const [id, sid] of [[ids.a, sids.a], [ids.b, sids.b]]) {
    await updateTaskRaw(id, { router_area_id: 'personal' }, { source: 'router-areas', emitEvent: false });
    await createSessionRecord(sid, id, '', WALNUT_HOME, { profile: routerAreaProfile('personal', 'work'), mode: 'dontAsk' });
    await updateSessionRecord(sid, { process_status: 'stopped' });
  }

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
  THIRD = await seedMail(store, bodies, 'INBOX:1:12', 'THIRD_BODY_CANARY');
  // Registered after boot, so this cache (not a plugin's empty one) answers for the mail kind.
  stopSource = registerMailRouterSource(store, bodies);
  // The adapter's own source for each unversioned handle is the one the seed recorded.
  for (const source of [FIRST, SECOND, THIRD]) expect((await resolveRouterItem(unversioned(source))).source).toEqual(source);
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
  it('a person confirms each exact mail into the same area, both under the RFC restriction key', async () => {
    // Same sent and received times, different stored bodies: two delivery versions, one scope key.
    expect(new Set([FIRST.version, SECOND.version, THIRD.version]).size).toBe(3);
    const [one, two] = [await resolveRouterItem(FIRST), await resolveRouterItem(SECOND)];
    expect(one.scopeKey).toBe(mailRouterKey(ACCOUNT, FIRST.message, RFC));
    expect(two.scopeKey).toBe(one.scopeKey);
    for (const source of [FIRST, SECOND]) {
      const response = await post('/api/v1/router/assign', { source, area_id: 'personal' });
      expect(response.status).toBe(200);
    }
    const items = (await readRouterAreas(WALNUT_HOME)).items;
    expect(items.map((one) => one.source.message).sort()).toEqual([FIRST.message, SECOND.message]);
    expect(new Set(items.map((one) => one.canonicalKey))).toEqual(new Set([mailRouterKey(ACCOUNT, FIRST.message, RFC)]));
  });

  it('routes them as two ledger rows with two message ids; a repeat returns its own receipt only', async () => {
    const first = await route(FIRST, ids.a);
    const second = await route(SECOND, ids.b);
    expect(first).toMatchObject({ fresh: true, route: { status: 'routed', taskId: ids.a, key: mailRouterKey(ACCOUNT, FIRST.message, '', FIRST.version) } });
    expect(second).toMatchObject({ fresh: true, route: { status: 'routed', taskId: ids.b, key: mailRouterKey(ACCOUNT, SECOND.message, '', SECOND.version) } });
    expect(second.route.messageId).not.toBe(first.route.messageId);
    expect(sent.map((r) => r.messageId)).toEqual([first.route.messageId, second.route.messageId]);
    const ledger = routerStore('personal');
    expect((await ledger.getSource(SECOND))?.key).toBe(mailRouterKey(ACCOUNT, SECOND.message, '', SECOND.version));
    expect((await ledger.getSource(FIRST))?.key).toBe(mailRouterKey(ACCOUNT, FIRST.message, '', FIRST.version));
    const again = await route(FIRST, ids.a);
    expect(again).toMatchObject({ fresh: false, route: { messageId: first.route.messageId } });
    expect(sent).toHaveLength(2);
  });

  it('each receiver reads its own exact mail and not the other one', async () => {
    const a = await readItem(FIRST, sids.a);
    expect(a.status).toBe(200);
    expect((await a.json()).body.text).toBe('FIRST_BODY_CANARY');
    const b = await readItem(SECOND, sids.b);
    expect(b.status).toBe(200);
    expect((await b.json()).body.text).toBe('SECOND_BODY_CANARY');
    const crossed = await readItem(SECOND, sids.a);
    expect(crossed.status).toBe(403);
    expect(JSON.stringify(await crossed.json())).not.toContain('SECOND_BODY_CANARY');
  });

  it('a later reply under one handle requires new confirmation and never inherits its old receipt or body grant', async () => {
    // The old receipt's source, read before the cache moves.
    const oldSource = (await resolveRouterItem(unversioned(FIRST))).source;
    expect(oldSource).toEqual(FIRST);
    const old = await cacheStore.getMessage(ACCOUNT, FIRST.message);
    const instant = old!.sent_at + 1000;
    await cacheBodies.remove(old!.body_ref!);
    await cacheStore.retireMessageBody(old!.rowid);
    await cacheStore.updateMessage(old!.rowid, mailWrite(FIRST.message,
      { subject: 'New reply', snippet: 'New reply', sentAt: instant, receivedAt: instant, envelopeHash: 'new-reply' }), Date.now());
    const held = await cacheBodies.write(ACCOUNT, FIRST.message, instant, { format: 'text', text: 'NEW_REPLY_CANARY', bytes: 16 }, 'New reply');
    await cacheStore.setMessageBody(old!.rowid, { bodyRef: held.ref, bodyBytes: held.bytes, snippet: 'New reply', payload: '{}' });
    const current = (await resolveRouterItem(unversioned(FIRST))).source;
    expect(held.ref).not.toBe(old!.body_ref);
    expect((await cacheStore.getMessage(ACCOUNT, FIRST.message))?.body_ref).toBe(held.ref);
    expect(current.version).toBe(await versionNow(FIRST.message));
    expect(current.version).not.toBe(oldSource.version);
    const oldRead = await readItem(FIRST, sids.a);
    expect(oldRead.status).toBe(409);
    expect(JSON.stringify(await oldRead.json())).not.toContain('NEW_REPLY_CANARY');
    expect((await readItem(current, sids.a)).status).toBe(403);
    expect(await routerStore('personal').getSource(current)).toBeUndefined();
    const stale = await post('/api/v1/router/assign', { source: FIRST, area_id: 'personal' });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe('source_changed');
    expect((await post('/api/v1/router/assign', { source: current, area_id: 'personal' })).status).toBe(200);
    const result = await route(current, ids.a);
    expect(result.route.status).toBe('routed');
    expect(result.route.key).toBe(mailRouterKey(ACCOUNT, FIRST.message, '', current.version));
    expect(result.route.key).not.toBe(mailRouterKey(ACCOUNT, FIRST.message, '', oldSource.version));
    expect(result.route.messageId).not.toBe(sent[0]!.messageId);
    const fresh = await readItem(current, sids.a);
    expect(fresh.status).toBe(200);
    expect((await fresh.json()).body.text).toBe('NEW_REPLY_CANARY');
    // The old receipt stays on record under its own delivery, and still serves no new body.
    expect(await routerStore('personal').getSource(oldSource)).toMatchObject({ source: oldSource, key: mailRouterKey(ACCOUNT, FIRST.message, '', oldSource.version) });
    const stillOld = await readItem(oldSource, sids.a);
    expect(stillOld.status).toBe(409);
    expect(JSON.stringify(await stillOld.json())).not.toContain('NEW_REPLY_CANARY');
    expect(sent).toHaveLength(3);
  });

  it('another copy of the RFC id cannot be confirmed into another area, and no receipt is replayed for it', async () => {
    const before = await readRouterAreas(WALNUT_HOME);
    for (const source of [THIRD, SECOND]) {
      const response = await post('/api/v1/router/assign', { source, area_id: 'work' });
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe('area_reassignment');
    }
    expect(await readRouterAreas(WALNUT_HOME)).toEqual(before);
    expect(await routerStore('personal').getSource(THIRD)).toBeUndefined();
    expect(sent).toHaveLength(3);
  });

  it('same times, RFC id and body, changed metadata: the old confirmation grants nothing until confirmed again', async () => {
    const old = await cacheStore.getMessage(ACCOUNT, SECOND.message);
    await cacheStore.updateMessage(old!.rowid, mailWrite(SECOND.message,
      { subject: 'Invoice corrected', snippet: 'Corrected', envelopeHash: 'hash-corrected' }), Date.now());
    const row = await cacheStore.getMessage(ACCOUNT, SECOND.message);
    expect(row).toMatchObject({ sent_at: old!.sent_at, received_at: old!.received_at, rfc_message_id: RFC, body_ref: old!.body_ref });
    const current = (await resolveRouterItem(unversioned(SECOND))).source;
    expect(current.version).toBe(mailRowDeliveryVersion(row!));
    expect(current.version).not.toBe(SECOND.version);
    const stale = await readItem(SECOND, sids.b);
    expect(stale.status).toBe(409);
    expect(JSON.stringify(await stale.json())).not.toContain('SECOND_BODY_CANARY');
    const unconfirmed = await readItem(current, sids.b);
    expect(unconfirmed.status).toBe(403);
    expect(JSON.stringify(await unconfirmed.json())).not.toContain('SECOND_BODY_CANARY');
    expect(await routerStore('personal').getSource(current)).toBeUndefined();
    expect((await post('/api/v1/router/assign', { source: current, area_id: 'personal' })).status).toBe(200);
    const result = await route(current, ids.b);
    expect(result.route).toMatchObject({ status: 'routed', key: mailRouterKey(ACCOUNT, SECOND.message, '', current.version) });
    const confirmed = await readItem(current, sids.b);
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json()).body.text).toBe('SECOND_BODY_CANARY');
    // The old receipt stays under its own delivery.
    expect(await routerStore('personal').getSource(SECOND)).toMatchObject({ source: SECOND });
    expect(sent).toHaveLength(4);
  });
});

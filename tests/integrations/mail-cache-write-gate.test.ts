// Real store and files: a delete never hits a row a newer delivery replaced, and a read racing a clear fails closed.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginDatabaseClient } from '../../src/core/plugins/plugin-storage.js';
import type { WalnutServerPluginApi } from '../../src/core/plugins/server-api.js';
import { MailBodyStore } from '../../src/integrations/mail/bodies.js';
import { reconcileBodyRevision } from '../../src/integrations/mail/body-revision.js';
import type { RetentionLimits } from '../../src/integrations/mail/contract.js';
import { MailDatabase } from '../../src/integrations/mail/db.js';
import type { MailEvents } from '../../src/integrations/mail/events.js';
import { reconcileIdentityRevision } from '../../src/integrations/mail/identity-revision.js';
import { MailProviderRegistry } from '../../src/integrations/mail/provider-registry.js';
import { MailRetention } from '../../src/integrations/mail/retention.js';
import { MailService } from '../../src/integrations/mail/service.js';
import { MailStore } from '../../src/integrations/mail/store.js';
import type { MailBody, MailEnvelope, MailProviderSpec } from '../../src/integrations/mail/types.js';

const ACCOUNT = 'gated:acct-1';
const HANDLE = 'inbox:conv-ledger';
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const OLD_AT = Date.UTC(2026, 0, 5, 9, 0, 0);
const RECENT_AT = NOW - 2 * 60 * 60 * 1_000;
const REPLY_AT = NOW - 60 * 1_000;

interface Rig {
  root: string;
  store: MailStore;
  bodies: MailBodyStore;
  service: MailService;
  retention: MailRetention;
  body: { current: MailBody };
}

const open: MailDatabase[] = [];
const roots: string[] = [];

async function openRig(protectedRouterItems?: () => Promise<ReadonlySet<string>>): Promise<Rig> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mail-write-gate-'));
  roots.push(root);
  const client = new PluginDatabaseClient(path.join(root, 'plugin.sqlite'));
  const db = new MailDatabase({ storage: { get database() { return client; } } } as unknown as WalnutServerPluginApi);
  open.push(db);
  const store = new MailStore(db);
  const bodies = new MailBodyStore(root);
  const body = { current: { format: 'text', text: 'The first capture', bytes: 17 } as MailBody };
  const spec = {
    id: 'gated',
    label: 'A conversation-shaped fixture',
    capabilities: {
      search: false, watch: false, drafts: false, markRead: false, flags: false,
      threads: false, send: false, sendAsReply: false, bodies: 'text', attachments: 'none',
    },
    setup: { fields: [], submit: async () => { throw new Error('no setup'); } },
    listAccounts: async () => [],
    health: async () => ({ state: 'ok', checkedAt: Date.now() }),
    listMailboxes: async () => [],
    poll: async () => ({ messages: [], cursor: 'c0', more: false }),
    getBody: async () => ({ ...body.current }),
    send: async () => { throw new Error('cannot send'); },
  } as MailProviderSpec;
  const providers = new MailProviderRegistry(() => undefined);
  providers.register(spec, 'the-fixture-plugin');
  const service = new MailService({ store, bodies, providers });
  const events = { forgetAccount: () => undefined } as unknown as MailEvents;
  const retention = new MailRetention({ store, bodies, events, now: () => NOW, ...(protectedRouterItems ? { protectedRouterItems } : {}) });
  await store.upsertAccount({
    accountId: ACCOUNT, providerId: 'gated', displayName: 'A mailbox', address: 'quartz@example.invalid',
    state: 'active', healthJson: null, payload: '{}',
  });
  return { root, store, bodies, service, retention, body };
}

afterEach(async () => {
  for (const release of holds.splice(0)) release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  vi.restoreAllMocks();
  for (const db of open.splice(0)) await db.dispose().catch(() => undefined);
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

function envelope(at: number): MailEnvelope {
  return {
    messageId: HANDLE, rfcMessageId: 'conv-ledger', mailboxId: 'inbox',
    from: { name: 'Stone, Alex', address: 'alex@example.invalid' }, subject: 'RE: the ledger',
    sentAt: at, receivedAt: at, flags: [],
  };
}

/** Every hold a test made; afterEach opens them first so a failed assertion never leaves the gate (and dispose) hung. */
const holds: Array<() => void> = [];

function gateOf(): { promise: Promise<void>; open: () => void } {
  let release = () => undefined as void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  holds.push(release);
  return { promise, open: release };
}

function settledFlag(work: Promise<unknown>): { done: boolean } {
  const flag = { done: false };
  void work.then(() => { flag.done = true; }, () => { flag.done = true; });
  return flag;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

async function rowOf(rig: Rig) {
  return rig.store.getMessage(ACCOUNT, HANDLE);
}

/** Ingest one delivery and open it once, so its row names a real body file. */
async function seedBody(rig: Rig, at: number): Promise<string> {
  await rig.service.ingestPage(ACCOUNT, [envelope(at)]);
  await rig.service.readMessage(ACCOUNT, HANDLE);
  const ref = (await rowOf(rig))?.body_ref;
  if (!ref) throw new Error('the seed did not cache a body');
  return ref;
}

const fileOf = (rig: Rig, ref: string, half: 'txt' | 'html' = 'txt') => path.join(rig.root, `${ref}.${half}`);
const KEEP_ALL: RetentionLimits = { retentionDays: 36_500, maxRowsPerAccount: 10_000, bodyCacheMb: 10_000 };

describe('retention deletes only rows it selected under the gate', () => {
  it('a new delivery on a doomed handle waits for the sweep and is not deleted with the old row', async () => {
    const rig = await openRig();
    await rig.service.ingestPage(ACCOUNT, [envelope(OLD_AT)]);
    const held = gateOf();
    const select = rig.store.doomedRows.bind(rig.store);
    const selected = vi.spyOn(rig.store, 'doomedRows').mockImplementationOnce(async (...args) => {
      const rows = await select(...args);
      await held.promise;
      return rows;
    });
    const sweeping = rig.retention.retain({ ...KEEP_ALL, retentionDays: 30 }, Date.now() + 60_000);
    await vi.waitFor(() => expect(selected).toHaveBeenCalled());
    const ingesting = rig.service.ingestPage(ACCOUNT, [envelope(REPLY_AT)]);
    const ingested = settledFlag(ingesting);
    await tick();
    expect(ingested.done).toBe(false);
    expect((await rowOf(rig))?.sent_at).toBe(OLD_AT);
    held.open();
    expect(await sweeping).toMatchObject({ messagesDeleted: 1 });
    expect(await ingesting).toMatchObject({ added: 1, received: 1 });
    expect((await rowOf(rig))?.sent_at).toBe(REPLY_AT);
  });

  it('the body cap never clears a ref that replaced the one it listed', async () => {
    const rig = await openRig();
    const first = await seedBody(rig, RECENT_AT);
    const held = gateOf();
    const list = rig.store.bodiedOldestFirst.bind(rig.store);
    const listed = vi.spyOn(rig.store, 'bodiedOldestFirst').mockImplementationOnce(async (...args) => {
      const rows = await list(...args);
      await held.promise;
      return rows;
    });
    const sweeping = rig.retention.retain({ ...KEEP_ALL, bodyCacheMb: 0 }, Date.now() + 60_000);
    await vi.waitFor(() => expect(listed).toHaveBeenCalled());
    // The listing is outside the gate: a reply retires the listed body and a new one is stored meanwhile.
    await rig.service.ingestPage(ACCOUNT, [envelope(REPLY_AT)]);
    rig.body.current = { format: 'text', text: 'The reply capture', bytes: 17 };
    await rig.service.readMessage(ACCOUNT, HANDLE);
    const second = (await rowOf(rig))?.body_ref;
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    held.open();
    expect(await sweeping).toMatchObject({ bodiesDropped: 0 });
    expect((await rowOf(rig))?.body_ref).toBe(second);
    expect(fs.existsSync(fileOf(rig, second!))).toBe(true);
    expect((await rig.service.readMessage(ACCOUNT, HANDLE)).body?.text).toBe('The reply capture');
  });
});

describe('revision sweeps hold the account for the whole clear', () => {
  it('body revision: an ingest waits, and the body stored after it is kept', async () => {
    const rig = await openRig();
    await seedBody(rig, RECENT_AT);
    const held = gateOf();
    const page = rig.store.bodiedForAccount.bind(rig.store);
    const paged = vi.spyOn(rig.store, 'bodiedForAccount').mockImplementationOnce(async (...args) => {
      const rows = await page(...args);
      await held.promise;
      return rows;
    });
    const sweeping = reconcileBodyRevision({ store: rig.store, bodies: rig.bodies }, 'gated', 'r2');
    await vi.waitFor(() => expect(paged).toHaveBeenCalled());
    const ingesting = rig.service.ingestPage(ACCOUNT, [envelope(REPLY_AT)]);
    const ingested = settledFlag(ingesting);
    await tick();
    expect(ingested.done).toBe(false);
    held.open();
    expect(await sweeping).toMatchObject({ swept: true, bodies: 1 });
    expect(await ingesting).toMatchObject({ updated: 1, received: 1 });
    rig.body.current = { format: 'text', text: 'The reply capture', bytes: 17 };
    await rig.service.readMessage(ACCOUNT, HANDLE);
    const kept = (await rowOf(rig))?.body_ref;
    expect(kept).toBeTruthy();
    expect(fs.existsSync(fileOf(rig, kept!))).toBe(true);
  });

  it('identity revision: a new delivery waits for the wipe and survives it', async () => {
    const rig = await openRig();
    await seedBody(rig, RECENT_AT);
    const held = gateOf();
    const page = rig.store.rowsForAccount.bind(rig.store);
    const paged = vi.spyOn(rig.store, 'rowsForAccount').mockImplementationOnce(async (...args) => {
      const rows = await page(...args);
      await held.promise;
      return rows;
    });
    const sweeping = reconcileIdentityRevision({ store: rig.store, bodies: rig.bodies }, 'gated', 'r2');
    await vi.waitFor(() => expect(paged).toHaveBeenCalled());
    const ingesting = rig.service.ingestPage(ACCOUNT, [envelope(REPLY_AT)]);
    const ingested = settledFlag(ingesting);
    await tick();
    expect(ingested.done).toBe(false);
    held.open();
    expect(await sweeping).toMatchObject({ swept: true, messages: 1 });
    expect(await ingesting).toMatchObject({ added: 1, received: 1 });
    expect((await rowOf(rig))?.sent_at).toBe(REPLY_AT);
  });
});

describe('a read racing a clear fails closed', () => {
  const HTML_ONLY: MailBody = { format: 'html', html: '<p>Only html here</p>', bytes: 22 };

  for (const when of ['before', 'after'] as const) {
    it(`an html-only body cleared ${when} the file read is a changed delivery, never an empty success`, async () => {
      const rig = await openRig();
      rig.body.current = HTML_ONLY;
      const ref = await seedBody(rig, RECENT_AT);
      expect((await rig.service.readMessage(ACCOUNT, HANDLE)).body?.html).toBe('<p>Only html here</p>');
      const held = gateOf();
      const read = rig.bodies.read.bind(rig.bodies);
      const reads = vi.spyOn(rig.bodies, 'read').mockImplementationOnce(async (...args) => {
        if (when === 'before') await held.promise;
        const out = await read(...args);
        if (when === 'after') await held.promise;
        return out;
      });
      const reading = rig.service.readMessage(ACCOUNT, HANDLE);
      reading.catch(() => undefined);
      await vi.waitFor(() => expect(reads).toHaveBeenCalled());
      expect(await rig.retention.retain({ ...KEEP_ALL, bodyCacheMb: 0 }, Date.now() + 60_000)).toMatchObject({ bodiesDropped: 1 });
      expect(fs.existsSync(fileOf(rig, ref, 'html'))).toBe(false);
      held.open();
      await expect(reading).rejects.toMatchObject({ code: 'delivery_changed', status: 409 });
    });
  }

  it('an html half gone under an unchanged row is refused, never answered as an empty text body', async () => {
    const rig = await openRig();
    rig.body.current = HTML_ONLY;
    const ref = await seedBody(rig, RECENT_AT);
    await fsp.rm(fileOf(rig, ref, 'html'));
    await expect(rig.service.readMessage(ACCOUNT, HANDLE)).rejects.toMatchObject({ code: 'delivery_changed', status: 409 });
  });
});

describe('retention keeps mail the router registry holds', () => {
  const KEY = JSON.stringify([ACCOUNT, HANDLE]);
  const DROP_ALL: RetentionLimits = { retentionDays: 30, maxRowsPerAccount: 10_000, bodyCacheMb: 0 };

  async function seedOld(rig: Rig): Promise<string> {
    return seedBody(rig, OLD_AT);
  }

  it('a registered mail keeps its row and its body past the age cutoff and the body cap', async () => {
    const rig = await openRig(async () => new Set([KEY]));
    const ref = await seedOld(rig);
    expect(await rig.retention.retain({ ...KEEP_ALL, bodyCacheMb: 0 }, Date.now() + 60_000)).toMatchObject({ bodiesDropped: 0 });
    expect(await rig.retention.retain(DROP_ALL, Date.now() + 60_000)).toMatchObject({ messagesDeleted: 0, bodiesDropped: 0, incomplete: false });
    expect((await rowOf(rig))?.body_ref).toBe(ref);
    expect(fs.existsSync(fileOf(rig, ref))).toBe(true);
  });

  it('a registry that cannot be read deletes nothing and reports the sweep incomplete', async () => {
    const rig = await openRig(async () => { throw new Error('registry unreadable'); });
    const ref = await seedOld(rig);
    expect(await rig.retention.retain(DROP_ALL, Date.now() + 60_000)).toMatchObject({ messagesDeleted: 0, bodiesDropped: 0, incomplete: true });
    expect(await rig.retention.retain({ ...KEEP_ALL, bodyCacheMb: 0 }, Date.now() + 60_000)).toMatchObject({ bodiesDropped: 0, incomplete: true });
    expect((await rowOf(rig))?.body_ref).toBe(ref);
    expect(fs.existsSync(fileOf(rig, ref))).toBe(true);
  });

  it('a draft made while the registry read is in flight still protects its mail', async () => {
    const held = gateOf();
    let asked = false;
    const rig = await openRig(async () => { asked = true; await held.promise; return new Set(); });
    const ref = await seedOld(rig);
    const sweeping = rig.retention.retain(DROP_ALL, Date.now() + 60_000);
    await vi.waitFor(() => expect(asked).toBe(true));
    await rig.store.write.insertDraft({
      draftId: 'draft-late', accountId: ACCOUNT, inReplyTo: 'conv-ledger', toJson: '[]', subject: 'RE: the ledger',
      bodyMd: 'Thanks', origin: 'console', createdBySession: null, payload: '{}', now: NOW,
    });
    held.open();
    expect(await sweeping).toMatchObject({ messagesDeleted: 0, bodiesDropped: 0 });
    expect((await rowOf(rig))?.body_ref).toBe(ref);
  });

  it('a mail the registry does not hold is evicted as before', async () => {
    const rig = await openRig(async () => new Set([JSON.stringify([ACCOUNT, 'inbox:another'])]));
    const ref = await seedOld(rig);
    expect(await rig.retention.retain(DROP_ALL, Date.now() + 60_000)).toMatchObject({ messagesDeleted: 1, incomplete: false });
    expect(await rowOf(rig)).toBeUndefined();
    expect(fs.existsSync(fileOf(rig, ref))).toBe(false);
  });
});

describe('every cache row or body-file mutation is a known member of the gated set', () => {
  const MAIL = path.join(__dirname, '../../src/integrations/mail');
  const MUTATOR = /\.(insertMessage|updateMessage|setMessageBody|setMessageBodyError|clearMessageBodyError|clearMessageBody|retireMessageBody|deleteMessages|deleteAccount)\(|bodies\.(write|remove)\(/g;
  // Each entry runs inside `store.withAccountWrite` (retention.ts's deleteAccount inside purgeAccount's gate).
  const KNOWN: Record<string, Record<string, number>> = {
    'body-revision.ts': { clearMessageBody: 1, 'bodies.remove': 1 },
    'identity-revision.ts': { deleteMessages: 1, 'bodies.remove': 1 },
    'mail-filter-moves.ts': { deleteMessages: 1, 'bodies.remove': 1 },
    'retention.ts': { clearMessageBody: 1, deleteAccount: 1, deleteMessages: 1, 'bodies.remove': 2 },
    'service.ts': {
      insertMessage: 1, updateMessage: 1, retireMessageBody: 1, setMessageBody: 1, setMessageBodyError: 2,
      'bodies.remove': 1, 'bodies.write': 1,
    },
  };

  it('lists every caller; a new one must take the gate and be added here', () => {
    const found: Record<string, Record<string, number>> = {};
    for (const name of fs.readdirSync(MAIL).filter((one) => one.endsWith('.ts') && one !== 'store.ts')) {
      const text = fs.readFileSync(path.join(MAIL, name), 'utf8');
      for (const match of text.matchAll(MUTATOR)) {
        const key = match[1] ?? `bodies.${match[2]}`;
        (found[name] ??= {})[key] = (found[name]![key] ?? 0) + 1;
      }
    }
    expect(found).toEqual(KNOWN);
    for (const name of Object.keys(KNOWN)) {
      expect(fs.readFileSync(path.join(MAIL, name), 'utf8'), name).toMatch(/withAccountWrite\(/);
    }
  });

  it('there is one gate, on the store', () => {
    for (const name of fs.readdirSync(MAIL).filter((one) => one.endsWith('.ts'))) {
      const text = fs.readFileSync(path.join(MAIL, name), 'utf8');
      const defines = /async withAccountWrite<T>\(/.test(text) || /accountWrites\s*=\s*new Map/.test(text);
      expect(defines, name).toBe(name === 'store.ts');
    }
  });
});

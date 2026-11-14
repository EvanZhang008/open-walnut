// Every new mail of a bound mailbox goes straight to its router (2026-11-14, Evan: "mailbox goes
// straight to the router; the router itself is the triage"). Real sync, service and store; the area
// file and the confirm are stand-ins, except in the bound-router blocks at the end, which use the
// real areas file and confirmAccountArrivals.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertNoReassignment, normalizeRouterAreas, readRouterAreas, updateRouterAreas, type RouterAreasFile } from '../../src/core/router/areas.js';
import { confirmAccountArrivals, ensureAccountRouter, followOpenArrivals, type AccountRouterOutcome } from '../../src/core/router/account-intake.js';
import { currentRouterSources, readRouterItem, relocateRouterItem } from '../../src/core/router/source-registry.js';
import { disposeRouterStores, routerStore } from '../../src/core/router/runtime.js';
import { routerKey } from '../../src/core/router/store.js';
import { routeItem } from '../../src/core/router/service.js';
import type { Task } from '../../src/core/types.js';
import { seedTaskStore } from '../helpers/router-task-store.js';
import { checkRouterPending, pendingSources, type RouterWakeDeps, type WakeTask } from '../../src/core/router/wake.js';
import type { RouterRoute, RouterSource } from '../../src/core/router/types.js';
import { PluginDatabaseClient } from '../../src/core/plugins/plugin-storage.js';
import type { WalnutServerPluginApi } from '../../src/core/plugins/server-api.js';
import { MailBodyStore } from '../../src/integrations/mail/bodies.js';
import { MAIL_INTAKE_MAX_TRIES, mailIntakeQueue } from '../../src/integrations/mail/intake-pending.js';
import type { MailNoRouterParams } from '../../src/core/human-inbox/walnut-letters/mail-no-router.js';
import type { MailIncomingCapture } from '../../src/integrations/mail/contract.js';
import { MailDatabase } from '../../src/integrations/mail/db.js';
import { reconcileIdentityRevision } from '../../src/integrations/mail/identity-revision.js';
import type { MailHeadline } from '../../src/integrations/mail/events.js';
import { MailProviderRegistry } from '../../src/integrations/mail/provider-registry.js';
import { decorateMailRoutes } from '../../src/integrations/mail/router-decoration.js';
import {
  bindMailAccounts, createMailRouterIntake, OTHER_FOLDER_NEW_MS, ROUTER_INTAKE_BATCH, watchesOtherFolders,
} from '../../src/integrations/mail/router-intake.js';
import { mailRowDeliveryVersion, registerMailRouterSource } from '../../src/integrations/mail/router-source.js';
import { MailService } from '../../src/integrations/mail/service.js';
import { MailStore } from '../../src/integrations/mail/store.js';
import { MailSync, type MailSyncHost } from '../../src/integrations/mail/sync.js';
import type { MailAddress, MailEnvelope, MailProviderSpec } from '../../src/integrations/mail/types.js';

const ACCOUNT = 'fixture:acct-a';
const OTHER = 'fixture:acct-b';
const HOME = '/walnut-home-under-test';
const BASE = Date.UTC(2026, 9, 1, 9, 0, 0);
/** The intake's clock: an hour after the fixture's first mail, so every fixture arrival is recent. */
const NOW = BASE + 3_600_000;

const UNBOUND = { version: 1, areas: [], routers: [], items: [] } as unknown as RouterAreasFile;
/** ACCOUNT bound to area-1's open router, watching `folders` (none: the plugin's default, the Inbox). */
const bound = (folders?: string[]): RouterAreasFile => ({
  version: 1,
  areas: [{ id: 'area-1', name: 'Area one', host: '__local__', taskIds: ['router-1'], sources: [{ kind: 'mail', account: ACCOUNT }], ...(folders ? { folders } : {}) }],
  routers: [{ taskId: 'router-1', areaId: 'area-1', paused: false }],
  items: [],
  accountBindings: [{ kind: 'mail', account: ACCOUNT, areaId: 'area-1', boundAt: 1 }],
}) as RouterAreasFile;
const BOUND_OUTCOME: AccountRouterOutcome = { bound: true, areaId: 'area-1', created: false, already: true };

const open: Array<{ db: MailDatabase; sync?: MailSync }> = [];
const roots: string[] = [];

afterEach(async () => {
  for (const one of open.splice(0)) {
    await one.sync?.stop();
    await one.db.dispose().catch(() => undefined);
  }
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

function envelope(n: number, over: Partial<MailEnvelope> = {}): MailEnvelope {
  return {
    messageId: `inbox:m-${n}`,
    rfcMessageId: `rfc-${n}@example.invalid`,
    mailboxId: 'inbox',
    from: { name: `Sender ${n}`, address: `sender${n}@example.invalid` },
    subject: `Subject ${n}`,
    snippet: `Preview ${n}`,
    sentAt: BASE + n * 60_000,
    receivedAt: BASE + n * 60_000,
    flags: [],
    ...over,
  };
}

/** A mail in the Receipts folder. */
const receipt = (n: number, over: Partial<MailEnvelope> = {}) =>
  envelope(n, { messageId: `receipts:m-${n}`, mailboxId: 'receipts', rfcMessageId: `rfc-receipt-${n}@example.invalid`, ...over });

const INBOX_ROW = { mailboxId: 'inbox', name: 'Inbox', role: 'inbox', unread: 0, total: 0 };
const RECEIPTS_ROW = { mailboxId: 'receipts', name: 'Receipts', role: 'other', unread: 0, total: 0 };

async function cache(accounts: readonly string[] = [ACCOUNT, OTHER]) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mail-router-intake-'));
  roots.push(root);
  const client = new PluginDatabaseClient(path.join(root, 'plugin.sqlite'));
  const walnut = { storage: { get database() { return client; } } } as unknown as WalnutServerPluginApi;
  const db = new MailDatabase(walnut);
  const store = new MailStore(db);
  const bodies = new MailBodyStore(root);
  const entry: { db: MailDatabase; sync?: MailSync } = { db };
  open.push(entry);
  for (const accountId of accounts) {
    await store.upsertAccount({
      accountId, providerId: 'fixture', displayName: accountId,
      address: `${accountId.split(':')[1]}@example.invalid`, state: 'active', healthJson: null, payload: '{}',
    });
  }
  return { store, bodies, entry };
}

/** The intake with a recording confirm and a switchable area file; `real` uses the areas file and confirm under that home. */
function intake(store: MailStore, areas: { current: RouterAreasFile }, options: {
  /** `true` fails every confirm; `'once'` only the first one (one tick's finish). */
  confirmFails?: boolean | 'once';
  /** A confirm that holds this message id throws, every time (one mail its router can never take). */
  confirmRefuses?: string;
  /** What the no-router letter send answers (false: held back, not sent). */
  letterSent?: boolean;
  areasFail?: boolean;
  /** The intake's first call of this store read fails. */
  failOnce?: 'messagesByIds' | 'listMailboxes';
  real?: { home: string };
  warnings?: string[];
  /** Whether a router task is open; every one is by default. */
  routerOpen?: (taskId: string) => Promise<boolean>;
} = {}) {
  // The pending queue lives under the home, so a fake home is still a real temp dir.
  const home = options.real?.home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mail-router-intake-home-'));
  if (!options.real) roots.push(home);
  const confirmed: RouterSource[][] = [];
  /** What each confirm answered it wrote. */
  const written: RouterSource[][] = [];
  const ensured: string[] = [];
  /** Each "no router reads this mailbox" letter the intake sent. */
  const letters: Array<{ params: MailNoRouterParams; opKey: string }> = [];
  let reads = 0;
  const real = options.real;
  /** The intake's clock. */
  const clock = { at: NOW };
  const failing = new Set(options.failOnce ? [options.failOnce] : []);
  const failOnce = <T>(name: 'messagesByIds' | 'listMailboxes', run: () => Promise<T>): Promise<T> => {
    if (!failing.delete(name)) return run();
    return Promise.reject(new Error(`${name} unavailable`));
  };
  const capture = createMailRouterIntake({
    store: {
      messagesByIds: (accountId, wanted) => failOnce('messagesByIds', () => store.messagesByIds(accountId, wanted)),
      listMailboxes: (accountId) => failOnce('listMailboxes', () => store.listMailboxes(accountId)),
      getAccount: (accountId) => store.getAccount(accountId),
    },
    home,
    now: () => clock.at,
    log: { warn: (message) => { options.warnings?.push(message); } },
    routerOpen: options.routerOpen ?? (async () => true),
    notifyNoRouter: async (params, opKey) => {
      if (options.letterSent === false) return false;
      letters.push({ params, opKey });
      return true;
    },
    readAreas: async (at) => {
      expect(at).toBe(home);
      reads += 1;
      if (options.areasFail) throw new Error('areas file unreadable');
      return real ? readRouterAreas(at) : areas.current;
    },
    ensureRouter: async (accountId) => { ensured.push(accountId); return BOUND_OUTCOME; },
    confirmAccount: async (sources, at) => {
      expect(at).toBe(home);
      confirmed.push([...sources]);
      if (real) {
        const out = await confirmAccountArrivals(sources, at);
        written.push([...out]);
        return out;
      }
      if (options.confirmFails === true || (options.confirmFails === 'once' && confirmed.length === 1)) throw new Error('areas store is down');
      if (options.confirmRefuses && sources.some((one) => one.message === options.confirmRefuses)) throw new Error('unusable scope key');
      written.push([...sources]);
      return sources;
    },
  });
  return {
    capture, confirmed, written, ensured, letters, clock, home, reads: () => reads,
    /** The arrivals kept for a retry, as `message` ids. */
    pending: async () => (await mailIntakeQueue(home).read()).entries.map((one) => one.message).sort(),
    notices: async () => (await mailIntakeQueue(home).read()).notices,
  };
}

const messagesOf = (batches: RouterSource[][]) => batches.map((batch) => batch.map((one) => one.message).sort());

async function harness(options: {
  /** `false` starts with the mailbox bound to no router. */
  bound?: boolean;
  /** The folders the bound router watches. */
  folders?: string[];
  /** Every page reads as sorted out of Important, so only the full headline list can carry it. */
  nothingImportant?: boolean;
  confirmFails?: boolean | 'once';
  /** The intake's capture read fails once. */
  captureFails?: boolean;
  areasFail?: boolean;
  /** The intake's folder list read fails once (at the finish). */
  mailboxesFail?: boolean;
  routerOpen?: (taskId: string) => Promise<boolean>;
  noPrefetch?: boolean;
  /** One message per page, so a listing of more than 20 takes several ticks to walk. */
  paged?: boolean;
  /** The provider also lists a Receipts folder. */
  receipts?: boolean;
  real?: { home: string };
  /** The provider changes read flags, and its listing then carries them (off by default, as every other test expects). */
  markRead?: boolean;
  /** The service decorates rows with the real area file and ledgers under the real router's home. */
  decorate?: boolean;
} = {}) {
  // One account only: the poll loop would sync every account against the same fixture listing.
  const { store, bodies, entry } = await cache([ACCOUNT]);
  const providers = new MailProviderRegistry(() => undefined);
  const listing: { current: MailEnvelope[] } = { current: [envelope(1)] };
  /** The Receipts folder's listing (with `receipts`). */
  const receipts: { current: MailEnvelope[] } = { current: [] };
  /** The next poll answers "your cursor is void" with the listing's first page. */
  const control = { reset: false };
  /** The sender a body read reveals, as a conversation transport does. */
  const bodyFrom: { current?: MailAddress } = {};
  /** Recipient lists a body read reveals and the listing lacks. */
  const bodyAddresses: { current?: { to?: MailAddress[]; cc?: MailAddress[]; replyTo?: MailAddress[] } } = {};
  const calls = { listMailboxes: 0, poll: 0, getBody: 0, send: 0, markRead: 0, other: 0 };
  const spec: MailProviderSpec = {
    id: 'fixture',
    label: 'A fixture provider',
    capabilities: {
      search: false, watch: false, drafts: false, markRead: options.markRead === true, flags: false,
      threads: false, send: false, sendAsReply: false, bodies: 'text', attachments: 'none',
    },
    setup: {
      fields: [{ name: 'address', label: 'Address', kind: 'text' }],
      submit: async () => { throw new Error('this fixture adds accounts by hand'); },
    },
    listAccounts: async () => { calls.other += 1; return []; },
    health: async () => { calls.other += 1; return { state: 'ok', checkedAt: Date.now() }; },
    listMailboxes: async () => {
      calls.listMailboxes += 1;
      return [
        { mailboxId: 'inbox', name: 'Inbox', role: 'inbox', unread: 0, total: listing.current.length },
        ...(options.receipts ? [{ mailboxId: 'receipts', name: 'Receipts', role: 'other' as const, unread: 0, total: receipts.current.length }] : []),
      ];
    },
    poll: async (_account, request) => {
      calls.poll += 1;
      if (request.mailbox === 'receipts') return { messages: receipts.current, cursor: 'r1', more: false };
      if (!options.paged) return { messages: listing.current, cursor: 'c1', more: false };
      const reset = control.reset;
      control.reset = false;
      const at = reset ? 0 : Number(request.cursor ?? 0);
      const page = listing.current.slice(at, at + 1);
      return { messages: page, cursor: String(at + page.length), more: at + 1 < listing.current.length, ...(reset ? { reset: true } : {}) };
    },
    getBody: async (_account, messageId) => {
      calls.getBody += 1;
      const text = `Body of ${messageId}`;
      return {
        format: 'text' as const, text, bytes: Buffer.byteLength(text),
        ...(bodyFrom.current ? { from: bodyFrom.current } : {}), ...(bodyAddresses.current ?? {}),
      };
    },
    send: async () => { calls.send += 1; return { acceptedAt: Date.now() }; },
    ...(options.markRead ? {
      markRead: async (_account: string, messageId: string, read: boolean) => {
        calls.markRead += 1;
        // The mailbox now holds the flag, so the next poll lists it.
        listing.current = listing.current.map((one) => one.messageId !== messageId ? one : {
          ...one, flags: read ? [...new Set([...(one.flags ?? []), '\\Seen'])] : (one.flags ?? []).filter((flag) => flag !== '\\Seen'),
        });
      },
    } : {}),
  };
  providers.register(spec, 'the-fixture-plugin');
  const routingHome = options.real?.home;
  const service = new MailService({
    store, bodies, providers,
    ...(options.decorate && routingHome ? { routes: (messages) => decorateMailRoutes(messages, routingHome) } : {}),
  });

  const warnings: string[] = [];
  const areas = { current: options.bound === false ? UNBOUND : bound(options.folders) };
  const recorder = intake(store, areas, {
    confirmFails: options.confirmFails, areasFail: options.areasFail, real: options.real, warnings,
    failOnce: options.captureFails ? 'messagesByIds' : options.mailboxesFail ? 'listMailboxes' : undefined,
    routerOpen: options.routerOpen,
  });
  const captured: Array<{ accountId: string; headlines: MailHeadline[]; inbox: boolean }> = [];
  const captureIncoming: MailIncomingCapture = async (accountId, headlines, opts) => {
    captured.push({ accountId, headlines: [...headlines], inbox: opts?.inbox !== false });
    return recorder.capture(accountId, headlines, opts);
  };

  const real = { ingestPage: service.ingestPage.bind(service), prefetchBodies: service.prefetchBodies.bind(service) };
  if (options.nothingImportant) {
    service.ingestPage = async (accountId, envelopes) => {
      const result = await real.ingestPage(accountId, envelopes);
      return { ...result, importantAdded: 0, importantHeadlines: [], sortedPairs: [{ accountId, mailboxId: 'inbox' }] };
    };
  }
  /** Runs right before the real prefetch, between capture and finish. */
  const beforePrefetch: { current?: () => Promise<void> } = {};
  service.prefetchBodies = async (accountId, mailboxId, limit, deadlineAt) => {
    await beforePrefetch.current?.();
    if (options.noPrefetch) return 0;
    return real.prefetchBodies(accountId, mailboxId, limit, deadlineAt);
  };

  /** Each event with what the intake had confirmed at the moment it went out. */
  const events: Array<{ count: number; headlines: MailHeadline[]; confirmedAtEmit: RouterSource[][] }> = [];
  const host = {
    replica: false,
    log: { debug: () => undefined, info: () => undefined, warn: (message: string) => { warnings.push(message); } },
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
      resetContainer: async (accountId: string) => {
        for (let rows = await store.rowsForAccount(accountId, 200); rows.length > 0; rows = await store.rowsForAccount(accountId, 200)) {
          await store.deleteMessages(rows.map((row) => row.rowid));
        }
      },
    } as never,
    events: {
      syncCompleted: () => undefined,
      messagesReceived: (_account: string, count: number, headlines: MailHeadline[]) => {
        events.push({ count, headlines: [...headlines], confirmedAtEmit: recorder.confirmed.map((batch) => [...batch]) });
      },
      accountHealth: () => undefined,
      mailboxCounts: () => undefined,
    } as never,
    sort: options.nothingImportant ? {
      groupedOn: () => true,
      refreshIdentities: async () => undefined,
      applyCategoryHints: async () => 0,
    } : undefined,
    captureIncoming,
    retryIncoming: recorder.capture.retry,
  });
  entry.sync = sync;
  return {
    db: entry.db, store, bodies, service, sync, listing, receipts, control, bodyFrom, bodyAddresses, calls, areas, captured, beforePrefetch, warnings, events,
    confirmed: () => recorder.confirmed, written: recorder.written, ensured: recorder.ensured, reads: recorder.reads,
    letters: recorder.letters, clock: recorder.clock, home: recorder.home, pending: recorder.pending, notices: recorder.notices,
  };
}

const rowOf = async (store: MailStore, messageId: string, accountId = ACCOUNT) => {
  const row = await store.getMessage(accountId, messageId);
  if (!row) throw new Error(`no cached row for ${messageId}`);
  return row;
};

const ids = (...ns: number[]) => ns.map((n) => `inbox:m-${n}`).sort();

describe('mail sync hands every new inbox mail to its router', () => {
  it('enters every arrival before the event, then announces it once at its body-filled version', async () => {
    const mail = await harness();
    await mail.sync.runTick({ force: true });
    // The backfill is not an arrival: nothing captured, the area file not even read.
    expect(mail.captured).toEqual([]);
    expect(mail.reads()).toBe(0);

    mail.listing.current = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => envelope(n));
    const before = { ...mail.calls };
    await mail.sync.runTick({ force: true });
    expect(mail.captured).toHaveLength(1);
    expect(mail.ensured).toEqual([ACCOUNT]);
    const announced = new Map(mail.captured[0]!.headlines.map((one) => [one.messageId, one.version]));
    expect([...announced.keys()].sort()).toEqual(ids(2, 3, 4, 5, 6, 7, 8));

    // One confirm, after the prefetch, of the body-filled versions only.
    expect(mail.confirmed()).toHaveLength(1);
    // One event, after that confirm, counting seven and naming each at its current exact version.
    expect(mail.events).toHaveLength(1);
    const event = mail.events[0]!;
    expect(event.count).toBe(7);
    expect(event.confirmedAtEmit).toHaveLength(1);
    expect(event.headlines.map((one) => one.messageId).sort()).toEqual(ids(2, 3, 4, 5, 6, 7, 8));
    for (const headline of event.headlines) {
      const row = await rowOf(mail.store, headline.messageId!);
      expect(row.body_ref).toBeTruthy();
      expect(headline.version).toBe(mailRowDeliveryVersion(row));
      expect(headline.version).not.toBe(announced.get(headline.messageId));
      expect(mail.confirmed()[0]).toContainEqual({ kind: 'mail', account: ACCOUNT, message: row.message_id, version: headline.version });
      // Nothing was marked read or flagged on the way.
      expect(row.flags_json).toBe('[]');
    }
    // The intake adds no provider call: one poll, one mailbox list and the prefetch's own bodies.
    expect(mail.calls).toEqual({ ...before, listMailboxes: before.listMailboxes + 1, poll: before.poll + 1, getBody: before.getBody + 7 });
    expect(mail.calls.send).toBe(0);

    // The same listing again is no arrival: nothing captured, confirmed or named, and the binding is not asked again.
    await mail.sync.runTick({ force: true });
    expect(mail.captured).toHaveLength(1);
    expect(mail.confirmed()).toHaveLength(1);
    expect(mail.events.at(-1)).toMatchObject({ count: 0, headlines: [] });
    mail.listing.current = [...mail.listing.current, envelope(9)];
    await mail.sync.runTick({ force: true });
    expect(messagesOf(mail.confirmed().slice(1))).toEqual([ids(9)]);
    expect(mail.ensured).toEqual([ACCOUNT]);
  });

  it('with grouping on, the router gets every arrival while the event names only the initially Important ones', async () => {
    const mail = await harness({ nothingImportant: true });
    await mail.sync.runTick({ force: true });
    mail.listing.current = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => envelope(n));
    await mail.sync.runTick({ force: true });
    expect(mail.captured[0]!.headlines.map((one) => one.messageId).sort()).toEqual(ids(2, 3, 4, 5, 6, 7, 8));
    expect(messagesOf(mail.confirmed())).toEqual([ids(2, 3, 4, 5, 6, 7, 8)]);
    expect(mail.events).toEqual([expect.objectContaining({ count: 0, headlines: [] })]);
  });

  it('a body read that fills a blank sender enters that version, and the event names it', async () => {
    const billing = 'billing@invoices.example.invalid';
    const mail = await harness();
    await mail.sync.runTick({ force: true });
    mail.bodyFrom.current = { address: billing };
    mail.listing.current = [envelope(1), envelope(2, { from: { name: 'Billing', address: '' }, subject: 'Invoice 2' })];
    await mail.sync.runTick({ force: true });

    const row = await rowOf(mail.store, 'inbox:m-2');
    expect(row.from_addr).toBe(billing);
    const initial = mail.captured[0]!.headlines[0]!;
    expect(initial).toMatchObject({ from: '', messageId: 'inbox:m-2' });
    expect(mailRowDeliveryVersion(row)).not.toBe(initial.version);
    expect(mail.confirmed().map((batch) => batch.map((one) => one.version))).toEqual([[mailRowDeliveryVersion(row)]]);
    expect(mail.events).toHaveLength(1);
    expect(mail.events[0]!.confirmedAtEmit).toHaveLength(1);
    expect(mail.events[0]!.headlines).toEqual([expect.objectContaining({
      from: billing, subject: 'Invoice 2', messageId: 'inbox:m-2', version: mailRowDeliveryVersion(row),
    })]);
  });

  it('a known sender rewritten to another between capture and finish is another delivery: neither entered nor named', async () => {
    const other = 'billing@invoices.example.invalid';
    const mail = await harness();
    await mail.sync.runTick({ force: true });
    mail.listing.current = [envelope(1), envelope(2)];
    mail.beforePrefetch.current = async () => {
      mail.beforePrefetch.current = undefined;
      // Same instants and Message-ID, so the same handle to the cache, but another known sender.
      await mail.service.ingestPage(ACCOUNT, [envelope(2, { from: { address: other } })]);
    };
    await mail.sync.runTick({ force: true });
    expect((await rowOf(mail.store, 'inbox:m-2')).from_addr).toBe(other);
    expect(mail.confirmed()).toEqual([]);
    expect(mail.events).toEqual([expect.objectContaining({ count: 1, headlines: [] })]);
  });

  it('leaves quiet a handle whose later delivery landed between capture and finish', async () => {
    const mail = await harness();
    await mail.sync.runTick({ force: true });
    mail.listing.current = [envelope(1), envelope(2), envelope(3)];
    mail.beforePrefetch.current = async () => {
      mail.beforePrefetch.current = undefined;
      // A reply on the same handle replaces the captured row's delivery before finish reads it.
      await mail.service.ingestPage(ACCOUNT, [envelope(2, { sentAt: BASE + 9e6, receivedAt: BASE + 9e6, subject: 'RE: Subject 2' })]);
    };
    await mail.sync.runTick({ force: true });
    // Neither delivery of m-2 is entered: the first was replaced before finish, and the reply was never captured.
    expect(messagesOf(mail.confirmed())).toEqual([ids(3)]);
    expect(mail.events.at(-1)!.headlines.map((one) => one.messageId)).toEqual(['inbox:m-3']);
  });

  it('a mailbox bound to no router keeps its mail, sends one letter, and its router gets the mail once it is bound', async () => {
    const mail = await harness({ bound: false });
    await mail.sync.runTick({ force: true });
    mail.listing.current = [envelope(1), envelope(2), envelope(3)];
    await mail.sync.runTick({ force: true });
    expect(mail.confirmed()).toEqual([]);
    expect(mail.events).toHaveLength(1);
    const latest = await Promise.all(['inbox:m-2', 'inbox:m-3'].map(async (id) => mailRowDeliveryVersion(await rowOf(mail.store, id))));
    expect(mail.events[0]!.headlines.map((one) => [one.messageId, one.version])).toEqual([['inbox:m-2', latest[0]], ['inbox:m-3', latest[1]]]);
    expect(mail.events[0]!.headlines.map((one) => one.version)).not.toContain(mail.captured[0]!.headlines[0]!.version);
    // Kept, never dropped, and the person is told once.
    expect(await mail.pending()).toEqual(ids(2, 3));
    expect(mail.letters).toEqual([{ params: { mailbox: 'acct-a@example.invalid', reason: 'none' }, opKey: expect.stringMatching(/^mail-no-router:fixture%3Aacct-a:\d+$/) }]);

    // Still no router: more mail is kept too, and no second letter.
    mail.listing.current = [envelope(1), envelope(2), envelope(3), envelope(4)];
    await mail.sync.runTick({ force: true });
    expect(await mail.pending()).toEqual(ids(2, 3, 4));
    expect(mail.letters).toHaveLength(1);

    // Bound to its router: the next tick's retry enters every kept mail at its current version, and the episode ends.
    mail.areas.current = bound();
    await mail.sync.runTick({ force: true });
    expect(messagesOf(mail.written)).toEqual([ids(2, 3, 4)]);
    for (const source of mail.written[0]!) expect(source.version).toBe(mailRowDeliveryVersion(await rowOf(mail.store, source.message)));
    expect(await mail.pending()).toEqual([]);
    expect(await mail.notices()).toEqual({});
    expect(mail.letters).toHaveLength(1);
  });

  it('a confirm that fails once goes in one by one in the same tick: the event names the arrivals and nothing waits', async () => {
    const mail = await harness({ confirmFails: 'once' });
    await mail.sync.runTick({ force: true });
    mail.listing.current = [envelope(1), envelope(2), envelope(3)];
    await mail.sync.runTick({ force: true });
    expect(mail.events[0]!.headlines.map((one) => one.messageId)).toEqual(['inbox:m-2', 'inbox:m-3']);
    expect(messagesOf(mail.written)).toEqual([ids(2), ids(3)]);
    expect(await mail.pending()).toEqual([]);
    expect(mail.warnings).toContain('mail router intake failed; entering that batch one by one');
  });

  it.each([
    ['every confirm fails', { confirmFails: true }, 'mail router intake failed; entering that batch one by one', true, [], ids(2, 3, 4)],
    ['the capture itself fails', { captureFails: true }, 'mail router intake capture failed', false, [ids(2, 3), ids(4)], []],
    ['the area file cannot be read', { areasFail: true }, 'mail router intake confirm failed', false, [], ids(2, 3, 4)],
    ['the folder list cannot be read', { mailboxesFail: true }, 'mail router intake confirm failed', false, [ids(2, 3), ids(4)], []],
  ] as const)('when %s, the event still names the arrivals, polling carries on, and the arrivals are kept for the retry', async (_label, failure, warning, current, writtenAfter, pendingAfter) => {
    const mail = await harness(failure);
    await mail.sync.runTick({ force: true });
    mail.listing.current = [envelope(1), envelope(2), envelope(3)];
    const report = await mail.sync.runTick({ force: true });
    expect(report.polled).toBe(1);
    expect(mail.events).toHaveLength(1);
    expect(mail.events[0]).toMatchObject({ count: 2 });
    expect(mail.events[0]!.headlines.map((one) => one.messageId)).toEqual(['inbox:m-2', 'inbox:m-3']);
    // A failed write still names the current versions; a failed capture or finish names them as ingested.
    const finals = await Promise.all(['inbox:m-2', 'inbox:m-3'].map(async (id) => mailRowDeliveryVersion(await rowOf(mail.store, id))));
    if (current) expect(mail.events[0]!.headlines.map((one) => one.version)).toEqual(finals);
    else expect(mail.events[0]!.headlines.map((one) => one.version)).not.toEqual(finals);
    expect(mail.warnings).toContain(warning);
    expect(mail.warnings).not.toContain('mail poll failed');
    expect((await mail.store.getAccount(ACCOUNT))?.state).toBe('active');
    expect((await rowOf(mail.store, 'inbox:m-3')).body_ref).toBeTruthy();

    // Nothing was lost: what did not reach the router waits for the next tick.
    expect(await mail.pending()).toEqual(ids(2, 3));
    expect(mail.letters).toEqual([]);

    // The next tick runs normally, and its retry enters what the failure kept (before the new mail).
    mail.listing.current = [envelope(1), envelope(2), envelope(3), envelope(4)];
    expect((await mail.sync.runTick({ force: true })).polled).toBe(1);
    expect(mail.events.at(-1)!.count).toBe(1);
    expect(mail.events.at(-1)!.headlines.map((one) => one.messageId)).toEqual(['inbox:m-4']);
    expect(messagesOf(mail.written)).toEqual(writtenAfter);
    expect(await mail.pending()).toEqual(pendingAfter);
    for (const batch of mail.written) {
      for (const source of batch) expect(source.version).toBe(mailRowDeliveryVersion(await rowOf(mail.store, source.message)));
    }
  });

  it('reads only the cache: a body not cached is entered as it stands, never fetched', async () => {
    const mail = await harness({ noPrefetch: true });
    await mail.sync.runTick({ force: true });
    mail.listing.current = [envelope(1), envelope(2)];
    await mail.sync.runTick({ force: true });
    expect(mail.calls.getBody).toBe(0);
    const row = await rowOf(mail.store, 'inbox:m-2');
    expect(row.body_ref).toBeNull();
    // The version did not move: finish enters that same exact version, once.
    expect(mail.confirmed()).toEqual([[{ kind: 'mail', account: ACCOUNT, message: 'inbox:m-2', version: mailRowDeliveryVersion(row) }]]);
  });

  it('nothing can wake the router while the prefetch runs; after it, only the final version is pending, once', async () => {
    const mail = await harness();
    // The real mail source registry answers the wake's "still current" check from the same cache.
    const unregister = registerMailRouterSource(mail.store, mail.bodies);
    try {
      await mail.sync.runTick({ force: true });
      // What the area file holds once each entered source is an open item of area-1, with its active local router.
      const wakeFile = (): RouterAreasFile => ({
        ...bound(),
        openItems: mail.confirmed().flat().map((source) => ({ source: { ...source }, areaId: 'area-1', canonicalKey: `key-${source.message}` })),
      });
      const wakeDeps: RouterWakeDeps = {
        readAreas: async () => wakeFile(),
        getTask: async (id) => ({ id, phase: 'IN_PROGRESS', source: 'local', org_role: 'router', router_area_id: 'area-1', router_paused: false }) as WakeTask,
        orgEnabled: async () => true,
        routesFor: async () => new Map(),
        sessionsForTask: async () => [],
        send: async () => undefined,
        start: async () => ({}),
        nonce: () => 'n',
      };
      const atPrefetch: Array<{ confirmed: number; wake: boolean }> = [];
      mail.listing.current = [envelope(1), envelope(2)];
      mail.beforePrefetch.current = async () => {
        atPrefetch.push({ confirmed: mail.confirmed().length, wake: (await checkRouterPending({ areaId: 'area-1' }, wakeDeps)).fire });
      };
      await mail.sync.runTick({ force: true });
      // Capture wrote nothing, so the wake check during the prefetch finds no item to route.
      expect(atPrefetch).toEqual([{ confirmed: 0, wake: false }]);

      const row = await rowOf(mail.store, 'inbox:m-2');
      const final = { kind: 'mail' as const, account: ACCOUNT, message: 'inbox:m-2', version: mailRowDeliveryVersion(row) };
      expect(row.body_ref).toBeTruthy();
      expect(mail.confirmed()).toEqual([[final]]);
      expect((await checkRouterPending({ areaId: 'area-1' }, wakeDeps)).fire).toBe(true);
      expect(await pendingSources(wakeFile(), wakeFile().areas[0]!, wakeDeps)).toEqual([final]);
    } finally {
      unregister();
    }
  });
});

describe('the folders a router watches', () => {
  it('by default only the Inbox: a new Receipts mail reaches the intake but is neither read nor entered nor announced', async () => {
    const mail = await harness({ receipts: true });
    await mail.sync.runTick({ force: true });
    mail.listing.current = [envelope(1), envelope(2)];
    mail.receipts.current = [receipt(3)];
    await mail.sync.runTick({ force: true });
    expect(mail.captured.map((one) => [one.inbox, one.headlines.map((headline) => headline.messageId)]))
      .toEqual([[true, ['inbox:m-2']], [false, ['receipts:m-3']]]);
    expect(messagesOf(mail.confirmed())).toEqual([ids(2)]);
    expect(mail.events.map((one) => one.headlines.map((headline) => headline.messageId))).toEqual([['inbox:m-2']]);
  });

  it('a router that names Receipts gets a new Receipts arrival at its final version, never announced as inbox news', async () => {
    const mail = await harness({ receipts: true, folders: ['inbox', 'Receipts'] });
    await mail.sync.runTick({ force: true });
    mail.receipts.current = [receipt(3)];
    await mail.sync.runTick({ force: true });
    const row = await rowOf(mail.store, 'receipts:m-3');
    expect(mail.confirmed()).toEqual([[{ kind: 'mail', account: ACCOUNT, message: 'receipts:m-3', version: mailRowDeliveryVersion(row) }]]);
    expect(mail.events.flatMap((one) => one.headlines)).toEqual([]);
    expect(await watchesOtherFolders(ACCOUNT, HOME, async () => mail.areas.current)).toBe(true);
  });

  it('a Receipts mail that arrived longer ago than the new-mail window is not routed (its folder\'s first sweep lists old mail)', async () => {
    const mail = await harness({ receipts: true, folders: ['inbox', 'Receipts'] });
    await mail.sync.runTick({ force: true });
    mail.receipts.current = [
      receipt(3, { sentAt: NOW - OTHER_FOLDER_NEW_MS - 60_000, receivedAt: NOW - OTHER_FOLDER_NEW_MS - 60_000 }),
      receipt(4, { sentAt: NOW - OTHER_FOLDER_NEW_MS + 60_000, receivedAt: NOW - OTHER_FOLDER_NEW_MS + 60_000 }),
    ];
    await mail.sync.runTick({ force: true });
    expect(messagesOf(mail.confirmed())).toEqual([['receipts:m-4']]);
  });
});

describe('a cache that lists again from the top is a backfill, not an arrival', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => envelope(i + 1));
  const cachedIds = async (store: MailStore) => (await store.messagesByIds(ACCOUNT, many(30).map((one) => one.messageId)))
    .map((row) => row.message_id).sort();

  /** Backfills 25 mails over two ticks; returns the harness with the cache full and quiet. */
  async function backfilled() {
    const mail = await harness({ paged: true });
    mail.listing.current = many(25);
    await mail.sync.runTick({ force: true });
    await mail.sync.runTick({ force: true });
    expect(await cachedIds(mail.store)).toEqual(many(25).map((one) => one.messageId).sort());
    expect(mail.events).toEqual([]);
    return mail;
  }

  /** Walks the re-listing to its end, then checks that only a later delivery is news. */
  async function relistQuietThenNews(mail: Awaited<ReturnType<typeof backfilled>>) {
    // Two ticks of old mail re-listed: rows come back, nothing is received, captured or confirmed.
    await mail.sync.runTick({ force: true });
    await mail.sync.runTick({ force: true });
    expect(await cachedIds(mail.store)).toEqual(many(25).map((one) => one.messageId).sort());
    expect(mail.events.filter((one) => one.count > 0)).toEqual([]);
    expect(mail.captured).toEqual([]);
    expect(mail.confirmed()).toEqual([]);

    // Drained: a quiet poll replays nothing, and the next real delivery is news again.
    await mail.sync.runTick({ force: true });
    expect(mail.captured).toEqual([]);
    mail.listing.current = many(26);
    await mail.sync.runTick({ force: true });
    expect(mail.events.at(-1)).toMatchObject({ count: 1 });
    expect(mail.captured.map((one) => one.headlines.map((headline) => headline.messageId))).toEqual([['inbox:m-26']]);
    expect(messagesOf(mail.confirmed()).flat()).toContain('inbox:m-26');
  }

  it('an inbox reset re-lists its old mail over several ticks without announcing or confirming any of it', async () => {
    const mail = await backfilled();
    mail.control.reset = true;
    await relistQuietThenNews(mail);
  });

  it('a provider identity revision re-lists its accounts the same way', async () => {
    const mail = await backfilled();
    await mail.sync.resetAccountBackfill(async () => {
      const swept = await reconcileIdentityRevision({ store: mail.store, bodies: mail.bodies }, 'fixture', 'handles-v2');
      expect(swept).toMatchObject({ swept: true, messages: 25 });
      return [ACCOUNT];
    });
    expect(await cachedIds(mail.store)).toEqual([]);
    await relistQuietThenNews(mail);
  });
});

describe('the router intake helper', () => {
  async function seeded(n: number, mailboxes = [INBOX_ROW]) {
    const { store, bodies } = await cache();
    for (const accountId of [ACCOUNT, OTHER]) for (const row of mailboxes) await store.upsertMailbox({ accountId, ...row });
    const service = new MailService({ store, bodies, providers: new MailProviderRegistry(() => undefined) });
    const ingested = await service.ingestPage(ACCOUNT, Array.from({ length: n }, (_, i) => envelope(i + 1)));
    expect(ingested.headlines).toHaveLength(n);
    return { store, service, headlines: ingested.headlines };
  }

  it('an unbound mailbox enters nothing but keeps it and still answers exact current headlines; with no ids it reads nothing', async () => {
    const { store, headlines } = await seeded(3);
    const quiet = intake(store, { current: UNBOUND });
    const shown = await (await quiet.capture(ACCOUNT, headlines))();
    expect(quiet.confirmed).toEqual([]);
    expect(quiet.reads()).toBe(1);
    expect(await quiet.pending()).toEqual(ids(1, 2, 3));
    expect(quiet.letters).toHaveLength(1);
    expect(shown).toEqual(await Promise.all(headlines.map(async (one) => {
      const row = await rowOf(store, one.messageId!);
      return { from: row.from_addr, subject: row.subject, messageId: row.message_id, version: mailRowDeliveryVersion(row), canonicalKey: one.canonicalKey };
    })));

    // Void (keep the ingested headlines) only when no headline names an exact delivery.
    const empty = intake(store, { current: bound() });
    expect(await (await empty.capture(ACCOUNT, []))()).toBeUndefined();
    expect(await (await empty.capture(ACCOUNT, [{ from: 'x', subject: 'no handle' }]))()).toBeUndefined();
    expect(empty.reads()).toBe(0);
    expect(empty.confirmed).toEqual([]);
  });

  it('captures only a row still at the announced version, and answers [] when none is', async () => {
    const { store, service, headlines } = await seeded(2);
    // The second row was rewritten (a re-decoded subject) after its headline went out.
    await service.ingestPage(ACCOUNT, [envelope(2, { subject: 'Subject 2 (re-decoded)' })]);
    const recorder = intake(store, { current: bound() });
    await (await recorder.capture(ACCOUNT, headlines))();
    expect(messagesOf(recorder.confirmed)).toEqual([ids(1)]);

    for (const areas of [bound(), UNBOUND]) {
      const stale = intake(store, { current: areas });
      expect(await (await stale.capture(ACCOUNT, headlines.slice(1)))()).toEqual([]);
      expect(stale.confirmed).toEqual([]);
    }
  });

  it('enters only the exact headlined rows of that account', async () => {
    const { store, service, headlines } = await seeded(2);
    // The same handle cached under another account, and more mail in this account, none headlined.
    await service.ingestPage(OTHER, [envelope(1)]);
    await service.ingestPage(ACCOUNT, [envelope(40), envelope(41)]);
    const recorder = intake(store, { current: bound() });
    await (await recorder.capture(ACCOUNT, headlines.slice(0, 1)))();
    expect(recorder.confirmed).toEqual([[{
      kind: 'mail', account: ACCOUNT, message: 'inbox:m-1',
      version: mailRowDeliveryVersion(await rowOf(store, 'inbox:m-1')),
    }]]);
  });

  it('enters nothing at capture, and finish leaves out a row that left the cache', async () => {
    const { store, headlines } = await seeded(2);
    const recorder = intake(store, { current: bound() });
    const finish = await recorder.capture(ACCOUNT, headlines);
    expect(recorder.confirmed).toEqual([]);
    expect(recorder.reads()).toBe(0);
    await store.deleteMessages([(await rowOf(store, 'inbox:m-1')).rowid]);
    expect(await store.getMessage(ACCOUNT, 'inbox:m-1')).toBeUndefined();
    expect((await finish() ?? []).map((one) => one.messageId)).toEqual(['inbox:m-2']);
    expect(messagesOf(recorder.confirmed)).toEqual([ids(2)]);
  });

  it('a mail in a folder no router watches is still named, never entered', async () => {
    const { store, headlines } = await seeded(2);
    // The row's folder has no mailbox row at all (a folder the cache forgot): never the router's.
    await store.deleteMailbox(ACCOUNT, 'inbox');
    const recorder = intake(store, { current: bound() });
    expect((await (await recorder.capture(ACCOUNT, headlines))())?.map((one) => one.messageId)).toEqual(['inbox:m-1', 'inbox:m-2']);
    expect(recorder.confirmed).toEqual([]);
  });

  it('{ inbox: false } with an Inbox-only router reads nothing; a router that watches another folder reads it', async () => {
    const { store, headlines } = await seeded(2, [INBOX_ROW, RECEIPTS_ROW]);
    let storeReads = 0;
    const counting = {
      messagesByIds: async (accountId: string, wanted: ReadonlyArray<string>) => { storeReads += 1; return store.messagesByIds(accountId, wanted); },
      listMailboxes: async (accountId: string) => { storeReads += 1; return store.listMailboxes(accountId); },
    };
    const confirmed: RouterSource[][] = [];
    const make = (file: RouterAreasFile) => createMailRouterIntake({
      store: counting, home: HOME, now: () => NOW, routerOpen: async () => true, readAreas: async () => file,
      ensureRouter: async () => BOUND_OUTCOME,
      confirmAccount: async (sources) => { confirmed.push([...sources]); return sources; },
    });
    for (const file of [bound(), bound(['inbox']), bound(['INBOX'])]) {
      expect(await (await make(file)(ACCOUNT, headlines, { inbox: false }))()).toBeUndefined();
    }
    expect(storeReads).toBe(0);
    expect(confirmed).toEqual([]);
    // These rows sit in the Inbox, which the router also watches: entered, folder by role.
    await (await make(bound(['Receipts', 'inbox']))(ACCOUNT, headlines, { inbox: false }))();
    expect(storeReads).toBeGreaterThan(0);
    expect(messagesOf(confirmed)).toEqual([ids(1, 2)]);
  });

  it('binds the mailbox once per run while the binding holds; a person\'s pick or a failure asks again next time', async () => {
    const { store, headlines } = await seeded(1);
    const answers: Array<AccountRouterOutcome | Error> = [{ bound: false, reason: 'choose' }, new Error('areas locked'), BOUND_OUTCOME];
    const asked: string[] = [];
    const warnings: string[] = [];
    const capture = createMailRouterIntake({
      store, home: HOME, now: () => NOW, routerOpen: async () => true, readAreas: async () => bound(),
      log: { warn: (message) => { warnings.push(message); } },
      ensureRouter: async (accountId) => {
        asked.push(accountId);
        const next = answers.shift()!;
        if (next instanceof Error) throw next;
        return next;
      },
      confirmAccount: async (sources) => sources,
    });
    for (let i = 0; i < 4; i += 1) await (await capture(ACCOUNT, headlines))();
    expect(asked).toEqual([ACCOUNT, ACCOUNT, ACCOUNT]);
    expect(warnings).toEqual(['mail router binding left this mailbox unbound', 'mail router binding failed']);
  });

  it('a retry waits for the first backfill, then enters a kept mail; one gone from the cache is dropped', async () => {
    const mail = await harness();
    await mailIntakeQueue(mail.home, { now: () => NOW }).add([
      { account: ACCOUNT, message: 'inbox:m-1', at: NOW },
      { account: ACCOUNT, message: 'inbox:m-99', at: NOW },
      { account: OTHER, message: 'inbox:m-1', at: NOW },
    ]);
    await mail.sync.runTick({ force: true });
    // The backfill tick: nothing retried yet.
    expect(mail.confirmed()).toEqual([]);
    expect(await mail.pending()).toEqual(['inbox:m-1', 'inbox:m-1', 'inbox:m-99']);
    await mail.sync.runTick({ force: true });
    expect(mail.written).toEqual([[{ kind: 'mail', account: ACCOUNT, message: 'inbox:m-1', version: mailRowDeliveryVersion(await rowOf(mail.store, 'inbox:m-1')) }]]);
    // Only this account's entries are this account's retry: the other mailbox's stays for its own.
    expect((await mailIntakeQueue(mail.home).read()).entries).toEqual([{ account: OTHER, message: 'inbox:m-1', at: NOW }]);
  });

  it('a retried mail outside the Inbox counts as new by when it was first seen, not by the retry', async () => {
    const { store, service } = await seeded(0, [INBOX_ROW, RECEIPTS_ROW]);
    await service.ingestPage(ACCOUNT, [receipt(1), receipt(2)]);
    const recorder = intake(store, { current: bound(['Receipts']) });
    // Seen within the window (an hour after it arrived), retried three days later; the other first seen three days on.
    await mailIntakeQueue(recorder.home, { now: () => NOW }).add([
      { account: ACCOUNT, message: 'receipts:m-1', at: NOW },
      { account: ACCOUNT, message: 'receipts:m-2', at: NOW + 3 * 24 * 60 * 60_000 },
    ]);
    recorder.clock.at = NOW + 3 * 24 * 60 * 60_000;
    await recorder.capture.retry(ACCOUNT);
    expect(messagesOf(recorder.written)).toEqual([['receipts:m-1']]);
    // Neither waits any more: one entered, one not new for any router.
    expect(await recorder.pending()).toEqual([]);
  });

  it('a retry that fails keeps its entries and never throws', async () => {
    const { store } = await seeded(1);
    const warnings: string[] = [];
    const recorder = intake(store, { current: bound() }, { confirmFails: true, warnings });
    await mailIntakeQueue(recorder.home, { now: () => NOW }).add([{ account: ACCOUNT, message: 'inbox:m-1', at: NOW }]);
    await expect(recorder.capture.retry(ACCOUNT)).resolves.toBeUndefined();
    expect(await recorder.pending()).toEqual(ids(1));
    expect(warnings).toContain('mail router intake failed; entering that batch one by one');
  });

  it('one mail its router always refuses holds back no other, and leaves the queue after MAIL_INTAKE_MAX_TRIES retries', async () => {
    const { store } = await seeded(3);
    const warnings: string[] = [];
    const recorder = intake(store, { current: bound() }, { confirmRefuses: 'inbox:m-1', warnings });
    await mailIntakeQueue(recorder.home, { now: () => NOW }).add(['inbox:m-1', 'inbox:m-2', 'inbox:m-3'].map((message) => ({ account: ACCOUNT, message, at: NOW })));
    await recorder.capture.retry(ACCOUNT);
    // The other two went in at once; only the refused one waits.
    expect(messagesOf(recorder.written).flat().sort()).toEqual(['inbox:m-2', 'inbox:m-3']);
    expect(await recorder.pending()).toEqual(['inbox:m-1']);
    for (let n = 1; n < MAIL_INTAKE_MAX_TRIES; n += 1) await recorder.capture.retry(ACCOUNT);
    expect(await recorder.pending()).toEqual([]);
    expect(warnings).toContain('mail intake dropped arrivals its router refused every time');
  });

  it('a no-router letter held back (automatic router off) is asked again, never marked sent', async () => {
    const { store, headlines } = await seeded(1);
    const recorder = intake(store, { current: UNBOUND }, { letterSent: false });
    await (await recorder.capture(ACCOUNT, headlines))();
    expect(Object.values(await recorder.notices()).map((one) => one.sent)).toEqual([false]);
  });

  it(`queries rows and enters them in batches of ${ROUTER_INTAKE_BATCH}`, async () => {
    const { store, headlines } = await seeded(450);
    const queried: number[] = [];
    const counting = {
      messagesByIds: async (accountId: string, wanted: ReadonlyArray<string>) => {
        queried.push(wanted.length);
        return store.messagesByIds(accountId, wanted);
      },
      listMailboxes: (accountId: string) => store.listMailboxes(accountId),
    };
    const confirmed: number[] = [];
    const capture = createMailRouterIntake({
      store: counting, home: HOME, now: () => NOW, routerOpen: async () => true, readAreas: async () => bound(),
      ensureRouter: async () => BOUND_OUTCOME,
      confirmAccount: async (sources) => { confirmed.push(sources.length); return sources; },
    });
    const finish = await capture(ACCOUNT, headlines);
    expect(queried).toEqual([200, 200, 50]);
    expect(confirmed).toEqual([]);
    expect(await finish()).toHaveLength(450);
    expect(queried).toEqual([200, 200, 50, 200, 200, 50]);
    // Finish enters every row once at its exact version, unchanged here.
    expect(confirmed).toEqual([200, 200, 50]);
  });
});

describe('a mailbox bound to its router: every new mail reaches that router', () => {
  // 2026-11-12: the prod Personal router had no rule and no confirmed item, so no mail ever reached it.
  const BAKERY = 'desk@bakery.example.invalid';
  const prior = process.env.WALNUT_MAIL_AUTO_ROUTER;
  beforeEach(() => { process.env.WALNUT_MAIL_AUTO_ROUTER = '1'; });
  afterEach(() => {
    if (prior === undefined) delete process.env.WALNUT_MAIL_AUTO_ROUTER; else process.env.WALNUT_MAIL_AUTO_ROUTER = prior;
  });

  const routerOpen = async () => true;

  /** A real areas file under a temp home: the Personal area and its router; `bind` binds ACCOUNT to it already. */
  async function boundRouter(options: { paused?: boolean; bind?: boolean } = {}) {
    const paused = options.paused ?? false;
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'mail-router-bound-'));
    roots.push(home);
    seedTaskStore(home);
    await updateRouterAreas(home, () => ({
      version: 1,
      areas: [{ id: 'personal', name: 'Personal', host: '__local__', taskIds: ['router-personal'], sources: options.bind === false ? [] : [{ kind: 'mail', account: ACCOUNT }] }],
      routers: [{ taskId: 'router-personal', areaId: 'personal', paused }],
      items: [],
      ...(options.bind === false ? {} : { accountBindings: [{ kind: 'mail', account: ACCOUNT, areaId: 'personal', boundAt: 1 }] }),
    }) as RouterAreasFile);
    const wakeDeps = (): RouterWakeDeps => ({
      readAreas: () => readRouterAreas(home),
      getTask: async (id) => ({ id, phase: 'IN_PROGRESS', source: 'local', org_role: 'router', router_area_id: 'personal', router_paused: paused }) as WakeTask,
      orgEnabled: async () => true,
      routesFor: async () => new Map(),
      sessionsForTask: async () => [],
      send: async () => undefined,
      start: async () => ({}),
      nonce: () => 'n',
    });
    const wakes = async () => (await checkRouterPending({ areaId: 'personal' }, wakeDeps())).fire;
    return { home, wakes, wakeDeps, openItems: async () => (await readRouterAreas(home)).openItems ?? [] };
  }

  /** A tick of backfill, then `envelopes` arrive after m-1, with the real areas file and confirm. */
  async function arrive(
    router: Awaited<ReturnType<typeof boundRouter>>, envelopes: MailEnvelope[],
    extra: { markRead?: boolean; decorate?: boolean; routerOpen?: (taskId: string) => Promise<boolean> } = {}, prepare?: (mail: Awaited<ReturnType<typeof harness>>) => void,
  ) {
    const mail = await harness({ real: { home: router.home }, ...extra });
    prepare?.(mail);
    const unregister = registerMailRouterSource(mail.store, mail.bodies);
    await mail.sync.runTick({ force: true });
    mail.listing.current = [envelope(1), ...envelopes];
    await mail.sync.runTick({ force: true });
    return { mail, unregister };
  }

  async function bindAndArrive(router: Awaited<ReturnType<typeof boundRouter>>, envelopes: MailEnvelope[]) {
    const outcome = await ensureAccountRouter('mail', ACCOUNT, { home: router.home, routerOpen });
    return { outcome, ...await arrive(router, envelopes) };
  }

  it('binds the mailbox to the one router area and gives that router every arrival, with no rule', async () => {
    const router = await boundRouter({ bind: false });
    const { outcome, mail, unregister } = await bindAndArrive(router, [envelope(2), envelope(3, { subject: 'A newsletter' }), envelope(4)]);
    try {
      expect(outcome).toEqual({ bound: true, areaId: 'personal', created: false, already: false });
      const file = await readRouterAreas(router.home);
      expect(file.accountBindings).toEqual([{ kind: 'mail', account: ACCOUNT, areaId: 'personal', boundAt: expect.any(Number) }]);
      expect(file.areas[0].sources).toEqual([{ kind: 'mail', account: ACCOUNT }]);
      // Open, never restricted: the confirmed list stays empty.
      expect(file.items).toEqual([]);
      expect((file.openItems ?? []).map((one) => one.source.message).sort()).toEqual(ids(2, 3, 4));
      expect(await router.wakes()).toBe(true);
      const pending = await pendingSources(file, file.areas[0], { routesFor: async () => new Map() });
      expect(pending.map((one) => one.message).sort()).toEqual(ids(2, 3, 4));
      // Every arrival is still announced, at the version the router holds.
      const announced = mail.events.at(-1)!.headlines;
      expect(announced.map((one) => one.messageId).sort()).toEqual(ids(2, 3, 4));
      expect(announced.map((one) => one.version).sort()).toEqual((file.openItems ?? []).map((one) => one.source.version).sort());
      // The same listing again is no new arrival.
      await mail.sync.runTick({ force: true });
      expect(await router.openItems()).toHaveLength(3);
    } finally { unregister(); }
  });

  it('a paused router keeps its mail: arrivals are entered, and the wake waits for the resume', async () => {
    const router = await boundRouter({ paused: true });
    const { mail, unregister } = await arrive(router, [envelope(2)]);
    try {
      const row = await rowOf(mail.store, 'inbox:m-2');
      expect((await router.openItems()).map((one) => one.source)).toEqual([{ kind: 'mail', account: ACCOUNT, message: 'inbox:m-2', version: mailRowDeliveryVersion(row) }]);
      expect(mail.written).toEqual([[{ kind: 'mail', account: ACCOUNT, message: 'inbox:m-2', version: mailRowDeliveryVersion(row) }]]);
      expect(await router.wakes()).toBe(false);
      expect(mail.events.at(-1)!.headlines.map((one) => one.messageId)).toEqual(['inbox:m-2']);
      // Resumed: the same item wakes it, nothing re-entered.
      await updateRouterAreas(router.home, (file) => ({ ...file, routers: file.routers.map((one) => ({ ...one, paused: false })) }));
      const resumed = { ...router.wakeDeps(), getTask: async (id: string) => ({ id, phase: 'IN_PROGRESS', source: 'local', org_role: 'router', router_area_id: 'personal', router_paused: false }) as WakeTask };
      expect((await checkRouterPending({ areaId: 'personal' }, resumed)).fire).toBe(true);
    } finally { unregister(); }
  });

  it('a mailbox whose area has no router at all keeps its mail and tells the person once; a router given to the area gets it', async () => {
    const router = await boundRouter();
    await updateRouterAreas(router.home, (file) => ({ ...file, routers: [] }));
    const { mail, unregister } = await arrive(router, [envelope(2)]);
    try {
      expect(mail.confirmed()).toEqual([]);
      expect(await router.openItems()).toEqual([]);
      expect(mail.events.at(-1)!.headlines.map((one) => one.messageId)).toEqual(['inbox:m-2']);
      expect(await mail.pending()).toEqual(ids(2));
      expect(mail.letters.map((one) => one.params)).toEqual([{ mailbox: 'acct-a@example.invalid', reason: 'none' }]);
      await mail.sync.runTick({ force: true });
      expect(mail.letters).toHaveLength(1);

      // The area gets its router back: the next tick's retry lists the kept mail.
      await updateRouterAreas(router.home, (file) => ({ ...file, routers: [{ taskId: 'router-personal', areaId: 'personal', paused: false }] }));
      await mail.sync.runTick({ force: true });
      expect((await router.openItems()).map((one) => one.source.message)).toEqual(['inbox:m-2']);
      expect(await mail.pending()).toEqual([]);
      expect(await mail.notices()).toEqual({});
      expect(mail.letters).toHaveLength(1);
    } finally { unregister(); }
  });

  it('a mailbox whose router is complete lists its mail for the reopen and tells the person once per episode', async () => {
    const router = await boundRouter();
    const state = { open: false };
    const { mail, unregister } = await arrive(router, [envelope(2)], { routerOpen: async () => state.open });
    try {
      // Listed for the area, so the reopened router is woken for it; nothing waits in the queue.
      expect((await router.openItems()).map((one) => one.source.message)).toEqual(['inbox:m-2']);
      expect(await mail.pending()).toEqual([]);
      expect(mail.letters.map((one) => one.params)).toEqual([{ mailbox: 'acct-a@example.invalid', reason: 'closed' }]);
      mail.listing.current = [envelope(1), envelope(2), envelope(3)];
      await mail.sync.runTick({ force: true });
      expect((await router.openItems()).map((one) => one.source.message)).toEqual(ids(2, 3));
      expect(mail.letters).toHaveLength(1);

      // Reopened: the next tick ends the episode; closed again later, a new mail starts a new one.
      state.open = true;
      await mail.sync.runTick({ force: true });
      expect(await mail.notices()).toEqual({});
      state.open = false;
      mail.clock.at += 60_000;
      mail.listing.current = [envelope(1), envelope(2), envelope(3), envelope(4)];
      await mail.sync.runTick({ force: true });
      expect(mail.letters).toHaveLength(2);
      expect(mail.letters[1]!.opKey).not.toBe(mail.letters[0]!.opKey);
    } finally { unregister(); }
  });

  it('an arrival a filter moves out of the inbox before the router wakes still reaches the router, at its new copy', async () => {
    // 2026-11-12, prod: a CI notice arrived in the inbox, the person's keep-out-of-inbox rule moved it
    // seconds later, and the router's next wake found no current copy: no wake, no receipt.
    const router = await boundRouter();
    const { mail, unregister } = await arrive(router, [envelope(2, { subject: 'Run failed: CI' }), envelope(3)]);
    try {
      expect((await router.openItems()).map((one) => one.source.message).sort()).toEqual(ids(2, 3));
      // The cache now holds the message only in the CI folder, under another id.
      await mail.db.run('UPDATE messages SET mailbox_id = ?, message_id = ? WHERE account_id = ? AND message_id = ?', ['ci', 'ci:m-2', ACCOUNT, 'inbox:m-2']);
      const before = await readRouterAreas(router.home);
      expect((await pendingSources(before, before.areas[0], { routesFor: async () => new Map() })).map((one) => one.message)).toEqual(['inbox:m-3']);

      expect(await followOpenArrivals('personal', { routesFor: async () => new Map() }, router.home)).toBe(1);
      const after = await readRouterAreas(router.home);
      const moved = after.openItems!.find((one) => one.source.message === 'ci:m-2')!;
      expect(moved.source.version).toBe(mailRowDeliveryVersion(await rowOf(mail.store, 'ci:m-2')));
      expect(moved.canonicalKey).toBe(before.openItems!.find((one) => one.source.message === 'inbox:m-2')!.canonicalKey);
      expect((await pendingSources(after, after.areas[0], { routesFor: async () => new Map() })).map((one) => one.message).sort()).toEqual(['ci:m-2', 'inbox:m-3']);
      // Followed once: nothing changes again.
      expect(await followOpenArrivals('personal', { routesFor: async () => new Map() }, router.home)).toBe(0);

      // A message the cache holds no copy of any more leaves the list.
      await mail.db.run('DELETE FROM messages WHERE account_id = ? AND message_id = ?', [ACCOUNT, 'inbox:m-3']);
      expect(await followOpenArrivals('personal', { routesFor: async () => new Map() }, router.home)).toBe(1);
      expect((await router.openItems()).map((one) => one.source.message)).toEqual(['ci:m-2']);
    } finally { unregister(); }
  });

  it('the wake check follows a moved arrival first, so the router is woken for it', async () => {
    const router = await boundRouter();
    const { mail, unregister } = await arrive(router, [envelope(2)]);
    try {
      await mail.db.run('UPDATE messages SET mailbox_id = ?, message_id = ? WHERE account_id = ? AND message_id = ?', ['ci', 'ci:m-2', ACCOUNT, 'inbox:m-2']);
      expect(await router.wakes()).toBe(false);
      const fire = (await checkRouterPending({ areaId: 'personal' }, {
        ...router.wakeDeps(),
        followOpen: (areaId) => followOpenArrivals(areaId, { routesFor: async () => new Map() }, router.home),
      })).fire;
      expect(fire).toBe(true);
    } finally { unregister(); }
  });

  it('one arrival the source cannot follow never holds back the others, and an unknown answer keeps it', async () => {
    const router = await boundRouter();
    const { mail, unregister } = await arrive(router, [envelope(2), envelope(3)]);
    try {
      for (const n of [2, 3]) {
        await mail.db.run('UPDATE messages SET mailbox_id = ?, message_id = ? WHERE account_id = ? AND message_id = ?', ['ci', `ci:m-${n}`, ACCOUNT, `inbox:m-${n}`]);
      }
      const relocate = async (source: RouterSource, scopeKey: string) => {
        if (source.message === 'inbox:m-2') throw new Error('cache unavailable');
        return relocateRouterItem(source, scopeKey);
      };
      expect(await followOpenArrivals('personal', { routesFor: async () => new Map(), relocate }, router.home)).toBe(1);
      expect((await router.openItems()).map((one) => one.source.message).sort()).toEqual(['ci:m-3', 'inbox:m-2']);
      // A source that cannot tell (undefined) leaves the item as it is.
      expect(await followOpenArrivals('personal', { routesFor: async () => new Map(), relocate: async () => undefined }, router.home)).toBe(0);
      expect((await router.openItems()).map((one) => one.source.message).sort()).toEqual(['ci:m-3', 'inbox:m-2']);
    } finally { unregister(); }
  });

  it('a mail with no RFC id that moved under another id is kept, never dropped as gone', async () => {
    const router = await boundRouter();
    const { mail, unregister } = await arrive(router, [envelope(2, { rfcMessageId: '' })]);
    try {
      const listed = await router.openItems();
      expect(listed.map((one) => one.source.message)).toEqual(['inbox:m-2']);
      await mail.db.run('UPDATE messages SET mailbox_id = ?, message_id = ? WHERE account_id = ? AND message_id = ?', ['ci', 'ci:m-2', ACCOUNT, 'inbox:m-2']);
      expect(await followOpenArrivals('personal', { routesFor: async () => new Map() }, router.home)).toBe(0);
      expect(await router.openItems()).toEqual(listed);
    } finally { unregister(); }
  });

  it('a routed arrival stays where it was routed when its mail moves', async () => {
    const router = await boundRouter();
    const { mail, unregister } = await arrive(router, [envelope(2)]);
    try {
      const routed = (await router.openItems())[0]!.source;
      await mail.db.run('UPDATE messages SET mailbox_id = ?, message_id = ? WHERE account_id = ? AND message_id = ?', ['ci', 'ci:m-2', ACCOUNT, 'inbox:m-2']);
      const routesFor = async (_area: string, sources: readonly RouterSource[]) => new Map(sources.map((one) => [routerKey(one), {} as RouterRoute]));
      expect(await followOpenArrivals('personal', { routesFor }, router.home)).toBe(0);
      expect((await router.openItems()).map((one) => one.source)).toEqual([routed]);
    } finally { unregister(); }
  });

  it('is off with WALNUT_MAIL_AUTO_ROUTER=0', async () => {
    const router = await boundRouter({ bind: false });
    process.env.WALNUT_MAIL_AUTO_ROUTER = '0';
    expect(await ensureAccountRouter('mail', ACCOUNT, { home: router.home, routerOpen })).toEqual({ bound: false, reason: 'off' });
    expect((await readRouterAreas(router.home)).accountBindings).toBeUndefined();
  });

  it('the areas file keeps open arrivals honest: one listing per source, a binding needs its source, an item never changes area', () => {
    const base = {
      version: 1, routers: [],
      areas: [
        { id: 'personal', name: 'Personal', host: '__local__', taskIds: [], sources: [{ kind: 'mail', account: ACCOUNT }] },
        { id: 'family', name: 'Family', host: '__local__', taskIds: [], sources: [{ kind: 'mail', account: ACCOUNT }] },
      ],
    };
    const item = { source: { kind: 'mail', account: ACCOUNT, message: 'inbox:m-1', version: 'v1' }, areaId: 'personal' };
    expect(() => normalizeRouterAreas({ ...base, items: [item], openItems: [item] })).toThrow(/listed twice/);
    expect(() => normalizeRouterAreas({ ...base, items: [], accountBindings: [{ kind: 'mail', account: OTHER, areaId: 'personal', boundAt: 1 }] }))
      .toThrow(/no mail source for its bound account/);
    const closed = normalizeRouterAreas({ ...base, items: [item] });
    const reopened = normalizeRouterAreas({ ...base, items: [], openItems: [item] });
    const empty = normalizeRouterAreas({ ...base, items: [] });
    // A restricted item may become an open one of the same area (the 2026-11-14 move), and any item may leave the list.
    expect(() => assertNoReassignment(closed, reopened)).not.toThrow();
    expect(() => assertNoReassignment(reopened, closed)).not.toThrow();
    expect(() => assertNoReassignment(reopened, empty)).not.toThrow();
    expect(() => assertNoReassignment(closed, empty)).not.toThrow();
    // Never to another area.
    const elsewhere = normalizeRouterAreas({ ...base, items: [], openItems: [{ ...item, areaId: 'family' }] });
    expect(() => assertNoReassignment(reopened, elsewhere)).toThrow(/cannot move from area personal to family/);
  });

  it('binds every mailbox the cache holds at start', async () => {
    const router = await boundRouter({ bind: false });
    const { store } = await cache([ACCOUNT, OTHER]);
    await bindMailAccounts(store, router.home, undefined, (accountId, at) => ensureAccountRouter('mail', accountId, { home: at, routerOpen }));
    expect((await readRouterAreas(router.home)).accountBindings?.map((one) => [one.account, one.areaId]))
      .toEqual([[ACCOUNT, 'personal'], [OTHER, 'personal']]);
  });

  describe('which router a mailbox is bound to (pickArea)', () => {
    const MAIL_AREA = { id: 'mail', name: 'Mail', host: '__local__', taskIds: ['router-mail'], sources: [] };
    const MAIL_ROUTER = { taskId: 'router-mail', areaId: 'mail', paused: false };

    async function homeWith(areas: Array<{ id: string; router: string }>) {
      const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'mail-router-pick-'));
      roots.push(home);
      seedTaskStore(home);
      await updateRouterAreas(home, () => ({
        version: 1, items: [],
        areas: areas.map((one) => ({ id: one.id, name: one.id, host: '__local__', taskIds: [one.router], sources: [] })),
        routers: areas.map((one) => ({ taskId: one.router, areaId: one.id, paused: false })),
      }) as RouterAreasFile);
      const made: string[] = [];
      // As the Org's router setup does: the Mail area and its router join whatever the file holds.
      const createRouter = async (_kind: string, account: string) => {
        made.push(account);
        await updateRouterAreas(home, (file) => ({
          ...file,
          areas: [...file.areas, { ...MAIL_AREA, sources: [{ kind: 'mail', account }] }],
          routers: [...file.routers, MAIL_ROUTER],
        }));
        return 'router-mail';
      };
      return { home, made, createRouter };
    }

    it('several open routers and a Mail router: the mailbox goes to the Mail router', async () => {
      const { home, made, createRouter } = await homeWith([{ id: 'personal', router: 'r-1' }, { id: 'mail', router: 'router-mail' }]);
      expect(await ensureAccountRouter('mail', ACCOUNT, { home, routerOpen, createRouter })).toEqual({ bound: true, areaId: 'mail', created: false, already: false });
      expect(made).toEqual([]);
      expect((await readRouterAreas(home)).accountBindings?.map((one) => [one.account, one.areaId])).toEqual([[ACCOUNT, 'mail']]);
    });

    it('several open routers and no Mail router: the Mail router is made and takes the mailbox, never left unbound', async () => {
      const { home, made, createRouter } = await homeWith([{ id: 'personal', router: 'r-1' }, { id: 'family', router: 'r-2' }]);
      expect(await ensureAccountRouter('mail', ACCOUNT, { home, routerOpen, createRouter })).toEqual({ bound: true, areaId: 'mail', created: true, already: false });
      expect(made).toEqual([ACCOUNT]);
      expect((await readRouterAreas(home)).accountBindings?.map((one) => [one.account, one.areaId])).toEqual([[ACCOUNT, 'mail']]);
    });

    it('no router area at all: one Mail router is made, active, for the first mailbox, and the next joins it', async () => {
      const { home, made, createRouter } = await homeWith([]);
      const [first, second] = await Promise.all([
        ensureAccountRouter('mail', ACCOUNT, { home, routerOpen, createRouter }),
        ensureAccountRouter('mail', OTHER, { home, routerOpen, createRouter }),
      ]);
      expect(made).toEqual([ACCOUNT]);
      expect(first).toEqual({ bound: true, areaId: 'mail', created: true, already: false });
      expect(second).toEqual({ bound: true, areaId: 'mail', created: false, already: false });
      expect((await readRouterAreas(home)).accountBindings?.map((one) => one.account)).toEqual([ACCOUNT, OTHER]);
    });

    it('the kind\'s other mailboxes are bound to one area: a new one joins it, whatever else is open', async () => {
      const { home, createRouter } = await homeWith([{ id: 'personal', router: 'r-1' }, { id: 'mail', router: 'router-mail' }]);
      await updateRouterAreas(home, (file) => ({
        ...file,
        areas: file.areas.map((one) => one.id === 'personal' ? { ...one, sources: [{ kind: 'mail', account: OTHER }] } : one),
        accountBindings: [{ kind: 'mail', account: OTHER, areaId: 'personal', boundAt: 1 }],
      }));
      expect(await ensureAccountRouter('mail', ACCOUNT, { home, routerOpen, createRouter })).toMatchObject({ bound: true, areaId: 'personal' });
    });

    it('a Mail area whose router is closed is the person\'s pick: nothing is bound and nothing made', async () => {
      const { home, made, createRouter } = await homeWith([{ id: 'personal', router: 'r-1' }, { id: 'family', router: 'r-2' }, { id: 'mail', router: 'router-mail' }]);
      const closed = async (id: string) => id !== 'router-mail';
      expect(await ensureAccountRouter('mail', ACCOUNT, { home, routerOpen: closed, createRouter })).toEqual({ bound: false, reason: 'choose' });
      expect(made).toEqual([]);
      expect((await readRouterAreas(home)).accountBindings).toBeUndefined();
    });
  });

  describe('a routed arrival read and marked in the mailbox', () => {
    const FLORIST = 'task-florist';
    const M2 = 'inbox:m-2';
    type Mail = Awaited<ReturnType<typeof harness>>;
    type Shape = { envelope?: Partial<MailEnvelope>; bodyFrom?: MailAddress; bodyAddresses?: { replyTo?: MailAddress[] }; learned?: Record<string, unknown> };
    const FRONT = 'front@bakery.example.invalid';
    const SHAPES: Array<[string, Shape]> = [
      ['a listing that names the sender', {}],
      // A conversation transport: the listing names nobody, the body read names the sender and a reply address.
      ['a body read that taught the sender\'s name and a reply address the listing lacks', {
        envelope: { from: { name: '', address: '' } },
        bodyFrom: { name: 'Bakery Desk', address: BAKERY },
        bodyAddresses: { replyTo: [{ address: FRONT }] },
        learned: { from: { name: 'Bakery Desk', address: BAKERY }, replyTo: [{ address: FRONT }] },
      }],
    ];

    /** One bakery arrival entered into Personal by the bound mailbox, then routed for real: only the session send is a stand-in. */
    async function routedArrival(router: Awaited<ReturnType<typeof boundRouter>>, shape: Shape = SHAPES[0]![1]) {
      // `bodyBytes` lands in the payload as a hint, so the prefetch and a later poll write its keys in different orders.
      const arrived = await arrive(router, [envelope(2, { from: { address: BAKERY }, subject: 'Pickup', bodyBytes: 40, ...shape.envelope })],
        { markRead: true, decorate: true }, (mail) => {
          mail.bodyFrom.current = shape.bodyFrom;
          mail.bodyAddresses.current = shape.bodyAddresses;
        });
      const row = await rowOf(arrived.mail.store, M2);
      expect(row.body_ref).toBeTruthy();
      const source: RouterSource = { kind: 'mail', account: ACCOUNT, message: M2, version: mailRowDeliveryVersion(row) };
      expect((await router.openItems()).map((one) => one.source)).toEqual([source]);
      const sent: RouterRoute[] = [];
      // The florist task is ordinary open work in no area: the router hands it the mail straight.
      const route = async (at: RouterSource) => routeItem(
        { source: at, taskId: FLORIST, reason: 'Bakery mail goes to the florist task.', text: 'Please book the pickup.' },
        {
          areas: await readRouterAreas(router.home),
          store: routerStore('personal', router.home),
          getTask: async (id) => ({ id, title: id, phase: 'IN_PROGRESS', source: 'local' }) as Task,
          send: async (one) => { sent.push(one); },
        },
      );
      const first = await route(source);
      expect(first).toMatchObject({ fresh: true, route: { status: 'routed', taskId: FLORIST, source } });
      expect(sent).toHaveLength(1);
      return { ...arrived, row, source, receipt: first.route, sent, route };
    }

    /** The row as the list, cache search and the reader each decorate it, read one after another. */
    async function views(mail: Mail) {
      const listed = (await mail.service.listMessages({ accountId: ACCOUNT, mailboxId: 'inbox', limit: 20 })).messages.find((one) => one.messageId === M2);
      const found = (await mail.service.search({ accountId: ACCOUNT, q: 'Pickup', limit: 20, cacheOnly: true })).messages.find((one) => one.messageId === M2);
      const opened = await mail.service.readMessage(ACCOUNT, M2, { cacheOnly: true });
      expect(listed && found).toBeTruthy();
      return { all: [listed!, found!, opened.message], body: opened.body };
    }
    const shown = (one: { deliveryVersion?: string; routingArea?: unknown; route?: unknown; routingUnavailable?: boolean }) =>
      ({ version: one.deliveryVersion, area: one.routingArea, route: one.route, unavailable: one.routingUnavailable });

    it.each(SHAPES)('%s: every poll after a read flag keeps the same version and receipt, the source still reads from cache, and nothing arrives or sends again', async (_name, shape) => {
      const router = await boundRouter();
      const { mail, unregister, row: prefetched, source, receipt, sent, route } = await routedArrival(router, shape);
      try {
        const before = await views(mail);
        const baseline = before.all[2]!.route;
        expect(baseline).toMatchObject({ areaId: 'personal', status: 'routed', taskId: FLORIST, at: receipt.at });
        const expected = { version: source.version, area: { id: 'personal', name: 'Personal', paused: false }, route: baseline, unavailable: undefined };
        for (const one of before.all) expect(shown(one)).toEqual(expected);
        // What the prefetch left: the body's preview, and its payload key order.
        expect(prefetched.snippet).not.toBe('Preview 2');
        const prefetchedKeys = Object.keys(JSON.parse(prefetched.payload ?? '{}'));
        expect(prefetched.from_addr).toBe(BAKERY);
        if (shape.learned) expect(JSON.parse(prefetched.payload ?? '{}')).toMatchObject(shape.learned);
        const start = { calls: { ...mail.calls }, captured: mail.captured.length, confirmed: mail.confirmed().length, events: mail.events.length };

        for (const read of [true, false, true]) {
          const marked = await mail.service.markRead(ACCOUNT, M2, read);
          expect(shown(marked)).toEqual(expected);
          const hashBefore = (await rowOf(mail.store, M2)).envelope_hash;
          await mail.sync.runTick({ force: true });
          const row = await rowOf(mail.store, M2);
          // The poll really rewrote the row: the new flag, the listing's preview over the body's, its own key order.
          expect(row.envelope_hash).not.toBe(hashBefore);
          expect(JSON.parse(row.flags_json)).toEqual(read ? ['\\Seen'] : []);
          expect(row.snippet).toBe('Preview 2');
          expect(row.body_ref).toBe(prefetched.body_ref);
          const keys = Object.keys(JSON.parse(row.payload ?? '{}'));
          expect(keys).not.toEqual(prefetchedKeys);
          expect([...keys].sort()).toEqual([...prefetchedKeys].sort());
          // What the body read taught stays: the sender column, its name, the reply address.
          expect(row.from_addr).toBe(BAKERY);
          if (shape.learned) expect(JSON.parse(row.payload ?? '{}')).toMatchObject(shape.learned);
          // Still the confirmed delivery, everywhere it is shown.
          expect(mailRowDeliveryVersion(row)).toBe(source.version);
          const now = await views(mail);
          for (const one of now.all) expect(shown(one)).toEqual(expected);
          if (shape.learned) for (const one of now.all) expect(one).toMatchObject(shape.learned);
          expect(now.body?.text).toBe(`Body of ${M2}`);
          expect(await currentRouterSources([source])).toEqual([source]);
          expect(await readRouterItem(source)).toMatchObject({ item: { source }, bodyAvailable: true, body: { text: `Body of ${M2}` } });
          // Routing it again finds the one receipt and sends nothing.
          expect(await route(source)).toEqual({ route: receipt, fresh: false });
        }

        expect(mail.calls.markRead).toBe(start.calls.markRead + 3);
        expect(mail.calls.getBody).toBe(start.calls.getBody);
        expect(mail.calls.send).toBe(0);
        expect(sent).toHaveLength(1);
        expect(mail.captured).toHaveLength(start.captured);
        expect(mail.confirmed()).toHaveLength(start.confirmed);
        expect(mail.events.slice(start.events).map((one) => [one.count, one.headlines])).toEqual([[0, []], [0, []], [0, []]]);
        expect((await router.openItems()).map((one) => one.source)).toEqual([source]);
        expect([...(await routerStore('personal', router.home).getSources([source])).values()]).toEqual([receipt]);
      } finally { unregister(); await disposeRouterStores(); }
    });

    it.each([
      // Not in the envelope hash, so it rides a read flag into the row; any payload field but the five cache ones is content.
      ['a reply address the listing now names', (one: MailEnvelope) => ({ ...one, replyTo: [{ address: 'front@bakery.example.invalid' }] }), true],
      ['a re-decoded subject', (one: MailEnvelope) => ({ ...one, subject: 'Pickup moved to Friday' }), false],
      ['an attachment the listing now names', (one: MailEnvelope) => ({ ...one, attachments: [{ filename: 'form.pdf', mimeType: 'application/pdf', bytes: 9 }] }), false],
    ] as const)('%s is another delivery: the old receipt and confirmation are never shown on it', async (_name, change, withFlag) => {
      const router = await boundRouter();
      const { mail, unregister, source, receipt, sent, route } = await routedArrival(router);
      try {
        const start = { captured: mail.captured.length, confirmed: mail.confirmed().length };
        mail.listing.current = mail.listing.current.map((one) => one.messageId === M2 ? change(one) as MailEnvelope : one);
        if (withFlag) await mail.service.markRead(ACCOUNT, M2, true);
        await mail.sync.runTick({ force: true });
        const row = await rowOf(mail.store, M2);
        expect(row.body_ref).toBeTruthy();
        const version = mailRowDeliveryVersion(row);
        expect(version).not.toBe(source.version);
        const now = await views(mail);
        for (const one of now.all) expect(shown(one)).toEqual({ version, area: undefined, route: undefined, unavailable: undefined });
        expect(await currentRouterSources([source])).toEqual([]);
        await expect(readRouterItem(source)).rejects.toMatchObject({ code: 'source_changed' });
        await expect(route(source)).rejects.toMatchObject({ code: 'source_changed' });
        await expect(route({ ...source, version })).rejects.toMatchObject({ code: 'area_unassigned' });
        // Not an arrival either: nothing captured, confirmed or sent, and the ledger keeps its one receipt for the old delivery.
        expect(mail.captured).toHaveLength(start.captured);
        expect(mail.confirmed()).toHaveLength(start.confirmed);
        expect(mail.events.at(-1)).toMatchObject({ count: 0, headlines: [] });
        expect(sent).toHaveLength(1);
        expect(mail.calls.send).toBe(0);
        expect((await router.openItems()).map((one) => one.source)).toEqual([source]);
        expect([...(await routerStore('personal', router.home).getSources([source])).values()]).toEqual([receipt]);
      } finally { unregister(); await disposeRouterStores(); }
    });
  });
});

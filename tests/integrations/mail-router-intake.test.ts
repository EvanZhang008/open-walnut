// Real sync, service and store; the area file and the rules confirm are stand-ins, except in the real-confirm block at the end.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRouterAreas, updateRouterAreas, type RouterAreasFile, type RouterRuleBinding } from '../../src/core/router/areas.js';
import {
  confirmRouterIncoming, readPendingRuleMatches, routerRulesView, saveRouterRuleBindings,
  type PendingRuleMatch, type RouterRulesDeps,
} from '../../src/core/router/rules.js';
import { currentRouterSources, readRouterItem, resolveRouterItem } from '../../src/core/router/source-registry.js';
import { disposeRouterStores, routerStore } from '../../src/core/router/runtime.js';
import { routeItem } from '../../src/core/router/service.js';
import type { Task } from '../../src/core/types.js';
import { setRoutingRule } from '../../src/core/triage/routing-rules.js';
import { seedTaskStore } from '../helpers/router-task-store.js';
import type { MailRouterIntakeConfirmDeps } from '../../src/integrations/mail/router-intake.js';
import { checkRouterPending, pendingSources, type RouterWakeDeps, type WakeTask } from '../../src/core/router/wake.js';
import type { RouterRoute, RouterSource } from '../../src/core/router/types.js';
import { PluginDatabaseClient } from '../../src/core/plugins/plugin-storage.js';
import type { WalnutServerPluginApi } from '../../src/core/plugins/server-api.js';
import { MailBodyStore } from '../../src/integrations/mail/bodies.js';
import type { MailIncomingCapture } from '../../src/integrations/mail/contract.js';
import { MailDatabase } from '../../src/integrations/mail/db.js';
import { reconcileIdentityRevision } from '../../src/integrations/mail/identity-revision.js';
import type { MailHeadline } from '../../src/integrations/mail/events.js';
import { MailProviderRegistry } from '../../src/integrations/mail/provider-registry.js';
import { decorateMailRoutes } from '../../src/integrations/mail/router-decoration.js';
import { createMailRouterIntake, ROUTER_INTAKE_BATCH } from '../../src/integrations/mail/router-intake.js';
import { mailRowDeliveryVersion, registerMailRouterSource } from '../../src/integrations/mail/router-source.js';
import { MailService } from '../../src/integrations/mail/service.js';
import { MailStore } from '../../src/integrations/mail/store.js';
import { MailSync, type MailSyncHost } from '../../src/integrations/mail/sync.js';
import type { MailAddress, MailEnvelope, MailProviderSpec } from '../../src/integrations/mail/types.js';

const ACCOUNT = 'fixture:acct-a';
const OTHER = 'fixture:acct-b';
const HOME = '/walnut-home-under-test';
const BASE = Date.UTC(2026, 9, 1, 9, 0, 0);

const NO_RULES = { version: 1, areas: [], routers: [], items: [] } as unknown as RouterAreasFile;
const binding = (n: number, areaId = 'area-1', confirmedAt = BASE + n): RouterRuleBinding =>
  ({ ruleId: `rule-${n}`, revision: String(n).repeat(64).slice(0, 64), areaId, confirmedAt });
const withBindings = (...bindings: RouterRuleBinding[]) => ({ ...NO_RULES, ruleBindings: bindings }) as unknown as RouterAreasFile;
const WITH_RULES = withBindings(binding(1));
const WITH_MORE_RULES = withBindings(binding(1), binding(2));

type RuleMatch = PendingRuleMatch['match'];
/** A real areas file under `home`, read and confirmed by the real rules code with these deps. */
type RealRouter = { home: string; ruleDeps: RouterRulesDeps };
/** Each rule's live match by id; `null` is a rule no longer live (its fingerprint changed, it is off, its target complete). */
type RuleTable = { current: Record<string, RuleMatch | null> };
const SUBJECT_RULE: RuleMatch = { subject: 'Subject' };

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

/** The intake with a recording confirm and a switchable area file. */
function intake(store: MailStore, areas: { current: RouterAreasFile }, options: {
  /** `true` fails every confirm; `'once'` only the first one (one tick's finish). */
  confirmFails?: boolean | 'once';
  areasFail?: boolean;
  /** `true` fails every read; `'second'` only the one at finish. */
  pendingRulesFail?: boolean | 'second';
  /** A stand-in rule: an exact source enters the area when its cached row, at that version, is from this sender. */
  matchSender?: string;
  /** Rule matches by id; a rule not listed matches subjects containing "Subject". */
  rules?: RuleTable;
  /** Pending matches lose their rule id, as a reader that cannot tie a match to its binding. */
  noRuleIds?: boolean;
  /** The real area file, pending rules and confirm under this home. */
  real?: RealRouter;
} = {}) {
  const home = options.real?.home ?? HOME;
  const confirmed: RouterSource[][] = [];
  /** What each confirm answered it wrote. */
  const written: RouterSource[][] = [];
  const confirmDeps: MailRouterIntakeConfirmDeps[] = [];
  const assigned = new Set<string>();
  let reads = 0;
  let ruleReads = 0;
  const table: RuleTable = options.rules ?? { current: options.matchSender ? { 'rule-1': { from: options.matchSender } } : {} };
  const real = options.real;
  const capture = createMailRouterIntake({
    store,
    home,
    // Like the real reader: one entry per live binding, carrying the rule id it was bound for.
    pendingRules: real ? (file, at) => readPendingRuleMatches(file, at, real.ruleDeps) : async (file) => {
      ruleReads += 1;
      if (options.pendingRulesFail === true || (options.pendingRulesFail === 'second' && ruleReads === 2)) throw new Error('rules unreadable');
      return (file.ruleBindings ?? []).flatMap((one): PendingRuleMatch[] => {
        const match = one.ruleId in table.current ? table.current[one.ruleId] : SUBJECT_RULE;
        if (!match) return [];
        return [{ areaId: one.areaId, match: { ...match }, ...(options.noRuleIds ? {} : { ruleId: one.ruleId }) }];
      });
    },
    readAreas: async (at) => {
      expect(at).toBe(home);
      reads += 1;
      if (options.areasFail) throw new Error('areas file unreadable');
      return real ? readRouterAreas(at) : areas.current;
    },
    confirm: async (sources, at, deps) => {
      expect(at).toBe(home);
      confirmed.push([...sources]);
      confirmDeps.push(deps);
      if (real) {
        const out = await confirmRouterIncoming(sources, at, { ...real.ruleDeps, ...deps });
        written.push([...out]);
        return out;
      }
      if (options.confirmFails === true || (options.confirmFails === 'once' && confirmed.length === 1)) throw new Error('rules store is down');
      // The stand-in writes every source, or with a sender rule only the exact rows from that sender.
      const out: RouterSource[] = [];
      for (const source of sources) {
        const row = await store.getMessage(source.account, source.message);
        if (!options.matchSender) { out.push(source); continue; }
        if (row && row.from_addr === options.matchSender && mailRowDeliveryVersion(row) === source.version) {
          assigned.add(`${source.message}@${source.version}`);
          out.push(source);
        }
      }
      written.push([...out]);
      return out;
    },
  });
  return { capture, confirmed, confirmDeps, written, assigned, reads: () => reads };
}

const messagesOf = (batches: RouterSource[][]) => batches.map((batch) => batch.map((one) => one.message).sort());

async function harness(options: {
  /** `false` starts with no bindings at all. */
  ruleBindings?: boolean;
  /** Every page reads as sorted out of Important, so only the full headline list can carry it. */
  nothingImportant?: boolean;
  confirmFails?: boolean | 'once';
  matchSender?: string;
  captureFails?: boolean;
  areasFail?: boolean;
  pendingRulesFail?: boolean | 'second';
  /** The bindings standing at the start (default WITH_RULES). */
  areas?: RouterAreasFile;
  rules?: Record<string, RuleMatch | null>;
  noRuleIds?: boolean;
  noPrefetch?: boolean;
  /** One message per page, so a listing of more than 20 takes several ticks to walk. */
  paged?: boolean;
  real?: RealRouter;
  /** The provider changes read flags, and its listing then carries them (off by default, as every other test expects). */
  markRead?: boolean;
  /** The service decorates rows with the real area file and ledgers under the real router's home. */
  decorate?: boolean;
} = {}) {
  // One account only: the poll loop would sync every account against the same fixture listing.
  const { store, bodies, entry } = await cache([ACCOUNT]);
  const providers = new MailProviderRegistry(() => undefined);
  const listing: { current: MailEnvelope[] } = { current: [envelope(1)] };
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
      return [{ mailboxId: 'inbox', name: 'Inbox', role: 'inbox', unread: 0, total: listing.current.length }];
    },
    poll: async (_account, request) => {
      calls.poll += 1;
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

  const areas = { current: options.areas ?? (options.ruleBindings === false ? NO_RULES : WITH_RULES) };
  const rules: RuleTable = { current: { ...(options.matchSender ? { 'rule-1': { from: options.matchSender } } : {}), ...options.rules } };
  const recorder = intake(store, areas, {
    confirmFails: options.confirmFails, areasFail: options.areasFail, pendingRulesFail: options.pendingRulesFail,
    matchSender: options.matchSender, rules, noRuleIds: options.noRuleIds, real: options.real,
  });
  const captured: Array<{ accountId: string; headlines: MailHeadline[] }> = [];
  const captureIncoming: MailIncomingCapture = async (accountId, headlines) => {
    captured.push({ accountId, headlines: [...headlines] });
    if (options.captureFails) throw new Error('intake unavailable');
    return recorder.capture(accountId, headlines);
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

  const warnings: string[] = [];
  /** Each event with what the rules had confirmed at the moment it went out. */
  const events: Array<{ count: number; headlines: MailHeadline[]; confirmedAtEmit: RouterSource[][]; assignedAtEmit: string[] }> = [];
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
        events.push({
          count, headlines: [...headlines],
          confirmedAtEmit: recorder.confirmed.map((batch) => [...batch]), assignedAtEmit: [...recorder.assigned],
        });
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
  });
  entry.sync = sync;
  return {
    store, bodies, service, sync, listing, control, bodyFrom, bodyAddresses, calls, areas, captured, beforePrefetch, warnings, events, assigned: recorder.assigned,
    confirmed: () => recorder.confirmed, confirmDeps: recorder.confirmDeps, written: recorder.written, reads: recorder.reads, rules,
  };
}

const rowOf = async (store: MailStore, messageId: string, accountId = ACCOUNT) => {
  const row = await store.getMessage(accountId, messageId);
  if (!row) throw new Error(`no cached row for ${messageId}`);
  return row;
};

const ids = (...ns: number[]) => ns.map((n) => `inbox:m-${n}`).sort();

describe('mail sync hands arrived inbox mail to the area rules intake', () => {
  it('confirms every arrival before the event, then announces it once at its body-filled version', async () => {
    const mail = await harness();
    await mail.sync.runTick({ force: true });
    // The backfill is not an arrival: nothing captured, the area file not even read.
    expect(mail.captured).toEqual([]);
    expect(mail.reads()).toBe(0);

    mail.listing.current = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => envelope(n));
    const before = { ...mail.calls };
    await mail.sync.runTick({ force: true });
    expect(mail.captured).toHaveLength(1);
    const announced = new Map(mail.captured[0]!.headlines.map((one) => [one.messageId, one.version]));
    expect([...announced.keys()].sort()).toEqual(ids(2, 3, 4, 5, 6, 7, 8));

    // One confirm, after the prefetch, of the body-filled versions only, granted through the binding that matched at capture.
    expect(mail.confirmed()).toHaveLength(1);
    expect(mail.confirmDeps).toEqual([{ expectedRuleBindings: [binding(1)] }]);

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

    // The same listing again is no arrival: nothing captured, nothing confirmed, nothing named.
    await mail.sync.runTick({ force: true });
    expect(mail.captured).toHaveLength(1);
    expect(mail.confirmed()).toHaveLength(1);
    expect(mail.events.at(-1)).toMatchObject({ count: 0, headlines: [] });
  });

  it('with grouping on, the intake sees every arrival while the event names only the initially Important ones', async () => {
    const mail = await harness({ nothingImportant: true });
    await mail.sync.runTick({ force: true });
    mail.listing.current = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => envelope(n));
    await mail.sync.runTick({ force: true });
    expect(mail.captured[0]!.headlines.map((one) => one.messageId).sort()).toEqual(ids(2, 3, 4, 5, 6, 7, 8));
    expect(messagesOf(mail.confirmed())).toEqual([ids(2, 3, 4, 5, 6, 7, 8)]);
    expect(mail.events).toEqual([expect.objectContaining({ count: 0, headlines: [] })]);
  });

  it('a body read that fills a blank sender lets the matching rule confirm, and the event names that version', async () => {
    const billing = 'billing@invoices.example.invalid';
    const mail = await harness({ matchSender: billing });
    await mail.sync.runTick({ force: true });
    mail.bodyFrom.current = { address: billing };
    mail.listing.current = [envelope(1), envelope(2, { from: { name: 'Billing', address: '' }, subject: 'Invoice 2' })];
    await mail.sync.runTick({ force: true });

    const row = await rowOf(mail.store, 'inbox:m-2');
    expect(row.from_addr).toBe(billing);
    const initial = mail.captured[0]!.headlines[0]!;
    expect(initial).toMatchObject({ from: '', messageId: 'inbox:m-2' });
    // Only the filled version is confirmed, and it entered the area before the event.
    expect(mail.confirmed().map((batch) => batch.map((one) => one.version))).toEqual([[mailRowDeliveryVersion(row)]]);
    expect(mailRowDeliveryVersion(row)).not.toBe(initial.version);
    // The unknown sender kept the sender rule as a capture-time candidate, so its own binding grants the filled version.
    expect(mail.confirmDeps).toEqual([{ expectedRuleBindings: [binding(1)] }]);
    expect(mail.events).toHaveLength(1);
    expect(mail.events[0]!.assignedAtEmit).toEqual([`inbox:m-2@${mailRowDeliveryVersion(row)}`]);
    expect(mail.events[0]!.headlines).toEqual([expect.objectContaining({
      from: billing, subject: 'Invoice 2', messageId: 'inbox:m-2', version: mailRowDeliveryVersion(row),
    })]);
  });

  it('a known sender no rule matches stays unassigned and named in the event', async () => {
    const mail = await harness({ matchSender: 'billing@invoices.example.invalid' });
    await mail.sync.runTick({ force: true });
    mail.listing.current = [envelope(1), envelope(2)];
    await mail.sync.runTick({ force: true });
    expect(mail.assigned.size).toBe(0);
    const row = await rowOf(mail.store, 'inbox:m-2');
    expect(mail.events[0]!.headlines).toEqual([expect.objectContaining({
      from: 'sender2@example.invalid', messageId: 'inbox:m-2', version: mailRowDeliveryVersion(row),
    })]);
  });

  it('a known sender rewritten to another between capture and finish inherits nothing', async () => {
    const other = 'billing@invoices.example.invalid';
    const mail = await harness({ matchSender: other });
    await mail.sync.runTick({ force: true });
    mail.listing.current = [envelope(1), envelope(2)];
    mail.beforePrefetch.current = async () => {
      mail.beforePrefetch.current = undefined;
      // Same instants and Message-ID, so the same delivery to the cache, but another known sender.
      await mail.service.ingestPage(ACCOUNT, [envelope(2, { from: { address: other } })]);
    };
    await mail.sync.runTick({ force: true });
    expect((await rowOf(mail.store, 'inbox:m-2')).from_addr).toBe(other);
    expect(mail.confirmed()).toEqual([]);
    expect(mail.assigned.size).toBe(0);
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
    // Neither delivery of m-2 is confirmed: the first was replaced before finish, and the reply was never captured.
    expect(messagesOf(mail.confirmed())).toEqual([ids(3)]);
    // The replaced handle gets no headline; the other is named at its current version.
    expect(mail.events.at(-1)!.headlines.map((one) => one.messageId)).toEqual(['inbox:m-3']);
  });

  it('without bindings, nothing is confirmed and the event names each arrival at its body-filled version', async () => {
    const mail = await harness({ ruleBindings: false });
    await mail.sync.runTick({ force: true });
    mail.listing.current = [envelope(1), envelope(2), envelope(3)];
    await mail.sync.runTick({ force: true });
    expect(mail.confirmed()).toEqual([]);
    expect(mail.events).toHaveLength(1);
    const latest = await Promise.all(['inbox:m-2', 'inbox:m-3'].map(async (id) => mailRowDeliveryVersion(await rowOf(mail.store, id))));
    expect(mail.events[0]!.headlines.map((one) => [one.messageId, one.version])).toEqual([['inbox:m-2', latest[0]], ['inbox:m-3', latest[1]]]);
    expect(mail.events[0]!.headlines.map((one) => one.version)).not.toContain(mail.captured[0]!.headlines[0]!.version);
  });

  it('never captures the backfill, and a rule set that appears during the prefetch neither confirms nor exposes the arrival', async () => {
    const mail = await harness({ ruleBindings: false });
    mail.listing.current = [envelope(1), envelope(2)];
    await mail.sync.runTick({ force: true });
    expect(mail.confirmed()).toEqual([]);

    mail.listing.current = [envelope(1), envelope(2), envelope(3)];
    mail.beforePrefetch.current = async () => { mail.areas.current = WITH_RULES; };
    await mail.sync.runTick({ force: true });
    expect(mail.captured).toHaveLength(1);
    expect(mail.confirmed()).toEqual([]);
    expect(mail.events.at(-1)).toMatchObject({ count: 1, headlines: [] });

    // Rules on now: the history already cached is not scanned, only the next arrival is confirmed.
    mail.beforePrefetch.current = undefined;
    mail.listing.current = [envelope(1), envelope(2), envelope(3), envelope(4)];
    await mail.sync.runTick({ force: true });
    expect(messagesOf(mail.confirmed())).toEqual([ids(4)]);
    expect(mail.events.at(-1)!.headlines.map((one) => one.messageId)).toEqual(['inbox:m-4']);
  });

  it('a binding of the same area confirmed during the prefetch adds no authority: the original binding alone grants', async () => {
    const mail = await harness();
    await mail.sync.runTick({ force: true });
    mail.listing.current = [envelope(1), envelope(2)];
    mail.beforePrefetch.current = async () => { mail.areas.current = WITH_MORE_RULES; };
    await mail.sync.runTick({ force: true });
    const row = await rowOf(mail.store, 'inbox:m-2');
    expect(mail.confirmed()).toEqual([[{ kind: 'mail', account: ACCOUNT, message: 'inbox:m-2', version: mailRowDeliveryVersion(row) }]]);
    // Never the new binding: it only agrees on the area.
    expect(mail.confirmDeps).toEqual([{ expectedRuleBindings: [binding(1)] }]);
    expect(mail.events.at(-1)!.headlines.map((one) => [one.messageId, one.version])).toEqual([['inbox:m-2', mailRowDeliveryVersion(row)]]);

    // The next arrival is captured under the new bindings, and both may grant it.
    mail.beforePrefetch.current = undefined;
    mail.listing.current = [envelope(1), envelope(2), envelope(3)];
    await mail.sync.runTick({ force: true });
    expect(mail.confirmDeps.slice(1)).toEqual([{ expectedRuleBindings: [binding(1), binding(2)] }]);
  });

  it.each([
    ['added', WITH_RULES, WITH_MORE_RULES],
    ['removed', WITH_MORE_RULES, WITH_RULES],
  ] as const)('an unrelated binding %s during the prefetch still confirms the body-filled version under the original one', async (_label, start, next) => {
    const mail = await harness({ areas: start, rules: { 'rule-2': { subject: 'Unrelated' } } });
    await mail.sync.runTick({ force: true });
    mail.listing.current = [envelope(1), envelope(2), envelope(3, { subject: 'Ordinary arrival' })];
    mail.beforePrefetch.current = async () => { mail.areas.current = next; };
    await mail.sync.runTick({ force: true });
    const [m2, m3] = await Promise.all(['inbox:m-2', 'inbox:m-3'].map((id) => rowOf(mail.store, id)));
    // The rule's own binding never moved, so the new delivery version is not left out of the area.
    expect(mail.confirmed()).toEqual([[{ kind: 'mail', account: ACCOUNT, message: 'inbox:m-2', version: mailRowDeliveryVersion(m2!) }]]);
    expect(mail.confirmDeps).toEqual([{ expectedRuleBindings: [binding(1)] }]);
    // Both headlines go out at their current versions; the one no rule matches is never confirmed.
    expect(mail.events.at(-1)!.headlines.map((one) => [one.messageId, one.version])).toEqual([
      ['inbox:m-2', mailRowDeliveryVersion(m2!)], ['inbox:m-3', mailRowDeliveryVersion(m3!)],
    ]);
  });

  it.each([
    ['its binding was removed', () => withBindings(binding(2)), {}],
    ['its binding moved to another area', () => withBindings(binding(1, 'area-2')), {}],
    ['its binding was confirmed again', () => withBindings(binding(1, 'area-1', BASE + 99)), {}],
    ['its rule changed or its target completed', () => WITH_RULES, { 'rule-1': null }],
  ] as const)('when the matching rule\'s %s, the new version is withheld and never confirmed; unrelated mail still goes out', async (_label, next, live) => {
    const mail = await harness({ rules: { 'rule-2': { subject: 'Unrelated' } } });
    await mail.sync.runTick({ force: true });
    mail.listing.current = [envelope(1), envelope(2), envelope(3, { subject: 'Ordinary arrival' })];
    mail.beforePrefetch.current = async () => {
      mail.areas.current = next();
      Object.assign(mail.rules.current, live);
    };
    await mail.sync.runTick({ force: true });
    expect(mail.confirmed()).toEqual([]);
    expect(mail.events.at(-1)).toMatchObject({ count: 2, headlines: [{ messageId: 'inbox:m-3', subject: 'Ordinary arrival' }] });
  });

  it('a binding that alone matches only after capture authorizes nothing captured before it', async () => {
    const mail = await harness({ rules: { 'rule-1': { subject: 'Invoice' } } });
    await mail.sync.runTick({ force: true });
    mail.listing.current = [envelope(1), envelope(2), envelope(3, { subject: 'Ordinary arrival' })];
    mail.beforePrefetch.current = async () => { mail.areas.current = WITH_MORE_RULES; };
    await mail.sync.runTick({ force: true });
    // The new binding matches m-2, which no binding matched at capture: withheld, nothing confirmed.
    expect(mail.confirmed()).toEqual([]);
    expect(mail.events.at(-1)).toMatchObject({ count: 2, headlines: [{ messageId: 'inbox:m-3' }] });
  });

  it('a binding of another area that now also matches is a conflict: withheld and never confirmed', async () => {
    const mail = await harness();
    await mail.sync.runTick({ force: true });
    mail.listing.current = [envelope(1), envelope(2), envelope(3, { subject: 'Ordinary arrival' })];
    mail.beforePrefetch.current = async () => { mail.areas.current = withBindings(binding(1), binding(2, 'area-2')); };
    await mail.sync.runTick({ force: true });
    expect(mail.confirmed()).toEqual([]);
    expect(mail.events.at(-1)).toMatchObject({ count: 2, headlines: [{ messageId: 'inbox:m-3' }] });
  });

  it('two original bindings of one area: one removed, the other unchanged still grants alone', async () => {
    const mail = await harness({ areas: WITH_MORE_RULES });
    await mail.sync.runTick({ force: true });
    mail.listing.current = [envelope(1), envelope(2)];
    mail.beforePrefetch.current = async () => { mail.areas.current = withBindings(binding(2)); };
    await mail.sync.runTick({ force: true });
    expect(messagesOf(mail.confirmed())).toEqual([ids(2)]);
    expect(mail.confirmDeps).toEqual([{ expectedRuleBindings: [binding(2)] }]);
    expect(mail.events.at(-1)!.headlines.map((one) => one.messageId)).toEqual(['inbox:m-2']);
  });

  it('a pending match with no rule id restricts but never authorizes', async () => {
    const mail = await harness({ noRuleIds: true });
    await mail.sync.runTick({ force: true });
    mail.listing.current = [envelope(1), envelope(2), envelope(3, { subject: 'Ordinary arrival' })];
    await mail.sync.runTick({ force: true });
    expect(mail.confirmed()).toEqual([]);
    expect(mail.events.at(-1)).toMatchObject({ count: 2, headlines: [{ messageId: 'inbox:m-3' }] });
  });

  it.each([
    ['every confirm fails', { confirmFails: true }, 'mail area intake confirm failed', []],
    ['the capture itself fails', { captureFails: true }, 'mail area intake capture failed', []],
    ['the area file cannot be read', { areasFail: true }, 'mail area intake capture failed', []],
    ['the pending rules cannot be read', { pendingRulesFail: true }, 'mail area intake capture failed', []],
    ['the confirm after the prefetch fails once', { confirmFails: 'once' }, 'mail area intake confirm failed', ['inbox:m-4']],
    ['the pending rules cannot be read at finish', { pendingRulesFail: 'second' }, 'mail area intake confirm failed', ['inbox:m-4']],
  ] as const)('when %s, the event keeps its count with no headlines and polling carries on', async (_label, failure, warning, nextNamed) => {
    const mail = await harness(failure);
    await mail.sync.runTick({ force: true });
    mail.listing.current = [envelope(1), envelope(2), envelope(3)];
    const report = await mail.sync.runTick({ force: true });
    expect(report.polled).toBe(1);
    expect(mail.events).toEqual([expect.objectContaining({ count: 2, headlines: [] })]);
    expect(mail.warnings).toContain(warning);
    expect(mail.warnings).not.toContain('mail poll failed');
    expect((await mail.store.getAccount(ACCOUNT))?.state).toBe('active');
    expect((await rowOf(mail.store, 'inbox:m-3')).body_ref).toBeTruthy();

    // The next tick runs normally.
    mail.listing.current = [envelope(1), envelope(2), envelope(3), envelope(4)];
    expect((await mail.sync.runTick({ force: true })).polled).toBe(1);
    expect(mail.events.at(-1)!.count).toBe(1);
    expect(mail.events.at(-1)!.headlines.map((one) => one.messageId)).toEqual(nextNamed);
  });

  it('reads only the cache: a body not cached is confirmed as it stands, never fetched', async () => {
    const mail = await harness({ noPrefetch: true });
    await mail.sync.runTick({ force: true });
    mail.listing.current = [envelope(1), envelope(2)];
    await mail.sync.runTick({ force: true });
    expect(mail.calls.getBody).toBe(0);
    const row = await rowOf(mail.store, 'inbox:m-2');
    expect(row.body_ref).toBeNull();
    // The version did not move: finish confirms that same exact version, once.
    expect(mail.confirmed()).toEqual([[{ kind: 'mail', account: ACCOUNT, message: 'inbox:m-2', version: mailRowDeliveryVersion(row) }]]);
  });

  it('nothing can wake the area router while the prefetch runs; after it, only the final version is pending, once', async () => {
    const mail = await harness();
    // The real mail source registry answers the wake's "still current" check from the same cache.
    const unregister = registerMailRouterSource(mail.store, mail.bodies);
    try {
      await mail.sync.runTick({ force: true });
      // What the area file holds if each confirmed source entered area-1, with its active local router.
      const wakeFile = (): RouterAreasFile => ({
        version: 1,
        areas: [{ id: 'area-1', name: 'Area one', host: '__local__', taskIds: ['task-router'], sources: [{ kind: 'mail', account: ACCOUNT }] }],
        routers: [{ taskId: 'task-router', areaId: 'area-1', paused: false }],
        items: mail.confirmed().flat().map((source) => ({ source: { ...source }, areaId: 'area-1', canonicalKey: `key-${source.message}` })),
        ruleBindings: [binding(1)],
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

describe('the area rules intake helper', () => {
  async function seeded(n: number) {
    const { store, bodies } = await cache();
    const service = new MailService({ store, bodies, providers: new MailProviderRegistry(() => undefined) });
    const ingested = await service.ingestPage(ACCOUNT, Array.from({ length: n }, (_, i) => envelope(i + 1)));
    expect(ingested.headlines).toHaveLength(n);
    return { store, service, headlines: ingested.headlines };
  }

  it('without bindings it confirms nothing but still answers exact current headlines; with no ids it reads nothing', async () => {
    const { store, headlines } = await seeded(3);
    const quiet = intake(store, { current: NO_RULES });
    const shown = await (await quiet.capture(ACCOUNT, headlines))();
    expect(quiet.confirmed).toEqual([]);
    expect(quiet.reads()).toBe(2);
    expect(shown).toEqual(await Promise.all(headlines.map(async (one) => {
      const row = await rowOf(store, one.messageId!);
      return { from: row.from_addr, subject: row.subject, messageId: row.message_id, version: mailRowDeliveryVersion(row), canonicalKey: one.canonicalKey };
    })));

    // Void (keep the ingested headlines) only when no headline names an exact delivery.
    const empty = intake(store, { current: WITH_RULES });
    expect(await (await empty.capture(ACCOUNT, []))()).toBeUndefined();
    expect(await (await empty.capture(ACCOUNT, [{ from: 'x', subject: 'no handle' }]))()).toBeUndefined();
    expect(empty.reads()).toBe(0);
    expect(empty.confirmed).toEqual([]);
  });

  it('captures only a row still at the announced version, and answers [] when none is', async () => {
    const { store, service, headlines } = await seeded(2);
    // The second row was rewritten (a re-decoded subject) after its headline went out.
    await service.ingestPage(ACCOUNT, [envelope(2, { subject: 'Subject 2 (re-decoded)' })]);
    const recorder = intake(store, { current: WITH_RULES });
    await (await recorder.capture(ACCOUNT, headlines))();
    expect(messagesOf(recorder.confirmed)).toEqual([ids(1)]);

    for (const areas of [WITH_RULES, NO_RULES]) {
      const stale = intake(store, { current: areas });
      expect(await (await stale.capture(ACCOUNT, headlines.slice(1)))()).toEqual([]);
      expect(stale.confirmed).toEqual([]);
    }
  });

  it('treats the account as no grant: only the exact headlined rows of that account are confirmed', async () => {
    const { store, service, headlines } = await seeded(2);
    // The same handle cached under another account, and more mail in this account, none headlined.
    await service.ingestPage(OTHER, [envelope(1)]);
    await service.ingestPage(ACCOUNT, [envelope(40), envelope(41)]);
    const recorder = intake(store, { current: WITH_RULES });
    await (await recorder.capture(ACCOUNT, headlines.slice(0, 1)))();
    expect(recorder.confirmed).toEqual([[{
      kind: 'mail', account: ACCOUNT, message: 'inbox:m-1',
      version: mailRowDeliveryVersion(await rowOf(store, 'inbox:m-1')),
    }]]);
  });

  it('confirms nothing at capture, and finish leaves out a row that left the cache', async () => {
    const { store, headlines } = await seeded(2);
    const recorder = intake(store, { current: WITH_RULES });
    const finish = await recorder.capture(ACCOUNT, headlines);
    expect(recorder.confirmed).toEqual([]);
    await store.deleteMessages([(await rowOf(store, 'inbox:m-1')).rowid]);
    expect(await store.getMessage(ACCOUNT, 'inbox:m-1')).toBeUndefined();
    expect((await finish() ?? []).map((one) => one.messageId)).toEqual(['inbox:m-2']);
    expect(messagesOf(recorder.confirmed)).toEqual([ids(2)]);
  });

  it('names a restricted arrival only when the confirm answers it wrote that exact source', async () => {
    const { store, headlines } = await seeded(3);
    const capture = createMailRouterIntake({
      store, home: HOME,
      pendingRules: async () => [{ ruleId: 'rule-1', areaId: 'area-1', match: { subject: 'Subject 2' } }],
      readAreas: async () => WITH_RULES,
      // An answer at another version is not the source asked.
      confirm: async (sources) => sources.map((one) => ({ ...one, version: 'another-version' })),
    });
    expect((await (await capture(ACCOUNT, headlines))())?.map((one) => one.messageId)).toEqual(['inbox:m-1', 'inbox:m-3']);
  });

  it(`queries rows and confirms in batches of ${ROUTER_INTAKE_BATCH}`, async () => {
    const { store, headlines } = await seeded(450);
    const queried: number[] = [];
    const counting = {
      messagesByIds: async (accountId: string, wanted: ReadonlyArray<string>) => {
        queried.push(wanted.length);
        return store.messagesByIds(accountId, wanted);
      },
    };
    const confirmed: number[] = [];
    const capture = createMailRouterIntake({
      store: counting, home: HOME,
      pendingRules: async () => [{ ruleId: 'rule-1', areaId: 'area-1', match: { subject: 'Subject' } }],
      readAreas: async () => WITH_RULES,
      confirm: async (sources) => { confirmed.push(sources.length); return sources; },
    });
    const finish = await capture(ACCOUNT, headlines);
    expect(queried).toEqual([200, 200, 50]);
    expect(confirmed).toEqual([]);
    expect(await finish()).toHaveLength(450);
    expect(queried).toEqual([200, 200, 50, 200, 200, 50]);
    // Finish confirms every row once at its exact version, unchanged here.
    expect(confirmed).toEqual([200, 200, 50]);
  });
});

describe('with the real rules confirm and area file, only what the confirm wrote is announced', () => {
  const BAKERY = 'desk@bakery.example.invalid';

  async function realRouter() {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'mail-router-real-'));
    roots.push(home);
    seedTaskStore(home);
    await updateRouterAreas(home, () => ({
      version: 1,
      areas: [
        { id: 'personal', name: 'Personal', host: '__local__', taskIds: ['router-personal'], sources: [] },
        { id: 'work', name: 'Work', host: '__local__', taskIds: ['router-work'], sources: [] },
      ],
      routers: [{ taskId: 'router-personal', areaId: 'personal', paused: false }, { taskId: 'router-work', areaId: 'work', paused: false }],
      items: [],
    }) as RouterAreasFile);
    const hooks: { beforeResolve?: () => Promise<void> } = {};
    const ruleDeps: RouterRulesDeps = {
      targets: async (wanted) => new Map(wanted.map((id) => [id, { title: id, open: true }])),
      resolve: async (source) => {
        const run = hooks.beforeResolve;
        hooks.beforeResolve = undefined;
        await run?.();
        return resolveRouterItem(source);
      },
    };
    const rule = (match: { from?: string; subject?: string }, taskId: string) =>
      setRoutingRule(home, { ...match, taskId }, { by: 'human' });
    const bind = async (entries: Array<{ ruleId: string; areaId: string }>) => {
      const view = await routerRulesView(home, ruleDeps);
      const byId = new Map(view.rules.map((one) => [one.id, one.revision]));
      await saveRouterRuleBindings({
        bindings: entries.map((one) => ({ ...one, revision: byId.get(one.ruleId)! })), expectedRevision: view.fileRevision,
      }, home, ruleDeps);
    };
    const wakes = async (areaId: string) => (await checkRouterPending({ areaId }, {
      readAreas: () => readRouterAreas(home),
      getTask: async (id) => ({
        id, phase: 'IN_PROGRESS', source: 'local', org_role: 'router', router_area_id: id.replace('router-', ''), router_paused: false,
      }) as WakeTask,
      orgEnabled: async () => true,
      routesFor: async () => new Map(),
      sessionsForTask: async () => [],
      send: async () => undefined,
      start: async () => ({}),
      nonce: () => 'n',
    })).fire;
    return { real: { home, ruleDeps }, hooks, rule, bind, wakes, items: async () => (await readRouterAreas(home)).items };
  }

  async function arrive(
    router: Awaited<ReturnType<typeof realRouter>>, envelopes: MailEnvelope[],
    extra: { markRead?: boolean; decorate?: boolean } = {}, prepare?: (mail: Awaited<ReturnType<typeof harness>>) => void,
  ) {
    const mail = await harness({ real: router.real, ...extra });
    prepare?.(mail);
    const unregister = registerMailRouterSource(mail.store, mail.bodies);
    await mail.sync.runTick({ force: true });
    mail.listing.current = [envelope(1), ...envelopes];
    await mail.sync.runTick({ force: true });
    return { mail, unregister };
  }

  it('an arrival two areas match at capture is withheld: no registry item, no wake, no headline', async () => {
    const router = await realRouter();
    const bakery = await router.rule({ from: 'bakery.example.invalid' }, 'task-florist');
    const invoice = await router.rule({ subject: 'invoice' }, 'task-invoices');
    await router.bind([{ ruleId: bakery.id, areaId: 'personal' }, { ruleId: invoice.id, areaId: 'work' }]);
    const { mail, unregister } = await arrive(router, [envelope(2, { from: { address: BAKERY }, subject: 'Invoice for pickup' })]);
    try {
      expect(await router.items()).toEqual([]);
      expect([await router.wakes('personal'), await router.wakes('work')]).toEqual([false, false]);
      expect(mail.events).toEqual([expect.objectContaining({ count: 1, headlines: [] })]);
    } finally { unregister(); }
  });

  it('a blank sender the body read never fills is withheld: the confirm writes nothing, so nothing is named', async () => {
    const router = await realRouter();
    const bakery = await router.rule({ from: 'bakery.example.invalid' }, 'task-florist');
    await router.bind([{ ruleId: bakery.id, areaId: 'personal' }]);
    const { mail, unregister } = await arrive(router, [envelope(2, { from: { name: 'Desk', address: '' }, subject: 'Pickup' })]);
    try {
      expect((await rowOf(mail.store, 'inbox:m-2')).from_addr).toBe('');
      // The rule could not be cleared, so the confirm was asked, and answered it wrote nothing.
      expect(mail.confirmed()).toHaveLength(1);
      expect(mail.written).toEqual([[]]);
      expect(await router.items()).toEqual([]);
      expect(await router.wakes('personal')).toBe(false);
      expect(mail.events).toEqual([expect.objectContaining({ count: 1, headlines: [] })]);
    } finally { unregister(); }
  });

  it('a binding moved while the confirm runs grants nothing, so the arrival is not named', async () => {
    const router = await realRouter();
    const bakery = await router.rule({ from: 'bakery.example.invalid' }, 'task-florist');
    await router.bind([{ ruleId: bakery.id, areaId: 'personal' }]);
    // After the finish read its bindings, before the confirm takes the lock.
    router.hooks.beforeResolve = () => router.bind([{ ruleId: bakery.id, areaId: 'work' }]);
    const { mail, unregister } = await arrive(router, [envelope(2, { from: { address: BAKERY }, subject: 'Pickup' })]);
    try {
      expect(mail.confirmed()).toHaveLength(1);
      expect(mail.written).toEqual([[]]);
      expect(await router.items()).toEqual([]);
      expect([await router.wakes('personal'), await router.wakes('work')]).toEqual([false, false]);
      expect(mail.events).toEqual([expect.objectContaining({ count: 1, headlines: [] })]);
    } finally { unregister(); }
  });

  it('a confirmed arrival is named once at its written version, beside an ordinary one', async () => {
    const router = await realRouter();
    const bakery = await router.rule({ from: 'bakery.example.invalid' }, 'task-florist');
    await router.bind([{ ruleId: bakery.id, areaId: 'personal' }]);
    const { mail, unregister } = await arrive(router, [
      envelope(2, { from: { address: BAKERY }, subject: 'Pickup' }), envelope(3, { subject: 'Ordinary arrival' }),
    ]);
    try {
      const [m2, m3] = await Promise.all(['inbox:m-2', 'inbox:m-3'].map((id) => rowOf(mail.store, id)));
      const final = { kind: 'mail' as const, account: ACCOUNT, message: 'inbox:m-2', version: mailRowDeliveryVersion(m2!) };
      expect(mail.written).toEqual([[final]]);
      expect((await router.items()).map((one) => [one.source, one.areaId])).toEqual([[final, 'personal']]);
      expect([await router.wakes('personal'), await router.wakes('work')]).toEqual([true, false]);
      expect(mail.events.map((one) => one.headlines.map((headline) => [headline.messageId, headline.version]))).toEqual([[
        ['inbox:m-2', final.version], ['inbox:m-3', mailRowDeliveryVersion(m3!)],
      ]]);

      // The same listing again is no arrival: nothing confirmed or named again, the one item kept.
      await mail.sync.runTick({ force: true });
      expect(mail.confirmed()).toHaveLength(1);
      expect(mail.events.at(-1)).toMatchObject({ count: 0, headlines: [] });
      expect(await router.items()).toHaveLength(1);
    } finally { unregister(); }
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

    /** One bakery arrival confirmed into Personal by its rule, then routed for real: only the session send is a stand-in. */
    async function routedArrival(router: Awaited<ReturnType<typeof realRouter>>, shape: Shape = SHAPES[0]![1]) {
      const bakery = await router.rule({ from: 'bakery.example.invalid' }, FLORIST);
      await router.bind([{ ruleId: bakery.id, areaId: 'personal' }]);
      // `bodyBytes` lands in the payload as a hint, so the prefetch and a later poll write its keys in different orders.
      const arrived = await arrive(router, [envelope(2, { from: { address: BAKERY }, subject: 'Pickup', bodyBytes: 40, ...shape.envelope })],
        { markRead: true, decorate: true }, (mail) => {
          mail.bodyFrom.current = shape.bodyFrom;
          mail.bodyAddresses.current = shape.bodyAddresses;
        });
      // The rule's target is work of this area, so a route may name it.
      await updateRouterAreas(router.real.home, (file) => ({
        ...file, areas: file.areas.map((area) => area.id === 'personal' ? { ...area, taskIds: [...area.taskIds, FLORIST] } : area),
      }));
      const row = await rowOf(arrived.mail.store, M2);
      expect(row.body_ref).toBeTruthy();
      const source: RouterSource = { kind: 'mail', account: ACCOUNT, message: M2, version: mailRowDeliveryVersion(row) };
      expect((await router.items()).map((one) => one.source)).toEqual([source]);
      const sent: RouterRoute[] = [];
      const route = async (at: RouterSource) => routeItem(
        { source: at, taskId: FLORIST, reason: 'Bakery mail goes to the florist task.', text: 'Please book the pickup.' },
        {
          areas: await readRouterAreas(router.real.home),
          store: routerStore('personal', router.real.home),
          getTask: async (id) => ({ id, title: id, phase: 'IN_PROGRESS', source: 'local', router_area_id: 'personal' }) as Task,
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
      const router = await realRouter();
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
        expect((await router.items()).map((one) => one.source)).toEqual([source]);
        expect([...(await routerStore('personal', router.real.home).getSources([source])).values()]).toEqual([receipt]);
      } finally { unregister(); await disposeRouterStores(); }
    });

    it.each([
      // Not in the envelope hash, so it rides a read flag into the row; any payload field but the five cache ones is content.
      ['a reply address the listing now names', (one: MailEnvelope) => ({ ...one, replyTo: [{ address: 'front@bakery.example.invalid' }] }), true],
      ['a re-decoded subject', (one: MailEnvelope) => ({ ...one, subject: 'Pickup moved to Friday' }), false],
      ['an attachment the listing now names', (one: MailEnvelope) => ({ ...one, attachments: [{ filename: 'form.pdf', mimeType: 'application/pdf', bytes: 9 }] }), false],
    ] as const)('%s is another delivery: the old receipt and confirmation are never shown on it', async (_name, change, withFlag) => {
      const router = await realRouter();
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
        expect((await router.items()).map((one) => one.source)).toEqual([source]);
        expect([...(await routerStore('personal', router.real.home).getSources([source])).values()]).toEqual([receipt]);
      } finally { unregister(); await disposeRouterStores(); }
    });
  });
});

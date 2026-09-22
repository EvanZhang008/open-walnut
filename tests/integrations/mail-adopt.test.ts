/**
 * Adoption: the base mirrors the accounts a provider already knows about.
 *
 * `MailProviderSpec.listAccounts()` has always been in the contract ("every account the provider
 * knows") and the base never called it, so a provider whose accounts need no setup at all (an
 * ambient corporate sign-in: no password to type, the helper already knows the mailbox) could not
 * show a single message until a human filled in a form about their own address.
 *
 * Two halves are graded here, and they are graded differently on purpose:
 *
 * - The RULES, against `MailAccounts.adopt` directly with an in-memory mirror: a row the mirror
 *   already has is untouched, a foreign provider prefix is skipped, and one provider that throws
 *   or never answers cannot stop the sweep or delay a registration.
 * - The WIRING, through a real server and a real provider plugin: an ambient account appears in
 *   `GET /api/plugins/mail/accounts` within a tick of the plugin activating, with no setup POST,
 *   and a poll runs for it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import yaml from 'js-yaml';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('mail-adopt-test'));

import { WALNUT_HOME, CONFIG_FILE, TASKS_FILE } from '../../src/constants.js';
import { bus } from '../../src/core/event-bus.js';
import { registry } from '../../src/core/integration-registry.js';
import { getPluginLifecycleRecords } from '../../src/core/integration-loader.js';
import { MailAccounts } from '../../src/integrations/mail/accounts.js';
import { createMailBaseApi } from '../../src/integrations/mail/api.js';
import { MailEvents } from '../../src/integrations/mail/events.js';
import { MailProviderRegistry } from '../../src/integrations/mail/provider-registry.js';
import type { AccountSetupField, MailAccount, MailProviderSpec } from '../../src/integrations/mail/types.js';
import { startServer, stopServer } from '../../src/web/server.js';

const CAPABILITIES = {
  search: false, watch: false, drafts: false, markRead: false, flags: false,
  threads: false, send: false, sendAsReply: false, bodies: 'text', attachments: 'none',
} as const;

function account(accountId: string, extra: Partial<MailAccount> = {}): MailAccount {
  return {
    accountId,
    providerId: accountId.slice(0, Math.max(0, accountId.indexOf(':'))),
    displayName: 'Ambient mailbox',
    address: 'alice@example.invalid',
    state: 'active',
    ...extra,
  };
}

/** A provider with no form at all, which is the shape an ambient sign-in has. */
function providerSpec(
  id: string,
  listAccounts: () => Promise<MailAccount[]>,
  fields: AccountSetupField[] = [],
): MailProviderSpec {
  return {
    id,
    label: id,
    capabilities: { ...CAPABILITIES },
    setup: {
      fields,
      submit: async () => { throw new Error('an ambient provider has nothing to submit'); },
    },
    listAccounts,
    health: async () => ({ state: 'ok', checkedAt: Date.now() }),
    listMailboxes: async () => [],
    poll: async () => ({ messages: [], cursor: 'c0', more: false }),
    getBody: async () => ({ format: 'text', text: '', bytes: 0 }),
    send: async () => ({ acceptedAt: Date.now() }),
  };
}

interface LogLine { level: 'info' | 'warn'; message: string; meta: Record<string, unknown> }
interface MirrorRow { account_id: string; display_name: string; address: string; state: string }

/**
 * `MailAccounts` with an in-memory mirror.
 *
 * The row semantics are pinned against a real database in mail-sync.test.ts; what these cases
 * need is the ability to say "no write reached the mirror at all", which a recorded upsert list
 * states exactly.
 */
function harness(options: { replica?: boolean } = {}) {
  const rows = new Map<string, MirrorRow>();
  const upserts: string[] = [];
  const emitted: Array<{ name: string; data: unknown }> = [];
  const kicked: string[] = [];
  const logs: LogLine[] = [];
  const providers = new MailProviderRegistry(() => undefined);
  const events = new MailEvents((name, data) => { emitted.push({ name, data }); });
  const accounts = new MailAccounts({
    store: {
      listAccounts: async () => [...rows.values()],
      getAccount: async (accountId: string) => rows.get(accountId),
      upsertAccount: async (row: {
        accountId: string; providerId: string; displayName: string; address: string; state: string;
      }) => {
        upserts.push(row.accountId);
        rows.set(row.accountId, {
          account_id: row.accountId,
          display_name: row.displayName,
          address: row.address,
          state: row.state,
        });
      },
    } as never,
    retention: {
      purgeAccount: () => { throw new Error('adoption must never delete anything'); },
    } as never,
    providers,
    events,
    kick: (accountId: string) => { kicked.push(accountId); },
    forget: async () => { throw new Error('adoption must never forget an account'); },
    replica: () => options.replica === true,
    log: {
      info: (message: string, meta?: Record<string, unknown>) => logs.push({ level: 'info', message, meta: meta ?? {} }),
      warn: (message: string, meta?: Record<string, unknown>) => logs.push({ level: 'warn', message, meta: meta ?? {} }),
    },
  });
  const seed = (accountId: string, row: Partial<MirrorRow> = {}): void => {
    rows.set(accountId, {
      account_id: accountId,
      display_name: 'The name the human already has',
      address: 'alice@example.invalid',
      state: 'active',
      ...row,
    });
  };
  return { providers, events, accounts, rows, upserts, emitted, kicked, logs, seed };
}

function warnings(logs: LogLine[]): LogLine[] {
  return logs.filter((line) => line.level === 'warn');
}

describe('adopt, against the rules', () => {
  it('mirrors an account the provider already knows, announces it and kicks a poll', async () => {
    const one = harness();
    one.providers.register(providerSpec('ambient', async () => [account('ambient:desk')]), 'test');

    await expect(one.accounts.adopt('ambient')).resolves.toEqual(['ambient:desk']);

    expect(one.upserts).toEqual(['ambient:desk']);
    expect(one.rows.get('ambient:desk')).toMatchObject({
      display_name: 'Ambient mailbox', address: 'alice@example.invalid', state: 'active',
    });
    expect(one.emitted).toEqual([
      { name: 'account-changed', data: { accountId: 'ambient:desk', action: 'added' } },
    ]);
    // The backfill starts on its own: an adopted account that waits out a poll interval before it
    // shows a single message is the same empty mailbox the human was complaining about.
    expect(one.kicked).toEqual(['ambient:desk']);
    expect(one.logs.find((line) => line.message === 'mail adopted provider accounts')?.meta)
      .toMatchObject({ providerId: 'ambient', count: 1, accountIds: ['ambient:desk'] });
  });

  it('leaves a row the mirror already has completely alone', async () => {
    // The mirror is the source of truth once it has a row: its state carries an auth park the poll
    // loop set, and its display name may be one the human edited. A provider re-listing the account
    // is not news, and re-mirroring it would quietly revive a disabled account and re-announce it.
    const one = harness();
    one.seed('ambient:desk', { state: 'auth-required', display_name: 'The name the human already has' });
    one.providers.register(providerSpec('ambient', async () => [
      account('ambient:desk', { displayName: 'Ambient mailbox', state: 'active' }),
    ]), 'test');

    await expect(one.accounts.adopt('ambient')).resolves.toEqual([]);

    expect(one.upserts).toEqual([]);
    expect(one.emitted).toEqual([]);
    expect(one.kicked).toEqual([]);
    expect(one.rows.get('ambient:desk')).toMatchObject({
      display_name: 'The name the human already has', state: 'auth-required',
    });
  });

  it('does not overwrite a row that appears while the provider is still answering', async () => {
    // The mirror is read once, before any provider is asked, so a setup POST for the same account
    // can land inside that window. Mirroring it anyway would overwrite what the POST just stored,
    // announce the account a second time and poll it twice.
    const one = harness();
    one.providers.register(providerSpec('ambient', async () => {
      one.seed('ambient:desk', { display_name: 'The name the POST stored' });
      return [account('ambient:desk')];
    }), 'test');

    await expect(one.accounts.adopt('ambient')).resolves.toEqual([]);

    expect(one.upserts).toEqual([]);
    expect(one.emitted).toEqual([]);
    expect(one.kicked).toEqual([]);
    expect(one.rows.get('ambient:desk')).toMatchObject({ display_name: 'The name the POST stored' });
  });

  it('skips an account whose id belongs to another provider, and adopts the good one beside it', async () => {
    // An account id is `<providerId>:<providerAccountId>`, and a row whose prefix names somebody
    // else can never be routed back to the provider that produced it: every poll of it would go to
    // a provider that has never heard of it.
    const one = harness();
    one.providers.register(providerSpec('ambient', async () => [
      account('other:desk'), account('ambient:desk'),
    ]), 'test');

    await expect(one.accounts.adopt('ambient')).resolves.toEqual(['ambient:desk']);

    expect(one.upserts).toEqual(['ambient:desk']);
    expect(warnings(one.logs)).toHaveLength(1);
    expect(warnings(one.logs)[0]!.meta).toMatchObject({ providerId: 'ambient', accountId: 'other:desk' });
  });

  it('carries on past a provider that throws and one that never answers', async () => {
    const one = harness();
    one.providers.register(providerSpec('broken', async () => {
      throw new Error('the helper is not signed in');
    }), 'test');
    one.providers.register(providerSpec('stuck', () => new Promise<MailAccount[]>(() => undefined)), 'test');
    one.providers.register(providerSpec('ambient', async () => [account('ambient:desk')]), 'test');

    vi.useFakeTimers();
    try {
      const sweep = one.accounts.adopt();
      // Past the adoption deadline, which is the only thing that can end the middle provider.
      await vi.advanceTimersByTimeAsync(11_000);
      await expect(sweep).resolves.toEqual(['ambient:desk']);
    } finally {
      vi.useRealTimers();
    }

    expect(one.upserts).toEqual(['ambient:desk']);
    expect(warnings(one.logs).map((line) => line.meta.providerId)).toEqual(['broken', 'stuck']);
    expect(String(warnings(one.logs)[0]!.meta.error)).toContain('not signed in');
    expect(String(warnings(one.logs)[1]!.meta.error)).toContain('10000ms');
  });

  it('does nothing at all on a replica, without asking any provider', async () => {
    // The mirror lives on the primary. A replica that adopted would write a second copy of the
    // account it does not own, and then poll it.
    const one = harness({ replica: true });
    let asked = 0;
    one.providers.register(providerSpec('ambient', async () => {
      asked += 1;
      return [account('ambient:desk')];
    }), 'test');

    await expect(one.accounts.adopt('ambient')).resolves.toEqual([]);
    await expect(one.accounts.adopt()).resolves.toEqual([]);

    expect(asked).toBe(0);
    expect(one.upserts).toEqual([]);
    expect(one.emitted).toEqual([]);
  });
});

describe('the trigger on the service', () => {
  function service(one: ReturnType<typeof harness>) {
    const scheduled: Array<() => void> = [];
    const adoptCalls: Array<string | undefined> = [];
    const api = createMailBaseApi({
      providers: one.providers,
      events: one.events,
      sync: {} as never,
      accounts: async () => [],
      caller: () => 'a-provider-plugin',
      adopt: (providerId) => {
        adoptCalls.push(providerId);
        return one.accounts.adopt(providerId);
      },
      // Graded on their own in mail-body-revision.test.ts and mail-identity-revision.test.ts. Here
      // they only have to exist, so that a provider declaring neither provably schedules nothing extra.
      bodyRevision: async () => undefined,
      identityRevision: async () => undefined,
      defer: (run) => { scheduled.push(run); },
    });
    return { api, scheduled, adoptCalls };
  }

  it('sweeps a provider that renders no form, deferred, and never makes registerProvider wait', async () => {
    const one = harness();
    const { api, scheduled, adoptCalls } = service(one);

    const handle = api.registerProvider(providerSpec('ambient', async () => [account('ambient:desk')]));

    // Synchronous, and nothing was asked of the provider yet: a slow `listAccounts` must not be
    // able to eat into the 20 seconds a plugin has to activate.
    expect(typeof handle.dispose).toBe('function');
    expect(adoptCalls).toEqual([]);
    expect(scheduled).toHaveLength(1);

    scheduled[0]!();
    await vi.waitFor(() => { expect(one.rows.has('ambient:desk')).toBe(true); });
    expect(adoptCalls).toEqual(['ambient']);
  });

  it('registers a provider whose listAccounts never answers without throwing or waiting', () => {
    const one = harness();
    const { api, scheduled } = service(one);

    const handle = api.registerProvider(providerSpec('stuck', () => new Promise<MailAccount[]>(() => undefined)));

    expect(typeof handle.dispose).toBe('function');
    expect(scheduled).toHaveLength(1);
    // Running the deferred sweep must not reject either: it reports its own failures.
    expect(() => scheduled[0]!()).not.toThrow();
  });

  it('leaves a provider with a setup form to the human, and still adopts it on request', async () => {
    // A form means there is something only the human knows, so the POST stays the way those
    // accounts arrive. A provider that has a form AND accounts it discovered by itself asks for
    // them to be mirrored with one call, which is also the late-discovery path.
    const one = harness();
    const { api, scheduled } = service(one);

    api.registerProvider(providerSpec(
      'formy',
      async () => [account('formy:desk')],
      [{ name: 'address', label: 'Address', kind: 'text' }],
    ));
    expect(scheduled).toEqual([]);
    expect(one.rows.size).toBe(0);

    await expect(api.adoptAccounts('formy')).resolves.toEqual(['formy:desk']);
    expect(one.rows.has('formy:desk')).toBe(true);
  });
});

/*
 * The wiring, through a real server: a provider plugin that activates and is simply THERE, with a
 * mailbox nobody typed an address for.
 */
const FIXTURE_ID = 'mail-adopt-fixture';
const AMBIENT = 'ambient:desk';
const LATE = 'late:desk';

interface Fixture {
  /** What the `late` provider answers with. Starts empty: it has not probed yet. */
  lateAccounts: string[];
  ambientName: string;
  ambientState: string;
  polls: Array<{ accountId: string; mailbox: string }>;
  /** How many times any provider's `setup.submit` ran. Adoption must never be a setup. */
  submits: number;
  /** Which providers were asked for their account list. */
  listed: string[];
  base?: { adoptAccounts(providerId?: string): Promise<string[]>; version(): string };
}

let server: HttpServer;
let port = 0;
const events: Array<{ name: string; data: Record<string, unknown> }> = [];

function marks(): Fixture {
  return (globalThis as unknown as { __mailAdopt: Fixture }).__mailAdopt;
}

function apiUrl(routePath: string): string {
  return `http://127.0.0.1:${port}/api/plugins/mail${routePath}`;
}

async function getJson<T>(routePath: string): Promise<{ status: number; body: T }> {
  const response = await fetch(apiUrl(routePath));
  return { status: response.status, body: await response.json() as T };
}

function eventsOf(name: string): Array<Record<string, unknown>> {
  return events.filter((event) => event.name === name).map((event) => event.data);
}

async function accountIds(): Promise<string[]> {
  const listed = await getJson<{ accounts: Array<{ accountId: string }> }>('/accounts');
  return listed.body.accounts.map((one) => one.accountId);
}

async function writeFixtureProvider(): Promise<void> {
  const dir = path.join(WALNUT_HOME, 'plugins', FIXTURE_ID);
  await fsp.mkdir(path.join(dir, 'dist'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    id: FIXTURE_ID,
    name: 'Mail Adoption Fixture',
    description: 'Three providers: one ambient, one that discovers late, one that never answers',
    version: '1.0.0',
    apiVersion: 1,
    engines: { walnut: '>=0.0.0' },
    server: 'dist/server.mjs',
    dependencies: { mail: '^1.0.0' },
  }));
  await fsp.writeFile(path.join(dir, 'dist', 'server.mjs'), `
const S = () => globalThis.__mailAdopt;

const CAPABILITIES = {
  search: false, watch: false, drafts: false, markRead: false, flags: false,
  threads: false, send: false, sendAsReply: false, bodies: 'text', attachments: 'none',
};

function common(id) {
  return {
    id,
    label: id,
    capabilities: CAPABILITIES,
    health: async () => ({ state: 'ok', checkedAt: Date.now() }),
    listMailboxes: async () => [{ mailboxId: 'INBOX', name: 'INBOX', role: 'inbox', unread: 0, total: 1 }],
    poll: async (accountId, request) => {
      S().polls.push({ accountId, mailbox: request.mailbox });
      return {
        messages: request.cursor ? [] : [{
          messageId: request.mailbox + ':1:1',
          rfcMessageId: '<one.' + accountId + '@example.invalid>',
          mailboxId: request.mailbox,
          from: { name: 'Alice', address: 'alice@example.invalid' },
          to: [{ address: 'me@example.invalid' }],
          subject: 'It was already here',
          sentAt: Date.UTC(2026, 0, 12, 9, 0, 0),
          flags: [],
          attachments: [],
        }],
        cursor: '1:1',
        more: false,
      };
    },
    getBody: async () => ({ format: 'text', text: 'It was already here.', bytes: 20 }),
    send: async () => ({ acceptedAt: Date.now() }),
  };
}

export function activate(walnut) {
  const base = walnut.services.require('mail:base');
  S().base = base;
  const handles = [
    // No form at all: there is no password, and the helper already knows the mailbox.
    base.registerProvider({
      ...common('ambient'),
      setup: { fields: [], submit: async () => { S().submits += 1; throw new Error('nothing to submit'); } },
      listAccounts: async () => {
        S().listed.push('ambient');
        return [{
          accountId: '${AMBIENT}', providerId: 'ambient',
          displayName: S().ambientName, address: 'alice@example.invalid', state: S().ambientState,
        }];
      },
    }),
    // A form AND accounts it finds by itself, after its own probe.
    base.registerProvider({
      ...common('late'),
      setup: {
        fields: [{ name: 'address', label: 'Address', kind: 'text' }],
        submit: async () => { S().submits += 1; throw new Error('nothing to submit'); },
      },
      listAccounts: async () => {
        S().listed.push('late');
        return S().lateAccounts.map((accountId) => ({
          accountId, providerId: 'late', displayName: 'Discovered later',
          address: 'desk@example.invalid', state: 'active',
        }));
      },
    }),
    // Never answers. The other two must be adopted anyway, and activate must not wait for it.
    base.registerProvider({
      ...common('stuck'),
      setup: { fields: [], submit: async () => { S().submits += 1; throw new Error('nothing to submit'); } },
      listAccounts: () => {
        S().listed.push('stuck');
        return new Promise(() => {});
      },
    }),
  ];
  return { dispose: () => { for (const handle of handles) handle.dispose(); } };
}
`);
}

describe('through a real server, an ambient mailbox is simply there', () => {
  beforeAll(async () => {
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
    await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true });
    await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }));
    (globalThis as unknown as { __mailAdopt: Fixture }).__mailAdopt = {
      lateAccounts: [],
      ambientName: 'Ambient mailbox',
      ambientState: 'active',
      polls: [],
      submits: 0,
      listed: [],
    };
    await writeFixtureProvider();
    bus.subscribe('mail-adopt-observer', (event) => {
      if (event.name.startsWith('plugin:mail:')) {
        events.push({ name: event.name.slice('plugin:mail:'.length), data: event.data as Record<string, unknown> });
      }
    }, { global: true, interest: ['plugin:mail:'] });
    // A long poll interval on purpose: the only thing that can poll the adopted account inside
    // this file is adoption's own kick.
    await fsp.writeFile(
      CONFIG_FILE,
      yaml.dump({
        version: 1,
        user: { name: 'test' },
        defaults: { priority: 'none' },
        plugins: { mail: { poll_interval_seconds: 600 } },
      }),
      'utf-8',
    );
    server = await startServer({ port: 0, dev: true });
    const address = server.address();
    port = typeof address === 'object' && address ? address.port : 0;
  }, 180_000);

  afterAll(async () => {
    bus.unsubscribe('mail-adopt-observer');
    await stopServer();
    delete (globalThis as unknown as { __mailAdopt?: Fixture }).__mailAdopt;
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => undefined);
  });

  it('mirrors it within a tick of the plugin activating, with no setup POST', async () => {
    await expect.poll(accountIds, { timeout: 30_000 }).toContain(AMBIENT);

    const listed = await getJson<{ accounts: Array<Record<string, unknown>> }>('/accounts');
    expect(listed.body.accounts.find((one) => one.accountId === AMBIENT)).toMatchObject({
      accountId: AMBIENT,
      providerId: 'ambient',
      displayName: 'Ambient mailbox',
      address: 'alice@example.invalid',
      state: 'active',
    });
    // Nobody typed anything: the form was never rendered and `submit` never ran.
    expect(marks().submits).toBe(0);
    expect(eventsOf('account-changed')).toEqual([{ accountId: AMBIENT, action: 'added' }]);

    // And the mail is there, because adoption kicked the backfill rather than waiting for the
    // poll interval.
    await expect.poll(
      () => marks().polls.filter((one) => one.accountId === AMBIENT).length,
      { timeout: 30_000 },
    ).toBeGreaterThan(0);
    const messages = await getJson<{ messages: Array<{ subject: string }> }>(
      `/messages?account=${encodeURIComponent(AMBIENT)}&mailbox=INBOX`,
    );
    expect(messages.body.messages.map((one) => one.subject)).toEqual(['It was already here']);

    // The provider that never answers was asked, and its plugin activated anyway.
    expect(marks().listed).toContain('stuck');
    expect(getPluginLifecycleRecords(registry).find((entry) => entry.id === FIXTURE_ID)?.state).toBe('active');
    expect(marks().base?.version()).toBe('1.10.0');
  }, 120_000);

  it('leaves the mirrored row alone when the provider lists it again with other values', async () => {
    marks().ambientName = 'A name the provider changed its mind about';
    marks().ambientState = 'disabled';

    await expect(marks().base!.adoptAccounts('ambient')).resolves.toEqual([]);

    const listed = await getJson<{ accounts: Array<Record<string, unknown>> }>('/accounts');
    expect(listed.body.accounts.find((one) => one.accountId === AMBIENT)).toMatchObject({
      displayName: 'Ambient mailbox', state: 'active',
    });
  }, 60_000);

  it('adopts an account a provider discovers after its own probe', async () => {
    // Nothing to adopt yet, and the account is not in the mirror either: a provider with a form is
    // not swept up automatically.
    expect(await accountIds()).not.toContain(LATE);
    await expect(marks().base!.adoptAccounts('late')).resolves.toEqual([]);

    marks().lateAccounts.push(LATE);
    await expect(marks().base!.adoptAccounts('late')).resolves.toEqual([LATE]);

    expect(await accountIds()).toContain(LATE);
    await expect.poll(
      () => marks().polls.some((one) => one.accountId === LATE),
      { timeout: 30_000 },
    ).toBe(true);
  }, 120_000);
});

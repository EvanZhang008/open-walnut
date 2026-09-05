/**
 * The mail base as a capability plugin, through a real server.
 *
 * Five things are graded here, and each one is a claim the platform makes rather than a
 * claim about mail:
 *
 * - A plugin can own a whole domain's HTTP surface and its own storage. The routes come
 *   from `walnut.http.route` and answer under `/api/plugins/mail/*` with no kernel change.
 * - Another plugin attaches through the published service. The fixture provider declares
 *   `dependencies: { mail: '^1.0.0' }`, calls `services.require('mail:base')` during its own
 *   activate, and the base never learns its name.
 * - The registration is OWNED. Disposing the returned Disposable removes the provider live,
 *   and turning the provider plugin off removes it too, because the plugin returned that
 *   Disposable from `activate` and the loader owns whatever activate returns.
 * - FTS5 is present in the bundled driver, reached through the plugin's own worker-thread
 *   database. A contentless FTS5 table is the whole point of the mail cache, so a driver
 *   built without it has to fail here and not in slice 1.
 * - A zero-account install adds NO agent tool. The full plugin tool-name list is compared
 *   against the same list from a server booted with the mail plugin disabled: equal, or the
 *   prompt-cache prefix moved for every user who never asked for mail.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import yaml from 'js-yaml';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('mail-plugin-test'));

import { WALNUT_HOME, CONFIG_FILE, TASKS_FILE } from '../../src/constants.js';
import { registry } from '../../src/core/integration-registry.js';
import {
  disableLoadedPlugin,
  getPluginLifecycleRecords,
  getPluginToolSpecs,
  reloadLoadedPlugin,
} from '../../src/core/integration-loader.js';
import { MailDatabase, mailDatabaseForTesting } from '../../src/integrations/mail/db.js';
import type { WalnutServerPluginApi } from '../../src/core/plugins/server-api.js';
import { startServer, stopServer } from '../../src/web/server.js';

/** What the fixture provider plugin records for the test to read back. */
interface FixtureMarks {
  activated: number;
  errors: string[];
  handles: Array<{ dispose(): void | Promise<void> }>;
  version?: string;
}

const FIXTURE_ID = 'mail-fixture-provider';

let server: HttpServer;
let port = 0;

function apiUrl(routePath: string): string {
  return `http://127.0.0.1:${port}/api/plugins/mail${routePath}`;
}

function marks(): FixtureMarks {
  return (globalThis as unknown as { __mailFixture: FixtureMarks }).__mailFixture;
}

async function getJson<T>(routePath: string): Promise<{ status: number; body: T }> {
  const response = await fetch(apiUrl(routePath));
  return { status: response.status, body: await response.json() as T };
}

async function writeConfig(plugins: Record<string, Record<string, unknown>> = {}): Promise<void> {
  await fsp.writeFile(
    CONFIG_FILE,
    yaml.dump({ version: 1, user: { name: 'test' }, defaults: { priority: 'none' }, plugins }),
    'utf-8',
  );
}

/**
 * The provider plugin. It RETURNS the Disposable from `activate`, which is how a provider
 * hands ownership to the loader: that one line is what makes "turn the provider off and the
 * provider row disappears" true without the base ever knowing who called it.
 */
async function writeFixtureProvider(): Promise<void> {
  const dir = path.join(WALNUT_HOME, 'plugins', FIXTURE_ID);
  await fsp.mkdir(path.join(dir, 'dist'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    id: FIXTURE_ID,
    name: 'Mail Fixture Provider',
    description: 'Registers one fake mail provider through the mail base service',
    version: '1.0.0',
    apiVersion: 1,
    engines: { walnut: '>=0.0.0' },
    server: 'dist/server.mjs',
    dependencies: { mail: '^1.0.0' },
  }));
  await fsp.writeFile(path.join(dir, 'dist', 'server.mjs'), `
const all = () => (globalThis.__mailFixture ??= { activated: 0, errors: [], handles: [] });

export function activate(walnut) {
  const state = all();
  state.activated += 1;
  const base = walnut.services.require('mail:base');
  const spec = {
    id: 'fake',
    label: 'Fake',
    capabilities: {
      search: false, watch: false, drafts: true, markRead: true, flags: false,
      threads: false, send: true, sendAsReply: false,
      bodies: 'text', attachments: 'none',
    },
    setup: { fields: [], submit: async () => { throw new Error('slice 0 has no account setup'); } },
    listAccounts: async () => [],
    health: async () => ({ state: 'ok', checkedAt: Date.now() }),
    listMailboxes: async () => [],
    poll: async () => ({ messages: [], cursor: 'c0', more: false }),
    getBody: async () => ({ format: 'text', text: '', bytes: 0 }),
    send: async () => ({ acceptedAt: Date.now() }),
  };
  const handle = base.registerProvider(spec);
  state.handles.push(handle);
  state.version = base.version();
  try { base.registerProvider(spec); }
  catch (error) { state.errors.push(error instanceof Error ? error.message : String(error)); }
  return { dispose: () => handle.dispose() };
}
`);
}

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true });
  await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }));
  await writeConfig();
  (globalThis as unknown as { __mailFixture: FixtureMarks }).__mailFixture = {
    activated: 0, errors: [], handles: [],
  };
  await writeFixtureProvider();
  server = await startServer({ port: 0, dev: true });
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
}, 120_000);

afterAll(async () => {
  await stopServer();
  delete (globalThis as unknown as { __mailFixture?: FixtureMarks }).__mailFixture;
  // Best effort: background writers (git auto-commit, the notes watcher) can still be
  // flushing into this temp home when the last test ends, and an ENOTEMPTY here would fail
  // the suite for a directory the OS cleans up anyway.
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => undefined);
});

describe('the mail base plugin owns its routes and its storage', () => {
  it('loads as a builtin from src/integrations/mail', () => {
    const record = getPluginLifecycleRecords(registry).find((entry) => entry.id === 'mail');
    expect(record?.state).toBe('active');
    expect(record?.builtin).toBe(true);
  });

  it('answers the zero-account routes for real', async () => {
    const accounts = await getJson<{ accounts: unknown[] }>('/accounts');
    expect(accounts.status).toBe(200);
    // Read from the accounts table, not a literal: an empty answer has to prove the
    // migration ran, or slice 1 would be the first code to find out it did not.
    expect(accounts.body).toEqual({ accounts: [] });

    const health = await getJson<{ ok: boolean; providers: number; accounts: number; db: string }>('/health');
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(true);
    expect(health.body.accounts).toBe(0);
    await expect.poll(
      async () => (await getJson<{ db: string }>('/health')).body.db,
      { timeout: 10_000 },
    ).toBe('ready');
  });
});

describe('a provider plugin attaches through the service, with no kernel change', () => {
  it('lists the provider it registered and refuses a second registration of the same id', async () => {
    expect(getPluginLifecycleRecords(registry).find((entry) => entry.id === FIXTURE_ID)?.state).toBe('active');
    expect(marks().activated).toBe(1);
    expect(marks().version).toBe('1.0.0');

    const providers = await getJson<{ providers: Array<{ id: string; label: string; capabilities: { bodies: string } }> }>('/providers');
    expect(providers.status).toBe(200);
    expect(providers.body.providers).toEqual([
      expect.objectContaining({ id: 'fake', label: 'Fake' }),
    ]);
    expect(providers.body.providers[0]!.capabilities.bodies).toBe('text');

    // The duplicate has to say WHY it is refused, in terms of the rule, not "already exists".
    expect(marks().errors).toHaveLength(1);
    expect(marks().errors[0]).toContain('"fake"');
    expect(marks().errors[0]).toMatch(/unique/i);

    const health = await getJson<{ providers: number }>('/health');
    expect(health.body.providers).toBe(1);
  });

  it('drops the provider when the plugin that registered it is turned off', async () => {
    await disableLoadedPlugin(registry, FIXTURE_ID);
    expect(getPluginLifecycleRecords(registry).find((entry) => entry.id === FIXTURE_ID)?.state).toBe('disabled');
    expect((await getJson<{ providers: unknown[] }>('/providers')).body.providers).toEqual([]);

    // Back on, so the next test has something to dispose by hand.
    await reloadLoadedPlugin(registry, FIXTURE_ID);
    expect(marks().activated).toBe(2);
    expect((await getJson<{ providers: unknown[] }>('/providers')).body.providers).toHaveLength(1);
  });

  it('drops the provider when the returned Disposable is disposed, with no reload', async () => {
    const handle = marks().handles[marks().handles.length - 1]!;
    await handle.dispose();

    expect((await getJson<{ providers: unknown[] }>('/providers')).body.providers).toEqual([]);
    // The plugin itself is untouched: only its registration went away.
    expect(getPluginLifecycleRecords(registry).find((entry) => entry.id === FIXTURE_ID)?.state).toBe('active');
    expect((await getJson<{ providers: number }>('/health')).body.providers).toBe(0);
  });
});

describe('the plugin database', () => {
  it('carries a contentless FTS5 index that matches', async () => {
    await expect.poll(
      async () => (await getJson<{ db: string }>('/health')).body.db,
      { timeout: 10_000 },
    ).toBe('ready');

    const db = mailDatabaseForTesting();
    expect(db, 'the mail plugin must have an open database once health says ready').not.toBeNull();

    await db!.run(
      'INSERT INTO messages_fts(rowid, subject, from_addr, snippet, body_text) VALUES (?, ?, ?, ?, ?)',
      [7, 'Quarterly plan', 'sender@example.invalid', 'short snippet', 'the needle sits deep in this body'],
    );

    // A contentless table returns no column values, so rowid is the only honest assertion.
    const hits = await db!.all<{ rowid: number }>(
      "SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'needle'",
    );
    expect(hits.map((row) => row.rowid)).toEqual([7]);

    const misses = await db!.all<{ rowid: number }>(
      "SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'haystack'",
    );
    expect(misses).toEqual([]);
  });

  it('lets retention DELETE from that index, and re-index the same rowid', async () => {
    // A plain `content=''` table REFUSES delete ("cannot DELETE from contentless fts5 table"),
    // so retention could never prune the index next to the messages it indexes, and adding
    // the option later would mean a DROP, a CREATE and a full re-tokenize. Pinned here so the
    // schema cannot lose `contentless_delete=1` quietly.
    const db = mailDatabaseForTesting();
    expect(db).not.toBeNull();

    await db!.run(
      'INSERT INTO messages_fts(rowid, subject, from_addr, snippet, body_text) VALUES (?, ?, ?, ?, ?)',
      [8, 'Another plan', 'sender@example.invalid', 'short snippet', 'one more needle for the pile'],
    );
    const before = await db!.all<{ rowid: number }>(
      "SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'needle' ORDER BY rowid",
    );
    expect(before.map((row) => row.rowid)).toEqual([7, 8]);

    await db!.run('DELETE FROM messages_fts WHERE rowid = ?', [8]);
    const after = await db!.all<{ rowid: number }>(
      "SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'needle' ORDER BY rowid",
    );
    expect(after.map((row) => row.rowid)).toEqual([7]);

    // Re-ingesting a pruned message must work: the same rowid comes back, matchable.
    await db!.run(
      'INSERT INTO messages_fts(rowid, subject, from_addr, snippet, body_text) VALUES (?, ?, ?, ?, ?)',
      [8, 'Another plan', 'sender@example.invalid', 'short snippet', 'the needle returns'],
    );
    const again = await db!.all<{ rowid: number }>(
      "SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'needle' ORDER BY rowid",
    );
    expect(again.map((row) => row.rowid)).toEqual([7, 8]);
  });
});

describe('a failed open', () => {
  /** A host api whose database is broken for the first `failures` opens. */
  function flakyWalnut(failures: number): { api: WalnutServerPluginApi; opens: () => number } {
    let opens = 0;
    const api = {
      get storage() {
        return {
          get database() {
            opens += 1;
            if (opens <= failures) throw new Error('no space left on device');
            return {
              migrate: async () => undefined,
              get: async () => ({ n: 0 }),
              all: async () => [],
              run: async () => ({ changes: 0, lastInsertRowid: 0 }),
              dispose: async () => undefined,
            };
          },
        };
      },
    } as unknown as WalnutServerPluginApi;
    return { api, opens: () => opens };
  }

  it('is retried after a cooldown instead of being permanent for the process', async () => {
    let clock = 1_000;
    const flaky = flakyWalnut(1);
    const db = new MailDatabase(flaky.api, () => clock);

    await expect(db.get('SELECT 1')).rejects.toThrow(/could not be opened/);
    expect(db.status).toBe('failed');
    expect(flaky.opens()).toBe(1);

    // Inside the cooldown: refused WITHOUT touching the host again, so a hot route cannot
    // spawn one worker thread per request while the disk is full.
    await expect(db.get('SELECT 1')).rejects.toThrow(/retry cooldown/);
    expect(flaky.opens()).toBe(1);

    // Past it: a fresh attempt, and the cache comes up. A rejected promise cached forever is
    // what this replaces, where one bad boot meant mail was dead until the server restarted.
    clock += 6_000;
    await expect(db.get<{ n: number }>('SELECT 1')).resolves.toEqual({ n: 0 });
    expect(db.status).toBe('ready');
    expect(flaky.opens()).toBe(2);

    await db.dispose();
  });
});

/*
 * LAST on purpose: it restarts the server with a different config, and everything above
 * needs the first one.
 */
describe('a zero-account install leaves the agent tool list byte-identical', () => {
  it('adds no tool, and the whole sorted name list matches a mail-free boot', async () => {
    const withMail = getPluginToolSpecs(registry).map((tool) => tool.name).sort();
    expect(withMail.filter((name) => name.startsWith('mail'))).toEqual([]);

    await stopServer();
    await writeConfig({ mail: { enabled: false } });
    server = await startServer({ port: 0, dev: true });
    const address = server.address();
    port = typeof address === 'object' && address ? address.port : 0;

    expect(getPluginLifecycleRecords(registry).find((entry) => entry.id === 'mail')?.state).toBe('disabled');
    // With the base off its dependent cannot run either, which is the state that makes
    // the comparison below fair: neither plugin contributed anything.
    expect(getPluginLifecycleRecords(registry).find((entry) => entry.id === FIXTURE_ID)?.state).toBe('needs-dependency');

    const withoutMail = getPluginToolSpecs(registry).map((tool) => tool.name).sort();
    expect(withMail).toEqual(withoutMail);
  }, 120_000);
});

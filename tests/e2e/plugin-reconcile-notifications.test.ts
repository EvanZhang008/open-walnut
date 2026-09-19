/**
 * The full-reconcile failure policy, end to end through the REAL sync loop
 * (startServer → startPluginSyncPolling → SyncReconciler.tick → the card path).
 *
 * A fixture plugin whose delta poll is healthy and whose full pull fails on
 * command, the shape behind the 2026-09-18 "Ms Todo full sync failed" cards:
 * one Graph page of one list timing out while everything else worked. What the
 * human must see: nothing for the first two failures, ONE
 * "<Plugin> full sync keeps failing" card on the third, and that card stamped
 * recovered once a full pull completes again. What they must never see: the
 * per-page "full sync failed" cards the log bridge minted from a log.error.
 *
 * Timing knobs: WALNUT_SYNC_FIRST_TICK_MS (first tick), sync_interval_ms (tick
 * cadence) and WALNUT_RECONCILE_RETRY_BASE_MS (the reconciler's failure backoff)
 * are all shrunk so three failures and a recovery land within seconds.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('reconcile-notify'));

import { WALNUT_HOME, SYNC_DIR } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';

const PLUGIN_ID = 'reconfix';
const PLUGIN_NAME = 'Reconfix';
const TICK_MS = 250;
const PULL_ERROR = 'Graph API GET /me/todo/lists/L/tasks?$skip=100 timed out after 30s (after 3 attempts)';

let server: HttpServer;
let port = 0;
const savedEnv: Record<string, string | undefined> = {};

const pluginDir = () => path.join(WALNUT_HOME, 'plugins', PLUGIN_ID);
const controlFile = () => path.join(pluginDir(), 'control.json');

interface FeedRecord {
  id: string; title: string; body?: string; severity: string; dedupKey: string;
  recoveryKey?: string; resolved?: string | null;
}

async function feed(): Promise<FeedRecord[]> {
  const res = await fetch(`http://localhost:${port}/api/notifications`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { feed: FeedRecord[] }).feed;
}

async function reconcileState(): Promise<{ consecutiveFailures?: number; lastFullPullCount?: number } | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(SYNC_DIR, `reconcile-${PLUGIN_ID}.json`), 'utf-8'));
  } catch {
    return null;
  }
}

async function waitFor<T>(label: string, probe: () => Promise<T | undefined | false>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const reconcileCard = (records: FeedRecord[]) => records.find((r) => r.title === `${PLUGIN_NAME} full sync keeps failing`);
const legacyPerPageCards = (records: FeedRecord[]) => records.filter((r) => /full sync failed/i.test(r.title));

beforeAll(async () => {
  for (const key of ['WALNUT_SYNC_FIRST_TICK_MS', 'WALNUT_RECONCILE_RETRY_BASE_MS', 'WALNUT_DISABLE_SEARCH', 'WALNUT_DISABLE_BACKGROUND_AI']) {
    savedEnv[key] = process.env[key];
  }
  process.env.WALNUT_SYNC_FIRST_TICK_MS = '200';
  // 80ms, 160ms, 320ms… between retries: three failures inside a few ticks.
  process.env.WALNUT_RECONCILE_RETRY_BASE_MS = '40';
  process.env.WALNUT_DISABLE_SEARCH = '1';
  process.env.WALNUT_DISABLE_BACKGROUND_AI = '1';

  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(path.join(pluginDir(), 'dist'), { recursive: true });
  await fs.writeFile(path.join(WALNUT_HOME, 'config.yaml'), JSON.stringify({
    version: 1,
    plugins: { [PLUGIN_ID]: { enabled: true, sync_interval_ms: TICK_MS } },
  }, null, 2));
  await fs.writeFile(controlFile(), JSON.stringify({ fullPull: 'fail' }));
  await fs.writeFile(path.join(pluginDir(), 'manifest.json'), JSON.stringify({
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description: 'A fixture sync plugin whose full pull fails on command.',
    version: '1.0.0',
    apiVersion: 1,
    engines: { walnut: '>=0.0.0' },
    server: 'dist/server.mjs',
  }, null, 2));
  await fs.writeFile(path.join(pluginDir(), 'dist', 'server.mjs'), `
import fs from 'node:fs';
const CONTROL = ${JSON.stringify(controlFile())};
const noop = async () => {};
const sync = {
  createTask: async () => null,
  deleteTask: noop, updateTitle: noop, updateDescription: noop, updateSummary: noop, updateNote: noop,
  updateConversationLog: noop, updatePriority: noop, updatePhase: noop, updateDueDate: noop,
  updateProject: noop, updateDependencies: noop,
  pushTask: async () => ({ serverTimestamp: new Date().toISOString() }),
  associateSubtask: noop, disassociateSubtask: noop,
  // Delta sync is healthy throughout: the condition under test is the full pull alone.
  syncPoll: noop,
  async fullPull() {
    const control = JSON.parse(fs.readFileSync(CONTROL, 'utf-8'));
    if (control.fullPull === 'fail') throw new Error(${JSON.stringify(PULL_ERROR)});
    return [];
  },
  extractRemoteId: (task) => task.ext?.['${PLUGIN_ID}']?.id,
};
export function activate(walnut) {
  walnut.registry.sync(sync);
  walnut.registry.extIndex({ source: '${PLUGIN_ID}', paths: [{ key: 'id', json: '$."${PLUGIN_ID}".id', unique: true }] });
}
export function deactivate() {}
`);

  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
}, 60_000);

afterAll(async () => {
  await stopServer();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('full reconcile failures reach the human as ONE card, only once they repeat', () => {
  it('stays quiet for two failures, cards the third, and retires the card when a pull completes', async () => {
    // Failure 1 (and 2): the reconciler keeps the streak, the feed shows nothing.
    await waitFor('first failed full reconcile', async () => ((await reconcileState())?.consecutiveFailures ?? 0) >= 1);
    let records = await feed();
    expect(reconcileCard(records)).toBeUndefined();
    expect(legacyPerPageCards(records)).toEqual([]);

    // Failure 3: escalate → one card, on the reconcile scope, tied to the plugin's recovery key.
    await waitFor('third failed full reconcile', async () => ((await reconcileState())?.consecutiveFailures ?? 0) >= 3);
    const card = await waitFor('the full-sync card', async () => reconcileCard(await feed()));
    expect(card.severity).toBe('error');
    expect(card.dedupKey).toBe(`error:plugin:${PLUGIN_ID}:reconcile`);
    expect(card.recoveryKey).toBe(`plugin:${PLUGIN_ID}`);
    expect(card.resolved ?? null).toBeNull();
    expect(card.body).toContain(`3 full comparisons against ${PLUGIN_NAME} in a row did not finish`);
    expect(card.body).toContain('timed out after 30s (after 3 attempts)');
    expect(card.body).toContain('Regular sync still runs; the full comparison retries on its own.');

    // The old shape is gone: no log-bridge card per failing page, ever.
    records = await feed();
    expect(legacyPerPageCards(records)).toEqual([]);
    expect(records.filter((r) => r.recoveryKey === `plugin:${PLUGIN_ID}`)).toHaveLength(1);

    // The pull completes again → the streak closes → the card is stamped recovered.
    await fs.writeFile(controlFile(), JSON.stringify({ fullPull: 'ok' }));
    await waitFor('streak closed', async () => (await reconcileState())?.consecutiveFailures === 0);
    const recovered = await waitFor('card recovered', async () => {
      const found = reconcileCard(await feed());
      return found?.resolved === 'recovered' ? found : undefined;
    });
    expect(recovered.id).toBe(card.id);
    expect(legacyPerPageCards(await feed())).toEqual([]);
  }, 120_000);
});

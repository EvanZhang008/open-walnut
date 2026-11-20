/**
 * One machine is one host: two aliases whose daemon confirmed they are one process count once.
 *
 * 2026-11-20: `clouddev` (the host network row, "New big clouddev") and `newdev` (an SSH row found in
 * ~/.ssh/config) are one box and one daemon. Usage & Costs listed both, plus an older `clouddev-net`,
 * each with the same responses (about 40% of one week was copies), and the host picker
 * offered the box twice. Every place below must read the two aliases as one:
 *  - collection reads the machine once and stores each response once;
 *  - a response already stored under the other alias is written again in place, never added;
 *  - copies an older build stored are removed once, keeping the machine's own name;
 *  - the report's By host, the pickers and the host's status name show one machine.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';
vi.mock('../../../src/constants.js', () => createMockConstants('usage-one-machine'));
const mocks = vi.hoisted(() => ({ send: vi.fn(), sessions: vi.fn(), config: vi.fn(), dialled: [] as string[] }));
vi.mock('../../../src/core/config-manager.js', () => ({ getConfig: mocks.config, isFallbackConfig: () => false }));
vi.mock('../../../src/core/session-tracker.js', () => ({ listSessions: mocks.sessions }));
vi.mock('../../../src/providers/daemon-connection.js', () => ({ getDaemonConnection: async (key: string) => ({
  connect: async () => { mocks.dialled.push(key); }, hasCapability: (cap: string) => cap !== 'codex-outside-v1',
  send: (cmd: string, params: unknown) => mocks.send(key, cmd, params),
}) }));
import { HOST_PROFILES_DIR } from '../../../src/core/hosts/host-profile.js';
import { __setSshResolverForTest } from '../../../src/core/hosts/same-daemon-record.js';
import { joinedAliasOf, pickableHosts } from '../../../src/core/hosts/joined-twins.js';
import { buildHostStatus } from '../../../src/core/hosts/host-status.js';
import { collectUsage, INCREMENTAL, responseUsageStore } from '../../../src/core/usage/collection.js';
import { buildCostReport, type CostReportDeps } from '../../../src/core/usage/cost-report.js';
import { priceThresholds, resetPriceBookForTests } from '../../../src/core/usage/price-book.js';
import { reconcileUsage } from '../../../src/providers/usage-reconcile-core.js';
import type { CanonicalUsageRecord } from '../../../src/providers/usage-scan-core.js';

const NET_KEY = 'd'.repeat(64);
const NET_ID = `net:${NET_KEY}`;
const SSH_ID = JSON.stringify(['ssh', 'dev', 'box.example.test', '22']);
const HOSTS = {
  clouddev: { hostname: 'clouddev.walnut-net.invalid', label: 'New big clouddev', transport: 'net', endpoint: NET_KEY, enabled: true, discovered: false },
  newdev: { hostname: 'box.example.test', user: 'dev', port: 22, enabled: true, discovered: true, connect: 'yes' },
};
const NET = { enabled: true };
const CONFIG = { usage: {}, hosts: HOSTS, net: NET };

async function writePair(a: string, aId: string, b: string, bId: string): Promise<void> {
  await fs.mkdir(HOST_PROFILES_DIR, { recursive: true });
  for (const [self, selfId, other, otherId] of [[a, aId, b, bId], [b, bId, a, aId]]) {
    await fs.writeFile(path.join(HOST_PROFILES_DIR, `${self}.json`), JSON.stringify({ host: self,
      sameDaemon: { [other]: { self: selfId, other: otherId, at: '2026-11-16T00:00:00.000Z' } } }));
  }
}

/** The snapshot every list reads (daemon-twins.ts), read again from the profiles. */
async function refreshTwins(): Promise<void> {
  const mod = await import('../../../src/core/hosts/daemon-twins.js').catch(() => null);
  await mod?.refreshDaemonTwins(CONFIG as never);
}

function record(responseId: string, sessionId: string): CanonicalUsageRecord {
  return { responseId, model: 'claude-opus-5-5', sessionId, timestamp: '2026-11-03T12:00:00.000Z', input_tokens: 1_000_000, output_tokens: 0,
    cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    speed: 'standard', inference_geo: '', service_tier: 'standard', server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    pricing_context_complete: true, complete: true } as CanonicalUsageRecord;
}
function evidence(records: CanonicalUsageRecord[], outsideSessions: unknown[] = []) {
  return { canonical: { records: [], diagnostics: {}, costStates: [] }, upstream: { records: [], diagnostics: [], coverage: {} },
    reconciliation: reconcileUsage(records, []), until: '2026-11-03T13:00:00.000Z', outsideSessions };
}

function deps(): CostReportDeps {
  const store = responseUsageStore();
  return { rollup: store.rollup, db: store.database, timeZone: store.timezone, tasks: async () => new Map(), sessions: async () => new Map() };
}

/** By host of the whole period, as the route builds it (with the machine names when this build has them). */
async function byHost(): Promise<string[]> {
  const store = responseUsageStore();
  const collection = await import('../../../src/core/usage/usage-machines.js').catch(() => ({})) as Record<string, unknown>;
  const machines = typeof collection.usageMachines === 'function'
    ? await (collection.usageMachines as (c: unknown, r: unknown) => Promise<{ machineOf: (h: string) => string }>)(CONFIG, store.rollup) : null;
  store.rollup.setThresholds(priceThresholds());
  await store.rollup.backfill();
  const report = await buildCostReport('agents', {}, { ...deps(), ...(machines ? { hostOf: machines.machineOf } : {}) });
  return report.groups.find(g => g.id === 'host')!.lines.map(l => `${l.key}:${l.requests}`);
}

function rowsOf(responseId: string): { host: string }[] {
  return responseUsageStore().database.prepare('SELECT host FROM response_usage WHERE response_id=?').all(responseId) as { host: string }[];
}

beforeEach(async () => {
  mocks.send.mockReset(); mocks.dialled.length = 0;
  mocks.config.mockResolvedValue(CONFIG);
  mocks.sessions.mockResolvedValue([
    { claudeSessionId: 's-cloud', host: 'clouddev', engine: 'claude', taskId: 't1' },
    { claudeSessionId: 's-new', host: 'newdev', engine: 'claude', taskId: 't2' },
  ]);
  __setSshResolverForTest(async () => ({ hostname: 'box.example.test', port: 22, user: 'dev' }));
  await fs.rm(HOST_PROFILES_DIR, { recursive: true, force: true });
  await writePair('clouddev', NET_ID, 'newdev', SSH_ID);
  await refreshTwins();
  responseUsageStore().database.exec('DELETE FROM response_usage; DELETE FROM usage_rollup; DELETE FROM usage_checks; DELETE FROM usage_rollup_origin; DELETE FROM usage_rollup_meta');
  resetPriceBookForTests({ source: 'litellm', url: '', fetchedAt: '2026-11-01T00:00:00.000Z',
    models: { 'claude-opus-5-5': { provider: 'anthropic', input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 } } });
});
afterAll(() => { __setSshResolverForTest(null); resetPriceBookForTests(); responseUsageStore().close(); });

describe('two aliases of one daemon are one host', () => {
  it('collection reads the machine once, under its own name, and stores each response once', async () => {
    // One daemon answers both names: the sessions asked for, and the terminal session outside Walnut when asked for those.
    mocks.send.mockImplementation(async (key: string, _cmd: string, params: { sessionIds?: string[]; outside?: boolean }) => {
      if (key !== 'clouddev' && key !== 'newdev') return { ok: true, done: true, result: evidence([]) }; // this computer: nothing
      const ids = [...(params.sessionIds ?? []), ...(params.outside ? ['terminal-run'] : [])];
      return { ok: true, done: true, result: evidence(ids.map(id => record(`msg-${id}`, id)),
        params.outside ? [{ sessionId: 'terminal-run', entrypoint: 'cli', cwd: '/work' }] : []) };
    });
    await collectUsage(INCREMENTAL, '2026-11-03T13:00:00.000Z');
    const reads = mocks.send.mock.calls.filter(c => c[1] === 'usage.scan' && c[2].outside);
    expect(reads.length).toBe(2); // this computer, and the box once
    expect(mocks.dialled).not.toContain('newdev');
    for (const id of ['msg-terminal-run', 'msg-s-cloud', 'msg-s-new']) expect(rowsOf(id)).toEqual([{ host: 'clouddev' }]);
    expect(await byHost()).toEqual(['clouddev:3']);
  });

  it('a response stored under the other name before is that row, written again in place', async () => {
    const store = responseUsageStore();
    await store.importHost('newdev', evidence([record('msg-1', 's-new')]) as never, []);
    await store.importHost('clouddev', evidence([record('msg-1', 's-new')]) as never, []);
    expect(rowsOf('msg-1')).toEqual([{ host: 'newdev' }]);
  });

  it('copies an older build stored under several names are removed once, keeping the machine\'s own name', async () => {
    const store = responseUsageStore();
    // An older alias Walnut no longer knows held the same responses too.
    for (const host of ['clouddev-net', 'newdev', 'clouddev']) {
      store.database.prepare("INSERT INTO response_usage (id, host, response_id, timestamp, date, source, model, session_id, agent_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cache_write_5m, cache_write_1h, verification, pricing_version) VALUES (?, ?, 'msg-old', '2026-11-03T12:00:00.000Z', '2026-11-03', 'session', 'claude-opus-5-5', 's-old', 'main', 1000000, 0, 0, 0, 0, 0, 'verified', 'x')")
        .run(`copy-${host}`, host);
    }
    store.database.prepare("INSERT INTO response_usage (id, host, response_id, timestamp, date, source, model, session_id, agent_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cache_write_5m, cache_write_1h, verification, pricing_version) VALUES ('only-newdev', 'newdev', 'msg-own', '2026-11-03T12:00:00.000Z', '2026-11-03', 'session', 'claude-opus-5-5', 's-old', 'main', 1000000, 0, 0, 0, 0, 0, 'verified', 'x')").run();
    expect(await byHost()).toEqual(['clouddev:2']); // one line for the box, each response once
    expect(rowsOf('msg-old')).toEqual([{ host: 'clouddev' }]);
    expect(rowsOf('msg-own')).toEqual([{ host: 'newdev' }]); // a response stored once stays as it was
  });

  it('the pickers list the machine once, and a status of its other alias names the machine', async () => {
    expect(pickableHosts(HOSTS, NET).map(([alias]) => alias)).toEqual(['clouddev']);
    const state = { host: 'newdev', connected: true, phase: 'connected', phaseElapsedMs: 0, connectElapsedMs: 0 } as never;
    expect(buildHostStatus('newdev', HOSTS.newdev as never, state).label).toBe('New big clouddev');
  });

  it('a row that now connects elsewhere is itself again at once', async () => {
    const moved = { ...HOSTS, newdev: { ...HOSTS.newdev, hostname: 'other.example.test' } };
    expect(pickableHosts(moved, NET).map(([alias]) => alias)).toEqual(['clouddev', 'newdev']);
  });

  it('with the host network off, the SSH alias carries the machine, and a call naming it keeps its own link', async () => {
    expect(pickableHosts(HOSTS, { enabled: false }).map(([alias]) => alias)).toEqual(['newdev']);
    const target = await import('../../../src/core/hosts/joined-twins.js') as Record<string, unknown>;
    const named = typeof target.foundTwinAliasOf === 'function' ? (target.foundTwinAliasOf as typeof joinedAliasOf)(HOSTS, NET)('newdev') : 'clouddev';
    expect(named).toBe('newdev'); // host_exec and host_copy dial the alias they are given: one daemon either way
    expect(joinedAliasOf(HOSTS, NET)('newdev')).toBe('clouddev');
  });

  it('a pair larger than a page, its kept copy stored after the others, keeps each response once under the machine\'s name', async () => {
    const store = responseUsageStore();
    const ins = store.database.prepare("INSERT INTO response_usage (id, host, response_id, timestamp, date, source, model, session_id, agent_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cache_write_5m, cache_write_1h, verification, pricing_version) VALUES (?, ?, ?, '2026-11-03T12:00:00.000Z', '2026-11-03', 'session', 'claude-opus-5-5', 'big', 'main', 1000, 0, 0, 0, 0, 0, 'verified', 'x')");
    store.database.transaction(() => {
      for (const host of ['newdev', 'clouddev-net', 'clouddev']) for (let i = 0; i < 400; i++) ins.run(`${host}-${i}`, host, `msg-big-${i}`);
    })();
    await byHost();
    const rows = store.database.prepare("SELECT host, COUNT(*) n FROM response_usage WHERE session_id='big' GROUP BY host").all();
    expect(rows).toEqual([{ host: 'clouddev', n: 400 }]);
  });

  it('an import meeting copies writes the one the removal keeps, and a later pass removes a copy that came back', async () => {
    const store = responseUsageStore();
    await byHost(); // the one-time removal ran on an empty table
    const ins = store.database.prepare("INSERT INTO response_usage (id, host, response_id, timestamp, date, source, model, session_id, agent_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cache_write_5m, cache_write_1h, verification, pricing_version) VALUES (?, ?, 'msg-1', '2026-11-03T12:00:00.000Z', '2026-11-03', 'session', 'claude-opus-5-5', 's-new', 'main', 1, 0, 0, 0, 0, 0, 'verified', 'x')");
    ins.run('copy-a', 'clouddev-net'); ins.run('copy-b', 'newdev');
    await store.importHost('clouddev', evidence([record('msg-1', 's-new')]) as never, []);
    // The pair's re-sum after the import removes the copy it did not write.
    expect(rowsOf('msg-1')).toEqual([{ host: 'newdev' }]);
  });

  it('a collection mark an older build left under the other name runs the removal again', async () => {
    const store = responseUsageStore();
    await byHost();
    store.finishHost('newdev', '2026-11-03T13:00:00.000Z', []);
    for (const host of ['newdev', 'clouddev']) {
      store.database.prepare("INSERT INTO response_usage (id, host, response_id, timestamp, date, source, model, session_id, agent_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cache_write_5m, cache_write_1h, verification, pricing_version) VALUES (?, ?, 'msg-back', '2026-11-02T12:00:00.000Z', '2026-11-02', 'session', 'claude-opus-5-5', 's-back', 'main', 1, 0, 0, 0, 0, 0, 'verified', 'x')").run(`back-${host}`, host);
    }
    mocks.send.mockResolvedValue({ ok: true, done: true, result: evidence([]) });
    await collectUsage(INCREMENTAL, '2026-11-03T13:00:00.000Z');
    expect(store.countedUntil().map(c => c.host)).not.toContain('newdev');
    expect(rowsOf('msg-back')).toEqual([{ host: 'clouddev' }]);
  });
});

describe('the class: every place the cost report counts by host reads the row\'s host as its machine', () => {
  it('each By host entry and each task\'s host list goes through hostOf', () => {
    const src = readFileSync(path.resolve(__dirname, '../../../src/core/usage/cost-report.ts'), 'utf8');
    const entries = [...src.matchAll(/\[byHost, ([^\]]+)\]/g)].map(m => m[1]);
    expect(entries.length).toBeGreaterThanOrEqual(3);
    for (const e of entries) expect(e, `[byHost, ${e}]`).toMatch(/^hostOf\(/);
    for (const m of src.matchAll(/hosts\.add\(([^)]*\)?)\)/g)) expect(m[1], `hosts.add(${m[1]})`).toMatch(/^hostOf\(/);
    expect(src).toMatch(/hostOf\(b\.host\)/); // the stored days, per machine
  });
});

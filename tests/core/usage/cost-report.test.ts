import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ResponseUsageStore } from '../../../src/core/usage/response-store.js';
import { buildCostReport, localDayStartIso, oneLine, type CostReportDeps } from '../../../src/core/usage/cost-report.js';
import { priceThresholds, resetPriceBookForTests } from '../../../src/core/usage/price-book.js';
import type { PriceSnapshot } from '../../../src/core/usage/price-data.js';
import { reconcileUsage } from '../../../src/providers/usage-reconcile-core.js';
import type { CanonicalUsageRecord } from '../../../src/providers/usage-scan-core.js';

const SNAPSHOT: PriceSnapshot = {
  source: 'litellm', url: '', fetchedAt: '2026-10-20T00:00:00.000Z',
  models: {
    'claude-opus-5-5': { provider: 'anthropic', input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 },
    'gpt-6.1-sol': { provider: 'openai', input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5,
      threshold: 272_000, long: { input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 } },
  },
};
const TZ = 'America/Los_Angeles';
const M = 1_000_000;

let dir: string;
let store: ResponseUsageStore;
let n = 0;

function response(over: Partial<Record<string, unknown>> = {}) {
  n += 1;
  const row = { id: `r${n}`, host: '__local__', response_id: `resp${n}`, timestamp: '2026-10-20T18:00:00.000Z', date: '2026-10-20',
    source: 'session', model: 'claude-opus-5-5', session_id: 's1', task_id: 't1', project: 'Walnut', title: 'stored title',
    agent_id: 'main', input_tokens: 1_000, output_tokens: 0, cache_read_tokens: 0, cache_write_5m: 0, cache_write_1h: 0,
    estimate_usd: null, verification: 'unverified', pricing_version: 'x', cache_creation_tokens: 0, ...over };
  store.database.prepare(`INSERT INTO response_usage (id, host, response_id, timestamp, date, source, model, session_id, task_id, project,
    title, agent_id, input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h, estimate_usd, verification,
    pricing_version, cache_creation_tokens) VALUES (@id,@host,@response_id,@timestamp,@date,@source,@model,@session_id,@task_id,
    @project,@title,@agent_id,@input_tokens,@output_tokens,@cache_read_tokens,@cache_write_5m,@cache_write_1h,@estimate_usd,
    @verification,@pricing_version,@cache_creation_tokens)`).run(row);
  return row;
}

function trackerTable() {
  store.database.exec(`CREATE TABLE IF NOT EXISTS usage (id TEXT PRIMARY KEY, timestamp TEXT, date TEXT, source TEXT, model TEXT,
    input_tokens INTEGER, output_tokens INTEGER, cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER, cost_usd REAL,
    task_id TEXT, session_id TEXT, run_id TEXT, external_cost_usd REAL, duration_ms INTEGER, parent_source TEXT, agent_id TEXT,
    ttft_ms INTEGER, generation_ms INTEGER)`);
}

function call(over: Partial<Record<string, unknown>>) {
  n += 1;
  const row = { id: `u${n}`, timestamp: '2026-10-20T18:00:00.000Z', date: '2026-10-20', source: 'title', model: 'claude-opus-5-5',
    input_tokens: 1_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cost_usd: 0,
    external_cost_usd: null, agent_id: null, ...over };
  store.database.prepare(`INSERT INTO usage (id, timestamp, date, source, model, input_tokens, output_tokens, cache_creation_input_tokens,
    cache_read_input_tokens, cost_usd, external_cost_usd, agent_id) VALUES (@id,@timestamp,@date,@source,@model,@input_tokens,
    @output_tokens,@cache_creation_input_tokens,@cache_read_input_tokens,@cost_usd,@external_cost_usd,@agent_id)`).run(row);
}

function deps(over: Partial<CostReportDeps> = {}): CostReportDeps {
  return {
    rollup: store.rollup, db: store.database, timeZone: TZ,
    tasks: async (ids) => new Map(ids.filter(id => id !== 'gone').map(id => [id, { title: `Task ${id}`, project: id === 't2' ? 'Mail' : 'Walnut' }])),
    sessions: async () => new Map([['s9', { title: 'A session with no task', project: '' }]]),
    ...over,
  };
}

async function ready() {
  store.rollup.setThresholds(priceThresholds());
  await store.rollup.backfill();
}

describe('cost report', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-report-'));
    store = new ResponseUsageStore(path.join(dir, 'usage.sqlite'));
    resetPriceBookForTests(SNAPSHOT);
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    resetPriceBookForTests();
  });

  it('prices coding sessions per request band and groups them by engine, model, host, project and task', async () => {
    response({ input_tokens: 1 * M, output_tokens: 0 });                                     // $4
    response({ input_tokens: 0, output_tokens: 1 * M, host: 'clouddev' });                   // $20
    response({ model: 'gpt-6.1-sol', session_id: 's2', task_id: 't2', input_tokens: 300_000, output_tokens: 0 }); // long rate: $1.20
    response({ model: 'gpt-6.1-sol', session_id: 's2', task_id: 't2', input_tokens: 100_000, output_tokens: 0 }); // base: $0.20
    response({ source: 'chat', session_id: 'c1', task_id: null, input_tokens: 1 * M });      // Walnut view only
    await ready();
    const report = await buildCostReport('agents', {}, deps());
    expect(report.ready).toBe(true);
    expect(report.totals.requests).toBe(4);
    expect(report.totals.costUsd).toBeCloseTo(25.4, 9);
    const group = (id: string) => report.groups.find(g => g.id === id)!.lines.map(l => [l.label, Number(l.costUsd.toFixed(2))]);
    expect(group('engine')).toEqual([['Claude Code', 25.4]]);
    expect(group('model')).toEqual([['claude-opus-5-5', 24], ['gpt-6.1-sol', 1.4]]);
    expect(group('host')).toEqual([['clouddev', 20], ['__local__', 5.4]]);
    expect(group('project')).toEqual([['Walnut', 24], ['Mail', 1.4]]);
    expect(report.tasks!.map(t => [t.label, t.project, t.sessionId, t.hosts.sort()])).toEqual([
      ['Task t1', 'Walnut', 's1', ['__local__', 'clouddev']], ['Task t2', 'Mail', 's2', ['__local__']]]);
    expect(report.shortSessions).toBeUndefined();
  });

  it('adds Walnut to the coding agents in the whole picture, with every breakdown per day', async () => {
    response({ input_tokens: 1 * M });                                                         // Oct 20, t1 Walnut, $4
    response({ date: '2026-10-21', timestamp: '2026-10-21T18:00:00.000Z', input_tokens: 0, output_tokens: 1 * M, host: 'clouddev' }); // $20
    response({ model: 'gpt-6.1-sol', session_id: 's2', task_id: 't2', input_tokens: 100_000 });  // Oct 20, t2 Mail, $0.20
    response({ source: 'chat', session_id: 'c1', task_id: null, input_tokens: 1 * M });         // Walnut chat, $4
    trackerTable();
    call({ source: 'title', model: 'global.anthropic.claude-opus-5-5', input_tokens: 500_000 }); // Walnut title, $2
    await ready();
    const report = await buildCostReport('all', {}, deps());
    expect(report.view).toBe('all');
    expect(report.totals.costUsd).toBeCloseTo(30.2, 9);
    const lines = (id: string) => report.groups.find(g => g.id === id)!.lines.map(l => [l.label, Number(l.costUsd.toFixed(2))]);
    expect(report.groups.map(g => g.id)).toEqual(['agent', 'model', 'project', 'host', 'feature']);
    expect(lines('agent')).toEqual([['Claude Code', 24.2], ['Walnut', 6]]);
    // The routing prefix is not part of the name: Walnut's title call joins its model's line.
    expect(lines('model')).toEqual([['claude-opus-5-5', 30], ['gpt-6.1-sol', 0.2]]);
    expect(lines('project')).toEqual([['Walnut', 24], ['Walnut itself', 6], ['Mail', 0.2]]);
    expect(lines('host')).toEqual([['clouddev', 20], ['__local__', 10.2]]);
    // Each group's days add up to its lines and to the period's total.
    for (const g of report.groups.filter(g => g.id !== 'feature')) {
      const sum = g.daily.reduce((n, d) => n + Object.values(d.costs).reduce((a, b) => a + b, 0), 0);
      expect(sum).toBeCloseTo(report.totals.costUsd, 4);
      for (const line of g.lines) {
        expect(g.daily.reduce((n, d) => n + (d.costs[line.key] ?? 0), 0)).toBeCloseTo(line.costUsd, 4);
      }
    }
    const project = report.groups.find(g => g.id === 'project')!;
    expect(project.daily).toEqual([
      { date: '2026-10-20', costs: { Walnut: 4, __walnut__: 6, Mail: 0.2 } },
      { date: '2026-10-21', costs: { Walnut: 20 } },
    ]);
    // A one-request session under $1 folds into the short sessions, as in the agents view.
    expect(report.tasks!.map(t => t.label)).toEqual(['Task t1']);
    expect(report.shortSessions!.lines.map(l => l.label)).toEqual(['Task t2']);
    // The two older views keep their own shape, now with days too.
    const agents = await buildCostReport('agents', {}, deps());
    expect(agents.groups.map(g => g.id)).toEqual(['engine', 'model', 'host', 'project']);
    expect(agents.totals.costUsd).toBeCloseTo(24.2, 9);
    const walnut = await buildCostReport('walnut', {}, deps());
    expect(walnut.groups.map(g => g.id)).toEqual(['feature', 'model']);
    expect(walnut.totals.costUsd).toBeCloseTo(6, 9);
    expect(walnut.groups[0].daily).toEqual([{ date: '2026-10-20', costs: { chat: 4, title: 2 } }]);
  });

  it('keeps a filtered engine out of the whole picture and an empty period empty', async () => {
    response({ input_tokens: 1 * M });
    await ready();
    const all = await buildCostReport('all', { engine: 'codex' }, deps());
    expect(all.engine).toBeNull();
    expect(all.totals.costUsd).toBeCloseTo(4, 9);
    const none = await buildCostReport('all', { start: '2000-01-01', end: '2000-01-02' }, deps());
    expect(none.totals.requests).toBe(0);
    expect(none.groups.every(g => g.lines.length === 0 && g.daily.length === 0)).toBe(true);
  });

  it('folds tests and one-off sessions into one line, and names a session that has no task', async () => {
    for (let i = 0; i < 6; i++) response({ input_tokens: 1 * M });                           // t1: 6 requests, $24
    response({ session_id: 's3', task_id: 't3', input_tokens: 1_000 });                       // short: 1 request
    response({ session_id: 's9', task_id: null, input_tokens: 2_000 });                       // short, no task
    await ready();
    const report = await buildCostReport('agents', {}, deps());
    expect(report.tasks!.map(t => t.label)).toEqual(['Task t1']);
    expect(report.shortSessions).toMatchObject({ count: 2, requests: 2 });
    expect(report.shortSessions!.lines.map(l => l.label).sort()).toEqual(['A session with no task', 'Task t3']);
  });

  it('counts a model with no price and names it, without pricing it as zero silently', async () => {
    response({ model: 'mystery-model', input_tokens: 1 * M });
    response({ input_tokens: 1 * M });
    await ready();
    const report = await buildCostReport('agents', {}, deps());
    expect(report.totals.requests).toBe(2);
    expect(report.totals.unpriced).toBe(1);
    expect(report.unpricedModels).toEqual(['mystery-model']);
    expect(report.totals.costUsd).toBeCloseTo(4, 9);
  });

  it('prices cache writes by lifetime, a write with no 5m/1h split at the 5m rate', async () => {
    response({ input_tokens: 0, output_tokens: 0, cache_write_5m: 1 * M, cache_write_1h: 1 * M, cache_creation_tokens: 3 * M });
    await ready();
    const report = await buildCostReport('agents', {}, deps());
    // 1M at 5m ($5) + 1M at 1h ($8) + 1M unsplit at 5m ($5)
    expect(report.totals.costUsd).toBeCloseTo(18, 9);
    expect(report.totals.tokens.cacheWrite).toBe(3 * M);
  });

  it('keeps the sums right when an import updates a response it already had', async () => {
    response({ id: 'same', input_tokens: 1 * M });
    await ready();
    store.database.prepare('UPDATE response_usage SET input_tokens=? WHERE id=?').run(2 * M, 'same');
    await store.rollup.refreshPairs([{ sessionId: 's1', date: '2026-10-20' }, { sessionId: 's1', date: '2026-10-20' }]);
    const report = await buildCostReport('agents', {}, deps());
    expect(report.totals.requests).toBe(1);
    expect(report.totals.costUsd).toBeCloseTo(8, 9);
  });

  it('adds Codex and OpenCode sessions from their day-split scans and replaces them on the next scan', async () => {
    await ready();
    const owner = { sessionId: 'x1', host: '__local__', engine: 'codex', taskId: 't2', source: 'session' };
    const day = (d: string, input: number) => ({ day: d, model: 'gpt-6.1-sol', band: 0, responses: 1, input, output: 0, cacheRead: 0,
      cacheWrite5m: 0, cacheWrite1h: 0, cacheWrite: 0 });
    await store.rollup.replaceSession(owner, [day('2026-10-19', 1 * M), day('2026-10-20', 1 * M)]);
    await store.rollup.replaceSession(owner, [day('2026-10-19', 1 * M), day('2026-10-20', 2 * M)]);
    const all = await buildCostReport('agents', {}, deps());
    expect(all.groups.find(g => g.id === 'engine')!.lines.map(l => [l.label, l.costUsd])).toEqual([['Codex', 6]]);
    const oneDay = await buildCostReport('agents', { start: '2026-10-20', end: '2026-10-20' }, deps());
    expect(oneDay.totals.costUsd).toBeCloseTo(4, 9);
    expect(oneDay.daily).toEqual([{ date: '2026-10-20', costUsd: 4, requests: 1 }]);
  });

  it("shows Walnut's own calls by feature: chat from transcripts, the rest from the live tracker", async () => {
    trackerTable();
    response({ source: 'chat', session_id: 'c1', task_id: null, input_tokens: 1 * M });                  // chat $4
    call({ source: 'title', input_tokens: 1 * M });                                                       // $4
    call({ source: 'task-search-agent', model: 'house-model', input_tokens: 500, cost_usd: 0.3 });        // no list price: its own reported cost
    call({ source: 'jev', model: 'internal/jev', input_tokens: 0, output_tokens: 0, external_cost_usd: 0.05 }); // cost only
    call({ source: 'plugin', agent_id: 'plugin:mail', input_tokens: 100_000 });                           // $0.40
    call({ source: 'session', input_tokens: 10 * M });                                                   // a coding session: not here
    call({ source: 'chat', input_tokens: 10 * M });                                                      // chat's old turn records: not here
    await ready();
    const report = await buildCostReport('walnut', {}, deps());
    const features = report.groups.find(g => g.id === 'feature')!.lines.map(l => [l.label, Number(l.costUsd.toFixed(2))]);
    expect(features).toEqual([['Personal AI chat', 4], ['Titles', 4], ['Plugin: mail', 0.4], ['AI task search', 0.3], ['Decision checks', 0.05]]);
    expect(report.totals.costUsd).toBeCloseTo(8.75, 9);
    expect(report.unpricedModels).toEqual([]);
  });

  it('prices a bare Claude Code alias as the newest model of its family the price book has', async () => {
    resetPriceBookForTests({ ...SNAPSHOT, models: { ...SNAPSHOT.models,
      'claude-haiku-4-5': { provider: 'anthropic', input: 1, output: 5 },
      'claude-haiku-4-5-20251001': { provider: 'anthropic', input: 1, output: 5 },
      'claude-haiku-5-5': { provider: 'anthropic', input: 0.5, output: 2.5 },
      // Newer than 5-5 by number, older by string order: proves the versions are compared as numbers.
      'claude-haiku-5-10': { provider: 'anthropic', input: 0.1, output: 0.5 },
    } });
    trackerTable();
    call({ source: 'title', model: 'haiku', input_tokens: 1 * M });                 // as claude-haiku-5-10: $0.10
    call({ source: 'cron', model: 'haiku', input_tokens: 1 * M, cost_usd: 0.9 });  // the cost it reported wins: it knew what ran
    call({ source: 'summary', model: 'opus[1m]', input_tokens: 1 * M });            // as claude-opus-5-5: $4
    call({ source: 'task-hook', model: 'unknown', input_tokens: 10, output_tokens: 3_000 }); // no model name: no price
    call({ source: 'cron', model: 'unknown', input_tokens: 0, output_tokens: 0 });  // no tokens: nothing to price
    await ready();
    const report = await buildCostReport('walnut', {}, deps());
    expect(report.totals.costUsd).toBeCloseTo(5, 9);
    expect(report.groups.find(g => g.id === 'model')!.lines.map(l => [l.label, Number(l.costUsd.toFixed(2)), l.unpriced])).toEqual([
      ['opus[1m] (claude-opus-5-5)', 4, 0], ['haiku (claude-haiku-5-10)', 1, 0], ['unknown', 0, 1]]);
    expect(report.totals.unpriced).toBe(1);
    expect(report.unpricedModels).toEqual(['unknown']);
    expect(report.unpriced).toEqual([{ model: 'unknown', where: 'Task overview upkeep', requests: 1 }]);
  });

  it('counts one engine when asked, and still offers every engine of the period', async () => {
    response({ input_tokens: 1 * M });                                                            // Claude Code, t1: $4
    await ready();
    const codex = { sessionId: 'x1', host: 'devbox', engine: 'codex', taskId: 't2', source: 'session' };
    await store.rollup.replaceSession(codex, [{ day: '2026-10-19', model: 'gpt-6.1-sol', band: 0, responses: 2, input: 1 * M, output: 0,
      cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWrite: 0 }]);                         // Codex, t2: $2
    const all = await buildCostReport('agents', {}, deps());
    expect(all.engine).toBeNull();
    expect(all.totals.costUsd).toBeCloseTo(6, 9);
    expect(all.groups.map(g => g.id)).toEqual(['engine', 'model', 'host', 'project']);
    const only = await buildCostReport('agents', { engine: 'codex' }, deps());
    expect(only.engine).toBe('codex');
    expect(only.engines).toEqual([{ key: 'codex', label: 'Codex' }, { key: 'claude', label: 'Claude Code' }]);
    expect(only.totals).toMatchObject({ requests: 2 });
    expect(only.totals.costUsd).toBeCloseTo(2, 9);
    expect(only.daily).toEqual([{ date: '2026-10-19', costUsd: 2, requests: 2 }]);
    // One engine: no "By engine" group, and every other group holds only its sessions.
    expect(only.groups.map(g => g.id)).toEqual(['model', 'host', 'project']);
    expect(only.groups.find(g => g.id === 'model')!.lines.map(l => l.label)).toEqual(['gpt-6.1-sol']);
    expect(only.groups.find(g => g.id === 'host')!.lines.map(l => l.label)).toEqual(['devbox']);
    expect(only.tasks!.map(l => [l.label, l.engines, l.hosts])).toEqual([['Task t2', ['Codex'], ['devbox']]]);
    expect(only.shortSessions).toBeUndefined();
    expect((await buildCostReport('agents', { engine: 'opencode' }, deps())).totals.requests).toBe(0);
    // A malformed engine counts every engine; the Walnut view has none.
    expect((await buildCostReport('agents', { engine: "x'; DROP" }, deps())).engine).toBeNull();
    expect((await buildCostReport('walnut', { engine: 'codex' }, deps())).engine).toBeNull();
  });

  it('dates a call by the local day it happened, also late in the evening', async () => {
    trackerTable();
    call({ timestamp: '2026-10-21T03:30:00.000Z', input_tokens: 1 * M });        // 20:30 on 10-20 in Los Angeles
    await ready();
    const report = await buildCostReport('walnut', { start: '2026-10-20', end: '2026-10-20' }, deps());
    expect(report.daily).toEqual([{ date: '2026-10-20', costUsd: 4, requests: 1 }]);
    expect((await buildCostReport('walnut', { start: '2026-10-21', end: '2026-10-21' }, deps())).totals.requests).toBe(0);
  });

  it('says it is not ready until past usage is summed, and sums it in the background', async () => {
    response({ input_tokens: 1 * M });
    const first = await buildCostReport('agents', {}, deps());
    expect(first.ready).toBe(false);
    await store.rollup.backfill();
    const second = await buildCostReport('agents', {}, deps());
    expect(second.ready).toBe(true);
    expect(second.totals.costUsd).toBeCloseTo(4, 9);
  });

  it('finds the start of a local day across a DST change, and flattens long titles', () => {
    expect(localDayStartIso('2026-10-20', TZ)).toBe('2026-10-20T07:00:00.000Z');
    expect(localDayStartIso('2026-11-01', TZ)).toBe('2026-11-01T07:00:00.000Z');
    expect(localDayStartIso('2026-11-02', TZ)).toBe('2026-11-02T08:00:00.000Z');
    expect(localDayStartIso('2026-10-20', 'UTC')).toBe('2026-10-20T00:00:00.000Z');
    expect(oneLine('a\n\n  b')).toBe('a b');
    expect(oneLine('x'.repeat(300))).toHaveLength(120);
  });
  it('keeps summing imports after a restart, without waiting for the page to be opened', async () => {
    response({ input_tokens: 1 * M });
    await ready();
    store.close();
    store = new ResponseUsageStore(path.join(dir, 'usage.sqlite'));
    expect(store.rollup.isReady()).toBe(true);
    await importOne({ responseId: 'later', sessionId: 's1', timestamp: '2026-10-20T19:00:00.000Z', input_tokens: 1 * M });
    const report = await buildCostReport('agents', {}, deps());
    expect(report.totals.requests).toBe(2);
    expect(report.totals.costUsd).toBeCloseTo(8, 9);
  });

  it('moves a re-imported response out of its old day and session, never counting it twice', async () => {
    await ready();
    await importOne({ responseId: 'one', sessionId: 'sA', timestamp: '2026-10-20T18:00:00.000Z', input_tokens: 1 * M });
    await importOne({ responseId: 'one', sessionId: 'sB', timestamp: '2026-10-21T18:00:00.000Z', input_tokens: 1 * M });
    const report = await buildCostReport('agents', {}, deps());
    expect(report.totals.requests).toBe(1);
    expect(report.daily.map(d => d.date)).toEqual(['2026-10-21']);
    expect(store.rollup.query({ sources: ['session'], by: ['session'] }).map(r => r.sessionId)).toEqual(['sB']);
  });

  it('dates helper calls in a half-hour zone by their own local day', async () => {
    trackerTable();
    call({ timestamp: '2026-10-20T18:40:00.000Z', input_tokens: 1 * M });   // 00:10 on 10-21 in Kolkata (+05:30)
    call({ timestamp: '2026-10-20T18:20:00.000Z', input_tokens: 1 * M });   // 23:50 on 10-20
    await ready();
    const report = await buildCostReport('walnut', { start: '2026-10-21', end: '2026-10-21' }, deps({ timeZone: 'Asia/Kolkata' }));
    expect(report.daily).toEqual([{ date: '2026-10-21', costUsd: 4, requests: 1 }]);
  });

  it('builds with the thresholds it started with when they change during the build', async () => {
    response({ input_tokens: 150_000 });
    store.rollup.setThresholds([100_000]);
    const building = store.rollup.backfill();
    await new Promise(resolve => setImmediate(resolve)); // the build has read its first batch
    store.rollup.setThresholds([200_000]);
    await building;
    expect(store.rollup.isReady()).toBe(false);
    await store.rollup.backfill();
    expect(store.rollup.isReady()).toBe(true);
    expect(store.rollup.query({ sources: ['session'], by: [] }).map(r => r.band)).toEqual([0]);
  });
});

async function importOne(r: { responseId: string; sessionId: string; timestamp: string; input_tokens: number }) {
  const records: CanonicalUsageRecord[] = [{ ...r, model: 'claude-opus-5-5', output_tokens: 0, cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0, complete: true, speed: 'standard', inference_geo: '', service_tier: 'standard', pricing_context_complete: true }];
  await store.importHost('__local__', {
    canonical: { records, diagnostics: {} as never, costStates: [] },
    upstream: { records: [], diagnostics: [], coverage: {} as never },
    reconciliation: reconcileUsage(records, []), until: r.timestamp,
  }, [{ sessionId: r.sessionId, taskId: 't1', project: 'Walnut', title: 'x' }]);
}

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ResponseUsageStore } from '../../../src/core/usage/response-store.js';
import { collectOutsideCodex, outsideHosts, type OutsideReader } from '../../../src/core/usage/outside-codex.js';
import { buildCostReport, type CostReportDeps } from '../../../src/core/usage/cost-report.js';
import { priceThresholds, resetPriceBookForTests } from '../../../src/core/usage/price-book.js';
import type { PriceSnapshot } from '../../../src/core/usage/price-data.js';
import { scanCodexOutside } from '../../../src/providers/codex-outside-core.js';

const SNAPSHOT: PriceSnapshot = {
  source: 'litellm', url: '', fetchedAt: '2026-10-20T00:00:00.000Z',
  models: {
    'claude-opus-5-5': { provider: 'anthropic', input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 },
    'gpt-6.1-sol': { provider: 'openai', input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  },
};
const TZ = 'America/Los_Angeles';
const M = 1_000_000;

let dir: string, home: string, store: ResponseUsageStore;

/**
 * One run per page whatever the machine's speed. A page's budget is measured on Date.now, and a
 * fast machine reads these small files in under a millisecond, so a tiny budget alone let a page
 * read every run (2026-11-05, the push gate on GitHub's runners: no resume point was left). Each
 * read of the clock during the scan moves it on by one millisecond, so the page stops after its
 * first run.
 */
async function scanOnePerPage(p: Parameters<OutsideReader['readCodexOutside']>[0]) {
  const real = Date.now;
  let t = real();
  Date.now = () => (t += 1);
  try { return await scanCodexOutside({ ...p, codexHome: home, budgetMs: 0.0001 }); } finally { Date.now = real; }
}

function meta(id: string, over: Record<string, unknown> = {}) {
  return { timestamp: '2026-11-04T10:00:00.000Z', type: 'session_meta', payload: { id, cwd: '/work/marina/src', originator: 'codex_exec', model_provider: 'amazon-bedrock', ...over } };
}
function count(total: number, input: number, cached: number, output: number, at: string) {
  return { timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total },
    last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } };
}
const ctx = { timestamp: '2026-11-04T10:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-6.1-sol' } };
function rollout(id: string, rows: unknown[], day = '2026-11-04') {
  const [y, m, d] = day.split('-');
  const file = path.join(home, 'sessions', y, m, d, `rollout-${day}T10-00-00-${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

/** The daemon, in process: the real scan against the temp Codex home. */
const reader = (calls: unknown[] = []): ((host: string) => OutsideReader) => () => ({
  readCodexOutside: async (params) => { calls.push(params); return scanCodexOutside({ ...params, codexHome: home }); },
});

function deps(over: Partial<CostReportDeps> = {}): CostReportDeps {
  return { rollup: store.rollup, db: store.database, timeZone: TZ,
    tasks: async (ids) => new Map(ids.map(id => [id, { title: `Task ${id}`, project: 'Walnut' }])),
    sessions: async () => new Map([['walnut-codex', { title: 'A Walnut Codex session', taskId: 't1', engine: 'codex' }]]), ...over };
}

async function collect(over: Partial<Parameters<typeof collectOutsideCodex>[0]> = {}) {
  return collectOutsideCodex({ rollup: store.rollup, hosts: ['__local__'], knownIds: () => [], timeZone: TZ, reader: reader(), ...over });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-codex-'));
  home = path.join(dir, 'codex');
  store = new ResponseUsageStore(path.join(dir, 'usage.sqlite'));
  resetPriceBookForTests(SNAPSHOT);
  store.rollup.setThresholds(priceThresholds());
});
afterEach(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); resetPriceBookForTests(); });

describe('codex runs outside Walnut', () => {
  it('stores a codex exec run, attributes it to its folder or task, and tells its account', async () => {
    rollout('exec1', [meta('exec1'), ctx, count(1_000, 1 * M, 0, 0, '2026-11-04T18:00:00.000Z')]);
    rollout('task1', [meta('task1', { cwd: '/home/u/.local/state/open-walnut/tasks/mv96n5cs-5181/work', model_provider: 'bp' }), ctx,
      count(500, 1 * M, 0, 0, '2026-11-04T19:00:00.000Z')]);
    const result = await collect();
    expect(result).toMatchObject({ hosts: 1, runs: 2, failed: 0 });
    const report = await buildCostReport('all', {}, deps());
    expect(report.totals.costUsd).toBeCloseTo(4, 9); // 2 x 1M input at $2
    expect(report.groups.find(g => g.id === 'account')!.lines.map(l => [l.label, l.costUsd])).toEqual(expect.arrayContaining([['Bedrock account', 2], ['Proxy: bp', 2]]));
    expect(report.accounts!.map(a => [a.key, a.direct, a.outsideRequests])).toEqual([['amazon-bedrock', true, 1], ['bp', false, 1]]);
    const lines = Object.fromEntries(report.tasks!.map(t => [t.key, t]));
    expect(lines['task:mv96n5cs-5181']).toMatchObject({ label: 'Task mv96n5cs-5181' });
    const folder = report.tasks!.find(t => t.key.startsWith('dir:'))!;
    expect(folder.label).toBe('Codex exec in marina/src');
    expect(report.groups.find(g => g.id === 'kind')!.lines.map(l => l.key)).toEqual(['outside']);
    expect(report.groups.find(g => g.id === 'project')!.lines.map(l => l.label).sort()).toEqual(['Walnut', 'marina/src']);
  });

  it('never counts a run twice: not a Walnut session, not a rescan; a Walnut child thread is counted once and is not outside', async () => {
    const day = { day: '2026-11-04', model: 'gpt-6.1-sol', band: 0, responses: 1, input: 1 * M, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWrite: 0 };
    // The run behind a Walnut Codex session, with its own rows already stored but its record gone from the known ids.
    await store.rollup.replaceSession({ sessionId: 'walnut-codex', host: '__local__', engine: 'codex', taskId: 't1', source: 'session' }, [day]);
    rollout('walnut-codex', [meta('walnut-codex', { originator: 'open-walnut' }), ctx, count(1_000, 1 * M, 0, 0, '2026-11-04T18:00:00.000Z')]);
    // A child thread Codex made inside a Walnut run: no session record, so its rows come from here.
    rollout('child', [meta('child', { originator: 'open-walnut', model_provider: 'local-proxy', cwd: '/home/u/open-walnut/tasks/mv96n5cs-5181' }), ctx,
      count(1_000, 1 * M, 0, 0, '2026-11-04T18:00:00.000Z')]);
    rollout('exec1', [meta('exec1'), ctx, count(1_000, 1 * M, 0, 0, '2026-11-04T18:00:00.000Z')]);
    await collect();
    await collect(); // a second pass reads the same files again
    const report = await buildCostReport('all', {}, deps());
    expect(report.totals.requests).toBe(3); // the Walnut session's row, the child thread and exec1, once each
    expect(report.totals.costUsd).toBeCloseTo(6, 9);
    expect(report.started.outside.requests).toBe(1); // exec1 only
    expect(report.started.walnut.requests).toBe(2);
    // The skipped Walnut session still gets its account: its rollout says which one it went through.
    expect(report.accounts!.map(a => [a.key, a.requests, a.outsideRequests]).sort()).toEqual([['amazon-bedrock', 2, 1], ['local-proxy', 1, 0]]);
    expect(store.rollup.origins().get('__local__\u0000walnut-codex')).toMatchObject({ outside: false, provider: 'amazon-bedrock' });
  });

  it('reads incrementally after the first pass, reads everything again when the price bands change, and keeps the history of a removed file', async () => {
    rollout('old', [meta('old'), ctx, count(100, 1 * M, 0, 0, '2026-10-01T18:00:00.000Z')], '2026-10-01');
    const oldFile = path.join(home, 'sessions', '2026', '10', '01', 'rollout-2026-10-01T10-00-00-old.jsonl');
    fs.utimesSync(oldFile, new Date('2026-10-01T20:00:00Z'), new Date('2026-10-01T20:00:00Z'));
    const first: unknown[] = [];
    await collect({ reader: reader(first), now: () => new Date('2026-11-04T20:00:00.000Z') });
    expect(first[0]).not.toHaveProperty('since');
    rollout('fresh', [meta('fresh'), ctx, count(100, 1 * M, 0, 0, '2026-11-04T21:00:00.000Z')]);
    const second: unknown[] = [];
    await collect({ reader: reader(second), now: () => new Date('2026-11-04T22:00:00.000Z') });
    expect((second[0] as { since: string }).since).toBe('2026-11-04T18:00:00.000Z'); // last pass start less two hours
    fs.rmSync(oldFile);
    const third: unknown[] = [];
    store.rollup.setThresholds([...priceThresholds(), 123_456]);
    await collect({ reader: reader(third), now: () => new Date('2026-11-04T23:00:00.000Z') });
    expect(third[0]).not.toHaveProperty('since'); // the bands changed: everything again
    store.rollup.setThresholds(priceThresholds());
    const report = await buildCostReport('agents', {}, deps());
    expect(report.totals.requests).toBe(2); // the removed file's day is kept
  });

  it('survives a host that has no support, one that fails, and a host with no runs', async () => {
    const unsupported: (h: string) => OutsideReader = () => ({ readCodexOutside: async () => null });
    expect(await collect({ reader: unsupported })).toMatchObject({ hosts: 0, failed: 0 });
    const broken: (h: string) => OutsideReader = () => ({ readCodexOutside: async () => { throw new Error('tunnel down'); } });
    expect(await collect({ reader: broken })).toMatchObject({ hosts: 0, failed: 1 });
    expect(await collect()).toMatchObject({ hosts: 1, runs: 0, failed: 0 });
    // A failed host is read in full next time: nothing was marked scanned.
    expect(store.rollup.outsideScan('__local__').at).not.toBe('');
  });

  it('follows pages until the daemon says it is done', async () => {
    for (let i = 1; i <= 4; i++) rollout(`p${i}`, [meta(`p${i}`), ctx, count(100, 1 * M, 0, 0, `2026-11-0${i}T18:00:00.000Z`)], `2026-11-0${i}`);
    const pages: unknown[] = [];
    const tiny: (h: string) => OutsideReader = () => ({ readCodexOutside: async (p) => { pages.push(p); return scanOnePerPage(p); } });
    const result = await collect({ reader: tiny });
    expect(result.runs).toBe(4);
    expect(pages.length).toBeGreaterThan(1);
  });
});

describe('runs that change after they were first stored', () => {
  it('rereads a Walnut child thread that grew, and never rereads a Walnut session\'s own rows', async () => {
    rollout('child', [meta('child', { originator: 'open-walnut', model_provider: 'local-proxy' }), ctx, count(1_000, 1 * M, 0, 0, '2026-11-04T18:00:00.000Z')]);
    await collect();
    rollout('child', [meta('child', { originator: 'open-walnut', model_provider: 'local-proxy' }), ctx, count(1_000, 1 * M, 0, 0, '2026-11-04T18:00:00.000Z'),
      count(3_000, 1 * M, 0, 0, '2026-11-04T19:00:00.000Z')]);
    await collect();
    const report = await buildCostReport('agents', {}, deps());
    expect(report.totals.requests).toBe(2);
    expect(report.totals.costUsd).toBeCloseTo(4, 9);
    expect(store.rollup.origins().get('__local__\u0000child')).toMatchObject({ outside: false, stored: true });
  });

  it('does not add a run on a day a bill brought in from outside already covers', async () => {
    await store.rollup.backfill();
    await store.rollup.replaceImport('Cloud usage bill', [{ date: '2026-10-01', model: 'gpt-6.1-sol', input: 5 * M, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }]);
    rollout('old', [meta('old'), ctx, count(100, 1 * M, 0, 0, '2026-10-01T18:00:00.000Z')], '2026-10-01');
    rollout('new', [meta('new'), ctx, count(100, 1 * M, 0, 0, '2026-11-04T18:00:00.000Z')]);
    await collect();
    const report = await buildCostReport('all', {}, deps());
    expect(report.totals.costUsd).toBeCloseTo(10 + 2, 9); // the bill's day once, the new run once
  });

  it('counts a terminal run Walnut imported as a session record as outside Walnut, not as Walnut work', async () => {
    const day = { day: '2026-11-04', model: 'gpt-6.1-sol', band: 0, responses: 1, input: 1 * M, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWrite: 0 };
    await store.rollup.replaceSession({ sessionId: 'tui1', host: '__local__', engine: 'codex', taskId: null, source: 'session' }, [day]);
    rollout('tui1', [meta('tui1', { originator: 'codex-tui' }), ctx, count(1_000, 1 * M, 0, 0, '2026-11-04T18:00:00.000Z')]);
    await collect({ knownIds: () => ['tui1'] });
    expect(store.rollup.origins().get('__local__\u0000tui1')).toMatchObject({ outside: true, stored: false });
    const report = await buildCostReport('all', {}, deps());
    expect(report.totals.requests).toBe(1); // its rows stay the session record's, once
    expect(report.started.outside.requests).toBe(1);
    expect(report.started.walnut.requests).toBe(0);
  });

  it('keeps a direct OpenAI run on a day an imported cloud bill covers, and drops a cloud-account one', async () => {
    await store.rollup.backfill();
    await store.rollup.replaceImport('Cloud usage bill', [{ date: '2026-10-01', model: 'gpt-6.1-sol', input: 5 * M, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }]);
    rollout('cloud', [meta('cloud'), ctx, count(100, 1 * M, 0, 0, '2026-10-01T18:00:00.000Z')], '2026-10-01');
    rollout('direct', [meta('direct', { model_provider: 'openai' }), ctx, count(100, 1 * M, 0, 0, '2026-10-01T18:00:00.000Z')], '2026-10-01');
    await collect();
    const report = await buildCostReport('all', {}, deps());
    expect(report.totals.costUsd).toBeCloseTo(10 + 2, 9); // the bill's day, plus the OpenAI run it cannot hold
    expect(report.accounts!.map(a => a.key)).toEqual(['openai']);
  });

  it('does not let a stored outside run pull an import cutoff back: the same bill imported again keeps its amount', async () => {
    await store.rollup.backfill();
    const bill = [{ date: '2026-10-01', model: 'gpt-6.1-sol', input: 5 * M, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }];
    await store.rollup.replaceImport('Cloud usage bill', bill);
    rollout('direct', [meta('direct', { model_provider: 'openai' }), ctx, count(100, 1 * M, 0, 0, '2026-10-01T18:00:00.000Z')], '2026-10-01');
    await collect();
    expect(await store.rollup.replaceImport('Cloud usage bill', bill)).toMatchObject({ stored: 1, skipped: 0 });
    const report = await buildCostReport('all', {}, deps());
    expect(report.totals.costUsd).toBeCloseTo(10 + 2, 9);
  });

  it('reads a file again that could not be read, until it fails three passes in a row', async () => {
    rollout('exec1', [meta('exec1'), ctx, count(1_000, 1 * M, 0, 0, '2026-11-04T18:00:00.000Z')]);
    const flaky: (h: string) => OutsideReader = () => ({ readCodexOutside: async (p) => ({ ...(await scanCodexOutside({ ...p, codexHome: home })), failed: ['rollout-x.jsonl'] }) });
    expect(await collect({ reader: flaky })).toMatchObject({ hosts: 0, failed: 1 });
    expect(store.rollup.outsideScan('__local__').at).toBe('');
    expect(await collect({ reader: flaky })).toMatchObject({ hosts: 0, failed: 1 });
    expect(await collect({ reader: flaky })).toMatchObject({ hosts: 1, failed: 0 }); // the third miss in a row is left behind
    expect(store.rollup.outsideScan('__local__').at).not.toBe('');
    expect(await collect()).toMatchObject({ hosts: 1, failed: 0 });
    expect(store.rollup.outsideMisses('__local__')).toEqual({});
  });
});

describe('days a bill covers and files a pass could not read', () => {
  it('adds a run on a day the bill does not cover, also between two billed days', async () => {
    await store.rollup.backfill();
    const bill = (date: string) => ({ date, model: 'gpt-6.1-sol', input: 5 * M, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
    await store.rollup.replaceImport('Cloud usage bill', [bill('2026-10-01'), bill('2026-10-03')]);
    rollout('on-bill', [meta('on-bill'), ctx, count(100, 1 * M, 0, 0, '2026-10-01T18:00:00.000Z')], '2026-10-01');
    rollout('in-gap', [meta('in-gap'), ctx, count(100, 1 * M, 0, 0, '2026-10-02T18:00:00.000Z')], '2026-10-02');
    await collect();
    const report = await buildCostReport('all', {}, deps());
    expect(report.totals.costUsd).toBeCloseTo(10 + 10 + 2, 9); // two billed days, and the one run in the gap
  });

  it('remembers a file it could not read across a pass the time budget cut short', async () => {
    for (let i = 1; i <= 3; i++) rollout(`r${i}`, [meta(`r${i}`), ctx, count(100, 1 * M, 0, 0, `2026-11-0${i}T18:00:00.000Z`)], `2026-11-0${i}`);
    let page = 0;
    const flaky: (h: string) => OutsideReader = () => ({ readCodexOutside: async (p) => {
      const scan = await scanOnePerPage(p);
      return page++ === 0 ? { ...scan, failed: ['rollout-old.jsonl'] } : scan; // the first page could not read one file
    } });
    await collect({ reader: flaky, passBudgetMs: 0 });
    expect(store.rollup.outsideResume('__local__')?.unreadable).toEqual(['rollout-old.jsonl']);
    for (let pass = 0; pass < 6 && store.rollup.outsideResume('__local__'); pass++) await collect({ reader: flaky, passBudgetMs: 0 });
    // The pass finished, but a file went unread: the watermark did not move.
    expect(store.rollup.outsideScan('__local__').at).toBe('');
    expect(store.rollup.outsideMisses('__local__')).toEqual({ 'rollout-old.jsonl': 1 });
  });

  it('counts the misses per file: three different files failing once each do not give any of them up', async () => {
    rollout('exec1', [meta('exec1'), ctx, count(1_000, 1 * M, 0, 0, '2026-11-04T18:00:00.000Z')]);
    const failing = (name: string): ((h: string) => OutsideReader) => () => ({ readCodexOutside: async (p) => ({ ...(await scanCodexOutside({ ...p, codexHome: home })), failed: [name] }) });
    for (const name of ['a.jsonl', 'b.jsonl', 'c.jsonl']) expect(await collect({ reader: failing(name) })).toMatchObject({ hosts: 0, failed: 1 });
    expect(store.rollup.outsideScan('__local__').at).toBe('');
    // Only the file that keeps failing is given up, on its third miss in a row.
    await collect({ reader: failing('c.jsonl') });
    expect(await collect({ reader: failing('c.jsonl') })).toMatchObject({ hosts: 1, failed: 0 });
    expect(store.rollup.outsideScan('__local__').at).not.toBe('');
  });

  it('marks a host as read with the bands the pass read with, not those of the moment it finished', async () => {
    rollout('exec1', [meta('exec1'), ctx, count(1_000, 1 * M, 0, 0, '2026-11-04T18:00:00.000Z')]);
    const before = store.rollup.key;
    const changing: (h: string) => OutsideReader = () => ({ readCodexOutside: async (p) => {
      store.rollup.setThresholds([...priceThresholds(), 123_456]); // the price list changed while the pass ran
      return scanCodexOutside({ ...p, codexHome: home });
    } });
    await collect({ reader: changing });
    expect(store.rollup.outsideScan('__local__').key).toBe(before);
    const seen: unknown[] = [];
    await collect({ reader: reader(seen) });
    expect(seen[0]).not.toHaveProperty('since'); // read in full again with the new bands
  });

  it('shows the runs on days a bill no longer covers, with no new read', async () => {
    await store.rollup.backfill();
    const bill = (date: string) => ({ date, model: 'gpt-6.1-sol', input: 5 * M, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
    await store.rollup.replaceImport('Cloud usage bill', [bill('2026-10-01')]);
    rollout('on-bill', [meta('on-bill'), ctx, count(100, 1 * M, 0, 0, '2026-10-01T18:00:00.000Z')], '2026-10-01');
    await collect();
    expect((await buildCostReport('all', {}, deps())).totals.costUsd).toBeCloseTo(10, 9); // the bill's day only
    await store.rollup.replaceImport('Cloud usage bill', []); // the bill no longer covers that day
    expect((await buildCostReport('all', {}, deps())).totals.costUsd).toBeCloseTo(2, 9); // the run was stored all along
  });

  it('writes a run\'s origin before its rows, so a crash between them leaves a run the next pass still updates', async () => {
    rollout('exec1', [meta('exec1'), ctx, count(1_000, 1 * M, 0, 0, '2026-11-04T18:00:00.000Z')]);
    const original = store.rollup.replaceSession.bind(store.rollup);
    store.rollup.replaceSession = async () => { throw new Error('process died before the rows'); };
    await collect();
    store.rollup.replaceSession = original;
    expect(store.rollup.origins().get('__local__\u0000exec1')).toMatchObject({ stored: true, outside: true });
    rollout('exec1', [meta('exec1'), ctx, count(1_000, 1 * M, 0, 0, '2026-11-04T18:00:00.000Z'), count(2_000, 1 * M, 0, 0, '2026-11-04T19:00:00.000Z')]);
    await collect();
    expect((await buildCostReport('agents', {}, deps())).totals.requests).toBe(2);
  });
});

describe('a pass cut short by its time budget', () => {
  it('goes on from its cursor in the next collection and reads every run once', async () => {
    for (let i = 1; i <= 6; i++) rollout(`r${i}`, [meta(`r${i}`), ctx, count(100, 1 * M, 0, 0, `2026-11-0${i}T18:00:00.000Z`)], `2026-11-0${i}`);
    const asked: { cursor?: string; since?: string }[] = [];
    const slow: (h: string) => OutsideReader = () => ({ readCodexOutside: async (p) => {
      asked.push({ cursor: p.cursor, since: p.since });
      return scanOnePerPage(p); // one run per page
    } });
    // A pass budget of zero stops after the first page; each collection moves on.
    for (let pass = 0; pass < 8 && store.rollup.outsideScan('__local__').at === ''; pass++) {
      await collect({ reader: slow, passBudgetMs: 0 });
    }
    expect(store.rollup.outsideScan('__local__').at).not.toBe('');
    expect(store.rollup.outsideResume('__local__')).toBeUndefined();
    const cursors = asked.map(a => a.cursor);
    expect(cursors[0]).toBeUndefined();
    expect(new Set(cursors).size).toBe(cursors.length); // no page was asked twice
    const report = await buildCostReport('agents', {}, deps());
    expect(report.totals.requests).toBe(6);
  });

  it('starts over when the price bands changed while a pass was half done', async () => {
    for (let i = 1; i <= 3; i++) rollout(`r${i}`, [meta(`r${i}`), ctx, count(100, 1 * M, 0, 0, `2026-11-0${i}T18:00:00.000Z`)], `2026-11-0${i}`);
    const slow: (h: string) => OutsideReader = () => ({ readCodexOutside: async (p) => scanOnePerPage(p) });
    await collect({ reader: slow, passBudgetMs: 0 });
    expect(store.rollup.outsideResume('__local__')).toBeDefined();
    store.rollup.setThresholds([...priceThresholds(), 123_456]);
    const seen: unknown[] = [];
    await collect({ reader: reader(seen) });
    expect(seen[0]).not.toHaveProperty('cursor');
  });

  it('reads the hosts of every session whatever its engine, and the configured ones, once each', () => {
    expect(outsideHosts(['__local__'], ['devbox', '__local__'], ['cloudbox', 'devbox'])).toEqual(['__local__', 'devbox', 'cloudbox']);
  });
});

describe('started by Walnut or not', () => {
  async function seed() {
    await store.rollup.backfill(); // Claude rows are rebuilt from the response table: seed after it, not before
    rollout('exec1', [meta('exec1'), ctx, count(1_000, 1 * M, 0, 0, '2026-11-04T18:00:00.000Z')]);
    await collect();
    const day = { day: '2026-11-04', model: 'gpt-6.1-sol', band: 0, responses: 1, input: 3 * M, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWrite: 0 };
    await store.rollup.replaceSession({ sessionId: 'walnut-codex', host: '__local__', engine: 'codex', taskId: 't1', source: 'session' }, [day]);
    // A Claude session with no task and no record (its task was deleted) is still Walnut's, never taken for outside work.
    const claude = { ...day, model: 'claude-opus-5-5', input: 1 * M };
    await store.rollup.replaceSession({ sessionId: 'orphan-claude', host: '__local__', engine: 'claude', taskId: null, source: 'session' }, [claude]);
    await store.rollup.replaceSession({ sessionId: 'chat1', host: '__local__', engine: 'claude', taskId: null, source: 'chat' }, [{ ...claude, input: 2 * M }]);
  }

  it('counts both by default and says what each origin cost', async () => {
    await seed();
    const report = await buildCostReport('all', {}, deps());
    expect(report.origin).toBe('all');
    expect(report.started.outside.costUsd).toBeCloseTo(2, 9); // exec1
    expect(report.started.walnut.costUsd).toBeCloseTo(6 + 4 + 8, 9); // the Walnut Codex session, the orphan Claude session and Walnut's own chat
    expect(report.totals.costUsd).toBeCloseTo(20, 9); // 2 + 6 + 4 + 8
  });

  it('narrows to one origin and keeps the other origin\'s amount in view', async () => {
    await seed();
    const outside = await buildCostReport('all', { origin: 'outside' }, deps());
    expect(outside.origin).toBe('outside');
    expect(outside.totals.costUsd).toBeCloseTo(2, 9);
    expect(outside.started.walnut.costUsd).toBeCloseTo(18, 9);
    expect(outside.groups.find(g => g.id === 'kind')!.lines.map(l => l.key)).toEqual(['outside']);
    expect(outside.accounts!.map(a => a.key)).toEqual(['amazon-bedrock']);
    const walnut = await buildCostReport('all', { origin: 'walnut' }, deps());
    expect(walnut.totals.costUsd).toBeCloseTo(18, 9);
    expect(walnut.groups.find(g => g.id === 'kind')!.lines.map(l => l.key).sort()).toEqual(['interactive', 'walnut']);
    // The agents view filters the same way.
    const agents = await buildCostReport('agents', { origin: 'outside' }, deps());
    expect(agents.totals.costUsd).toBeCloseTo(2, 9);
    expect(agents.tasks!.map(t => t.key)).toEqual(['dir:__local__:/work/marina/src']);
  });
});

describe('origin filter and the notes about what could not be priced', () => {
  it('keeps a bill brought in from outside under All only, and counts it in the amounts', async () => {
    await store.rollup.backfill();
    await store.rollup.replaceImport('Cloud usage bill', [{ date: '2026-10-01', model: 'claude-opus-5-5', input: 2_500_000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }]);
    const all = await buildCostReport('all', {}, deps());
    expect(all.totals.costUsd).toBeCloseTo(10, 9);
    expect(all.started.imported.costUsd).toBeCloseTo(10, 9);
    expect(all.started.walnut.costUsd + all.started.outside.costUsd + all.started.imported.costUsd).toBeCloseTo(all.totals.costUsd, 9);
    for (const origin of ['walnut', 'outside'] as const) {
      const narrowed = await buildCostReport('all', { origin }, deps());
      expect(narrowed.totals.costUsd).toBe(0);
      expect(narrowed.started.imported.costUsd).toBeCloseTo(10, 9); // still named, so the filter shows what it leaves out
    }
  });

  it('names a model with no price only when the filter counts its request', async () => {
    rollout('exec1', [meta('exec1'), ctx, count(1_000, 1 * M, 0, 0, '2026-11-04T18:00:00.000Z')]);
    await collect();
    await store.rollup.backfill();
    const day = { day: '2026-11-04', model: 'internal-model', band: 0, responses: 3, input: 1000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWrite: 0 };
    await store.rollup.replaceSession({ sessionId: 'walnut-codex', host: '__local__', engine: 'codex', taskId: 't1', source: 'session' }, [day]);
    const all = await buildCostReport('agents', {}, deps());
    expect(all.unpricedModels).toEqual(['internal-model']);
    expect(all.totals.unpriced).toBe(3);
    const outside = await buildCostReport('agents', { origin: 'outside' }, deps());
    expect(outside.unpricedModels).toEqual([]);
    expect(outside.unpriced).toEqual([]);
    expect(outside.totals.unpriced).toBe(0);
    const walnut = await buildCostReport('agents', { origin: 'walnut' }, deps());
    expect(walnut.unpricedModels).toEqual(['internal-model']);
  });
});

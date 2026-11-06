import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ResponseUsageStore } from '../../../src/core/usage/response-store.js';
import { buildCostReport, type CostReportDeps } from '../../../src/core/usage/cost-report.js';
import { uniqueDirectoryLabels } from '../../../src/core/usage/codex-account.js';
import { classifyClaudeOutside } from '../../../src/core/usage/outside-claude.js';
import { priceThresholds, resetPriceBookForTests } from '../../../src/core/usage/price-book.js';
import type { PriceSnapshot } from '../../../src/core/usage/price-data.js';

const SNAPSHOT: PriceSnapshot = {
  source: 'litellm', url: '', fetchedAt: '2026-10-20T00:00:00.000Z',
  models: { 'claude-opus-5-5': { provider: 'anthropic', input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 } },
};
const TZ = 'America/Los_Angeles';
const M = 1_000_000;

let dir: string, store: ResponseUsageStore, n = 0;

function response(session: string, date: string, over: Partial<Record<string, unknown>> = {}) {
  n += 1;
  store.database.prepare(`INSERT INTO response_usage (id, host, response_id, timestamp, date, source, model, session_id, task_id, project,
    title, agent_id, input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h, estimate_usd, verification,
    pricing_version, cache_creation_tokens) VALUES (@id,@host,@response_id,@timestamp,@date,@source,@model,@session_id,@task_id,
    @project,@title,@agent_id,@input_tokens,@output_tokens,@cache_read_tokens,@cache_write_5m,@cache_write_1h,@estimate_usd,
    @verification,@pricing_version,@cache_creation_tokens)`).run({ id: `r${n}`, host: '__local__', response_id: `resp${n}`, timestamp: `${date}T18:00:00.000Z`, date,
    source: 'session', model: 'claude-opus-5-5', session_id: session, task_id: null, project: null, title: null, agent_id: 'main', input_tokens: 1 * M,
    output_tokens: 0, cache_read_tokens: 0, cache_write_5m: 0, cache_write_1h: 0, estimate_usd: null, verification: 'unverified', pricing_version: 'x',
    cache_creation_tokens: 0, ...over });
}

function deps(): CostReportDeps {
  return { rollup: store.rollup, db: store.database, timeZone: TZ, tasks: async () => new Map(), sessions: async () => new Map() };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-claude-'));
  store = new ResponseUsageStore(path.join(dir, 'usage.sqlite'));
  resetPriceBookForTests(SNAPSHOT);
  store.rollup.setThresholds(priceThresholds());
});
afterEach(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); resetPriceBookForTests(); });

const classify = (metas: { sessionId: string; entrypoint: string; cwd: string }[], known: string[] = []) =>
  classifyClaudeOutside({ rollup: store.rollup, host: '__local__', metas, known: new Map(known.map(id => [id, '__local__'])), hasRows: id => store.hasSession(id) });

describe('Claude Code sessions outside Walnut', () => {
  it('a known session on a Walnut entrypoint (a helper call turned into a task, an SDK server run) is Walnut\'s, also over an older build\'s outside look', async () => {
    store.rollup.recordOrigins([{ host: '__local__', sessionId: 'kept-bad', originator: 'sdk-cli', provider: '', cwd: '/w', outside: true, stored: true, firstAt: '', lastAt: '' }]);
    classify([
      { sessionId: 'helper-task', entrypoint: 'walnut-utility', cwd: '/tmp/x' },
      { sessionId: 'sdk-server', entrypoint: 'sdk-ts', cwd: '/w' },
      { sessionId: 'kept-bad', entrypoint: 'sdk-cli', cwd: '/w' },
      { sessionId: 'terminal', entrypoint: 'cli', cwd: '/w' },
    ], ['helper-task', 'sdk-server', 'kept-bad', 'terminal']);
    const out = (id: string) => store.rollup.originOf('__local__', id);
    expect(out('helper-task')?.outside).toBeFalsy();
    expect(out('sdk-server')?.outside).toBeFalsy();
    expect(out('kept-bad')).toMatchObject({ outside: false, stored: false });
    expect(out('terminal')?.outside).toBe(true);
  });

  it('a session Walnut has no record of is outside; a record-less one with usage already stored stays Walnut\'s; a known claude -p session is Walnut\'s', async () => {
    response('old-deleted', '2026-10-20');
    classify([
      { sessionId: 'fresh', entrypoint: 'sdk-cli', cwd: '/work/marina' },
      { sessionId: 'old-deleted', entrypoint: 'sdk-cli', cwd: '/work/marina' },
      { sessionId: 'walnut-run', entrypoint: 'sdk-cli', cwd: '/work/marina' },
      { sessionId: 'terminal-imported', entrypoint: 'cli', cwd: '/work/marina' },
    ], ['walnut-run', 'terminal-imported']);
    const o = (id: string) => store.rollup.originOf('__local__', id);
    expect(o('fresh')).toMatchObject({ outside: true, stored: true, originator: 'sdk-cli' });
    expect(o('old-deleted')).toMatchObject({ outside: false });
    // A known session claude -p started is Walnut's own, so it needs no origin; a known terminal one was imported.
    expect(o('walnut-run')).toMatchObject({ outside: false });
    expect(o('terminal-imported')).toMatchObject({ outside: true, stored: true, originator: 'cli' });
  });

  it('the first look is kept: usage stored for the session afterwards does not turn it into Walnut\'s', async () => {
    classify([{ sessionId: 'fresh', entrypoint: 'cli', cwd: '/work/marina' }]);
    response('fresh', '2026-10-20');
    const owners = classify([{ sessionId: 'fresh', entrypoint: 'cli', cwd: '/work/marina' }]);
    expect(store.rollup.originOf('__local__', 'fresh')).toMatchObject({ outside: true });
    expect(owners).toEqual([{ sessionId: 'fresh', taskId: undefined }]);
  });

  it('names the task whose folder an outside session worked in', () => {
    const owners = classify([{ sessionId: 'in-task', entrypoint: 'sdk-cli', cwd: '/home/u/.local/state/open-walnut/tasks/mv96n5cs-5181/repo' }]);
    expect(owners).toEqual([{ sessionId: 'in-task', taskId: 'mv96n5cs-5181' }]);
  });

  it('counts under Outside Walnut with the filter, and the amounts agree whichever origin is picked', async () => {
    // The pass names a session before its usage is stored, as the collection does.
    classify([
      { sessionId: 'terminal-imported', entrypoint: 'cli', cwd: '/home/u/repo' },
      { sessionId: 'fresh', entrypoint: 'sdk-cli', cwd: '/home/u/other' },
    ], ['walnut-run', 'terminal-imported']);
    response('walnut-run', '2026-10-20');                  // $4, Walnut's
    response('terminal-imported', '2026-10-20');           // $4, a terminal session Walnut imported
    response('fresh', '2026-10-20', { input_tokens: 2 * M }); // $8, no Walnut record
    await store.rollup.backfill();
    const all = await buildCostReport('agents', {}, deps());
    expect(all.totals.costUsd).toBeCloseTo(16, 9);
    expect(all.started.walnut.costUsd).toBeCloseTo(4, 9);
    expect(all.started.outside.costUsd).toBeCloseTo(12, 9);
    const outside = await buildCostReport('agents', { origin: 'outside' }, deps());
    expect(outside.totals.costUsd).toBeCloseTo(12, 9);
    const everything = await buildCostReport('all', { origin: 'outside' }, deps());
    expect(everything.groups.find(g => g.id === 'kind')!.lines.map(l => l.key)).toEqual(['outside']);
    const titles = outside.tasks!.map(t => t.label).sort();
    expect(titles).toEqual(['Claude Code (claude -p) in u/other', 'Claude Code terminal in u/repo']);
    expect(outside.accounts).toBeUndefined(); // accounts are a Codex notion
    const walnut = await buildCostReport('agents', { origin: 'walnut' }, deps());
    expect(walnut.totals.costUsd).toBeCloseTo(4, 9);
  });

  it('an outside session does not move the day an import stops at', async () => {
    classify([{ sessionId: 'fresh', entrypoint: 'sdk-cli', cwd: '/work/marina' }]);
    response('fresh', '2026-01-05');
    response('walnut-run', '2026-10-20');
    await store.rollup.backfill();
    expect(store.rollup.firstOwnDay()).toBe('2026-10-20');
  });
});

describe('a session Walnut learns of after the outside pass stored it', () => {
  it('keeps its first origin, so its old rows still do not pull an import\'s cutoff back', async () => {
    classify([{ sessionId: 'fresh', entrypoint: 'cli', cwd: '/work/marina' }]);
    response('fresh', '2026-01-05');
    response('walnut-run', '2026-10-20');
    await store.rollup.backfill();
    await store.rollup.replaceImport('Cloud usage bill', [{ date: '2026-06-01', model: 'claude-opus-5-5', input: 5 * M, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }]);
    // Walnut imports the terminal session afterwards: it is known now, but the rows are still the pass's.
    classify([{ sessionId: 'fresh', entrypoint: 'cli', cwd: '/work/marina' }], ['fresh']);
    expect(store.rollup.originOf('__local__', 'fresh')).toMatchObject({ outside: true, stored: true });
    expect(store.rollup.firstOwnDay()).toBe('2026-10-20');
    const again = await store.rollup.replaceImport('Cloud usage bill', [{ date: '2026-06-01', model: 'claude-opus-5-5', input: 5 * M, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }]);
    expect(again.stored).toBe(1);
  });
});

describe('days a bill brought in from outside covers', () => {
  const bill = [{ date: '2026-10-01', model: 'claude-opus-5-5', input: 5 * M, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }];

  it('hides any other row on those days, whichever came first, and shows them again when the bill goes', async () => {
    await store.rollup.backfill();
    await store.rollup.replaceImport('Cloud usage bill', bill);                 // $20 for the day
    response('imported-later', '2026-10-01');                                   // a session imported after the bill: $4, already in it
    response('walnut-run', '2026-10-20');                                       // $4, a day the bill does not cover
    await store.rollup.refreshPairs([{ sessionId: 'imported-later', date: '2026-10-01' }, { sessionId: 'walnut-run', date: '2026-10-20' }]);
    const report = await buildCostReport('agents', {}, deps());
    expect(report.totals.costUsd).toBeCloseTo(4, 9);
    const withBill = await buildCostReport('all', {}, deps());
    expect(withBill.totals.costUsd).toBeCloseTo(24, 9);
    await store.rollup.replaceImport('Cloud usage bill', []);
    expect((await buildCostReport('all', {}, deps())).totals.costUsd).toBeCloseTo(8, 9);
  });

  it('also leaves out a Walnut helper call on a billed day, which is inside the bill', async () => {
    store.database.exec(`CREATE TABLE IF NOT EXISTS usage (id TEXT PRIMARY KEY, timestamp TEXT, date TEXT, source TEXT, model TEXT,
      input_tokens INTEGER, output_tokens INTEGER, cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER, cost_usd REAL,
      task_id TEXT, session_id TEXT, run_id TEXT, external_cost_usd REAL, duration_ms INTEGER, parent_source TEXT, agent_id TEXT,
      ttft_ms INTEGER, generation_ms INTEGER)`);
    const call = (id: string, date: string) => store.database.prepare(`INSERT INTO usage (id, timestamp, date, source, model, input_tokens, output_tokens,
      cache_creation_input_tokens, cache_read_input_tokens, cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, `${date}T18:00:00.000Z`, date, 'title', 'claude-opus-5-5', 1 * M, 0, 0, 0, 0);
    await store.rollup.backfill();
    await store.rollup.replaceImport('Cloud usage bill', bill);                 // $20 for 2026-10-01
    call('u1', '2026-10-01');                                                   // $4, already in the bill
    call('u2', '2026-10-20');                                                   // $4, a day the bill does not cover
    const report = await buildCostReport('all', {}, deps());
    expect(report.totals.costUsd).toBeCloseTo(24, 9);
    expect(report.started.walnut.costUsd).toBeCloseTo(4, 9);
  });
});

describe('folder labels for sessions outside Walnut', () => {
  it('two different folders never read the same, and a lone folder keeps its two-part name', () => {
    const label = uniqueDirectoryLabels(['/home/a/software/agent-orchestrator', '/home/b/software/agent-orchestrator', '/home/a/repo/marina']);
    expect(label('/home/a/repo/marina')).toBe('repo/marina');
    expect(label('/home/a/software/agent-orchestrator')).toBe('a/software/agent-orchestrator');
    expect(label('/home/b/software/agent-orchestrator')).toBe('b/software/agent-orchestrator');
  });
});

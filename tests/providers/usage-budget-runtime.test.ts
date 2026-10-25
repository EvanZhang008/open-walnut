import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsp, { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createUsageBudgetRuntime, type BudgetPrices } from '../../src/providers/usage-budget-runtime.js';
import type { SessionCostBucket, SessionCostRequest, SessionCostScan } from '../../src/providers/session-cost-core.js';

const SID = '11111111-2222-4333-8444-555555555555';
const PRICES: BudgetPrices = {
  hash: 'h1',
  snapshot: { source: 'litellm', url: '', fetchedAt: '2026-10-23T00:00:00.000Z', models: {
    'claude-opus-5-5': { provider: 'anthropic', input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 },
    'gpt-6.1-sol': { provider: 'openai', input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  } },
};

function bucket(over: Partial<SessionCostBucket>): SessionCostBucket {
  return { model: 'claude-opus-5-5', speed: 'standard', geo: 'global', tier: 'standard', band: 0, responses: 1,
    input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWrite: 0, webSearches: 0, incomplete: 0,
    firstAt: '2026-10-23T00:00:00.000Z', lastAt: '2026-10-23T00:00:00.000Z', ...over };
}

let dir: string;
let buckets: SessionCostBucket[];
let pending: boolean;
let scans: SessionCostRequest[];
let pauses: Array<[string, string, string | undefined]>;
let pauseError: Error | null;
let found: boolean;
let scanGate: Promise<void> | null;
let clock: number | undefined;
const perSid = new Map<string, SessionCostBucket[]>();
const scan = async (req: SessionCostRequest): Promise<SessionCostScan> => {
  scans.push(req);
  if (scanGate) await scanGate;
  return { engine: req.engine, sessionId: req.sessionId, source: 'claude-transcript', found, files: 1, scanMs: 1,
    ...(found ? {} : { reason: 'No transcript for this session on its host.' }),
    buckets: pending || !found ? [] : perSid.get(req.sessionId) ?? buckets, ...(pending ? { pending: { readBytes: 1, totalBytes: 2 } } : {}) };
};
function runtime() {
  return createUsageBudgetRuntime({ dir, projectsDir: dir, scan, tickMs: 60_000, ...(clock !== undefined ? { now: () => clock! } : {}),
    pause: async (sid, engine, runtimeId) => { pauses.push([sid, engine, runtimeId]); if (pauseError) throw pauseError; },
    log: () => {} });
}
// $1 of Opus input.
const dollars = (n: number) => bucket({ input: n * 250_000 });

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'budget-runtime-'));
  buckets = []; pending = false; scans = []; pauses = []; pauseError = null; found = true; scanGate = null; clock = undefined; perSid.clear();
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('session budget runtime', () => {
  it('leaves a session without a budget alone', async () => {
    const r = runtime();
    expect(await r.allow(SID)).toBe('ok');
    expect((await r.read(SID)).budget).toMatchObject({ state: 'unlimited', limitUsd: null, revision: 0 });
    r.observe(SID, { type: 'assistant' });
    await r.tick();
    expect(scans).toEqual([]);
    r.close();
  });

  it('prices the session like the cost line and pauses it once at the limit', async () => {
    const r = runtime();
    buckets = [dollars(4)];
    const set = await r.configure(SID, { limitUsd: 5, revision: 0, engine: 'claude', cwd: '/w', prices: PRICES });
    expect(set.budget).toMatchObject({ state: 'active', limitUsd: 5, spentUsd: 4, revision: 1, responses: 1 });
    expect(scans[0]).toMatchObject({ engine: 'claude', sessionId: SID, cwd: '/w' });
    expect(await r.allow(SID)).toBe('ok');
    buckets = [dollars(4), dollars(1.5)];
    await r.check(SID);
    const paused = (await r.read(SID)).budget;
    expect(paused).toMatchObject({ state: 'paused', reason: 'limit', spentUsd: 5.5, stopError: null });
    expect(paused.pauseId).toEqual(expect.any(String));
    expect(pauses).toEqual([[SID, 'claude', undefined]]);
    expect(await r.allow(SID)).toBe('paused');
    // Checked again while still over: no second stop, same pause.
    buckets = [dollars(4), dollars(2)];
    await r.check(SID);
    expect(pauses).toHaveLength(1);
    expect((await r.read(SID)).budget.pauseId).toBe(paused.pauseId);
    r.close();
  });

  it('lets the next send through after the limit is raised, and pauses again with a new id', async () => {
    const r = runtime();
    buckets = [dollars(6)];
    const first = (await r.configure(SID, { limitUsd: 5, revision: 0, engine: 'claude', prices: PRICES })).budget;
    expect(first.state).toBe('paused');
    const raised = (await r.configure(SID, { limitUsd: 10, revision: 1, engine: 'claude' })).budget;
    expect(raised).toMatchObject({ state: 'active', reason: null, pauseId: null, revision: 2 });
    expect(await r.allow(SID)).toBe('ok');
    buckets = [dollars(11)];
    await r.check(SID);
    const again = (await r.read(SID)).budget;
    expect(again.state).toBe('paused');
    expect(again.pauseId).not.toBe(first.pauseId);
    expect(pauses).toHaveLength(2);
    const removed = (await r.configure(SID, { limitUsd: null, revision: 2, engine: 'claude' })).budget;
    expect(removed).toMatchObject({ state: 'unlimited', limitUsd: null });
    expect(await r.allow(SID)).toBe('ok');
    r.close();
  });

  it('pauses on a request with no price and names the model', async () => {
    const r = runtime();
    buckets = [dollars(1), bucket({ model: 'some-new-model', input: 10 })];
    const b = (await r.configure(SID, { limitUsd: 100, revision: 0, engine: 'claude', prices: PRICES })).budget;
    expect(b).toMatchObject({ state: 'paused', reason: 'unpriced', unpricedResponses: 1, unpricedModel: 'some-new-model', spentUsd: 1 });
    expect(await r.allow(SID)).toBe('paused');
    r.close();
  });

  it('refuses a stale revision', async () => {
    const r = runtime();
    await r.configure(SID, { limitUsd: 5, revision: 0, engine: 'claude', prices: PRICES });
    await expect(r.configure(SID, { limitUsd: 9, revision: 0, engine: 'claude' })).rejects.toMatchObject({ code: 'BUDGET_CONFLICT' });
    await expect(r.configure(SID, { limitUsd: -1, revision: 1, engine: 'claude' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    r.close();
  });

  it('decides nothing while the first read is still going, and holds sends until it lands', async () => {
    const r = runtime();
    pending = true;
    const b = (await r.configure(SID, { limitUsd: 5, revision: 0, engine: 'claude', prices: PRICES })).budget;
    expect(b.state).toBe('checking');
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const allowed = r.allow(SID);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(await allowed).toBe('checking');
    vi.useRealTimers();
    pending = false;
    buckets = [dollars(1)];
    expect(await r.allow(SID)).toBe('ok');
    r.close();
  });

  it('checks every budget again after a restart before anything is sent, and keeps a pause', async () => {
    const r1 = runtime();
    buckets = [dollars(6)];
    const paused = (await r1.configure(SID, { limitUsd: 5, revision: 0, engine: 'claude', prices: PRICES })).budget;
    const other = '22222222-2222-4333-8444-555555555555';
    buckets = [dollars(1)];
    await r1.configure(other, { limitUsd: 10, revision: 0, engine: 'codex' });
    r1.close();
    const r2 = runtime();
    expect((await r2.read(other)).budget.state).toBe('checking');
    expect((await r2.read(SID)).budget).toMatchObject({ state: 'paused', pauseId: paused.pauseId });
    expect(r2.pricesHash()).toBe('h1');
    buckets = [dollars(6)];
    await r2.recover();
    expect((await r2.read(other)).budget.state).toBe('active');
    // The pause from before the restart is not a new pause.
    expect((await r2.read(SID)).budget.pauseId).toBe(paused.pauseId);
    expect(await r2.allow(SID)).toBe('paused');
    expect((await r2.list()).map(b => b.sid).sort()).toEqual([SID, other].sort());
    r2.close();
  });

  it('stops an ACP session by its worker id, kept current by the server', async () => {
    const r = runtime();
    buckets = [bucket({ model: 'gpt-6-1-sol', input: 100_000 })];
    await r.configure(SID, { limitUsd: 1, revision: 0, engine: 'codex', runtimeId: 'acp-1', prices: PRICES });
    expect(await r.allowRuntime('acp-1')).toBe('ok');
    await r.list({ [SID]: 'acp-2' });
    buckets = [bucket({ model: 'gpt-6-1-sol', input: 600_000 })];
    await r.check(SID);
    expect(pauses).toEqual([[SID, 'codex', 'acp-2']]);
    expect(await r.allowRuntime('acp-2')).toBe('paused');
    r.close();
  });

  it('records a stop it could not confirm and tries again on the next check', async () => {
    const r = runtime();
    pauseError = new Error('process identity is not confirmed');
    buckets = [dollars(6)];
    const b = (await r.configure(SID, { limitUsd: 5, revision: 0, engine: 'claude', prices: PRICES })).budget;
    expect(b.stopError).toMatch(/not confirmed/);
    pauseError = null;
    await r.check(SID);
    expect(pauses).toHaveLength(2);
    expect((await r.read(SID)).budget.stopError).toBeNull();
    r.close();
  });

  it('waits for the server\'s price list rather than calling everything unpriced', async () => {
    const r = runtime();
    buckets = [dollars(1)];
    const b = (await r.configure(SID, { limitUsd: 5, revision: 0, engine: 'claude' })).budget;
    expect(b.state).toBe('checking');
    expect(scans).toEqual([]);
    await r.setPrices(PRICES);
    await r.check(SID);
    expect((await r.read(SID)).budget.state).toBe('active');
    // The price list is written once per hash.
    expect((await readdir(path.join(dir, 'v2'))).sort()).toEqual(['11111111-2222-4333-8444-555555555555.json', 'prices.json']);
    expect(JSON.parse(await readFile(path.join(dir, 'v2', 'prices.json'), 'utf8')).hash).toBe('h1');
    r.close();
  });

  it('carries a first-version limit over, checked before anything is sent', async () => {
    // The first version's marker plus its journal: the last policy line holds; a torn tail is skipped.
    await writeFile(path.join(dir, `${SID}.json`), JSON.stringify({ version: 2, journal: `${SID}.jsonl` }));
    await writeFile(path.join(dir, `${SID}.jsonl`), [
      JSON.stringify({ version: 2, sequence: 1, kind: 'policy', policy: { limitUsd: 3, revision: 1 } }),
      JSON.stringify({ version: 2, sequence: 2, kind: 'response', entry: {} }),
      JSON.stringify({ version: 2, sequence: 3, kind: 'policy', policy: { limitUsd: 5, revision: 2 } }),
      '{"version":2,"seq',
    ].join('\n'));
    // A removed first-version limit is not carried over.
    const other = '33333333-2222-4333-8444-555555555555';
    await writeFile(path.join(dir, `${other}.json`), '{}');
    await writeFile(path.join(dir, `${other}.jsonl`), JSON.stringify({ kind: 'policy', policy: { limitUsd: null, revision: 4 } }));
    const r = runtime();
    expect((await r.read(SID)).budget).toMatchObject({ state: 'checking', limitUsd: 5, revision: 2, engine: 'claude' });
    expect((await r.read(other)).budget.state).toBe('unlimited');
    await r.setPrices(PRICES);
    buckets = [dollars(6)];
    expect(await r.allow(SID)).toBe('paused');
    expect((await r.read(SID)).budget).toMatchObject({ state: 'paused', reason: 'limit' });
    // The first version's files stay for a rollback.
    expect((await readdir(dir)).sort()).toEqual([`${other}.json`, `${other}.jsonl`, `${SID}.json`, `${SID}.jsonl`, 'v2'].sort());
    r.close();
  });

  it('gates a restarted ACP worker from its first turn, and checks it when a turn ends', async () => {
    const r = runtime();
    buckets = [bucket({ model: 'gpt-6.1-sol', input: 100_000 })];
    await r.configure(SID, { limitUsd: 1, revision: 0, engine: 'codex', runtimeId: 'acp-old', prices: PRICES });
    // A new worker for the same session: bound at start, so its first turn is gated.
    await r.bindRuntime(SID, 'acp-new');
    buckets = [bucket({ model: 'gpt-6.1-sol', input: 600_000 })];
    r.observeRuntime('acp-new');
    // The turn's check waits out the one-second spacing after the last one, then saves and stops.
    await vi.waitFor(() => expect(pauses).toEqual([[SID, 'codex', 'acp-new']]), { timeout: 5_000 });
    expect(await r.allowRuntime('acp-new')).toBe('paused');
    // An unbudgeted worker is never held.
    expect(await r.allowRuntime('acp-unrelated')).toBe('ok');
    await r.bindRuntime('44444444-2222-4333-8444-555555555555', 'acp-x');
    expect(await r.allowRuntime('acp-x')).toBe('ok');
    r.close();
  });

  it('lets a send through only on a decision newer than the last response', async () => {
    const r = runtime();
    buckets = [dollars(1)];
    await r.configure(SID, { limitUsd: 5, revision: 0, engine: 'claude', prices: PRICES });
    // A response lands that takes the session over; the next send must not go before it is priced.
    buckets = [dollars(6)];
    let release!: () => void;
    scanGate = new Promise(resolve => { release = resolve; });
    r.observe(SID, { type: 'assistant' });
    const send = r.allow(SID);
    await new Promise(resolve => setTimeout(resolve, 50));
    release(); scanGate = null;
    expect(await send).toBe('paused');
    expect((await r.read(SID)).budget).toMatchObject({ state: 'paused', reason: 'limit' });
    r.close();
  });

  it('holds sends while usage cannot be read, then pauses after a minute', async () => {
    clock = Date.parse('2026-10-23T00:00:00.000Z');
    const r = runtime();
    buckets = [dollars(1)];
    await r.configure(SID, { limitUsd: 5, revision: 0, engine: 'claude', prices: PRICES });
    found = false;
    await r.check(SID);
    expect((await r.read(SID)).budget).toMatchObject({ state: 'checking', checkError: expect.stringMatching(/No transcript/) });
    expect(await r.allow(SID)).toBe('checking');
    clock += 61_000;
    await r.check(SID);
    expect((await r.read(SID)).budget).toMatchObject({ state: 'paused', reason: 'unreadable' });
    expect(pauses).toHaveLength(1);
    // Readable again and under the limit: the next send goes.
    found = true;
    expect(await r.allow(SID)).toBe('paused');
    await r.check(SID);
    expect((await r.read(SID)).budget).toMatchObject({ state: 'active', checkError: null });
    r.close();
  });

  it('a session that never answered costs nothing yet', async () => {
    const r = runtime();
    found = false;
    expect((await r.configure(SID, { limitUsd: 5, revision: 0, engine: 'claude', prices: PRICES })).budget).toMatchObject({ state: 'active', spentUsd: 0 });
    r.close();
  });

  it('makes a stop again after a restart cut it', async () => {
    await mkdir(path.join(dir, 'v2'), { recursive: true });
    await writeFile(path.join(dir, 'v2', `${SID}.json`), JSON.stringify({ version: 2, sid: SID, limitUsd: 5, spentUsd: 6, state: 'paused',
      reason: 'limit', revision: 1, updatedAt: null, responses: 1, unpricedResponses: 0, pausedAt: 'x', pauseId: 'p-1', stopError: null,
      stopConfirmed: false, engine: 'claude', checkedAt: null }));
    const r = runtime();
    await r.recover();
    expect(pauses).toEqual([[SID, 'claude', undefined]]);
    expect((await r.read(SID)).budget.pauseId).toBe('p-1');
    r.close();
  });

  it('holds only the session whose budget file is broken, until a new budget replaces it', async () => {
    await mkdir(path.join(dir, 'v2'), { recursive: true });
    await writeFile(path.join(dir, 'v2', `${SID}.json`), '{"version":2,"si');
    const other = '55555555-2222-4333-8444-555555555555';
    const r = runtime();
    expect(await r.allow(SID)).toBe('paused');
    expect((await r.read(SID)).budget).toMatchObject({ state: 'paused', reason: 'unreadable' });
    expect(await r.allow(other)).toBe('ok');
    buckets = [dollars(1)];
    expect((await r.configure(SID, { limitUsd: 5, revision: 0, engine: 'claude', prices: PRICES })).budget.state).toBe('active');
    expect(await r.allow(SID)).toBe('ok');
    r.close();
  });

  it('follows an ACP session to a new thread id and keeps counting the old one', async () => {
    const r = runtime();
    const next = '66666666-2222-4333-8444-555555555555';
    perSid.set(SID, [bucket({ model: 'gpt-6.1-sol', input: 300_000 })]);
    perSid.set(next, [bucket({ model: 'gpt-6.1-sol', input: 300_000 })]);
    await r.configure(SID, { limitUsd: 1, revision: 0, engine: 'codex', runtimeId: 'acp-1', prices: PRICES });
    expect((await r.read(SID)).budget.spentUsd).toBeCloseTo(0.6, 9);
    // The worker's thread could not be loaded and was started over under a new id.
    await r.bindRuntime(next, 'acp-1');
    expect((await r.read(SID)).budget.state).toBe('unlimited');
    expect(await r.allowRuntime('acp-1')).toBe('paused');
    expect((await r.read(next)).budget).toMatchObject({ state: 'paused', reason: 'limit', limitUsd: 1 });
    expect((await r.read(next)).budget.spentUsd).toBeCloseTo(1.2, 9);
    expect(scans.filter(q => q.sessionId === SID).length).toBeGreaterThan(1);
    r.close();
  });

  it('lists only budgets of the asking Walnut, and keeps a worker id this daemon bound itself', async () => {
    const r = runtime();
    buckets = [dollars(1)];
    await r.configure(SID, { limitUsd: 5, revision: 0, engine: 'codex', home: '/home-a', runtimeId: 'acp-1', prices: PRICES });
    const other = '77777777-2222-4333-8444-555555555555';
    await r.configure(other, { limitUsd: 5, revision: 0, engine: 'claude', home: '/home-b' });
    expect((await r.list(undefined, '/home-a')).map(b => b.sid)).toEqual([SID]);
    await r.bindRuntime(SID, 'acp-2');
    await r.list({ [SID]: 'acp-stale' }, '/home-a');
    buckets = [dollars(9)];
    await r.check(SID);
    expect(pauses).toEqual([[SID, 'codex', 'acp-2']]);
    r.close();
  });

  it('holds a send it cannot decide as checking, never as paused', async () => {
    const r = runtime();
    buckets = [dollars(1)];
    // No price list yet: every request would look unpriced.
    expect((await r.configure(SID, { limitUsd: 5, revision: 0, engine: 'claude' })).budget.state).toBe('checking');
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const send = r.allow(SID);
      await vi.advanceTimersByTimeAsync(16_000);
      expect(await send).toBe('checking');
    } finally { vi.useRealTimers(); }
    await r.setPrices(PRICES);
    expect(await r.allow(SID)).toBe('ok');
    r.close();
  });

  it('a check that decides nothing leaves the next send waiting for one', async () => {
    clock = Date.parse('2026-10-23T00:00:00.000Z');
    const r = runtime();
    buckets = [dollars(1)];
    await r.configure(SID, { limitUsd: 5, revision: 0, engine: 'claude', prices: PRICES });
    clock += 2_000;
    // A response lands; its check finds the transcript still being read.
    pending = true;
    buckets = [dollars(6)];
    r.observe(SID, { type: 'assistant' });
    await r.check(SID);
    expect((await r.read(SID)).budget.state).toBe('active');
    pending = false;
    // The send does not go on the decision from before that response.
    expect(await r.allow(SID)).toBe('paused');
    expect(pauses).toHaveLength(1);
    r.close();
  });

  it('stops nothing when the limit is removed while the pause is being saved', async () => {
    const r = runtime();
    buckets = [dollars(1)];
    await r.configure(SID, { limitUsd: 5, revision: 0, engine: 'claude', prices: PRICES });
    buckets = [dollars(6)];
    let releaseSave!: () => void;
    const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
    const realOpen = fsp.open.bind(fsp);
    let armed = true;
    const spy = vi.spyOn(fsp, 'open').mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
      if (armed && String(args[0]).includes(`${SID}.json.`)) { armed = false; await saveGate; }
      return realOpen(...args);
    }) as typeof fsp.open);
    try {
      const checking = r.check(SID);
      await vi.waitFor(() => expect(armed).toBe(false));
      expect((await r.read(SID)).budget.state).toBe('paused');
      const removed = r.configure(SID, { limitUsd: null, revision: 1, engine: 'claude' });
      await vi.waitFor(async () => expect((await r.read(SID)).budget.state).toBe('unlimited'));
      releaseSave();
      await checking;
      await removed;
      expect(pauses).toEqual([]);
      expect(await r.allow(SID)).toBe('ok');
    } finally { releaseSave(); spy.mockRestore(); }
    r.close();
  });

  it('tries an owed stop once per check', async () => {
    const r = runtime();
    pauseError = new Error('process identity is not confirmed');
    buckets = [dollars(6)];
    await r.configure(SID, { limitUsd: 5, revision: 0, engine: 'claude', prices: PRICES });
    expect(pauses).toHaveLength(1);
    await r.check(SID);
    expect(pauses).toHaveLength(2);
    expect((await r.read(SID)).budget.stopError).toMatch(/not confirmed/);
    r.close();
  });

  it('a session seen answering whose usage cannot be found is unreadable, not free', async () => {
    const r = runtime();
    buckets = [];
    await r.configure(SID, { limitUsd: 5, revision: 0, engine: 'claude', prices: PRICES });
    found = false;
    r.observe(SID, { type: 'result' });
    await r.check(SID);
    expect((await r.read(SID)).budget).toMatchObject({ state: 'checking', checkError: expect.stringMatching(/No transcript/) });
    expect(await r.allow(SID)).toBe('checking');
    // The mark survives a restart.
    r.close();
    const r2 = runtime();
    await r2.check(SID);
    expect((await r2.read(SID)).budget.state).toBe('checking');
    r2.close();
  });

  it('refuses an unknown engine, another Walnut\'s budget, and an engine change', async () => {
    const r = runtime();
    buckets = [dollars(1)];
    await expect(r.configure(SID, { limitUsd: 5, revision: 0, engine: 'gemini', prices: PRICES })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await r.configure(SID, { limitUsd: 5, revision: 0, engine: 'codex', home: '/home-a', prices: PRICES });
    await expect(r.configure(SID, { limitUsd: 9, revision: 1, engine: 'codex', home: '/home-b' })).rejects.toMatchObject({ code: 'NOT_OWNED' });
    await expect(r.configure(SID, { limitUsd: 9, revision: 1, engine: 'claude', home: '/home-a' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect((await r.configure(SID, { limitUsd: 9, revision: 1, engine: 'codex', home: '/home-a' })).budget.limitUsd).toBe(9);
    r.close();
  });

  it('writes each limit into the first version\'s journal too, for a daemon rolled back to it', async () => {
    const r = runtime();
    buckets = [dollars(1)];
    await r.configure(SID, { limitUsd: 5, revision: 0, engine: 'claude', prices: PRICES });
    await r.configure(SID, { limitUsd: null, revision: 1, engine: 'claude' });
    expect(JSON.parse(await readFile(path.join(dir, `${SID}.json`), 'utf8'))).toEqual({ version: 2, journal: `${SID}.jsonl` });
    const events = (await readFile(path.join(dir, `${SID}.jsonl`), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
    expect(events).toEqual([
      { version: 2, kind: 'policy', updatedAt: expect.any(String), sequence: 1, policy: { limitUsd: 5, revision: 1, baselineComplete: false, unverifiedReason: null, stopError: null } },
      { version: 2, kind: 'policy', updatedAt: expect.any(String), sequence: 2, policy: { limitUsd: null, revision: 2, baselineComplete: false, unverifiedReason: null, stopError: null } },
    ]);
    // An existing journal continues its sequence; one that version could not read is left alone.
    const other = '88888888-2222-4333-8444-555555555555';
    await writeFile(path.join(dir, `${other}.json`), JSON.stringify({ version: 2, journal: `${other}.jsonl` }));
    await writeFile(path.join(dir, `${other}.jsonl`), JSON.stringify({ version: 2, sequence: 7, kind: 'policy', updatedAt: 'x', policy: { limitUsd: 3, revision: 3 } }) + '\n');
    const torn = '99999999-2222-4333-8444-555555555555';
    await writeFile(path.join(dir, `${torn}.json`), JSON.stringify({ version: 2, journal: `${torn}.jsonl` }));
    await writeFile(path.join(dir, `${torn}.jsonl`), '{"version":2,"seq');
    const r2 = runtime();
    expect((await r2.read(other)).budget).toMatchObject({ limitUsd: 3, revision: 3 });
    await r2.configure(other, { limitUsd: 4, revision: 3, engine: 'claude', prices: PRICES });
    const last = JSON.parse((await readFile(path.join(dir, `${other}.jsonl`), 'utf8')).trimEnd().split('\n').pop()!);
    expect(last).toMatchObject({ sequence: 8, policy: { limitUsd: 4, revision: 4 } });
    await r2.configure(torn, { limitUsd: 4, revision: 0, engine: 'claude' });
    expect(await readFile(path.join(dir, `${torn}.jsonl`), 'utf8')).toBe('{"version":2,"seq');
    r2.close();
    r.close();
  });

  it('takes over a limit the first version changed after a rollback', async () => {
    const r = runtime();
    buckets = [dollars(1)];
    await r.configure(SID, { limitUsd: 5, revision: 0, engine: 'claude', prices: PRICES });
    r.close();
    // The rolled-back daemon took a new limit; this version comes back.
    await appendFile(path.join(dir, `${SID}.jsonl`), JSON.stringify({ version: 2, sequence: 2, kind: 'policy', updatedAt: 'x',
      policy: { limitUsd: 9, revision: 2, baselineComplete: false, unverifiedReason: null, stopError: null } }) + '\n');
    const r2 = runtime();
    expect((await r2.read(SID)).budget).toMatchObject({ limitUsd: 9, revision: 2, state: 'checking' });
    r2.close();
    // An older first-version line never overrides this version's newer budget.
    await appendFile(path.join(dir, `${SID}.jsonl`), JSON.stringify({ version: 2, sequence: 3, kind: 'policy', updatedAt: 'x',
      policy: { limitUsd: 1, revision: 1, baselineComplete: false, unverifiedReason: null, stopError: null } }) + '\n');
    const r3 = runtime();
    expect((await r3.read(SID)).budget).toMatchObject({ limitUsd: 9, revision: 2 });
    r3.close();
  });
});

describe('session budget runtime: a limit changed during a pause', () => {
  it('a raise under the spend does not make the stop that was still owed', async () => {
    const r = runtime();
    pauseError = new Error('process identity is not confirmed');
    buckets = [dollars(6)];
    const paused = (await r.configure(SID, { limitUsd: 5, revision: 0, engine: 'claude', prices: PRICES })).budget;
    expect(paused).toMatchObject({ state: 'paused', stopError: expect.stringMatching(/not confirmed/) });
    expect(pauses).toHaveLength(1);
    pauseError = null;
    expect((await r.configure(SID, { limitUsd: 10, revision: 1, engine: 'claude' })).budget).toMatchObject({ state: 'active', pauseId: null });
    expect(pauses).toHaveLength(1);
    expect(await r.allow(SID)).toBe('ok');
    r.close();
  });

  it('a raise the check cannot decide yet holds the send as checking, not paused', async () => {
    const r = runtime();
    buckets = [dollars(6)];
    await r.configure(SID, { limitUsd: 5, revision: 0, engine: 'claude', prices: PRICES });
    pending = true;
    expect((await r.configure(SID, { limitUsd: 10, revision: 1, engine: 'claude' })).budget.state).toBe('checking');
    expect(await r.allow(SID)).toBe('checking');
    pending = false;
    expect(await r.allow(SID)).toBe('ok');
    r.close();
  });

  it('a raise still under the spend keeps the same pause and stops nothing again', async () => {
    const r = runtime();
    buckets = [dollars(12)];
    const first = (await r.configure(SID, { limitUsd: 5, revision: 0, engine: 'claude', prices: PRICES })).budget;
    const again = (await r.configure(SID, { limitUsd: 10, revision: 1, engine: 'claude' })).budget;
    expect(again).toMatchObject({ state: 'paused', reason: 'limit', pauseId: first.pauseId });
    expect(pauses).toHaveLength(1);
    r.close();
  });

  it('a raise that cannot lift the pause keeps it paused, and the owed stop is still made', async () => {
    const r = runtime();
    pauseError = new Error('process identity is not confirmed');
    buckets = [dollars(12)];
    await r.configure(SID, { limitUsd: 5, revision: 0, engine: 'claude', prices: PRICES });
    expect(pauses).toHaveLength(1);
    pauseError = null;
    pending = true;
    // $12 spent is over the new $10 too: nothing to decide, the pause holds.
    expect((await r.configure(SID, { limitUsd: 10, revision: 1, engine: 'claude' })).budget).toMatchObject({ state: 'paused', stopError: null });
    expect(pauses).toHaveLength(2);
    expect(await r.allow(SID)).toBe('paused');
    r.close();
  });

  it('clears the first-version copy of an ACP budget that moved to a new thread id', async () => {
    const r = runtime();
    const next = '66666666-2222-4333-8444-555555555555';
    buckets = [bucket({ model: 'gpt-6.1-sol', input: 100_000 })];
    await r.configure(SID, { limitUsd: 1, revision: 0, engine: 'codex', runtimeId: 'acp-1', prices: PRICES });
    await r.bindRuntime(next, 'acp-1');
    const last = JSON.parse((await readFile(path.join(dir, `${SID}.jsonl`), 'utf8')).trimEnd().split('\n').pop()!);
    expect(last.policy).toMatchObject({ limitUsd: null });
    r.close();
    const r2 = runtime();
    expect((await r2.read(SID)).budget.state).toBe('unlimited');
    expect((await r2.list()).map(b => b.sid)).toEqual([next]);
    r2.close();
  });
});

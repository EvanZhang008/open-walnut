import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createUsageBudgets, durableBudgetDirectory, type BudgetUsageRecord } from '../../src/providers/usage-budget-core.js';
import { PRICING_VERSION } from '../../src/core/usage/pricing.js';
import { createBudgetPersistence } from '../../src/providers/usage-budget-persistence.js';

const SID = 'session-a', START = Date.parse('2026-10-14T12:00:00Z');
let dir: string, clock: number, budgets: ReturnType<typeof createUsageBudgets>;
function record(overrides: Partial<BudgetUsageRecord> = {}): BudgetUsageRecord {
  return { responseId: 'msg-a', model: 'claude-opus-5-5', sessionId: SID, timestamp: new Date(START).toISOString(),
    input_tokens: 0, output_tokens: 1_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    speed: 'standard', service_tier: 'standard', inference_geo: '', pricing_context_complete: true,
    complete: true, verification: 'matched', upstream: {
      source: 'proxy', requestId: 'request-a', sessionId: SID, model: 'claude-opus-5-5',
      requestedModel: 'claude-opus-5-5', responseModel: 'claude-opus-5-5',
      forwardedModel: 'global.anthropic.claude-opus-5-5-v1:0', startedMs: START, finishedMs: START + 1_000,
      usagePresent: true, complete: true, fileIndex: 0, lineNumber: 1,
      input_tokens: 0, output_tokens: 1_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    }, ...overrides };
}
async function configure(limitUsd: number | null = 1, records: BudgetUsageRecord[] = [], complete = true) {
  const current = await budgets.read(SID);
  return budgets.configure(SID, { limitUsd, revision: current.revision, baseline: { records, complete } });
}
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wn-usage-budget-'));
  clock = START;
  budgets = createUsageBudgets({ dir, now: () => clock });
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true }); });

describe('host-persistent usage budgets', () => {
  it('does not invent an initial total or create a file for a read', async () => {
    expect(await budgets.read(SID)).toEqual({ limitUsd: null, spentUsd: null, state: 'unlimited', reason: null,
      revision: 0, updatedAt: null, stopError: null });
    expect(await fs.readdir(dir)).toEqual([]);
    expect(await budgets.listConfigured()).toEqual([]);
    expect(await budgets.records(SID)).toEqual([]);
  });

  it('starts unknown without a full baseline and accepts a verified empty baseline as zero', async () => {
    expect(await budgets.configure(SID, { limitUsd: 1, revision: 0 })).toMatchObject({
      state: 'unverified', spentUsd: null, reason: 'cost_unverified', revision: 1,
    });
    expect(await budgets.replaceBaseline(SID, { records: [], complete: false })).toMatchObject({ spentUsd: null, revision: 1 });
    expect(await budgets.replaceBaseline(SID, { records: [], complete: true })).toMatchObject({
      state: 'active', spentUsd: 0, reason: null, revision: 1,
    });
    expect(await configure(0.01)).toMatchObject({ state: 'active', spentUsd: 0, revision: 2 });
  });

  it.each([
    { model: 'unknown-model' }, { verification: 'unmatched' as const }, { verification: 'incomplete' as const },
    { upstream: undefined }, { complete: false }, { output_tokens: null }, { cache_read_input_tokens: null },
    { cache_creation_input_tokens: undefined }, { input_tokens: undefined }, { output_tokens: -1 }, { output_tokens: 1.5 },
    { model: 'claude-opus-4-6' },
    { pricing_context_complete: false }, { speed: 'fast' as const }, { service_tier: 'priority' },
    { inference_geo: 'us' }, { server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 }, pricing_context_complete: false },
  ])('keeps any unverifiable response unknown: %j', async (overrides) => {
    const result = await configure(1, [record({ responseId: 'known' }), record({ responseId: 'unknown', ...overrides })]);
    expect(result).toMatchObject({ state: 'unverified', spentUsd: null, reason: 'cost_unverified' });
    const snapshot = await budgets.snapshot(SID);
    expect(snapshot.knownSubtotalUsd).toBeCloseTo(0.02);
    expect(snapshot.records).toHaveLength(2);
    expect((await budgets.snapshot(SID)).knownSubtotalUsd).toBeCloseTo(0.02);
  });

  it('retains unknown cost with no limit without claiming a zero lifetime spend', async () => {
    expect(await configure(null, [record({ upstream: undefined })])).toMatchObject({
      limitUsd: null, spentUsd: null, state: 'unlimited', reason: null,
    });
  });

  it('deduplicates normalized model and response identity without writing on exact repeats', async () => {
    await configure(1, [record()]);
    const bytes = await fs.readFile(path.join(dir, `${SID}.json`), 'utf8');
    clock += 60_000;
    const write = vi.spyOn(fs, 'open');
    const result = await budgets.observe(SID, { record: record({ model: ' global.anthropic.claude-opus-5-5-v1:0 ' }) });
    expect(result).toMatchObject({ spentUsd: 0.02, revision: 1, updatedAt: new Date(START).toISOString() });
    expect(await fs.readFile(path.join(dir, `${SID}.json`), 'utf8')).toBe(bytes);
    expect(write.mock.calls.every(([, flags]) => flags !== 'wx')).toBe(true);
    expect(await budgets.records(SID)).toHaveLength(1);
    await budgets.observe(SID, { record: record({ model: 'claude-fable-5-1', upstream: {
      ...record().upstream!, forwardedModel: 'global.anthropic.claude-fable-5-1-v1:0',
    } }) });
    expect((await budgets.snapshot(SID)).records).toHaveLength(2);
    expect((await budgets.read(SID)).spentUsd).toBeCloseTo(0.07);
  });

  it('replaces corrected final evidence by identity and recomputes cost in both directions', async () => {
    await configure(0.03, [record()]);
    const corrected = record({ output_tokens: 2_000, upstream: { ...record().upstream!, output_tokens: 2_000 } });
    expect(await budgets.observe(SID, { record: corrected })).toMatchObject({ spentUsd: 0.04, state: 'paused', revision: 1 });
    expect(await budgets.observe(SID, { record: record() })).toMatchObject({ spentUsd: 0.02, state: 'active', revision: 1 });
    expect(await budgets.observe(SID, { record: record({ verification: 'unmatched', upstream: undefined }) }))
      .toMatchObject({ spentUsd: null, state: 'unverified', revision: 1 });
    expect(await budgets.observe(SID, { record: record() })).toMatchObject({ spentUsd: 0.02, state: 'active', revision: 1 });
    expect(await budgets.records(SID)).toHaveLength(1);
  });

  it.each([[0.019, 'paused'], [0.02, 'paused'], [0.020001, 'active']] as const)
    ('pauses at or above the limit %s', async (limitUsd, expected) => {
      expect(await configure(limitUsd, [record()])).toMatchObject({ spentUsd: 0.02, state: expected,
        reason: expected === 'paused' ? 'budget_limit' : null });
    });

  it('does not drift below an exact limit when many response costs accumulate', async () => {
    const records = Array.from({ length: 100 }, (_, index) => record({ responseId: `boundary-${index}` }));
    expect(await configure(2, records)).toMatchObject({ spentUsd: 2, state: 'paused', reason: 'budget_limit' });
  });

  it('preserves lifetime identities and spend through raise, removal, reload and a smaller baseline', async () => {
    await configure(0.01, [record()]);
    expect(await budgets.configure(SID, { limitUsd: 2, revision: 1 })).toMatchObject({ state: 'active', spentUsd: 0.02, revision: 2 });
    expect(await budgets.configure(SID, { limitUsd: null, revision: 2 })).toMatchObject({ state: 'unlimited', spentUsd: 0.02, revision: 3 });
    clock += 365 * 86_400_000;
    budgets = createUsageBudgets({ dir, now: () => clock });
    expect(await budgets.observe(SID, { record: record() })).toMatchObject({ spentUsd: 0.02, revision: 3 });
    expect(await configure(0.01, [], true)).toMatchObject({ state: 'paused', spentUsd: 0.02, revision: 4 });
    expect(await budgets.records(SID)).toHaveLength(1);
    expect(await budgets.replaceBaseline(SID, { records: [], complete: false })).toMatchObject({ spentUsd: null, revision: 4 });
    expect((await budgets.snapshot(SID)).knownSubtotalUsd).toBeCloseTo(0.02);
    expect(await budgets.replaceBaseline(SID, { records: [], complete: true })).toMatchObject({ spentUsd: 0.02, revision: 4 });
  });

  it('merges partial baselines and repairs unknown response evidence with a full recheck', async () => {
    await configure(1, [record({ responseId: 'old', upstream: undefined })], false);
    expect(await budgets.replaceBaseline(SID, { records: [record({ responseId: 'new' })], complete: false }))
      .toMatchObject({ spentUsd: null, revision: 1 });
    expect(await budgets.replaceBaseline(SID, { records: [record({ responseId: 'old' })], complete: true }))
      .toMatchObject({ spentUsd: 0.04, state: 'active', revision: 1 });
    expect((await budgets.records(SID)).map(item => item.responseId).sort()).toEqual(['new', 'old']);
  });

  it('serializes policy races across handles and evidence never invalidates a typed revision', async () => {
    await configure();
    const other = createUsageBudgets({ dir });
    const updates = await Promise.allSettled([
      budgets.configure(SID, { limitUsd: 2, revision: 1 }),
      budgets.observe(SID, { record: record() }),
      other.configure(SID, { limitUsd: 3, revision: 1 }),
    ]);
    expect(updates[0].status).toBe('fulfilled');
    expect(updates[1].status).toBe('fulfilled');
    expect(updates[2]).toMatchObject({ status: 'rejected', reason: { code: 'BUDGET_CONFLICT' } });
    expect(await budgets.read(SID)).toMatchObject({ limitUsd: 2, spentUsd: 0.02, revision: 2 });
    const revision = (await budgets.read(SID)).revision;
    await budgets.observe(SID, { record: record({ responseId: 'next' }) });
    expect(await budgets.configure(SID, { limitUsd: 4, revision })).toMatchObject({ spentUsd: 0.04, revision: 3 });
    await expect(budgets.configure(SID, { limitUsd: 9, revision: 1 })).rejects.toMatchObject({ code: 'BUDGET_CONFLICT' });
    expect((await budgets.read(SID)).limitUsd).toBe(4);
  });

  it('snapshots mutable caller inputs before queued operations run', async () => {
    await configure();
    const input = { limitUsd: 2, revision: 1 }, observation = record();
    const configurePromise = budgets.configure(SID, input);
    const observePromise = budgets.observe(SID, { record: observation });
    input.limitUsd = 9; input.revision = 30;
    observation.output_tokens = 9_000; observation.upstream!.output_tokens = 9_000;
    await Promise.all([configurePromise, observePromise]);
    expect(await budgets.read(SID)).toMatchObject({ limitUsd: 2, spentUsd: 0.02, revision: 2 });
    expect((await budgets.records(SID))[0].upstream?.output_tokens).toBe(1_000);
  });

  it('keeps a failed stop pinned across raising and removing the limit until confirmation', async () => {
    await configure(0.01, [record()]);
    expect(await budgets.markStopError(SID, 'Stop did not complete')).toMatchObject({
      state: 'paused', reason: 'stop_failed', stopError: 'Stop did not complete', revision: 1,
    });
    expect(await budgets.configure(SID, { limitUsd: 10, revision: 1 })).toMatchObject({ state: 'paused', stopError: 'Stop did not complete' });
    expect(await budgets.configure(SID, { limitUsd: null, revision: 2 })).toMatchObject({ state: 'paused' });
    budgets = createUsageBudgets({ dir });
    expect(await budgets.read(SID)).toMatchObject({ state: 'paused', reason: 'stop_failed' });
    expect(await budgets.markStopError(SID, null)).toMatchObject({ state: 'unlimited', spentUsd: 0.02, stopError: null, revision: 3 });
    expect(await budgets.configure(SID, { limitUsd: 0.01, revision: 3 })).toMatchObject({ state: 'paused', reason: 'budget_limit' });
  });

  it('clearing stop failure does not resolve unknown cost', async () => {
    await configure(1, [record({ upstream: undefined })]);
    expect(await budgets.markStopError(SID, 'Retry stop')).toMatchObject({ state: 'unverified', reason: 'stop_failed' });
    expect(await budgets.configure(SID, { limitUsd: 10, revision: 1 })).toMatchObject({ state: 'unverified', reason: 'stop_failed' });
    expect(await budgets.markStopError(SID, null)).toMatchObject({ state: 'unverified', reason: 'cost_unverified', stopError: null });
    await budgets.replaceBaseline(SID, { records: [record()], complete: true });
    expect(await budgets.read(SID)).toMatchObject({ state: 'active', spentUsd: 0.02 });
  });

  it('persists blind evidence failure and does not repair it from a different known response', async () => {
    await configure(1, [record()]);
    expect(await budgets.pauseUnverified(SID, 'evidence_unavailable')).toMatchObject({
      spentUsd: null, state: 'unverified', reason: 'evidence_unavailable', revision: 1,
    });
    budgets = createUsageBudgets({ dir });
    expect(await budgets.observe(SID, { record: record({ responseId: 'new' }) })).toMatchObject({ spentUsd: null, revision: 1 });
    expect(await budgets.replaceBaseline(SID, { records: [], complete: false })).toMatchObject({ spentUsd: null });
    expect(await budgets.replaceBaseline(SID, { records: [record()], complete: true })).toMatchObject({ spentUsd: 0.04, state: 'active', revision: 1 });
  });

  it('repairs a blind flag only with verified replacement of the same unknown identity', async () => {
    await configure(1, [record({ upstream: undefined })]);
    await budgets.pauseUnverified(SID);
    expect(await budgets.observe(SID, { record: record() })).toMatchObject({ spentUsd: 0.02, state: 'active', revision: 1 });
  });

  it.each(['canonical_unavailable', 'canonical_response_missing', 'source_changed', 'collection_failed', 'restartchecking'])
    ('does not clear a coverage hold %s when repairing one response', async (reason) => {
      await configure(1, [record({ upstream: undefined })]);
      await budgets.pauseUnverified(SID, reason);
      expect(await budgets.observe(SID, { record: record() })).toMatchObject({
        spentUsd: null, state: 'unverified', reason, revision: 1,
      });
      expect((await budgets.snapshot(SID)).knownSubtotalUsd).toBeCloseTo(0.02);
      budgets = createUsageBudgets({ dir });
      expect(await budgets.read(SID)).toMatchObject({ spentUsd: null, state: 'unverified', reason });
      expect(await budgets.clearCoverageHold(SID, 'different_reason')).toMatchObject({ spentUsd: null, reason, revision: 1 });
      expect(await budgets.clearCoverageHold(SID, reason)).toMatchObject({ spentUsd: 0.02, state: 'active', reason: null, revision: 1 });
    });

  it('clearing a coverage hold does not repair other unknown records or a failed stop', async () => {
    await configure(1, [record({ upstream: undefined })]);
    await budgets.pauseUnverified(SID, 'canonical_response_missing');
    expect(await budgets.clearCoverageHold(SID, 'canonical_response_missing')).toMatchObject({
      spentUsd: null, state: 'unverified', reason: 'cost_unverified', revision: 1,
    });
    await budgets.pauseUnverified(SID, 'collection_failed');
    await budgets.markStopError(SID, 'Stop failed');
    await budgets.observe(SID, { record: record() });
    expect(await budgets.clearCoverageHold(SID, 'collection_failed')).toMatchObject({
      spentUsd: 0.02, state: 'paused', reason: 'stop_failed', revision: 1,
    });
  });

  it('writes atomic private files, retains raw evidence and does not retain extra prompt fields', async () => {
    const input = { ...record(), prompt: 'Private input must not be stored', total_cost_usd: 99 };
    await configure(1, [input]);
    const file = path.join(dir, `${SID}.json`), journal = `${file}l`, bytes = await fs.readFile(journal, 'utf8');
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(journal)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(file)).size).toBeLessThan(200);
    expect((await fs.readdir(dir)).sort()).toEqual([`${SID}.json`, `${SID}.jsonl`]);
    expect(bytes).not.toContain('Private input');
    expect(bytes).not.toContain('total_cost_usd');
    expect(await budgets.records(SID)).toEqual([record()]);
    const output = await budgets.records(SID); output[0].output_tokens = 50_000;
    expect((await budgets.records(SID))[0].output_tokens).toBe(1_000);
  });

  it('retains opaque upstream identities across disk reload without storing account labels', async () => {
    const first = record({ responseId: 'first', upstream: { ...record().upstream!, evidenceId: 'a'.repeat(64) } });
    const second = record({ responseId: 'second', upstream: { ...record().upstream!, evidenceId: 'b'.repeat(64) } });
    await configure(1, [first, second]);
    budgets = createUsageBudgets({ dir });
    expect((await budgets.records(SID)).map(item => item.upstream?.evidenceId)).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
    expect((await budgets.records(SID)).map(item => item.upstream?.requestId)).toEqual(['request-a', 'request-a']);
    expect((await budgets.read(SID)).spentUsd).toBeCloseTo(0.04);
  });

  it('does not trust a stored cost from an old pricing version until evidence is repriced', async () => {
    await configure(1, [record()]);
    const file = path.join(dir, `${SID}.jsonl`), lines = (await fs.readFile(file, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
    lines.find(event => event.kind === 'response').entry.pricingVersion = 'old-price';
    const coldDir = path.join(dir, 'cold'); await fs.mkdir(coldDir);
    await fs.copyFile(path.join(dir, `${SID}.json`), path.join(coldDir, `${SID}.json`));
    await fs.writeFile(path.join(coldDir, `${SID}.jsonl`), lines.map(event => JSON.stringify(event)).join('\n') + '\n');
    budgets = createUsageBudgets({ dir: coldDir });
    expect(await budgets.read(SID)).toMatchObject({ spentUsd: null, state: 'unverified' });
    expect(await budgets.observe(SID, { record: record() })).toMatchObject({ spentUsd: 0.02, state: 'active', revision: 1 });
    expect((await budgets.snapshot(SID)).records[0].pricingVersion).toBe(PRICING_VERSION);
  });

  it('lists only configured budgets and never follows unrelated files, directories or symlinks', async () => {
    expect(await createUsageBudgets({ dir: path.join(dir, 'missing') }).listConfigured()).toEqual([]);
    await configure(1);
    await budgets.configure('session-b', { limitUsd: null, revision: 0 });
    await fs.writeFile(path.join(dir, 'unrelated.tmp'), 'not json');
    await fs.mkdir(path.join(dir, 'directory.json'));
    await fs.symlink(path.join(dir, `${SID}.json`), path.join(dir, 'alias.json'));
    await fs.writeFile(path.join(dir, '.unsafe.json'), 'not json');
    expect(await budgets.listConfigured()).toEqual([SID]);
    await expect(budgets.read('alias')).rejects.toMatchObject({ code: 'ELOOP' });
  });

  it.each([null, '', '.', '..', '../outside', 'a/b', 'a\\b', '/absolute', 'a\0b', 'a\nb', 'a b', '%2e%2e', 'x'.repeat(129)])
    ('rejects unsafe session id %j for every entry point', async (sid) => {
      const id = sid as string;
      for (const action of [() => budgets.read(id), () => budgets.configure(id, { limitUsd: 1, revision: 0 }),
        () => budgets.observe(id, { record: record() }), () => budgets.markStopError(id, null),
        () => budgets.pauseUnverified(id), () => budgets.replaceBaseline(id, { records: [], complete: true }),
        () => budgets.records(id), () => budgets.snapshot(id), () => budgets.summaries(id), () => budgets.clearCoverageHold(id, 'cost_unverified')]) {
        await expect(action()).rejects.toMatchObject({ code: 'BUDGET_INVALID_SESSION' });
      }
      expect(await fs.readdir(dir)).toEqual([]);
    });

  it.each(['55c993b1-3a53-4f2e-aed0-889cce6e8fb3', 'safe_id.v1', 'a..b'])
    ('accepts safe filename component %s', async (sid) => {
      expect(await budgets.configure(sid, { limitUsd: 0.01, revision: 0, baseline: { records: [], complete: true } }))
        .toMatchObject({ state: 'active', spentUsd: 0 });
    });

  it.each([0, 0.001, 0.009999, -1, NaN, Infinity, -Infinity, '1', undefined])
    ('rejects invalid limit %j without changing policy', async (limitUsd) => {
      await expect(budgets.configure(SID, { limitUsd: limitUsd as number, revision: 0 })).rejects.toMatchObject({ code: 'BUDGET_INVALID_LIMIT' });
      expect((await budgets.read(SID)).revision).toBe(0);
    });

  it.each([-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    ('rejects invalid policy revision %j', async (revision) => {
      await expect(budgets.configure(SID, { limitUsd: 1, revision })).rejects.toMatchObject({ code: 'BUDGET_INVALID_REVISION' });
    });

  it('rejects evidence for another session, rejects corrupt persistence and never silently resets', async () => {
    await configure(1, [record()]);
    await expect(budgets.observe(SID, { record: record({ sessionId: 'session-other' }) })).rejects.toMatchObject({ code: 'BUDGET_INVALID_EVIDENCE' });
    expect((await budgets.read(SID)).spentUsd).toBe(0.02);
    const coldDir = path.join(dir, 'cold'); await fs.mkdir(coldDir);
    const file = path.join(coldDir, `${SID}.json`);
    await fs.writeFile(file, '{broken');
    const cold = createUsageBudgets({ dir: coldDir });
    await expect(cold.read(SID)).rejects.toMatchObject({ code: 'BUDGET_CORRUPT' });
    await expect(cold.configure(SID, { limitUsd: 5, revision: 0 })).rejects.toMatchObject({ code: 'BUDGET_CORRUPT' });
    expect(await fs.readFile(file, 'utf8')).toBe('{broken');
  });

  it('does not claim success when marker rename fails and retries without a leaked temp', async () => {
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('Disk failure'), { code: 'EIO' }));
    await expect(budgets.configure(SID, { limitUsd: 2, revision: 0 })).rejects.toMatchObject({ code: 'EIO' });
    rename.mockRestore();
    expect(await budgets.read(SID)).toMatchObject({ limitUsd: null, spentUsd: null, revision: 0 });
    expect(await fs.readdir(dir)).toEqual([`${SID}.jsonl`]);
    expect(await budgets.configure(SID, { limitUsd: 2, revision: 0 })).toMatchObject({ limitUsd: 2, revision: 1 });
    expect((await fs.readdir(dir)).sort()).toEqual([`${SID}.json`, `${SID}.jsonl`]);
  });

  it('syncs the marker directory once before appending policy and evidence', async () => {
    const original = fs.open.bind(fs);
    const sync = vi.fn(async () => {}), close = vi.fn(async () => {});
    const open = vi.spyOn(fs, 'open').mockImplementation(((file, ...args) => file === dir
      ? Promise.resolve({ sync, close } as unknown as Awaited<ReturnType<typeof fs.open>>)
      : original(file, ...args)) as typeof fs.open);
    await durableBudgetDirectory(dir);
    sync.mockClear(); close.mockClear();
    await configure(1, [record()]);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    await budgets.observe(SID, { record: record({ responseId: 'next' }) });
    expect(sync).toHaveBeenCalledTimes(1);
    open.mockRestore();
  });

  it('rejects directory sync failure and retries it before claiming a saved budget', async () => {
    await durableBudgetDirectory(dir);
    const original = fs.open.bind(fs);
    const sync = vi.fn().mockRejectedValueOnce(Object.assign(new Error('Directory sync failed'), { code: 'EIO' }))
      .mockResolvedValue(undefined);
    const close = vi.fn(async () => {});
    const open = vi.spyOn(fs, 'open').mockImplementation(((file, ...args) => file === dir
      ? Promise.resolve({ sync, close } as unknown as Awaited<ReturnType<typeof fs.open>>)
      : original(file, ...args)) as typeof fs.open);
    await expect(configure(1, [record()])).rejects.toMatchObject({ code: 'EIO' });
    expect(await fs.readFile(path.join(dir, `${SID}.jsonl`), 'utf8')).toBe('');
    expect(await budgets.read(SID)).toMatchObject({ limitUsd: null, revision: 0 });
    expect(await configure(1, [record()])).toMatchObject({ limitUsd: 1, spentUsd: 0.02, revision: 1 });
    expect(sync).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
    open.mockRestore();
  });

  it('syncs an existing cold marker before the first new event after a restart', async () => {
    await configure(1, [record()]);
    const coldDir = path.join(dir, 'cold-marker'); await fs.mkdir(coldDir);
    await fs.copyFile(path.join(dir, `${SID}.json`), path.join(coldDir, `${SID}.json`));
    await fs.copyFile(path.join(dir, `${SID}.jsonl`), path.join(coldDir, `${SID}.jsonl`));
    await durableBudgetDirectory(coldDir);
    const original = fs.open.bind(fs), sync = vi.fn(async () => {}), close = vi.fn(async () => {});
    const open = vi.spyOn(fs, 'open').mockImplementation(((file, ...args) => file === coldDir
      ? Promise.resolve({ sync, close } as unknown as Awaited<ReturnType<typeof fs.open>>)
      : original(file, ...args)) as typeof fs.open);
    const cold = createUsageBudgets({ dir: coldDir });
    expect(await cold.observe(SID, { record: record({ responseId: 'cold-new' }) })).toMatchObject({ spentUsd: 0.04 });
    expect(sync).toHaveBeenCalledTimes(1);
    await cold.observe(SID, { record: record({ responseId: 'cold-next' }) });
    expect(sync).toHaveBeenCalledTimes(1);
    open.mockRestore();
  });

  it('durably creates a new nested budget directory and retries failed ancestor sync', async () => {
    const directory = '/fixture/budgets/nested', opened: string[] = [];
    const sync = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Ancestor sync failed'))
      .mockResolvedValue(undefined);
    const close = vi.fn(async () => {}), mkdir = vi.fn().mockResolvedValueOnce('/fixture/budgets').mockResolvedValue(undefined);
    const io = { mkdir, open: vi.fn(async (name: string) => { opened.push(name); return { sync, close }; }) };
    const persistence = createBudgetPersistence(io as unknown as Parameters<typeof createBudgetPersistence>[0], path.posix);
    await expect(persistence.ensureDirectory(directory)).rejects.toThrow('Ancestor sync failed');
    expect(opened).toEqual(['/fixture/budgets/nested', '/fixture/budgets']);
    await persistence.ensureDirectory(directory);
    expect(opened.slice(2)).toEqual(['/fixture/budgets/nested', '/fixture/budgets', '/fixture', '/']);
    const calls = sync.mock.calls.length;
    await persistence.ensureDirectory(directory);
    expect(sync).toHaveBeenCalledTimes(calls);
    expect(close).toHaveBeenCalledTimes(calls);
  });

  it('reads cached summaries without disk I/O and appends bounded events instead of rewriting history', async () => {
    await configure(20, Array.from({ length: 250 }, (_, index) => record({ responseId: `cached-${index}` })));
    const journal = path.join(dir, `${SID}.jsonl`), before = await fs.readFile(journal, 'utf8');
    const open = vi.spyOn(fs, 'open');
    const second = createUsageBudgets({ dir });
    for (let index = 0; index < 20; index++) await second.read(SID);
    expect(open).not.toHaveBeenCalled();
    await second.observe(SID, { record: record({ responseId: 'next' }) });
    open.mockRestore();
    const after = await fs.readFile(journal, 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(Buffer.byteLength(after) - Buffer.byteLength(before)).toBeLessThan(4_000);
  });

  it('returns small model and agent summaries without returning canonical response arrays', async () => {
    await configure(1, [record(), record({ responseId: 'worker', agentId: 'worker-a', upstream: undefined })]);
    const summary = await budgets.summaries(SID);
    expect(summary).toMatchObject({ budget: { spentUsd: null }, verifiedCalls: 1, unverifiedCalls: 1,
      byModel: [{ name: 'claude-opus-5-5', calls: 2, verifiedCalls: 1, unverifiedCalls: 1, costUsd: null }],
      byAgent: [{ name: 'main', calls: 1, verifiedCalls: 1, unverifiedCalls: 0, costUsd: 0.02 },
        { name: 'subagent', calls: 1, verifiedCalls: 0, unverifiedCalls: 1, costUsd: null }] });
    expect(summary).not.toHaveProperty('records');
    summary.byModel[0].calls = 99;
    expect((await budgets.summaries(SID)).byModel[0].calls).toBe(2);
  });

  it('incrementally repairs summary costs, counts, corrections and agent ownership with replay parity', async () => {
    await configure(1, [record(), record({ responseId: 'unknown', upstream: undefined })]);
    expect((await budgets.summaries(SID)).byModel[0]).toMatchObject({ calls: 2, verifiedCalls: 1, costUsd: null });
    await budgets.observe(SID, { record: record({ responseId: 'unknown' }) });
    expect((await budgets.summaries(SID)).byModel[0]).toMatchObject({ calls: 2, verifiedCalls: 2, unverifiedCalls: 0, costUsd: 0.04 });
    const correction = record({ responseId: 'unknown', agentId: 'worker-a', output_tokens: 2_000 });
    await budgets.observe(SID, { record: correction });
    const summary = await budgets.summaries(SID);
    expect(summary.byAgent).toEqual([
      { name: 'main', calls: 1, verifiedCalls: 1, unverifiedCalls: 0, costUsd: 0.02 },
      { name: 'subagent', calls: 1, verifiedCalls: 1, unverifiedCalls: 0, costUsd: 0.04 },
    ]);
    expect(summary.byModel[0].costUsd).toBeCloseTo(0.06);
    await budgets.observe(SID, { record: correction });
    expect(await budgets.summaries(SID)).toEqual(summary);
    const coldDir = path.join(dir, 'summary-cold'); await fs.mkdir(coldDir);
    for (const suffix of ['json', 'jsonl']) await fs.copyFile(path.join(dir, `${SID}.${suffix}`), path.join(coldDir, `${SID}.${suffix}`));
    expect(await createUsageBudgets({ dir: coldDir }).summaries(SID)).toEqual(summary);
    await budgets.observe(SID, { record: record({ responseId: 'unknown', upstream: undefined }) });
    expect((await budgets.summaries(SID)).byAgent).toEqual([
      { name: 'main', calls: 2, verifiedCalls: 1, unverifiedCalls: 1, costUsd: null },
    ]);
  });

  it('stream-replays journals into a new store and fails closed on missing, torn or reordered journals', async () => {
    await configure(1, [record()]);
    for (const variant of ['valid', 'missing', 'torn', 'reordered'] as const) {
      const coldDir = path.join(dir, variant); await fs.mkdir(coldDir);
      await fs.copyFile(path.join(dir, `${SID}.json`), path.join(coldDir, `${SID}.json`));
      const journal = await fs.readFile(path.join(dir, `${SID}.jsonl`), 'utf8');
      if (variant !== 'missing') {
        const lines = journal.trimEnd().split('\n');
        if (variant === 'reordered') lines.reverse();
        await fs.writeFile(path.join(coldDir, `${SID}.jsonl`), variant === 'torn' ? journal.slice(0, -1) : lines.join('\n') + '\n');
      }
      const cold = createUsageBudgets({ dir: coldDir });
      if (variant === 'valid') {
        expect(await cold.read(SID)).toMatchObject({ limitUsd: 1, spentUsd: 0.02, revision: 1 });
        expect(await cold.records(SID)).toEqual([record()]);
      } else await expect(cold.read(SID)).rejects.toMatchObject({ code: 'BUDGET_CORRUPT' });
    }
  });

  it('reports append failures and replays committed history before allowing a retry', async () => {
    await configure(1, [record()]);
    const open = vi.spyOn(fs, 'open');
    open.mockImplementationOnce((...args) => Promise.reject(Object.assign(new Error('Write failed'), { code: 'EIO' })));
    await expect(budgets.observe(SID, { record: record({ responseId: 'next' }) })).rejects.toMatchObject({ code: 'EIO' });
    open.mockRestore();
    expect(await budgets.read(SID)).toMatchObject({ spentUsd: 0.02, revision: 1 });
    expect(await budgets.observe(SID, { record: record({ responseId: 'next' }) })).toMatchObject({ spentUsd: 0.04, revision: 1 });
  });

  it('retains a dense lifetime baseline across concurrent additions and restart', async () => {
    const records = Array.from({ length: 250 }, (_, index) => record({ responseId: `msg-${index}` }));
    expect(await configure(20, records)).toMatchObject({ state: 'active', revision: 1 });
    await Promise.all(Array.from({ length: 10 }, (_, index) => budgets.observe(SID, {
      record: record({ responseId: `new-${index}` }),
    })));
    budgets = createUsageBudgets({ dir });
    expect((await budgets.read(SID)).spentUsd).toBeCloseTo(5.2);
    expect(await budgets.records(SID)).toHaveLength(260);
    expect((await budgets.read(SID)).revision).toBe(1);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUsageBudgetIndex } from '../../src/providers/usage-budget-index.js';
import { reconcileUsage, reconcileUsageAsync, type ProxyUsageRecord } from '../../src/providers/usage-reconcile-core.js';
import type { CanonicalUsageRecord } from '../../src/providers/usage-scan-core.js';

const START = Date.parse('2026-10-12T12:00:00Z');
const TOKENS = { input_tokens: 19, output_tokens: 47, cache_creation_input_tokens: 0, cache_read_input_tokens: 8_500 };
function canonical(id: string, offset: number, extra: Partial<CanonicalUsageRecord> = {}): CanonicalUsageRecord {
  return { responseId: id, model: 'claude-opus-4-6', sessionId: 'session-a', timestamp: new Date(START + offset).toISOString(),
    ...TOKENS, complete: true, ...extra };
}
function proxy(id: string, start: number, finish = start + 1_000, extra: Partial<ProxyUsageRecord> = {}): ProxyUsageRecord {
  return { source: 'proxy', evidenceId: id, requestId: id, sessionId: 'session-a', model: 'claude-opus-4-6',
    requestedModel: 'claude-opus-4-6', responseModel: 'claude-opus-4-6', forwardedModel: 'claude-opus-4-6',
    startedMs: START + start, finishedMs: START + finish, usagePresent: true, complete: true,
    fileIndex: 0, lineNumber: 1, ...TOKENS, ...extra };
}
const key = (row: CanonicalUsageRecord) => JSON.stringify([row.model, row.responseId]);
const byResponse = <T extends CanonicalUsageRecord>(rows: readonly T[]) => [...rows].sort((a, b) => a.responseId.localeCompare(b.responseId));
afterEach(() => vi.restoreAllMocks());

describe('createUsageBudgetIndex', () => {
  it('retains unmatched baseline responses and upstream-only session coverage', async () => {
    const index = createUsageBudgetIndex({ sessionId: 'session-a' });
    const row = canonical('unmatched', 1_000), evidence = proxy('only-proxy', 20_000);
    const baseline = await index.replaceBaseline([row], [evidence, proxy('unattributed', 30_000, 31_000, { sessionId: null })]);
    expect(baseline.changed).toEqual(reconcileUsage([row], []).records);
    expect(baseline.hasSessionResidual).toBe(true);
    expect(baseline.pendingIdentities.has(key(row))).toBe(true);
    expect(baseline.pendingIdentities).not.toHaveProperty('add');
    const matched = await index.update([canonical('arrived', 21_000)], [proxy('late-evidence', 0)]);
    expect(matched.changed.every(row => row.verification === 'matched')).toBe(true);
    expect(matched.hasSessionResidual).toBe(false);
    expect(matched.pendingIdentities.size).toBe(0);
    expect(baseline.pendingIdentities.size).toBe(0);
  });

  it('changes old matches when canonical responses or proxy evidence arrive out of order', async () => {
    const index = createUsageBudgetIndex();
    const late = canonical('late', 9_000), earlier = canonical('earlier', 5_000);
    const evidence = proxy('wide', 0, 5_000);
    await index.replaceBaseline(reconcileUsage([late], [evidence]).records);
    const added = await index.update([earlier], []);
    expect(added.changed).toEqual(reconcileUsage([late, earlier], [evidence]).records);
    expect(added.pendingIdentities.has(key(late))).toBe(true);
    const nextEvidence = proxy('early-finish', 0, 4_000);
    const repaired = await index.update([], [nextEvidence]);
    expect(repaired.changed).toEqual(reconcileUsage([late, earlier], [evidence, nextEvidence]).records);
    expect(repaired.pendingIdentities.size).toBe(0);
  });

  it('preserves stable ties and the earliest-compatible-finish greedy choice', async () => {
    const index = createUsageBudgetIndex();
    const rows = [canonical('first', 5_000), canonical('second', 5_000), canonical('later', 10_000)];
    const evidence = [proxy('later-finish', 0, 5_000), proxy('earlier-finish', 0, 4_000)];
    const actual = await index.replaceBaseline(rows, evidence);
    expect(byResponse(actual.changed)).toEqual(byResponse(reconcileUsage(rows, evidence).records));
    expect(['first', 'second', 'later'].map(id => actual.changed.find(row => row.responseId === id)?.upstream?.requestId))
      .toEqual(['earlier-finish', 'later-finish', undefined]);
  });

  it('uses full upstream tie order before embedded baseline matches from shuffled canonical rows', async () => {
    const rows = [canonical('late', 8_000), canonical('early', 5_000)];
    const evidence = [proxy('first-route', 0, 10_000, { forwardedModel: 'global.anthropic.claude-opus-4-6' }),
      proxy('second-route', 0, 10_000, { forwardedModel: 'claude-opus-4-6' })];
    const index = createUsageBudgetIndex();
    const baseline = reconcileUsage(rows, evidence);
    expect(baseline.records[0].upstream?.requestId).toBe('second-route');
    const initial = await index.replaceBaseline(baseline.records, evidence);
    expect(byResponse(initial.changed)).toEqual(byResponse(baseline.records));
    const earlier = canonical('earliest', 3_000);
    const result = await index.update([earlier], []);
    const expected = reconcileUsage([...rows, earlier], evidence);
    expect(byResponse(result.changed)).toEqual(byResponse(expected.records));
    expect(result.changed.find(row => row.responseId === 'earliest')?.upstream?.forwardedModel)
      .toBe('global.anthropic.claude-opus-4-6');
  });

  it('keeps proxy conflicts sticky across batches and splits only their affected component', async () => {
    const index = createUsageBudgetIndex();
    const rows = [canonical('one', 1_000), canonical('stable', 50_000)];
    const evidence = [proxy('one-p', 0), proxy('stable-p', 49_000)];
    await index.replaceBaseline(rows, evidence);
    const conflict = await index.update([], [{ ...evidence[0], output_tokens: 48 }]);
    expect(conflict.changed.map(row => [row.responseId, row.verification])).toEqual([['one', 'unmatched']]);
    expect(conflict.work.canonical).toBe(1);
    expect(conflict.hasSessionResidual).toBe(true);
    const repeat = await index.update([], [evidence[0]]);
    expect(repeat.changed).toEqual([]);
    expect(repeat.hasSessionResidual).toBe(true);
    expect(repeat.pendingIdentities.has(key(rows[0]))).toBe(true);
  });

  it('preserves baseline ownership, timestamp and incomplete identity while reporting counter corrections', async () => {
    const index = createUsageBudgetIndex();
    const owned = canonical('owned', 1_000, { agentId: 'original-agent' });
    const held = canonical('held', 30_000, { complete: false, agentId: 'original-agent' });
    await index.replaceBaseline([owned, held], [proxy('owned-p', 0)]);
    const correction = { ...owned, timestamp: new Date(START + 90_000).toISOString(), sessionId: 'foreign', agentId: 'copied-agent', output_tokens: 48 };
    const result = await index.update([correction, { ...held, complete: true }], [proxy('corrected-p', 0, 1_000, { output_tokens: 48 })]);
    const changed = result.changed.find(row => row.responseId === 'owned')!;
    expect(changed).toMatchObject({ verification: 'matched', output_tokens: 48, timestamp: owned.timestamp, sessionId: owned.sessionId, agentId: 'original-agent' });
    expect(result.pendingIdentities.has(key(held))).toBe(true);
    expect(result.changed.some(row => row.responseId === 'held' && row.complete)).toBe(false);
  });

  it('does not traverse or clone stable history for an isolated new response', async () => {
    const index = createUsageBudgetIndex();
    const rows = Array.from({ length: 2_000 }, (_, i) => canonical(`history-${i}`, i * 20_000));
    const evidence = rows.map((_, i) => proxy(`p-${i}`, i * 20_000));
    await index.replaceBaseline(rows, evidence);
    for (const row of rows) Object.defineProperty(row, 'timestamp', { get() { throw new Error('Stable history was reread'); } });
    const next = canonical('new', 50_000_000);
    const result = await index.update([next], [proxy('new-p', 49_999_000)]);
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0].verification).toBe('matched');
    expect(result.work).toMatchObject({ canonical: 1, proxy: 1, components: 1 });
    expect(result.work.entryVisits).toBeLessThan(40);
    expect((await index.update([], [])).work).toEqual({ canonical: 0, proxy: 0, components: 0, entryVisits: 0 });
  });

  it('matches the whole matcher after repeated shuffled multi-group deltas', async () => {
    const index = createUsageBudgetIndex({ sessionId: 'session-a' });
    const allRows: CanonicalUsageRecord[] = [], allProxy: ProxyUsageRecord[] = [];
    const actual = new Map<string, ReturnType<typeof reconcileUsage>['records'][number]>();
    let seed = 41;
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
    for (let round = 0; round < 60; round++) {
      const time = random() % 80_000, counter = random() % 3;
      const row = canonical(`response-${round}`, time, { input_tokens: counter });
      const evidence = proxy(`proxy-${round}`, random() % 80_000, 80_000, { input_tokens: random() % 3 });
      allRows.push(row); allProxy.push(evidence);
      const result = await index.update([row], [evidence]);
      for (const record of result.changed) actual.set(key(record), record);
      const expected = reconcileUsage(allRows, allProxy);
      expect([...actual.values()].sort((a, b) => a.responseId.localeCompare(b.responseId)))
        .toEqual([...expected.records].sort((a, b) => a.responseId.localeCompare(b.responseId)));
      expect(result.hasSessionResidual).toBe(expected.upstreamUnmatched.length > 0);
      expect(result.pendingIdentities.size).toBe(expected.records.filter(row => row.verification !== 'matched').length);
    }
  });

  it('holds a first unknown response until independent proxy evidence arrives', async () => {
    const index = createUsageBudgetIndex();
    const row = canonical('new', 1_000);
    const first = await index.update([row], []);
    expect(first.changed[0].verification).toBe('unmatched');
    expect(first.pendingIdentities.has(key(row))).toBe(true);
    const late = await index.update([], [proxy('late', 0)]);
    expect(late.changed).toEqual(reconcileUsage([row], [proxy('late', 0)]).records);
    expect(late.pendingIdentities.size).toBe(0);
  });

  it('equals full reconciliation through deterministic counter, timestamp and proxy conflict mutations', async () => {
    const index = createUsageBudgetIndex({ sessionId: 'session-a' });
    const canonicalState = new Map<string, CanonicalUsageRecord>(), proxyState = new Map<string, ProxyUsageRecord>();
    const actual = new Map<string, ReturnType<typeof reconcileUsage>['records'][number]>();
    const fields = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const;
    let seed = 91;
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
    for (let round = 0; round < 100; round++) {
      const id = `response-${random() % 12}`, time = random() % 60_000;
      const delta = canonical(id, time, { input_tokens: random() % 3, output_tokens: random() % 4,
        ...(round % 17 === 0 ? { complete: false } : {}) });
      const previous = canonicalState.get(key(delta));
      canonicalState.set(key(delta), previous ? { ...delta, timestamp: previous.timestamp, sessionId: previous.sessionId,
        agentId: previous.agentId, complete: previous.complete === false ? false : delta.complete } : delta);
      const evidence = proxy(`proxy-${random() % 12}`, random() % 60_000, 65_000, {
        input_tokens: random() % 3, output_tokens: random() % 4,
      });
      const old = proxyState.get(evidence.evidenceId!);
      if (!old) proxyState.set(evidence.evidenceId!, evidence);
      else {
        const conflict = old.model !== evidence.model || old.sessionId !== evidence.sessionId
          || old.forwardedModel !== evidence.forwardedModel || old.finishedMs !== evidence.finishedMs
          || fields.some(field => old[field] !== evidence[field]);
        const next = conflict || !old.complete || !evidence.complete ? { ...old, complete: false } : old;
        for (const field of fields) if (old[field] !== evidence[field]) next[field] = null;
        proxyState.set(evidence.evidenceId!, next);
      }
      const result = await index.update([delta], [evidence]);
      for (const record of result.changed) actual.set(key(record), record);
      const expected = reconcileUsage([...canonicalState.values()], [...proxyState.values()]);
      expect(byResponse([...actual.values()])).toEqual(byResponse(expected.records));
      expect(result.pendingIdentities.size).toBe(expected.records.filter(row => row.verification !== 'matched').length);
      expect(result.hasSessionResidual).toBe(expected.upstreamUnmatched.length > 0);
    }
  });

  it('cooperatively sorts and matches a large connected component with shared sync semantics', async () => {
    const rows = Array.from({ length: 400 }, (_, i) => canonical(`row-${i}`, i));
    const evidence = rows.map((_, i) => proxy(`proxy-${i}`, 0, 10_000));
    let calls = 0;
    vi.spyOn(process, 'cpuUsage').mockImplementation(() => ({ user: calls++ * 5_001, system: 0 }));
    const actual = await createUsageBudgetIndex().replaceBaseline(rows, evidence);
    expect(byResponse(actual.changed)).toEqual(byResponse(reconcileUsage(rows, evidence).records));
    expect(calls).toBeGreaterThan(50);
    expect(await reconcileUsageAsync(rows, evidence)).toEqual(reconcileUsage(rows, evidence));
  });
});

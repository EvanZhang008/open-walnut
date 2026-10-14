import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { ResponseUsageStore, type UsageEvidence } from '../../../src/core/usage/response-store.js';
import { reconcileUsage, type ProxyUsageRecord } from '../../../src/providers/usage-reconcile-core.js';
import type { CanonicalUsageRecord } from '../../../src/providers/usage-scan-core.js';

const roots: string[] = [];
const stores: ResponseUsageStore[] = [];
afterEach(() => { stores.forEach(s => s.close()); roots.forEach(r => rmSync(r, { recursive: true, force: true })); stores.length = roots.length = 0; });
function store() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'response-usage-')); roots.push(root);
  const result = new ResponseUsageStore(path.join(root, 'usage.sqlite')); stores.push(result); return result;
}
function record(id = 'reply-1'): CanonicalUsageRecord {
  return { responseId: id, sessionId: 'session-one', model: 'claude-opus-5-5', timestamp: '2026-10-13T12:00:00Z',
    input_tokens: 2, output_tokens: 1711, cache_creation_input_tokens: 460039, cache_read_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 460039 }, complete: true,
    speed: 'standard', inference_geo: '', service_tier: 'standard', pricing_context_complete: true };
}
function evidence(canonical: CanonicalUsageRecord[], match = true): UsageEvidence {
  const upstream: ProxyUsageRecord[] = match ? canonical.map(r => ({ ...r, source: 'proxy', requestId: r.responseId,
    model: r.model, requestedModel: r.model, responseModel: r.model, forwardedModel: `global.anthropic.${r.model}`,
    startedMs: Date.parse(r.timestamp) - 1000, finishedMs: Date.parse(r.timestamp), usagePresent: true,
    fileIndex: 0, lineNumber: 1 })) : [];
  return { canonical: { records: canonical, diagnostics: {} as UsageEvidence['canonical']['diagnostics'], costStates: [] },
    upstream: { records: upstream, diagnostics: [], coverage: {} as UsageEvidence['upstream']['coverage'] },
    reconciliation: reconcileUsage(canonical, upstream), until: '2026-10-14T00:00:00Z' };
}
const owners = [{ sessionId: 'session-one', title: 'Review the change', taskId: 'task-one', project: 'Example' }];

describe('response-level usage storage', () => {
  it('stores only matched token prices as verified cost', async () => {
    const s = store(); await s.importHost('local', evidence([record()]), owners);
    const result = s.getOverview({});
    expect(result.summary.total_cost).toBeCloseTo(3.71454, 8);
    expect(result.recent[0].cache_creation_input_tokens).toBe(460039);
    expect(result.summary.token_counts_complete).toBe(true);
    expect(result.summary.verified_calls).toBe(1);
    expect(result.summary.session_cost).toBeCloseTo(3.71454, 8);
    expect(result.sessions[0]).toMatchObject({ title: 'Review the change', taskId: 'task-one' });
  });
  it('reports token matches separately from price verification', async () => {
    const s = store(); const imported = await s.importHost('local', evidence([{ ...record(), pricing_context_complete: false }]), owners);
    s.finishHost('local', '2026-10-14T00:00:00Z', imported.checks);
    const checks = s.getOverview({}).accuracy.checks;
    expect(checks.find(c => c.source === 'Canonical transcript')?.matchedCalls).toBe(1);
    expect(s.getOverview({}).summary.verified_calls).toBe(0);
  });
  it('does not publish an unmatched price as a number', async () => {
    const s = store(); await s.importHost('local', evidence([record()], false), owners);
    const result = s.getOverview({});
    expect(result.summary.verified_calls).toBe(0);
    expect(result.summary.unverified_calls).toBe(1);
    expect(result.recent[0]?.cost_usd).toBeNull();
    expect(result.recent[0]?.verification).toBe('unverified');
  });
  it('rechecks are idempotent and can resolve missing evidence', async () => {
    const s = store(); await s.importHost('local', evidence([record()], false), owners);
    await s.importHost('local', evidence([record()]), owners);
    await s.importHost('local', evidence([record()]), owners);
    expect(s.getOverview({}).summary).toMatchObject({ api_calls: 1, verified_calls: 1, unverified_calls: 0 });
  });
  it('unknown models and incomplete counters never become zero-priced verified calls', async () => {
    const s = store(); await s.importHost('local', evidence([{ ...record(), model: 'unknown-model' }]), owners);
    await s.importHost('local', evidence([{ ...record('reply-2'), input_tokens: null, complete: false }]), owners);
    const result = s.getOverview({});
    expect(result.summary.verified_calls).toBe(0);
    expect(result.recent.every(r => r.cost_usd === null)).toBe(true);
    expect(result.recent.some(r => r.input_tokens === null)).toBe(true);
    expect(result.summary.token_counts_complete).toBe(false);
    expect(result.byModel.some(r => r.token_counts_complete === false)).toBe(true);
  });
  it('keeps session totals and model breakdown unknown when only a portion is verified', async () => {
    const s = store(); await s.importHost('local', evidence([record()]), owners);
    await s.importHost('local', evidence([{ ...record('reply-2'), agentId: 'example-agent' }], false), owners);
    expect(s.getSessionUsage('session-one')).toMatchObject({ verifiedCostUsd: null, verifiedCalls: 1, unverifiedCalls: 1 });
    expect(s.getSessionUsage('session-one').byModel[0].costUsd).toBeNull();
    expect(s.getSessionUsage('session-one').byAgent).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent: 'main', unverifiedCalls: 0 }),
      expect.objectContaining({ agent: 'subagent', costUsd: null, unverifiedCalls: 1 }),
    ]));
  });
  it('updates ownership and dates without duplicate charges when evidence is corrected', async () => {
    const s = store(); await s.importHost('local', evidence([record()]), owners);
    await s.importHost('local', evidence([{ ...record(), timestamp: '2026-10-12T12:00:00Z' }]),
      [{ ...owners[0], title: 'Corrected title', taskId: 'task-two' }]);
    expect(s.getOverview({}).summary.api_calls).toBe(1);
    expect(s.getOverview({}).sessions[0]).toMatchObject({ title: 'Corrected title', taskId: 'task-two' });
    expect(s.getOverview({ startDate: '2026-10-13' }).summary.api_calls).toBe(0);
  });
  it('keeps matched tokens unpriced when the provider route or pricing context is unknown', async () => {
    const s = store();
    await s.importHost('local', evidence([{ ...record(), pricing_context_complete: false }]), owners);
    const result = s.getOverview({});
    expect(result.summary.verified_calls).toBe(0);
    expect(result.recent[0]).toMatchObject({ verification: 'unpriced', cost_usd: null });
  });
  it('keeps legacy turn records as audit evidence without adding their inflated dollars or counts', async () => {
    const s = store(); await s.importHost('local', evidence([record()]), owners);
    const db = new Database(path.join(roots[0], 'usage.sqlite'));
    db.exec(`CREATE TABLE usage (source TEXT, model TEXT, timestamp TEXT, date TEXT, agent_id TEXT, cost_usd REAL);
      INSERT INTO usage VALUES ('session','claude-opus-5-5','2026-10-13T12:00:00Z','2026-10-13','main',690);`);
    db.close();
    const result = s.getOverview({ startDate: '2026-10-13', endDate: '2026-10-13' });
    expect(result.summary).toMatchObject({ api_calls: 1, verified_calls: 1, legacy_records: 1 });
    expect(result.summary.total_cost).toBeCloseTo(3.71454, 8);
    expect(result.accuracy.checks.some(c => c.detail.includes('retained for audit'))).toBe(true);
    expect(s.getOverview({ agentId: 'subagent' }).summary.legacy_records).toBe(0);
  });
  it('does not advance the collection cutoff on a partial import followed by failure', async () => {
    const s = store(); const first = await s.importHost('local', evidence([record()]), owners);
    s.finishHost('local', '2026-10-13T00:00:00Z', first.checks);
    await s.importHost('local', evidence([record('reply-2')]), owners);
    s.markHostUnavailable('local', 'Next page timed out');
    expect(s.getOverview({}).accuracy.until).toBe('2026-10-13T00:00:00Z');
    expect(s.getOverview({}).accuracy.checks[0].status).toBe('unverified');
  });
  it('hides stale price verification until responses are repriced with the current table', async () => {
    const s = store(); await s.importHost('local', evidence([record()]), owners);
    const db = new Database(path.join(roots[0], 'usage.sqlite'));
    db.prepare("UPDATE response_usage SET pricing_version='previous'").run(); db.close();
    const result = s.getOverview({});
    expect(result.summary).toMatchObject({ verified_calls: 0, unverified_calls: 1, total_cost: 0 });
    expect(result.recent[0].cost_usd).toBeNull();
    expect(result.bySource[0].unverified_calls).toBe(1);
    await s.importHost('local', evidence([record()]), owners);
    expect(s.getOverview({}).summary.verified_calls).toBe(1);
  });
  it('keeps the same response on different hosts separate and groups subagents once', async () => {
    const s = store(); await s.importHost('local', evidence([{ ...record(), agentId: 'agent-one' }]), owners);
    await s.importHost('remote', evidence([record()]), owners);
    const result = s.getOverview({});
    expect(result.summary.api_calls).toBe(2);
    expect(result.byAgent.map(x => x.name).sort()).toEqual(['main', 'subagent']);
    expect(result.summary.total_cost).toBeCloseTo(7.42908, 8);
  });
});

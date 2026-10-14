import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('response-usage-e2e'));
import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { responseUsageStore } from '../../src/core/usage/collection.js';
import { reconcileUsage, type ProxyUsageRecord } from '../../src/providers/usage-reconcile-core.js';
import type { CanonicalUsageRecord } from '../../src/providers/usage-scan-core.js';

let port: number;
beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  const server = await startServer({ port: 0, dev: true });
  port = (server.address() as { port: number }).port;
  const timestamp = new Date().toISOString();
  const records: CanonicalUsageRecord[] = [1, 2, 3].map(n => ({ responseId: `reply-${n}`, sessionId: 'session-one',
    timestamp, model: 'claude-opus-5-5', input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0, complete: true, speed: 'standard', inference_geo: '', service_tier: 'standard', pricing_context_complete: true, ...(n === 2 ? { agentId: 'agent-one' } : {}) }));
  const upstream: ProxyUsageRecord[] = records.slice(0, 2).map(r => ({ ...r, source: 'proxy', requestId: r.responseId,
    requestedModel: r.model, responseModel: r.model, forwardedModel: `global.anthropic.${r.model}`, startedMs: Date.parse(timestamp) - 100,
    finishedMs: Date.parse(timestamp), usagePresent: true, fileIndex: 0, lineNumber: 1 }));
  const imported = await responseUsageStore().importHost('local', {
    canonical: { records, diagnostics: {} as never, costStates: [] },
    upstream: { records: upstream, diagnostics: [], coverage: {} as never },
    reconciliation: reconcileUsage(records, upstream), until: timestamp,
  }, [{ sessionId: 'session-one', taskId: 'task-one', project: 'Example', title: 'Review the change' }]);
  responseUsageStore().finishHost('local', timestamp, imported.checks);
});
afterAll(async () => { responseUsageStore().close(); await stopServer(); await fs.rm(WALNUT_HOME, { recursive: true, force: true }); });
async function get(path: string) {
  const result = await fetch(`http://127.0.0.1:${port}${path}`); expect(result.status).toBe(200); return result.json();
}

describe('reconciled usage through the real server', () => {
  it('includes coding sessions and publishes only verified prices', async () => {
    const body = await get('/api/usage/overview');
    expect(body.summary).toMatchObject({ api_calls: 3, verified_calls: 2, unverified_calls: 1 });
    expect(body.summary.total_cost).toBeCloseTo(0.0016, 8);
    expect(body.summary.session_cost).toBeCloseTo(0.0016, 8);
    expect(body.sessions[0].title).toBe('Review the change');
    expect(body.recent.filter((r: { cost_usd: number | null }) => r.cost_usd === null)).toHaveLength(1);
  });
  it('exposes independent-source residuals instead of hiding them', async () => {
    const body = await get('/api/usage/overview');
    const check = body.accuracy.checks.find((x: { source: string }) => x.source === 'Canonical transcript');
    expect(check.unmatchedCalls).toBe(1);
    expect(check.residuals[0]).toMatchObject({ source: 'canonical', count: 1, input_tokens: 100 });
    expect(body.accuracy.checks.find((x: { source: string }) => x.source === 'Provider invoice').status).toBe('unverified');
  });
  it('rejects invalid collection windows without starting a scan', async () => {
    for (const body of [{ since: 'invalid' }, { since: '2026-10-14' },
      { since: '2026-10-14T12:00:00Z', until: '2026-10-13T12:00:00Z' }]) {
      const response = await fetch(`http://127.0.0.1:${port}/api/usage/collect`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
  });
  it('rejects invalid session allowance writes through the real HTTP boundary', async () => {
    for (const body of [{ limitUsd: -1, revision: 0 }, { limitUsd: 0, revision: 0 },
      { limitUsd: 10, revision: -1 }, { limitUsd: '10', revision: 0 }, { limitUsd: null }]) {
      const response = await fetch(`http://127.0.0.1:${port}/api/usage/sessions/example-session/budget`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    const absent = await fetch(`http://127.0.0.1:${port}/api/usage/sessions/absent-session`);
    expect(absent.status).toBe(404);
  });
  it('uses the same verified numbers in the older API entries', async () => {
    const groups = await get('/api/usage/by-agent?period=all');
    expect(groups.agents.map((x: { name: string }) => x.name).sort()).toEqual(['main', 'subagent']);
    const sources = await get('/api/usage/by-source?period=all');
    expect(sources.sources[0].name).toBe('session');
    const summary = await get('/api/usage/summary');
    expect(summary.allTime.verified_calls).toBe(2);
  });
});

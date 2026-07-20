/**
 * E2E test: per-agent cost attribution surfaces through the real HTTP API.
 *
 * Real server, real SQLite usage ledger, real REST calls. Proves the full
 * Part-C path: usageTracker.record({ agentId }) → GET /api/usage/by-agent
 * returns a breakdown keyed by the agent that spent the money, and rows with
 * no agentId collapse to 'unknown'. This is the cost-dashboard "By Agent" view's
 * data source.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';

import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-usage-by-agent'));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { usageTracker } from '../../src/core/usage/index.js';

let server: HttpServer;
let port: number;

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

interface ByGroupRow { name: string; cost_usd: number; api_calls: number; input_tokens: number; percentage: number }

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 3456;

  // Two summary-agent runs, one main-agent run, and one legacy row with no agentId.
  usageTracker.record({ source: 'subagent', model: 'claude-opus-4-6', input_tokens: 1000, output_tokens: 200, agentId: 'turn-complete-triage' });
  usageTracker.record({ source: 'subagent', model: 'claude-opus-4-6', input_tokens: 500, output_tokens: 100, agentId: 'turn-complete-triage' });
  usageTracker.record({ source: 'agent', model: 'claude-opus-4-6', input_tokens: 2000, output_tokens: 400, agentId: 'general' });
  usageTracker.record({ source: 'agent', model: 'claude-opus-4-6', input_tokens: 300, output_tokens: 50 }); // no agentId → 'unknown'
});

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('GET /api/usage/by-agent', () => {
  it('returns spend grouped by the agent that incurred it', async () => {
    const res = await fetch(apiUrl('/api/usage/by-agent?period=all'));
    expect(res.status).toBe(200);
    const body = await res.json() as { agents: ByGroupRow[] };

    const triage = body.agents.find((a) => a.name === 'turn-complete-triage');
    const general = body.agents.find((a) => a.name === 'general');

    expect(triage).toBeDefined();
    expect(triage!.api_calls).toBe(2);
    expect(triage!.input_tokens).toBe(1500);

    // Legacy agentId-less 'agent' row merges into 'general' (canonical main
    // agent) instead of collapsing into a giant 'unknown' bucket.
    expect(general).toBeDefined();
    expect(general!.api_calls).toBe(2);
    expect(body.agents.some((a) => a.name === 'unknown')).toBe(false);

    // Percentages across all agent buckets sum to ~100.
    const totalPct = body.agents.reduce((s, a) => s + a.percentage, 0);
    expect(totalPct).toBeCloseTo(100, 0);
  });
});

describe('GET /api/usage/overview (interactive dashboard)', () => {
  it('returns every aggregate in one call', async () => {
    const res = await fetch(apiUrl('/api/usage/overview'));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      summary: { api_calls: number };
      bySource: ByGroupRow[]; byModel: ByGroupRow[]; byAgent: ByGroupRow[];
      recent: unknown[]; daily: unknown[]; dateBounds: { min: string | null; max: string | null };
    };
    // 3 walnut rows have agentId, 1 legacy row does not — session rows excluded.
    expect(body.summary.api_calls).toBe(4);
    expect(body.bySource.length).toBeGreaterThan(0);
    expect(body.byAgent.length).toBeGreaterThan(0);
    expect(body.recent.length).toBe(4);
    expect(body.dateBounds.min).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('scopes every aggregate to a source drill-in', async () => {
    const res = await fetch(apiUrl('/api/usage/overview?source=subagent'));
    const body = await res.json() as {
      summary: { api_calls: number; input_tokens: number };
      bySource: ByGroupRow[];
    };
    // Only the two subagent (turn-complete-triage) rows.
    expect(body.summary.api_calls).toBe(2);
    expect(body.summary.input_tokens).toBe(1500);
    // bySource still lists all sources so the user can pivot.
    expect(body.bySource.length).toBeGreaterThan(1);
  });

  it('ANDs a source + agent drill-in', async () => {
    const res = await fetch(apiUrl('/api/usage/overview?source=subagent&agent=turn-complete-triage'));
    const body = await res.json() as { summary: { api_calls: number } };
    expect(body.summary.api_calls).toBe(2);
  });
});

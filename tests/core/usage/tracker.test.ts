import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { UsageTracker } from '../../../src/core/usage/tracker.js';

describe('UsageTracker', () => {
  let tracker: UsageTracker;
  let dbPath: string;

  beforeEach(() => {
    const tmpDir = path.join(os.tmpdir(), `usage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    dbPath = path.join(tmpDir, 'usage.sqlite');
    tracker = new UsageTracker(dbPath);
  });

  afterEach(() => {
    tracker.close();
  });

  describe('record', () => {
    it('inserts a usage record and returns it', () => {
      const rec = tracker.record({
        source: 'agent',
        model: 'global.anthropic.claude-opus-4-6-v1',
        input_tokens: 1000,
        output_tokens: 500,
      });

      expect(rec.id).toBeTruthy();
      expect(rec.source).toBe('agent');
      expect(rec.model).toBe('global.anthropic.claude-opus-4-6-v1');
      expect(rec.input_tokens).toBe(1000);
      expect(rec.output_tokens).toBe(500);
      expect(rec.cost_usd).toBeGreaterThan(0);
      expect(rec.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(rec.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('computes cost automatically', () => {
      const rec = tracker.record({
        source: 'agent',
        model: 'global.anthropic.claude-opus-4-6-v1',
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      });
      // 5 + 25 = 30
      expect(rec.cost_usd).toBeCloseTo(30.00, 2);
    });

    it('handles optional fields', () => {
      const rec = tracker.record({
        source: 'session',
        model: 'claude-code-cli',
        taskId: 'task-123',
        sessionId: 'sess-456',
        external_cost_usd: 0.05,
        duration_ms: 30000,
      });

      expect(rec.taskId).toBe('task-123');
      expect(rec.sessionId).toBe('sess-456');
      expect(rec.external_cost_usd).toBe(0.05);
      expect(rec.duration_ms).toBe(30000);
    });

    it('persists agentId and round-trips it through getRecentRecords', () => {
      const rec = tracker.record({
        source: 'subagent',
        model: 'claude-opus-4-6',
        input_tokens: 100,
        agentId: 'turn-complete-triage',
      });
      expect(rec.agentId).toBe('turn-complete-triage');

      const [recent] = tracker.getRecentRecords(1);
      expect(recent.agentId).toBe('turn-complete-triage');
    });

    it('uses external_cost_usd as cost_usd when provided', () => {
      const rec = tracker.record({
        source: 'session',
        model: 'claude-code-cli',
        external_cost_usd: 1.23,
      });

      // external_cost_usd should be used as cost_usd instead of computing from tokens
      expect(rec.cost_usd).toBe(1.23);
    });

    it('separates session costs from total_cost and excludes them from all other aggregates', () => {
      tracker.record({ source: 'agent', model: 'claude-opus-4-6', input_tokens: 1000, output_tokens: 500 });
      tracker.record({ source: 'session', model: 'claude-code-cli', input_tokens: 999_999, external_cost_usd: 2.00 });

      const summary = tracker.getSummary('all');
      // total_cost excludes session records; session_cost captures them.
      // Tokens and api_calls are walnut-only too — session rows are pass-through.
      expect(summary.total_cost).toBeGreaterThan(0);
      expect(summary.total_cost).toBeLessThan(2.00);
      expect(summary.session_cost).toBe(2.00);
      expect(summary.api_calls).toBe(1);
      expect(summary.input_tokens).toBe(1000);
    });

    it('defaults token counts to 0', () => {
      const rec = tracker.record({
        source: 'agent',
        model: 'claude-opus-4-6',
      });
      expect(rec.input_tokens).toBe(0);
      expect(rec.output_tokens).toBe(0);
      expect(rec.cache_creation_input_tokens).toBe(0);
      expect(rec.cache_read_input_tokens).toBe(0);
    });
  });

  describe('getSummary', () => {
    it('returns zeros for empty database', () => {
      const summary = tracker.getSummary('all');
      expect(summary.total_cost).toBe(0);
      expect(summary.session_cost).toBe(0);
      expect(summary.input_tokens).toBe(0);
      expect(summary.output_tokens).toBe(0);
      expect(summary.api_calls).toBe(0);
    });

    it('sums across multiple records', () => {
      tracker.record({ source: 'agent', model: 'claude-opus-4-6', input_tokens: 1000, output_tokens: 500 });
      tracker.record({ source: 'agent', model: 'claude-opus-4-6', input_tokens: 2000, output_tokens: 1000 });

      const summary = tracker.getSummary('all');
      expect(summary.input_tokens).toBe(3000);
      expect(summary.output_tokens).toBe(1500);
      expect(summary.api_calls).toBe(2);
      expect(summary.total_cost).toBeGreaterThan(0);
    });

    it('filters by today period', () => {
      tracker.record({ source: 'agent', model: 'claude-opus-4-6', input_tokens: 1000, output_tokens: 500 });

      const today = tracker.getSummary('today');
      expect(today.api_calls).toBe(1);
    });
  });

  describe('getAllSummaries', () => {
    it('returns all period summaries', () => {
      tracker.record({ source: 'agent', model: 'claude-opus-4-6', input_tokens: 1000, output_tokens: 500 });

      const summaries = tracker.getAllSummaries();
      expect(summaries.today).toBeDefined();
      expect(summaries.week).toBeDefined();
      expect(summaries.month).toBeDefined();
      expect(summaries.allTime).toBeDefined();
      expect(summaries.allTime.api_calls).toBe(1);
    });
  });

  describe('getDailyCosts', () => {
    it('returns empty array for no data', () => {
      const daily = tracker.getDailyCosts(30);
      expect(daily).toEqual([]);
    });

    it('groups by date', () => {
      tracker.record({ source: 'agent', model: 'claude-opus-4-6', input_tokens: 1000, output_tokens: 500 });
      tracker.record({ source: 'agent', model: 'claude-opus-4-6', input_tokens: 2000, output_tokens: 1000 });

      const daily = tracker.getDailyCosts(30);
      expect(daily.length).toBe(1); // all today
      expect(daily[0].api_calls).toBe(2);
      expect(daily[0].input_tokens).toBe(3000);
    });
  });

  describe('getBySource', () => {
    it('groups records by source', () => {
      tracker.record({ source: 'agent', model: 'claude-opus-4-6', input_tokens: 1000, output_tokens: 500 });
      tracker.record({ source: 'compaction', model: 'claude-opus-4-6', input_tokens: 2000, output_tokens: 1000 });
      tracker.record({ source: 'agent', model: 'claude-opus-4-6', input_tokens: 500, output_tokens: 250 });

      const sources = tracker.getBySource('all');
      expect(sources.length).toBe(2);

      const agentSource = sources.find(s => s.name === 'agent');
      const compactionSource = sources.find(s => s.name === 'compaction');

      expect(agentSource).toBeDefined();
      expect(agentSource!.api_calls).toBe(2);
      expect(agentSource!.input_tokens).toBe(1500);
      expect(compactionSource).toBeDefined();
      expect(compactionSource!.api_calls).toBe(1);
    });

    it('includes percentage', () => {
      tracker.record({ source: 'agent', model: 'claude-opus-4-6', input_tokens: 1000, output_tokens: 500 });
      tracker.record({ source: 'compaction', model: 'claude-opus-4-6', input_tokens: 1000, output_tokens: 500 });

      const sources = tracker.getBySource('all');
      const totalPct = sources.reduce((sum, s) => sum + s.percentage, 0);
      expect(totalPct).toBeCloseTo(100, 0);
    });
  });

  describe('getByModel', () => {
    it('groups records by model', () => {
      tracker.record({ source: 'agent', model: 'claude-opus-4-6', input_tokens: 1000, output_tokens: 500 });
      tracker.record({ source: 'agent', model: 'claude-sonnet-4', input_tokens: 2000, output_tokens: 1000 });

      const models = tracker.getByModel('all');
      expect(models.length).toBe(2);
      expect(models.some(m => m.name === 'claude-opus-4-6')).toBe(true);
      expect(models.some(m => m.name === 'claude-sonnet-4')).toBe(true);
    });
  });

  describe('getByAgent', () => {
    it('groups records by the agent that spent the cost', () => {
      tracker.record({ source: 'subagent', model: 'claude-opus-4-6', input_tokens: 1000, agentId: 'turn-complete-triage' });
      tracker.record({ source: 'subagent', model: 'claude-opus-4-6', input_tokens: 500, agentId: 'turn-complete-triage' });
      tracker.record({ source: 'agent', model: 'claude-opus-4-6', input_tokens: 2000, agentId: 'general' });

      const agents = tracker.getByAgent('all');
      expect(agents.length).toBe(2);

      const triage = agents.find(a => a.name === 'turn-complete-triage');
      const general = agents.find(a => a.name === 'general');
      expect(triage).toBeDefined();
      expect(triage!.api_calls).toBe(2);
      expect(triage!.input_tokens).toBe(1500);
      expect(general).toBeDefined();
      expect(general!.api_calls).toBe(1);
    });

    it('surfaces records without an agentId (old rows) under their canonical agent', () => {
      tracker.record({ source: 'agent', model: 'claude-opus-4-6', input_tokens: 1000 });          // no agentId → main agent
      tracker.record({ source: 'triage', model: 'claude-opus-4-6', input_tokens: 200 });          // no agentId → summary agent
      tracker.record({ source: 'subagent', model: 'claude-opus-4-6', input_tokens: 500, agentId: 'note-agent' });
      tracker.record({ source: 'subagent', model: 'claude-opus-4-6', input_tokens: 100 });        // no agentId → generic subagent

      const agents = tracker.getByAgent('all');
      // agentId-less rows merge into the canonical agent for their source,
      // not a giant 'unknown' bucket: agent→general, triage→turn-complete-triage.
      expect(agents.find(a => a.name === 'general')?.api_calls).toBe(1);
      expect(agents.find(a => a.name === 'turn-complete-triage')?.api_calls).toBe(1);
      expect(agents.find(a => a.name === 'subagent-legacy')?.api_calls).toBe(1);
      expect(agents.some(a => a.name === 'note-agent')).toBe(true);
      expect(agents.some(a => a.name === 'unknown')).toBe(false);
    });

    it('excludes Claude Code session rows from every grouped view', () => {
      tracker.record({ source: 'session', model: 'claude-code-cli', external_cost_usd: 100 });
      tracker.record({ source: 'agent', model: 'claude-opus-4-6', input_tokens: 1000, agentId: 'general' });

      expect(tracker.getByAgent('all').some(a => a.name === 'session')).toBe(false);
      expect(tracker.getBySource('all').some(s => s.name === 'session')).toBe(false);
      expect(tracker.getByModel('all').some(m => m.name === 'claude-code-cli')).toBe(false);
      expect(tracker.getRecentRecords(10).some(r => r.source === 'session')).toBe(false);
      // Daily chart is walnut-only too
      const daily = tracker.getDailyCosts(30);
      expect(daily[0].cost_usd).toBeLessThan(100);
    });
  });

  describe('getRecentRecords', () => {
    it('returns empty for no data', () => {
      const records = tracker.getRecentRecords(10);
      expect(records).toEqual([]);
    });

    it('returns records in reverse chronological order', () => {
      tracker.record({ source: 'agent', model: 'model-a', input_tokens: 100 });
      tracker.record({ source: 'agent', model: 'model-b', input_tokens: 200 });
      tracker.record({ source: 'agent', model: 'model-c', input_tokens: 300 });

      const records = tracker.getRecentRecords(10);
      expect(records.length).toBe(3);
      expect(records[0].model).toBe('model-c');
      expect(records[2].model).toBe('model-a');
    });

    it('respects limit', () => {
      for (let i = 0; i < 10; i++) {
        tracker.record({ source: 'agent', model: 'claude-opus-4-6', input_tokens: i * 100 });
      }

      const records = tracker.getRecentRecords(3);
      expect(records.length).toBe(3);
    });
  });

  describe('getOverview (cross-filter)', () => {
    it('returns every aggregate under one unfiltered call', () => {
      tracker.record({ source: 'agent', model: 'model-a', input_tokens: 1000, agentId: 'general' });
      tracker.record({ source: 'subagent', model: 'model-b', input_tokens: 500, agentId: 'note-agent' });

      const ov = tracker.getOverview({});
      expect(ov.summary.api_calls).toBe(2);
      expect(ov.bySource.length).toBe(2);
      expect(ov.byModel.length).toBe(2);
      expect(ov.byAgent.length).toBe(2);
      expect(ov.recent.length).toBe(2);
      expect(ov.daily.length).toBeGreaterThanOrEqual(1);
      expect(ov.dateBounds.min).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('scopes the summary to a source drill-in', () => {
      tracker.record({ source: 'agent', model: 'model-a', input_tokens: 1000, agentId: 'general' });
      tracker.record({ source: 'subagent', model: 'model-a', input_tokens: 400, agentId: 'note-agent' });
      tracker.record({ source: 'subagent', model: 'model-b', input_tokens: 600, agentId: 'note-agent' });

      const ov = tracker.getOverview({ source: 'subagent' });
      // Summary only counts the two subagent rows.
      expect(ov.summary.api_calls).toBe(2);
      expect(ov.summary.input_tokens).toBe(1000);
      // Recent + byModel are scoped to subagent...
      expect(ov.recent.every(r => r.source === 'subagent')).toBe(true);
      expect(ov.byModel.reduce((n, m) => n + m.api_calls, 0)).toBe(2);
      // ...but bySource still lists ALL sources (its own predicate is stripped)
      // so the user can pivot to another source without losing context.
      expect(ov.bySource.length).toBe(2);
    });

    it('ANDs multiple drill-in dimensions together', () => {
      tracker.record({ source: 'subagent', model: 'model-a', input_tokens: 100, agentId: 'note-agent' });
      tracker.record({ source: 'subagent', model: 'model-b', input_tokens: 200, agentId: 'note-agent' });
      tracker.record({ source: 'agent', model: 'model-a', input_tokens: 300, agentId: 'general' });

      const ov = tracker.getOverview({ source: 'subagent', model: 'model-a' });
      expect(ov.summary.api_calls).toBe(1);
      expect(ov.summary.input_tokens).toBe(100);
    });

    it('filters by an explicit date range', () => {
      const db = (tracker as unknown as { getDb: () => import('better-sqlite3').Database }).getDb();
      // Insert two rows on fixed dates directly (record() always stamps "now").
      const ins = db.prepare(`INSERT INTO usage (id, timestamp, date, source, model, input_tokens, cost_usd)
        VALUES (?, ?, ?, 'agent', 'model-a', ?, ?)`);
      ins.run('r1', '2026-01-01T00:00:00.000Z', '2026-01-01', 1000, 1.0);
      ins.run('r2', '2026-06-15T00:00:00.000Z', '2026-06-15', 2000, 2.0);

      const ov = tracker.getOverview({ startDate: '2026-06-01', endDate: '2026-06-30' });
      expect(ov.summary.api_calls).toBe(1);
      expect(ov.summary.input_tokens).toBe(2000);
    });

    it('always excludes Claude Code session rows regardless of filter', () => {
      tracker.record({ source: 'session', model: 'claude-code-cli', external_cost_usd: 100 });
      tracker.record({ source: 'agent', model: 'model-a', input_tokens: 1000, agentId: 'general' });

      const ov = tracker.getOverview({});
      expect(ov.summary.total_cost).toBeLessThan(100);
      expect(ov.recent.some(r => r.source === 'session')).toBe(false);
    });
  });

  describe('prune', () => {
    it('returns 0 for empty database', () => {
      const deleted = tracker.prune(30);
      expect(deleted).toBe(0);
    });

    it('does not delete recent records', () => {
      tracker.record({ source: 'agent', model: 'claude-opus-4-6', input_tokens: 1000 });
      const deleted = tracker.prune(30);
      expect(deleted).toBe(0);

      const summary = tracker.getSummary('all');
      expect(summary.api_calls).toBe(1);
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import Database from 'better-sqlite3';
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

describe('UsageTracker turn speed columns (ttft_ms, generation_ms)', () => {
  let tmpDir: string;
  let dbPath: string;
  const opened: UsageTracker[] = [];

  function openTracker(): UsageTracker {
    const t = new UsageTracker(dbPath);
    opened.push(t);
    return t;
  }

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `usage-speed-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    dbPath = path.join(tmpDir, 'usage.sqlite');
  });

  afterEach(() => {
    for (const t of opened.splice(0)) t.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trips ttft_ms and generation_ms through record, getRecentRecords and getOverview', () => {
    const tracker = openTracker();
    const rec = tracker.record({
      source: 'agent',
      model: 'claude-sonnet-5-5',
      output_tokens: 120,
      ttft_ms: 850,
      generation_ms: 3000,
    });
    expect(rec.ttft_ms).toBe(850);
    expect(rec.generation_ms).toBe(3000);

    const [recent] = tracker.getRecentRecords(1);
    expect(recent.id).toBe(rec.id);
    expect(recent.ttft_ms).toBe(850);
    expect(recent.generation_ms).toBe(3000);

    const ov = tracker.getOverview({});
    const row = ov.recent.find((r) => r.id === rec.id);
    expect(row).toBeDefined();
    expect(row!.ttft_ms).toBe(850);
    expect(row!.generation_ms).toBe(3000);
  });

  it('a record without speed fields reads back with ttft_ms and generation_ms undefined', () => {
    const tracker = openTracker();
    const rec = tracker.record({ source: 'agent', model: 'claude-sonnet-5-5', input_tokens: 10 });
    expect(rec.ttft_ms).toBeUndefined();
    expect(rec.generation_ms).toBeUndefined();

    const [recent] = tracker.getRecentRecords(1);
    expect(recent.ttft_ms).toBeUndefined();
    expect(recent.generation_ms).toBeUndefined();

    const [overviewRow] = tracker.getOverview({}).recent;
    expect(overviewRow.ttft_ms).toBeUndefined();
    expect(overviewRow.generation_ms).toBeUndefined();
  });

  it('reopening the same database re-runs the migrations without error', () => {
    const first = openTracker();
    const a = first.record({ source: 'agent', model: 'model-a', ttft_ms: 100, generation_ms: 200 });
    first.close();

    const second = openTracker();
    const b = second.record({ source: 'agent', model: 'model-b', ttft_ms: 300, generation_ms: 400 });

    const rows = second.getRecentRecords(10);
    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(a.id)?.ttft_ms).toBe(100);
    expect(byId.get(a.id)?.generation_ms).toBe(200);
    expect(byId.get(b.id)?.ttft_ms).toBe(300);
    expect(byId.get(b.id)?.generation_ms).toBe(400);
  });

  it('a legacy database with only the original columns opens and gains the new columns', () => {
    // The original schema, before parent_source / agent_id / ttft_ms / generation_ms.
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE usage (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        date TEXT NOT NULL,
        source TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        task_id TEXT,
        session_id TEXT,
        run_id TEXT,
        external_cost_usd REAL,
        duration_ms INTEGER
      );
    `);
    legacy.prepare(`INSERT INTO usage (id, timestamp, date, source, model, input_tokens, cost_usd)
      VALUES ('legacy-1', '2026-01-01T00:00:00.000Z', '2026-01-01', 'agent', 'model-old', 50, 0.01)`).run();
    legacy.close();

    const tracker = openTracker();
    const rec = tracker.record({ source: 'agent', model: 'model-new', ttft_ms: 700, generation_ms: 1500 });

    const rows = tracker.getRecentRecords(10);
    expect(rows).toHaveLength(2);
    const legacyRow = rows.find((r) => r.id === 'legacy-1');
    expect(legacyRow).toBeDefined();
    expect(legacyRow!.ttft_ms).toBeUndefined();
    expect(legacyRow!.generation_ms).toBeUndefined();
    expect(legacyRow!.agentId).toBeUndefined();
    expect(legacyRow!.parent_source).toBeUndefined();
    const newRow = rows.find((r) => r.id === rec.id);
    expect(newRow!.ttft_ms).toBe(700);
    expect(newRow!.generation_ms).toBe(1500);
    tracker.close();

    const check = new Database(dbPath);
    try {
      const columns = (check.prepare('PRAGMA table_info(usage)').all() as Array<{ name: string }>).map((c) => c.name);
      expect(columns).toEqual(expect.arrayContaining(['parent_source', 'agent_id', 'ttft_ms', 'generation_ms']));
    } finally {
      check.close();
    }
  });
});

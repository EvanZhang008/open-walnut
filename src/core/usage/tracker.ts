/**
 * UsageTracker — SQLite-backed usage data store.
 *
 * Records API call usage (tokens, cost) and provides aggregation queries
 * for the admin dashboard.
 */

import Database, { type Database as DatabaseType } from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { computeCost } from './pricing.js';
import { log } from '../../logging/index.js';
import type { RecordParams, UsageRecord, UsageSummary, DailyCost, UsageByGroup, UsagePeriod } from './types.js';

const DEFAULT_PRUNE_DAYS = 180;

export class UsageTracker {
  private db: DatabaseType | null = null;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /** Lazily open and initialize the database. */
  private getDb(): DatabaseType {
    if (this.db) return this.db;

    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage (
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
      CREATE INDEX IF NOT EXISTS idx_usage_date ON usage(date);
      CREATE INDEX IF NOT EXISTS idx_usage_source ON usage(source);
      CREATE INDEX IF NOT EXISTS idx_usage_model ON usage(model);
      CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage(timestamp);
    `);

    // Idempotent migration: add parent_source column for existing databases
    try { this.db.exec('ALTER TABLE usage ADD COLUMN parent_source TEXT'); } catch { /* column already exists */ }

    return this.db;
  }

  /**
   * Record a single API usage entry.
   * Cost is computed automatically from the pricing table.
   */
  record(params: RecordParams): UsageRecord {
    const db = this.getDb();
    const now = new Date();
    const id = crypto.randomUUID();
    const timestamp = now.toISOString();
    const date = timestamp.slice(0, 10); // YYYY-MM-DD

    const input_tokens = params.input_tokens ?? 0;
    const output_tokens = params.output_tokens ?? 0;
    const cache_creation = params.cache_creation_input_tokens ?? 0;
    const cache_read = params.cache_read_input_tokens ?? 0;

    // Use external_cost_usd (e.g. from Claude Code CLI sessions) when provided,
    // otherwise compute from token counts via the pricing table.
    const cost_usd = params.external_cost_usd ?? computeCost({
      model: params.model,
      input_tokens,
      output_tokens,
      cache_creation_input_tokens: cache_creation,
      cache_read_input_tokens: cache_read,
    });

    const stmt = db.prepare(`
      INSERT INTO usage (id, timestamp, date, source, model, input_tokens, output_tokens,
        cache_creation_input_tokens, cache_read_input_tokens, cost_usd,
        task_id, session_id, run_id, external_cost_usd, duration_ms, parent_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id, timestamp, date,
      params.source, params.model,
      input_tokens, output_tokens,
      cache_creation, cache_read,
      cost_usd,
      params.taskId ?? null,
      params.sessionId ?? null,
      params.runId ?? null,
      params.external_cost_usd ?? null,
      params.duration_ms ?? null,
      params.parent_source ?? null,
    );

    log.usage.debug('recorded usage', {
      source: params.source,
      model: params.model,
      input_tokens,
      output_tokens,
      cost_usd: cost_usd.toFixed(6),
    });

    return {
      id, timestamp, date,
      source: params.source,
      model: params.model,
      input_tokens, output_tokens,
      cache_creation_input_tokens: cache_creation,
      cache_read_input_tokens: cache_read,
      cost_usd,
      taskId: params.taskId,
      sessionId: params.sessionId,
      runId: params.runId,
      external_cost_usd: params.external_cost_usd,
      duration_ms: params.duration_ms,
      parent_source: params.parent_source,
    };
  }

  /**
   * Get usage summary for a time period.
   */
  getSummary(period: UsagePeriod): UsageSummary {
    const db = this.getDb();
    const { clause, params } = this.periodToWhere(period);
    const row = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN source != 'session' THEN cost_usd ELSE 0 END), 0) AS total_cost,
        COALESCE(SUM(CASE WHEN source = 'session' THEN cost_usd ELSE 0 END), 0) AS session_cost,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_tokens,
        COUNT(*) AS api_calls
      FROM usage
      ${clause}
    `).get(...params) as {
      total_cost: number;
      session_cost: number;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
      api_calls: number;
    };

    return row;
  }

  /**
   * Get all period summaries at once.
   */
  getAllSummaries(): Record<string, UsageSummary> {
    return {
      today: this.getSummary('today'),
      week: this.getSummary('7d'),
      month: this.getSummary('30d'),
      allTime: this.getSummary('all'),
    };
  }

  /**
   * Get daily cost aggregations for the chart.
   */
  getDailyCosts(days: number): DailyCost[] {
    const db = this.getDb();
    const cutoff = this.daysAgo(days);
    const rows = db.prepare(`
      SELECT
        date,
        COALESCE(SUM(cost_usd), 0) AS cost_usd,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_tokens,
        COUNT(*) AS api_calls
      FROM usage
      WHERE date >= ?
      GROUP BY date
      ORDER BY date ASC
    `).all(cutoff) as DailyCost[];

    return rows;
  }

  /**
   * Get usage grouped by source.
   */
  getBySource(period: UsagePeriod): UsageByGroup[] {
    return this.getGrouped('source', period);
  }

  /**
   * Get usage grouped by model.
   */
  getByModel(period: UsagePeriod): UsageByGroup[] {
    return this.getGrouped('model', period);
  }

  /**
   * Get recent usage records.
   */
  getRecentRecords(limit: number): UsageRecord[] {
    const db = this.getDb();
    const rows = db.prepare(`
      SELECT
        id, timestamp, date, source, model,
        input_tokens, output_tokens,
        cache_creation_input_tokens, cache_read_input_tokens,
        cost_usd, task_id, session_id, run_id,
        external_cost_usd, duration_ms, parent_source
      FROM usage
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit) as Array<{
      id: string; timestamp: string; date: string; source: string; model: string;
      input_tokens: number; output_tokens: number;
      cache_creation_input_tokens: number; cache_read_input_tokens: number;
      cost_usd: number; task_id: string | null; session_id: string | null;
      run_id: string | null; external_cost_usd: number | null; duration_ms: number | null;
      parent_source: string | null;
    }>;

    return rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      date: r.date,
      source: r.source as UsageRecord['source'],
      model: r.model,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      cache_creation_input_tokens: r.cache_creation_input_tokens,
      cache_read_input_tokens: r.cache_read_input_tokens,
      cost_usd: r.cost_usd,
      taskId: r.task_id ?? undefined,
      sessionId: r.session_id ?? undefined,
      runId: r.run_id ?? undefined,
      external_cost_usd: r.external_cost_usd ?? undefined,
      duration_ms: r.duration_ms ?? undefined,
      parent_source: (r.parent_source as UsageRecord['source']) ?? undefined,
    }));
  }

  /**
   * Delete records older than N days.
   */
  prune(olderThanDays = DEFAULT_PRUNE_DAYS): number {
    const db = this.getDb();
    const cutoff = this.daysAgo(olderThanDays);
    const result = db.prepare('DELETE FROM usage WHERE date < ?').run(cutoff);
    if (result.changes > 0) {
      log.usage.info('pruned old usage records', { olderThanDays, deleted: result.changes });
    }
    return result.changes;
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // ── Private helpers ──

  private getGrouped(column: 'source' | 'model', period: UsagePeriod): UsageByGroup[] {
    const db = this.getDb();
    const { clause, params } = this.periodToWhere(period);
    const rows = db.prepare(`
      SELECT
        ${column} AS name,
        COALESCE(SUM(cost_usd), 0) AS cost_usd,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_tokens,
        COUNT(*) AS api_calls
      FROM usage
      ${clause}
      GROUP BY ${column}
      ORDER BY cost_usd DESC
    `).all(...params) as Array<{
      name: string; cost_usd: number; input_tokens: number;
      output_tokens: number; cache_read_tokens: number;
      cache_creation_tokens: number; api_calls: number;
    }>;

    const total = rows.reduce((sum, r) => sum + r.cost_usd, 0);
    return rows.map((r) => ({
      ...r,
      percentage: total > 0 ? (r.cost_usd / total) * 100 : 0,
    }));
  }

  private periodToWhere(period: UsagePeriod): { clause: string; params: unknown[] } {
    switch (period) {
      case 'today':
        return { clause: 'WHERE date = ?', params: [this.today()] };
      case '7d':
        return { clause: 'WHERE date >= ?', params: [this.daysAgo(7)] };
      case '30d':
        return { clause: 'WHERE date >= ?', params: [this.daysAgo(30)] };
      case 'all':
        return { clause: '', params: [] };
    }
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private daysAgo(n: number): string {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  }
}

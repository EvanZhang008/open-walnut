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
import type { RecordParams, UsageRecord, UsageSummary, DailyCost, UsageByGroup, UsagePeriod, UsageFilter, UsageOverview } from './types.js';

/**
 * SQL expression that maps a row to its canonical agent name. Kept as a shared
 * constant so both the "By Agent" grouping and the agentId filter reference the
 * exact same fallback logic (legacy rows without agent_id fall back to a name
 * derived from their source). Must stay in sync with the labels in
 * web/src/utils/usageLabels.ts.
 */
const AGENT_NAME_EXPR = `COALESCE(agent_id, CASE source
    WHEN 'agent' THEN 'general'
    WHEN 'triage' THEN 'turn-complete-triage'
    WHEN 'subagent' THEN 'subagent-legacy'
    ELSE source END)`;

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
    // Idempotent migration: add agent_id so spend is attributable per agent (the "By Agent"
    // dashboard view). Old rows have NULL agent_id → surfaced as "unknown".
    try { this.db.exec('ALTER TABLE usage ADD COLUMN agent_id TEXT'); } catch { /* column already exists */ }

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
        task_id, session_id, run_id, external_cost_usd, duration_ms, parent_source, agent_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      params.agentId ?? null,
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
      agentId: params.agentId,
      external_cost_usd: params.external_cost_usd,
      duration_ms: params.duration_ms,
      parent_source: params.parent_source,
    };
  }

  /**
   * Get usage summary for a time period.
   *
   * The dashboard tracks WALNUT's own spend. Claude Code CLI sessions
   * (source='session') are pass-through costs of external coding sessions — they
   * stay in the DB as raw data but are excluded from every aggregate except the
   * dedicated session_cost field.
   */
  getSummary(period: UsagePeriod): UsageSummary {
    const db = this.getDb();
    const { clause, params } = this.periodToWhere(period);
    const row = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN source != 'session' THEN cost_usd ELSE 0 END), 0) AS total_cost,
        COALESCE(SUM(CASE WHEN source = 'session' THEN cost_usd ELSE 0 END), 0) AS session_cost,
        COALESCE(SUM(CASE WHEN source != 'session' THEN input_tokens ELSE 0 END), 0) AS input_tokens,
        COALESCE(SUM(CASE WHEN source != 'session' THEN output_tokens ELSE 0 END), 0) AS output_tokens,
        COALESCE(SUM(CASE WHEN source != 'session' THEN cache_read_input_tokens ELSE 0 END), 0) AS cache_read_tokens,
        COALESCE(SUM(CASE WHEN source != 'session' THEN cache_creation_input_tokens ELSE 0 END), 0) AS cache_creation_tokens,
        COALESCE(SUM(CASE WHEN source != 'session' THEN 1 ELSE 0 END), 0) AS api_calls
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
   * Get daily cost aggregations for the chart. Walnut spend only — Claude Code
   * CLI sessions (source='session') are excluded.
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
      WHERE date >= ? AND source != 'session'
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
   * Get usage grouped by the agent that spent it. Rows recorded before the
   * agent_id column existed (or sources that don't carry an agent) surface as
   * 'unknown'.
   */
  getByAgent(period: UsagePeriod): UsageByGroup[] {
    return this.getGrouped('agent_id', period);
  }

  /**
   * Get recent usage records. Walnut spend only — Claude Code CLI session
   * rows stay queryable in the raw DB but don't clutter the activity feed.
   */
  getRecentRecords(limit: number): UsageRecord[] {
    const db = this.getDb();
    const rows = db.prepare(`
      SELECT
        id, timestamp, date, source, model,
        input_tokens, output_tokens,
        cache_creation_input_tokens, cache_read_input_tokens,
        cost_usd, task_id, session_id, run_id,
        external_cost_usd, duration_ms, parent_source, agent_id
      FROM usage
      WHERE source != 'session'
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit) as Array<{
      id: string; timestamp: string; date: string; source: string; model: string;
      input_tokens: number; output_tokens: number;
      cache_creation_input_tokens: number; cache_read_input_tokens: number;
      cost_usd: number; task_id: string | null; session_id: string | null;
      run_id: string | null; external_cost_usd: number | null; duration_ms: number | null;
      parent_source: string | null; agent_id: string | null;
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
      agentId: r.agent_id ?? undefined,
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

  private getGrouped(column: 'source' | 'model' | 'agent_id', period: UsagePeriod): UsageByGroup[] {
    return this.getGroupedFiltered(column, this.periodToFilter(period));
  }

  /**
   * Group filtered spend by a column. The `groupBy` filter field is ignored for
   * whichever column we're grouping on (so clicking a By-Source row still shows
   * the full By-Source breakdown, just scoped to the other active filters) —
   * the caller passes the filter with that field already stripped.
   */
  private getGroupedFiltered(column: 'source' | 'model' | 'agent_id', filter: UsageFilter): UsageByGroup[] {
    const db = this.getDb();
    // NULL group keys collapse rather than drop. For agent_id, fall back to the
    // row's source (rows recorded before agent_id existed still say WHAT spent
    // the money, just not which named agent) — far more useful than one giant
    // 'unknown' bucket. Legacy sources that ARE a specific agent map to its
    // canonical id so old and new rows merge into one line instead of showing
    // e.g. "Summary" twice. Model/source columns are NOT NULL; 'unknown' is a backstop.
    const nameExpr = column === 'agent_id' ? AGENT_NAME_EXPR : `COALESCE(${column}, 'unknown')`;
    const { clause, params } = this.filterToWhere(filter);
    const rows = db.prepare(`
      SELECT
        ${nameExpr} AS name,
        COALESCE(SUM(cost_usd), 0) AS cost_usd,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_tokens,
        COUNT(*) AS api_calls
      FROM usage
      ${clause}
      GROUP BY ${nameExpr}
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

  /**
   * Build a WHERE clause for the unified cross-filter. Session rows are ALWAYS
   * excluded here (Walnut-own spend only — the same rule the period queries use)
   * so the dashboard totals stay consistent regardless of which drill-in is
   * active.
   */
  private filterToWhere(filter: UsageFilter): { clause: string; params: unknown[] } {
    const conds: string[] = [`source != 'session'`];
    const params: unknown[] = [];
    if (filter.startDate) { conds.push('date >= ?'); params.push(filter.startDate); }
    if (filter.endDate) { conds.push('date <= ?'); params.push(filter.endDate); }
    if (filter.source) { conds.push('source = ?'); params.push(filter.source); }
    if (filter.model) { conds.push('model = ?'); params.push(filter.model); }
    if (filter.agentId) { conds.push(`${AGENT_NAME_EXPR} = ?`); params.push(filter.agentId); }
    return { clause: `WHERE ${conds.join(' AND ')}`, params };
  }

  /** Translate a legacy period enum into an equivalent date-bounded filter. */
  private periodToFilter(period: UsagePeriod): UsageFilter {
    switch (period) {
      case 'today': return { startDate: this.today(), endDate: this.today() };
      case '7d': return { startDate: this.daysAgo(7) };
      case '30d': return { startDate: this.daysAgo(30) };
      case 'all': return {};
    }
  }

  /**
   * One-shot dashboard query: every aggregate under the same cross-filter, plus
   * the DB's overall date bounds for the range picker. When grouping by a
   * dimension the UI has already drilled into (e.g. filter.source is set), that
   * dimension's own breakdown is computed WITHOUT its own predicate so the panel
   * still shows the full list of siblings scoped to the other filters.
   */
  getOverview(filter: UsageFilter, recentLimit = 100): UsageOverview {
    const db = this.getDb();
    const { clause, params } = this.filterToWhere(filter);

    const summary = db.prepare(`
      SELECT
        COALESCE(SUM(cost_usd), 0) AS total_cost,
        0 AS session_cost,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_tokens,
        COUNT(*) AS api_calls
      FROM usage ${clause}
    `).get(...params) as UsageSummary;

    const daily = db.prepare(`
      SELECT
        date,
        COALESCE(SUM(cost_usd), 0) AS cost_usd,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_tokens,
        COUNT(*) AS api_calls
      FROM usage ${clause}
      GROUP BY date
      ORDER BY date ASC
    `).all(...params) as DailyCost[];

    // Each dimension's own filter is stripped when grouping on it (see doc above).
    const bySource = this.getGroupedFiltered('source', { ...filter, source: undefined });
    const byModel = this.getGroupedFiltered('model', { ...filter, model: undefined });
    const byAgent = this.getGroupedFiltered('agent_id', { ...filter, agentId: undefined });

    const recentRows = db.prepare(`
      SELECT
        id, timestamp, date, source, model,
        input_tokens, output_tokens,
        cache_creation_input_tokens, cache_read_input_tokens,
        cost_usd, task_id, session_id, run_id,
        external_cost_usd, duration_ms, parent_source, agent_id
      FROM usage ${clause}
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(...params, recentLimit) as Array<{
      id: string; timestamp: string; date: string; source: string; model: string;
      input_tokens: number; output_tokens: number;
      cache_creation_input_tokens: number; cache_read_input_tokens: number;
      cost_usd: number; task_id: string | null; session_id: string | null;
      run_id: string | null; external_cost_usd: number | null; duration_ms: number | null;
      parent_source: string | null; agent_id: string | null;
    }>;
    const recent: UsageRecord[] = recentRows.map((r) => ({
      id: r.id, timestamp: r.timestamp, date: r.date,
      source: r.source as UsageRecord['source'], model: r.model,
      input_tokens: r.input_tokens, output_tokens: r.output_tokens,
      cache_creation_input_tokens: r.cache_creation_input_tokens,
      cache_read_input_tokens: r.cache_read_input_tokens,
      cost_usd: r.cost_usd,
      taskId: r.task_id ?? undefined, sessionId: r.session_id ?? undefined,
      runId: r.run_id ?? undefined, agentId: r.agent_id ?? undefined,
      external_cost_usd: r.external_cost_usd ?? undefined,
      duration_ms: r.duration_ms ?? undefined,
      parent_source: (r.parent_source as UsageRecord['source']) ?? undefined,
    }));

    // Overall bounds ignore the active filter — the range picker must always
    // offer the full span of recorded data (Walnut-own rows).
    const bounds = db.prepare(
      `SELECT MIN(date) AS min, MAX(date) AS max FROM usage WHERE source != 'session'`,
    ).get() as { min: string | null; max: string | null };

    return { summary, daily, bySource, byModel, byAgent, recent, dateBounds: bounds };
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

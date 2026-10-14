import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { priceReconciledUsage, PRICING_VERSION } from './pricing.js';
import type { UsageFilter } from './types.js';
import type { scanHostUsage } from '../../providers/usage-host-core.js';

type HostEvidence = Awaited<ReturnType<typeof scanHostUsage>>;
export type UsageEvidence = HostEvidence & {
  upstream: HostEvidence['upstream'] & { recordCount?: number };
  reconciliation: HostEvidence['reconciliation'] & { unmatchedCount?: number; responseCount?: number; matchedCount?: number };
};
export interface UsageOwner { sessionId: string; taskId?: string; project?: string; title?: string; lane?: string; }
export type Verification = 'verified' | 'unverified' | 'unpriced' | 'incomplete';
export interface SourceCheck {
  source: string; host: string; status: 'matched' | 'partial' | 'unverified';
  matchedCalls: number; unmatchedCalls: number; detail: string;
  residuals?: UsageEvidence['reconciliation']['residuals'];
}

interface StoredResponse {
  id: string; host: string; responseId: string; timestamp: string; date: string; source: string; model: string; sessionId: string;
  taskId: string | null; project: string | null; title: string | null; agentId: string;
  input: number | null; output: number | null; read: number | null; creation: number | null; write5m: number | null; write1h: number | null;
  estimate: number | null; verification: Verification; pricingVersion: string;
}

export class ResponseUsageStore {
  private db: Database.Database;
  readonly timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS response_usage (
      id TEXT PRIMARY KEY, host TEXT NOT NULL, response_id TEXT NOT NULL, timestamp TEXT NOT NULL,
      date TEXT NOT NULL, source TEXT NOT NULL, model TEXT NOT NULL, session_id TEXT NOT NULL,
      task_id TEXT, project TEXT, title TEXT, agent_id TEXT, input_tokens INTEGER, output_tokens INTEGER,
      cache_read_tokens INTEGER, cache_write_5m INTEGER, cache_write_1h INTEGER,
      estimate_usd REAL, verification TEXT NOT NULL, pricing_version TEXT NOT NULL, cache_creation_tokens INTEGER);
      CREATE INDEX IF NOT EXISTS idx_response_usage_date ON response_usage(date);
      CREATE INDEX IF NOT EXISTS idx_response_usage_session_date ON response_usage(session_id, date);
      CREATE TABLE IF NOT EXISTS usage_checks (host TEXT PRIMARY KEY, until TEXT NOT NULL, checks TEXT NOT NULL);
    `);
    const columns = this.db.prepare('PRAGMA table_info(response_usage)').all() as { name: string }[];
    if (!columns.some(c => c.name === 'cache_creation_tokens')) this.db.exec('ALTER TABLE response_usage ADD COLUMN cache_creation_tokens INTEGER');
  }

  async importHost(host: string, evidence: UsageEvidence, owners: UsageOwner[]) {
    const map = new Map(owners.map(o => [o.sessionId, o]));
    const insert = this.db.prepare(`INSERT INTO response_usage
      VALUES (@id,@host,@responseId,@timestamp,@date,@source,@model,@sessionId,@taskId,@project,@title,
      @agentId,@input,@output,@read,@write5m,@write1h,@estimate,@verification,@pricingVersion,@creation)
      ON CONFLICT(id) DO UPDATE SET input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
      cache_read_tokens=excluded.cache_read_tokens, cache_write_5m=excluded.cache_write_5m,
      cache_write_1h=excluded.cache_write_1h, cache_creation_tokens=excluded.cache_creation_tokens, estimate_usd=excluded.estimate_usd,
      verification=excluded.verification, pricing_version=excluded.pricing_version,
      timestamp=excluded.timestamp, date=excluded.date, source=excluded.source, session_id=excluded.session_id,
      task_id=excluded.task_id, project=excluded.project, title=excluded.title, agent_id=excluded.agent_id`);
    const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: this.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const rows: StoredResponse[] = [];
    for (const r of evidence.reconciliation.records) {
      const owner = map.get(r.sessionId);
      const priced = r.input_tokens !== null && r.output_tokens !== null
        && r.cache_read_input_tokens !== null && r.cache_creation_input_tokens !== null
        ? priceReconciledUsage({ ...r, forwardedModel: r.upstream?.forwardedModel ?? null, input_tokens: r.input_tokens, output_tokens: r.output_tokens,
          cache_read_input_tokens: r.cache_read_input_tokens, cache_creation_input_tokens: r.cache_creation_input_tokens })
        : { costUsd: null };
      const verification: Verification = !r.complete ? 'incomplete' : r.verification !== 'matched' ? 'unverified'
        : priced.costUsd === null ? 'unpriced' : 'verified';
      rows.push({
        id: crypto.createHash('sha256').update(`${host}\0${r.model}\0${r.responseId}`).digest('hex'),
        host, responseId: r.responseId, timestamp: r.timestamp,
        date: dateFormat.format(new Date(r.timestamp)),
        source: owner?.lane?.startsWith('chat:') ? 'chat' : 'session', model: r.model, sessionId: r.sessionId,
        taskId: owner?.taskId ?? null, project: owner?.project ?? null, title: owner?.title ?? null,
        agentId: r.agentId ? 'subagent' : 'main', input: r.input_tokens, output: r.output_tokens,
        read: r.cache_read_input_tokens, creation: r.cache_creation_input_tokens, write5m: r.cache_creation?.ephemeral_5m_input_tokens ?? null,
        write1h: r.cache_creation?.ephemeral_1h_input_tokens ?? null, estimate: priced.costUsd,
        verification, pricingVersion: PRICING_VERSION,
      });
      if (rows.length % 100 === 0) await setImmediate();
    }
    const matched = rows.filter(r => r.verification === 'verified').length;
    const matchedTotal = evidence.reconciliation.matchedCount ?? evidence.reconciliation.records.filter(r => r.verification === 'matched').length;
    const responseTotal = evidence.reconciliation.responseCount ?? rows.length;
    const upstreamTotal = evidence.upstream.recordCount ?? evidence.upstream.records.length;
    const checks: SourceCheck[] = [
      { source: 'Canonical transcript', host, status: matchedTotal === responseTotal && responseTotal > 0 ? 'matched' : 'partial',
        matchedCalls: matchedTotal, unmatchedCalls: responseTotal - matchedTotal,
        detail: 'Final response usage, deduplicated across streaming blocks and copied history.', residuals: evidence.reconciliation.residuals.filter(r => r.source === 'canonical') },
      { source: 'Upstream token log', host, status: upstreamTotal && matchedTotal === upstreamTotal ? 'matched' : upstreamTotal ? 'partial' : 'unverified',
        matchedCalls: matchedTotal,
        unmatchedCalls: evidence.reconciliation.unmatchedCount ?? evidence.reconciliation.upstreamUnmatched.length,
        detail: upstreamTotal ? 'Only one-to-one matches count toward verified cost. Other requests remain separate.' : 'No matching upstream evidence is available.',
        residuals: evidence.reconciliation.residuals.filter(r => r.source === 'proxy') },
      { source: 'Published pricing', host, status: 'partial', matchedCalls: 0, unmatchedCalls: 0,
        detail: 'Standard/global Claude rates are checked against public provider prices. Missing speed, geography, tier or provider-route evidence, tool charges and other cache formats remain unverified.' },
      { source: 'ccusage', host, status: 'unverified', matchedCalls: 0, unmatchedCalls: 0,
        detail: 'Same-transcript parser only, not independent upstream evidence. Unknown model rates must not be read as zero cost.' },
      { source: 'llm-usage', host, status: 'unverified', matchedCalls: 0, unmatchedCalls: 0,
        detail: 'Additional parser of the same transcripts, not independent upstream evidence. Full-window figures need the same sessions, timestamps and final snapshots before comparison.' },
      { source: 'Provider invoice', host, status: 'unverified', matchedCalls: 0, unmatchedCalls: 0,
        detail: 'Account-wide, delayed usage. Not attributable to a session without a matching request route and time window.' },
      { source: 'Collection diagnostics', host, status: 'unverified', matchedCalls: 0, unmatchedCalls: 0,
        detail: `Canonical parse: ${evidence.canonical.diagnostics.invalid_lines ?? 0} invalid lines, ${evidence.canonical.diagnostics.unreadable_files ?? 0} unreadable files. Upstream parse: ${evidence.upstream.diagnostics.length} diagnostics. These cover all scanned files, not only selected sessions.` },
    ];
    const writeBatch = this.db.transaction((batch: typeof rows) => { for (const row of batch) insert.run(row); });
    for (let index = 0; index < rows.length; index += 100) {
      writeBatch(rows.slice(index, index + 100));
      await setImmediate();
    }
    return { host, responses: rows.length, verified: matched, unverified: rows.length - matched, checks };
  }

  getSessionUsage(sessionId: string) {
    const verified = `verification='verified' AND pricing_version='${PRICING_VERSION}'`;
    const rows = this.db.prepare(`SELECT COUNT(*) calls, SUM(CASE WHEN ${verified} THEN 1 ELSE 0 END) verified,
      SUM(CASE WHEN ${verified} THEN estimate_usd ELSE 0 END) cost FROM response_usage WHERE session_id=?`)
      .get(sessionId) as { calls: number; verified: number | null; cost: number | null };
    const groups = (field: 'model' | 'agent_id') => this.db.prepare(`SELECT ${field} name, COUNT(*) calls,
      SUM(CASE WHEN ${verified} THEN estimate_usd ELSE 0 END) cost,
      SUM(CASE WHEN NOT (${verified}) THEN 1 ELSE 0 END) unverified
      FROM response_usage WHERE session_id=? GROUP BY ${field} ORDER BY cost DESC`).all(sessionId)
      .map(raw => {
        const row = raw as { name: string; calls: number; cost: number | null; unverified: number };
        return { name: row.name, calls: row.calls, costUsd: row.unverified ? null : row.cost ?? 0,
          unverifiedCalls: row.unverified };
      });
    return { verifiedCostUsd: null,
      verifiedCalls: rows.verified ?? 0, unverifiedCalls: rows.calls - (rows.verified ?? 0),
      byModel: groups('model').map(({ name, ...row }) => ({ model: name, ...row })),
      byAgent: groups('agent_id').map(({ name, ...row }) => ({ agent: name, ...row })) };
  }

  finishHost(host: string, until: string, checks: SourceCheck[]) {
    this.db.prepare('INSERT OR REPLACE INTO usage_checks VALUES (?,?,?)').run(host, until, JSON.stringify(checks));
  }

  legacyCoverage(filter: UsageFilter) {
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='usage'").get()) return [];
    const clauses = ['1=1']; const args: string[] = [];
    if (filter.startDate) { clauses.push("date(timestamp, 'localtime') >= ?"); args.push(filter.startDate); }
    if (filter.endDate) { clauses.push("date(timestamp, 'localtime') <= ?"); args.push(filter.endDate); }
    if (filter.source) { clauses.push('source = ?'); args.push(filter.source); }
    if (filter.model) { clauses.push('model = ?'); args.push(filter.model); }
    if (filter.agentId) { clauses.push('agent_id = ?'); args.push(filter.agentId); }
    return this.db.prepare(`SELECT source, model, COUNT(*) calls FROM usage WHERE ${clauses.join(' AND ')} GROUP BY source, model`).all(...args) as { source: string; model: string; calls: number }[];
  }

  markHostUnavailable(host: string, detail: string) {
    const checks: SourceCheck[] = [{ source: 'Host collection', host, status: 'unverified', matchedCalls: 0, unmatchedCalls: 0, detail }];
    const previous = this.db.prepare('SELECT until FROM usage_checks WHERE host=?').get(host) as { until: string } | undefined;
    this.db.prepare('INSERT OR REPLACE INTO usage_checks VALUES (?,?,?)').run(host, previous?.until ?? '', JSON.stringify(checks));
  }

  getOverview(filter: UsageFilter, limit = 100) {
    const clauses: string[] = []; const args: string[] = [];
    for (const [field, value, op] of [
      ['date', filter.startDate, '>='], ['date', filter.endDate, '<='], ['source', filter.source, '='],
      ['model', filter.model, '='], ['agent_id', filter.agentId, '='],
    ]) if (value) { clauses.push(`${field} ${op} ?`); args.push(value); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const verified = `verification='verified' AND pricing_version='${PRICING_VERSION}'`;
    const total = this.db.prepare(`SELECT COUNT(*) calls, SUM(CASE WHEN ${verified} THEN 1 ELSE 0 END) verified,
      SUM(CASE WHEN ${verified} THEN estimate_usd ELSE 0 END) cost,
      SUM(input_tokens) input, SUM(output_tokens) output, SUM(cache_read_tokens) read,
      SUM(cache_creation_tokens) writes,
      SUM(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL OR cache_read_tokens IS NULL OR cache_creation_tokens IS NULL THEN 1 ELSE 0 END) unknown,
      SUM(CASE WHEN source='session' AND (${verified}) THEN estimate_usd ELSE 0 END) session
      FROM response_usage ${where}`).get(...args) as Record<string, number | null>;
    const group = (field: string) => this.db.prepare(`SELECT ${field} name, COUNT(*) calls,
      SUM(CASE WHEN ${verified} THEN estimate_usd ELSE 0 END) cost,
      SUM(CASE WHEN NOT (${verified}) THEN 1 ELSE 0 END) unverified,
      SUM(input_tokens) input, SUM(output_tokens) output, SUM(cache_read_tokens) read,
      SUM(cache_creation_tokens) writes,
      SUM(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL OR cache_read_tokens IS NULL OR cache_creation_tokens IS NULL THEN 1 ELSE 0 END) unknown FROM response_usage ${where}
      GROUP BY ${field} ORDER BY cost DESC`).all(...args).map(raw => {
      const r = raw as Record<string, string | number | null>;
      return { name: r.name ?? 'Unknown', cost_usd: Number(r.cost ?? 0), input_tokens: Number(r.input ?? 0), output_tokens: Number(r.output ?? 0),
        cache_read_tokens: Number(r.read ?? 0), cache_creation_tokens: Number(r.writes ?? 0), api_calls: Number(r.calls),
        token_counts_complete: !r.unknown, verified_calls: Number(r.calls) - Number(r.unverified), unverified_calls: Number(r.unverified), percentage: total.cost ? Number(r.cost) / total.cost * 100 : 0 };
    });
    const recent = this.db.prepare(`SELECT * FROM response_usage ${where} ORDER BY timestamp DESC LIMIT ?`).all(...args, limit).map(raw => {
      const r = raw as Record<string, string | number | null>;
      return { id: r.id, timestamp: r.timestamp, date: r.date, source: r.source, model: r.model,
        input_tokens: r.input_tokens === null ? null : Number(r.input_tokens), output_tokens: r.output_tokens === null ? null : Number(r.output_tokens),
        cache_read_input_tokens: r.cache_read_tokens === null ? null : Number(r.cache_read_tokens),
        cache_creation_input_tokens: r.cache_creation_tokens === null ? null : Number(r.cache_creation_tokens),
        cost_usd: r.verification === 'verified' && r.pricing_version === PRICING_VERSION ? Number(r.estimate_usd) : null,
        verification: r.pricing_version === PRICING_VERSION ? r.verification : 'unpriced', sessionId: r.session_id, taskId: r.task_id, agentId: r.agent_id,
        taskTitle: r.title, project: r.project, host: r.host };
    });
    const sessions = this.db.prepare(`SELECT session_id sessionId, MAX(title) title, MAX(task_id) taskId, MAX(project) project, MAX(host) host,
      COUNT(*) calls, SUM(CASE WHEN ${verified} THEN estimate_usd ELSE 0 END) cost,
      SUM(CASE WHEN NOT (${verified}) THEN 1 ELSE 0 END) unverified FROM response_usage ${where}
      GROUP BY session_id ORDER BY cost DESC LIMIT 100`).all(...args);
    const checksRows = this.db.prepare('SELECT * FROM usage_checks').all() as { host: string; until: string; checks: string }[];
    const bounds = this.db.prepare('SELECT MIN(date) min, MAX(date) max FROM response_usage').get();
    const legacy = this.legacyCoverage(filter);
    const legacyCalls = legacy.reduce((sum, row) => sum + row.calls, 0);
    const helperChecks: SourceCheck[] = legacy.map(row => ({ source: row.source, host: 'Application', status: 'unverified',
      matchedCalls: 0, unmatchedCalls: row.calls, detail: `${row.model}: legacy turn records are retained for audit, not added to response counts or cost. They may overlap verified calls; their own amounts remain unverified.` }));
    return {
      summary: { total_cost: Number(total.cost ?? 0), session_cost: Number(total.session ?? 0), api_calls: Number(total.calls ?? 0),
        input_tokens: Number(total.input ?? 0), output_tokens: Number(total.output ?? 0), cache_read_tokens: Number(total.read ?? 0),
        cache_creation_tokens: Number(total.writes ?? 0), token_counts_complete: !total.unknown, verified_calls: Number(total.verified ?? 0),
        unverified_calls: Number(total.calls ?? 0) - Number(total.verified ?? 0), legacy_records: legacyCalls },
      daily: group('date').filter(r => r.verified_calls > 0).map(r => ({ ...r, date: r.name })).sort((a, b) => String(a.date).localeCompare(String(b.date))), bySource: group('source'), byModel: group('model'), byAgent: group('agent_id'),
      recent, sessions, dateBounds: bounds, accuracy: {
        timezone: this.timezone, pricingVersion: PRICING_VERSION, until: checksRows.some(r => !r.until) ? null : checksRows.map(r => r.until).sort()[0] ?? null,
        checks: [...checksRows.flatMap(r => JSON.parse(r.checks) as SourceCheck[]), ...helperChecks],
        status: total.calls && total.verified === total.calls && !legacyCalls ? 'verified' : 'partial',
        note: 'Verified token estimates only. Unmatched calls are not included in cost. This is not an invoice. Source checks cover the collection window, not the display filters.',
      },
    };
  }

  close() { this.db.close(); }
}

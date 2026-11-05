/**
 * Per-day usage sums for the Usage & Costs page, small enough to read on the
 * event loop. `response_usage` holds one row per response (1.2M on a busy Mac;
 * one GROUP BY over it took 16 s), so every read goes through this table:
 * one row per day x host x source x engine x session x model x agent x prompt
 * band. Claude rows are rebuilt from `response_usage` for the (session, day)
 * pairs an import touched; other engines (Codex, OpenCode) come from their
 * per-session day-split scans and replace that session's rows whole.
 *
 * The band is how many price thresholds the request's prompt went past, the
 * same rule as the daemon's session-cost buckets (session-cost-core.ts), so a
 * long-context rate prices the same here as in the model picker.
 */
import type { Database as DatabaseType } from '../../lib/sqlite.js';
import { setImmediate } from 'node:timers/promises';

export interface RollupRow {
  date: string; host: string; source: string; engine: string; sessionId: string; taskId: string | null;
  model: string; agent: string; band: number;
  calls: number; input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number;
  /** Responses whose token counts were missing (counted, priced as zero tokens). */
  unknown: number;
}

/** One day of one model's tokens from a source outside Walnut's own records. */
/**
 * A bill brought in from outside is the cloud account's whole spend for the days it covers, so any other
 * row on those days (a run read later, a session imported later) is already in it and is left out of every
 * sum, whichever came first. A run on a direct OpenAI account is not in a cloud bill and stays.
 */
const BILLED_DAY_CLAUSE = `NOT (source != 'import' AND date IN (SELECT date FROM usage_rollup WHERE source = 'import')
  AND NOT EXISTS (SELECT 1 FROM usage_rollup_origin o WHERE o.host = usage_rollup.host AND o.session_id = usage_rollup.session_id AND o.provider LIKE 'openai%'))`;

export interface ImportRow {
  date: string; model: string; band?: number;
  input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number;
}

/**
 * Where a Codex run came from, kept beside the sums in a table of its own (the sums table's
 * columns are positional, so it never grows one). `outside`: Walnut started no session for it
 * (an agent's `codex exec`, the desktop app); `provider` is Codex's `model_provider`, the account
 * its requests went through.
 */
export interface RunOrigin {
  host: string; sessionId: string; originator: string; provider: string; cwd: string; outside: boolean;
  /** The rows of this run were written by the outside pass (a child thread of a Walnut run included), not by a Walnut session's read. */
  stored: boolean; firstAt: string; lastAt: string;
}

/** A pass a time budget cut short: where it goes on, with the window it had and the files it could not read so far. */
export interface OutsideResume { cursor: string; since?: string; startedAt: string; key: string; unreadable?: string[] }

export interface DayBucket {
  day: string; model: string; band: number; responses: number;
  input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number; cacheWrite: number;
}

// 250 rows is under 1 ms typical and ~25 ms at p99 on a cold file at load 70
// (1,000 rows: p99 99 ms; 5,000 held the loop for 0.9 s).
const BATCH = 250;

export class CostRollup {
  private lock: Promise<unknown> = Promise.resolve();
  private thresholdsKey = '';
  private thresholds: number[] = [];

  constructor(private readonly db: DatabaseType) {
    db.exec(`CREATE TABLE IF NOT EXISTS usage_rollup (
      date TEXT NOT NULL, host TEXT NOT NULL, source TEXT NOT NULL, engine TEXT NOT NULL, session_id TEXT NOT NULL,
      task_id TEXT, model TEXT NOT NULL, agent TEXT NOT NULL, band INTEGER NOT NULL,
      calls INTEGER NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL,
      cache_w5m INTEGER NOT NULL, cache_w1h INTEGER NOT NULL, unknown INTEGER NOT NULL,
      PRIMARY KEY (date, host, source, engine, session_id, model, agent, band));
      CREATE INDEX IF NOT EXISTS idx_usage_rollup_date ON usage_rollup(date);
      CREATE INDEX IF NOT EXISTS idx_usage_rollup_session ON usage_rollup(session_id);
      CREATE TABLE IF NOT EXISTS usage_rollup_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_rollup_origin (
        host TEXT NOT NULL, session_id TEXT NOT NULL, originator TEXT NOT NULL, provider TEXT NOT NULL, cwd TEXT NOT NULL,
        outside INTEGER NOT NULL, stored INTEGER NOT NULL DEFAULT 0, first_at TEXT NOT NULL, last_at TEXT NOT NULL, PRIMARY KEY (host, session_id));`);
    // Until the price book is read, imports band by the thresholds the stored sums
    // were built with, so a restart neither drops them nor forces a rebuild.
    const built = this.meta('claude_built');
    if (built) { try { this.setThresholds(JSON.parse(built) as number[]); } catch { /* rebuilt on first read */ } }
  }

  /** Runs one writer at a time: a backfill and an import never interleave. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.lock.then(work, work);
    this.lock = next.catch(() => undefined);
    return next;
  }

  setThresholds(thresholds: number[]): void {
    this.thresholds = [...thresholds].filter(t => Number.isFinite(t) && t > 0).sort((a, b) => a - b);
    this.thresholdsKey = JSON.stringify(this.thresholds);
  }

  /** The thresholds key one host's Codex/OpenCode rows were last all scanned with ('' = never). */
  enginesKey(host: string): string { return this.meta(`engines_built:${host}`) ?? ''; }
  markEnginesBuilt(host: string, key: string): void { this.setMeta(`engines_built:${host}`, key); }
  get key(): string { return this.thresholdsKey; }

  /** When and under which thresholds a host's outside Codex runs were last all read ('' = never). */
  outsideScan(host: string): { at: string; key: string } {
    return { at: this.meta(`outside_at:${host}`) ?? '', key: this.meta(`outside_key:${host}`) ?? '' };
  }
  markOutsideScanned(host: string, at: string, key: string): void {
    this.setMeta(`outside_at:${host}`, at); this.setMeta(`outside_key:${host}`, key);
  }

  /** How many passes in a row each rollout file could not be read on this host (by file name). */
  outsideMisses(host: string): Record<string, number> {
    try { return JSON.parse(this.meta(`outside_misses:${host}`) ?? '{}') as Record<string, number>; } catch { return {}; }
  }
  setOutsideMisses(host: string, misses: Record<string, number>): void { this.setMeta(`outside_misses:${host}`, JSON.stringify(misses)); }

  /** Where a pass a time budget cut short goes on from (absent: none is half done). */
  outsideResume(host: string): OutsideResume | undefined {
    const raw = this.meta(`outside_resume:${host}`);
    if (!raw) return undefined;
    try { return JSON.parse(raw) as OutsideResume; } catch { return undefined; }
  }
  setOutsideResume(host: string, state: OutsideResume | undefined): void {
    if (state) this.setMeta(`outside_resume:${host}`, JSON.stringify(state));
    else this.db.prepare('DELETE FROM usage_rollup_meta WHERE key=?').run(`outside_resume:${host}`);
  }

  /** True when this session has rows a Walnut session's own read wrote (the outside pass rewrites only its own). */
  hasOwnSession(host: string, sessionId: string, engine: string): boolean {
    const known = this.db.prepare('SELECT stored FROM usage_rollup_origin WHERE host=? AND session_id=?').get(host, sessionId) as { stored: number } | undefined;
    if (known?.stored) return false;
    return !!this.db.prepare('SELECT 1 FROM usage_rollup WHERE session_id=? AND engine=? LIMIT 1').get(sessionId, engine);
  }

  originOf(host: string, sessionId: string): RunOrigin | undefined {
    const r = this.db.prepare('SELECT originator, provider, cwd, outside, stored, first_at first_day, last_at last_day FROM usage_rollup_origin WHERE host=? AND session_id=?').get(host, sessionId) as
      { originator: string; provider: string; cwd: string; outside: number; stored: number; first_day: string; last_day: string } | undefined;
    return r && { host, sessionId, originator: r.originator, provider: r.provider, cwd: r.cwd, outside: !!r.outside, stored: !!r.stored, firstAt: r.first_day, lastAt: r.last_day };
  }

  /** Whether a host's Claude Code sessions outside Walnut were ever read in full (an incremental pass only sees new ones). */
  claudeOutsideBuilt(host: string): boolean { return this.meta(`claude_outside_built:${host}`) === '1'; }
  markClaudeOutsideBuilt(host: string): void { this.setMeta(`claude_outside_built:${host}`, '1'); }
  /** Full reads that left a file unreadable, in a row: a file that stays unreadable stops holding the full read back after a few. */
  claudeOutsideTries(host: string): number { return Number(this.meta(`claude_outside_tries:${host}`) ?? 0) || 0; }
  setClaudeOutsideTries(host: string, tries: number): void { this.setMeta(`claude_outside_tries:${host}`, String(tries)); }

  recordOrigins(rows: RunOrigin[]): void {
    const put = this.db.prepare('INSERT OR REPLACE INTO usage_rollup_origin VALUES (?,?,?,?,?,?,?,?,?)');
    this.db.transaction(() => { for (const r of rows) put.run(r.host, r.sessionId, r.originator, r.provider, r.cwd, r.outside ? 1 : 0, r.stored ? 1 : 0, r.firstAt, r.lastAt); })();
  }

  origins(): Map<string, RunOrigin> {
    const rows = this.db.prepare('SELECT host, session_id sid, originator, provider, cwd, outside, stored, first_at first_day, last_at last_day FROM usage_rollup_origin').all() as
      { host: string; sid: string; originator: string; provider: string; cwd: string; outside: number; stored: number; first_day: string; last_day: string }[];
    return new Map(rows.map(r => [originKey(r.host, r.sid), { host: r.host, sessionId: r.sid, originator: r.originator, provider: r.provider,
      cwd: r.cwd, outside: !!r.outside, stored: !!r.stored, firstAt: r.first_day, lastAt: r.last_day }]));
  }

  private meta(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM usage_rollup_meta WHERE key=?').get(key) as { value: string } | undefined)?.value;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO usage_rollup_meta VALUES (?,?)').run(key, value);
  }

  /** True once the Claude rows match the response table under the current thresholds. */
  isReady(): boolean {
    return this.meta('claude_built') === this.thresholdsKey;
  }

  /**
   * Rebuilds every Claude row from `response_usage` when the thresholds changed
   * (or it never ran). Reads in rowid batches with a yield between them, so the
   * loop is never held for more than one batch (a few ms).
   */
  backfill(): Promise<void> {
    return this.exclusive(async () => {
      if (this.isReady()) return;
      // Fixed for the whole run: a change while it runs leaves it unready, and it runs again.
      const thresholds = this.thresholds, key = this.thresholdsKey;
      const sums = new Map<string, RollupRow>();
      const read = this.db.prepare(`SELECT rowid, date, host, source, session_id, task_id, model, agent_id,
        input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h, cache_creation_tokens
        FROM response_usage WHERE rowid > ? AND rowid <= ?`);
      const top = (this.db.prepare('SELECT MAX(rowid) n FROM response_usage').get() as { n: number | null }).n ?? 0;
      for (let cursor = 0; cursor < top; cursor += BATCH) {
        for (const r of read.all(cursor, cursor + BATCH) as RawResponse[]) this.fold(sums, r, thresholds);
        await setImmediate();
      }
      const all = [...sums.values()];
      await this.deleteClaudeRows();
      await this.writeRows(all);
      this.setMeta('claude_built', key);
    });
  }

  /** Recomputes the Claude rows of the (session, day) pairs an import touched. */
  refreshPairs(pairs: Iterable<{ sessionId: string; date: string }>): Promise<void> {
    const list = [...new Map([...pairs].map(p => [`${p.sessionId}\u0000${p.date}`, p])).values()];
    return this.exclusive(async () => {
      if (!this.isReady()) return; // the pending backfill covers them
      const read = this.db.prepare(`SELECT 0 rowid, date, host, source, session_id, task_id, model, agent_id,
        input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h, cache_creation_tokens
        FROM response_usage WHERE session_id=? AND date=?`);
      const drop = this.db.prepare("DELETE FROM usage_rollup WHERE engine='claude' AND session_id=? AND date=?");
      // Written in chunks of about BATCH rows read, with a yield between them; a
      // busy session-day alone is one chunk.
      for (let i = 0; i < list.length;) {
        const sums = new Map<string, RollupRow>();
        const batch: typeof list = [];
        let rowsRead = 0;
        while (i < list.length && (rowsRead < BATCH || !batch.length)) {
          const p = list[i++];
          batch.push(p);
          const rows = read.all(p.sessionId, p.date) as RawResponse[];
          rowsRead += rows.length;
          for (const r of rows) this.fold(sums, r, this.thresholds);
        }
        this.db.transaction(() => {
          for (const p of batch) drop.run(p.sessionId, p.date);
          this.insertAll([...sums.values()]);
        })();
        await setImmediate();
      }
    });
  }

  /** Replaces one non-Claude session's rows for the days its day-split scan covers. */
  replaceSession(owner: { sessionId: string; host: string; engine: string; taskId: string | null; source: string },
    buckets: DayBucket[], opts: { byDay?: boolean } = {}): Promise<void> {
    return this.exclusive(async () => {
      const sums = new Map<string, RollupRow>();
      for (const b of buckets) {
        const row: RollupRow = { date: b.day, host: owner.host, source: owner.source, engine: owner.engine, sessionId: owner.sessionId,
          taskId: owner.taskId, model: b.model, agent: 'main', band: b.band, calls: b.responses, input: b.input, output: b.output,
          cacheRead: b.cacheRead, cacheWrite5m: b.cacheWrite5m + b.cacheWrite, cacheWrite1h: b.cacheWrite1h, unknown: 0 };
        const key = rowKey(row);
        const prev = sums.get(key);
        if (prev) addInto(prev, row); else sums.set(key, row);
      }
      // A scan split by day replaces only the days it covers: a day it no longer reads (its
      // files were removed, a host cleaned old sessions up) keeps what was stored, which is
      // the history. A scan dated by its last response moves the whole session to one day,
      // so it replaces every day, as before.
      const days = [...new Set([...sums.values()].map(r => r.date))];
      const dropDay = this.db.prepare('DELETE FROM usage_rollup WHERE session_id=? AND engine=? AND date=?');
      const dropAll = this.db.prepare('DELETE FROM usage_rollup WHERE session_id=? AND engine=?');
      this.db.transaction(() => {
        if (opts.byDay) for (const day of days) dropDay.run(owner.sessionId, owner.engine, day);
        else dropAll.run(owner.sessionId, owner.engine);
        this.insertAll([...sums.values()]);
      })();
    });
  }

  /** Sums grouped by the given columns plus model and band, for a date range and set of sources. */
  query(opts: { start?: string; end?: string; sources: string[]; by: RollupColumn[] }): (RollupRow & Record<string, unknown>)[] {
    const clauses = [`source IN (${opts.sources.map(() => '?').join(',')})`, BILLED_DAY_CLAUSE];
    const args: unknown[] = [...opts.sources];
    if (opts.start) { clauses.push('date >= ?'); args.push(opts.start); }
    if (opts.end) { clauses.push('date <= ?'); args.push(opts.end); }
    const cols = [...new Set([...opts.by, 'model', 'band'])].map(c => COLUMN[c as RollupColumn]);
    return (this.db.prepare(`SELECT ${cols.map(c => `${c.sql} AS ${c.as}`).join(', ')},
      SUM(calls) calls, SUM(input) input, SUM(output) output, SUM(cache_read) cacheRead,
      SUM(cache_w5m) cacheWrite5m, SUM(cache_w1h) cacheWrite1h, SUM(unknown) unknown
      FROM usage_rollup WHERE ${clauses.join(' AND ')} GROUP BY ${cols.map(c => c.sql).join(', ')}`).all(...args)) as (RollupRow & Record<string, unknown>)[];
  }

  /** The days an import covers: anything else counted on them is already in the bill. */
  billedDays(): Set<string> {
    return new Set((this.db.prepare("SELECT DISTINCT date FROM usage_rollup WHERE source = 'import'").all() as { date: string }[]).map(r => r.date));
  }

  /** Each host's first and last stored day; an import is listed as a host of its own, flagged. */
  hostBounds(): { host: string; from: string; to: string; imported?: true }[] {
    // Plain aliases: `from` and `to` in double quotes are an error in the macOS build's SQLite.
    const rows = this.db.prepare(`SELECT host, MIN(date) first_day, MAX(date) last_day, source='import' imported FROM usage_rollup
      GROUP BY host, source='import' ORDER BY source='import', host`).all() as { host: string; first_day: string; last_day: string; imported: number }[];
    return rows.map(r => ({ host: r.host, from: r.first_day, to: r.last_day, ...(r.imported ? { imported: true as const } : {}) }));
  }

  /** The first day usage Walnut recorded itself is stored (an import stops short of it, so no day is counted twice). */
  firstOwnDay(): string | null {
    // Runs the outside pass stored are not Walnut's own records: a bill may still cover their days (the pass skips those
    // for the cloud account), and counting them here would pull an import's cutoff back and drop the bill on its next import.
    return (this.db.prepare(`SELECT MIN(date) d FROM usage_rollup u WHERE source != 'import' AND NOT EXISTS (
      SELECT 1 FROM usage_rollup_origin o WHERE o.host = u.host AND o.session_id = u.session_id AND o.outside = 1 AND o.stored = 1)`).get() as { d: string | null }).d;
  }

  /**
   * Replaces everything one import label brought with `rows`: per-day token sums of a
   * source outside Walnut's own records (a provider's usage bill, say). Days on or after
   * the first recorded day are skipped, so a day is never counted by both. Safe to run again.
   */
  replaceImport(label: string, rows: ImportRow[]): Promise<{ stored: number; skipped: number; from: string | null; to: string | null }> {
    return this.exclusive(async () => {
      const stop = this.firstOwnDay();
      const sums = new Map<string, RollupRow>();
      let skipped = 0;
      for (const r of rows) {
        if (stop && r.date >= stop) { skipped++; continue; }
        const row: RollupRow = { date: r.date, host: label, source: 'import', engine: 'imported', sessionId: '', taskId: null,
          model: r.model, agent: 'imported', band: r.band ?? 0, calls: 0, input: r.input, output: r.output, cacheRead: r.cacheRead,
          cacheWrite5m: r.cacheWrite5m, cacheWrite1h: r.cacheWrite1h, unknown: 0 };
        const key = rowKey(row), prev = sums.get(key);
        if (prev) addInto(prev, row); else sums.set(key, row);
      }
      this.db.prepare("DELETE FROM usage_rollup WHERE source='import' AND host=?").run(label);
      const all = [...sums.values()];
      await this.writeRows(all);
      const days = all.map(r => r.date).sort();
      return { stored: all.length, skipped, from: days[0] ?? null, to: days[days.length - 1] ?? null };
    });
  }

  bounds(): { min: string | null; max: string | null } {
    return this.db.prepare('SELECT MIN(date) min, MAX(date) max FROM usage_rollup').get() as { min: string | null; max: string | null };
  }

  private fold(sums: Map<string, RollupRow>, r: RawResponse, thresholds: number[]): void {
    const known = r.input_tokens !== null && r.output_tokens !== null && r.cache_read_tokens !== null;
    const input = r.input_tokens ?? 0, output = r.output_tokens ?? 0, read = r.cache_read_tokens ?? 0;
    const w5 = r.cache_write_5m ?? 0, w1 = r.cache_write_1h ?? 0;
    // A write the transcript gave without its 5m/1h split is priced at the 5m rate.
    const unsplit = Math.max(0, (r.cache_creation_tokens ?? 0) - w5 - w1);
    const row: RollupRow = { date: r.date, host: r.host, source: r.source, engine: 'claude', sessionId: r.session_id,
      taskId: r.task_id, model: r.model, agent: r.agent_id ?? 'main', band: bandOf(input + read + w5 + w1 + unsplit, thresholds),
      calls: 1, input, output, cacheRead: read, cacheWrite5m: w5 + unsplit, cacheWrite1h: w1, unknown: known ? 0 : 1 };
    const key = rowKey(row);
    const prev = sums.get(key);
    if (prev) { addInto(prev, row); prev.taskId ??= row.taskId; } else sums.set(key, row);
  }

  private insertAll(rows: RollupRow[]): void {
    const insert = this.db.prepare(`INSERT INTO usage_rollup VALUES
      (@date,@host,@source,@engine,@sessionId,@taskId,@model,@agent,@band,@calls,@input,@output,@cacheRead,@cacheWrite5m,@cacheWrite1h,@unknown)
      ON CONFLICT DO UPDATE SET calls=calls+excluded.calls, input=input+excluded.input, output=output+excluded.output,
      cache_read=cache_read+excluded.cache_read, cache_w5m=cache_w5m+excluded.cache_w5m, cache_w1h=cache_w1h+excluded.cache_w1h,
      unknown=unknown+excluded.unknown, task_id=COALESCE(task_id, excluded.task_id)`);
    for (const row of rows) insert.run(row);
  }

  private async deleteClaudeRows(): Promise<void> {
    const drop = this.db.prepare("DELETE FROM usage_rollup WHERE rowid IN (SELECT rowid FROM usage_rollup WHERE engine='claude' LIMIT 2000)");
    while (drop.run().changes > 0) await setImmediate();
  }

  private async writeRows(rows: RollupRow[]): Promise<void> {
    for (let i = 0; i < rows.length; i += 500) {
      this.db.transaction(() => this.insertAll(rows.slice(i, i + 500)))();
      await setImmediate();
    }
  }
}

export type RollupColumn = 'date' | 'host' | 'source' | 'engine' | 'session' | 'task' | 'model' | 'agent' | 'band';

const COLUMN: Record<RollupColumn, { sql: string; as: string }> = {
  date: { sql: 'date', as: 'date' }, host: { sql: 'host', as: 'host' }, source: { sql: 'source', as: 'source' },
  engine: { sql: 'engine', as: 'engine' }, session: { sql: 'session_id', as: 'sessionId' }, task: { sql: 'task_id', as: 'taskId' },
  model: { sql: 'model', as: 'model' }, agent: { sql: 'agent', as: 'agent' }, band: { sql: 'band', as: 'band' },
};

interface RawResponse {
  rowid: number; date: string; host: string; source: string; session_id: string; task_id: string | null; model: string; agent_id: string | null;
  input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null;
  cache_write_5m: number | null; cache_write_1h: number | null; cache_creation_tokens: number | null;
}

function bandOf(prompt: number, thresholds: number[]): number {
  let n = 0;
  for (const t of thresholds) if (prompt > t) n++;
  return n;
}

export function originKey(host: string, sessionId: string): string { return `${host}\u0000${sessionId}`; }

function rowKey(r: RollupRow): string {
  return [r.date, r.host, r.source, r.engine, r.sessionId, r.model, r.agent, r.band].join('\u0000');
}

function addInto(a: RollupRow, b: RollupRow): void {
  a.calls += b.calls; a.input += b.input; a.output += b.output; a.cacheRead += b.cacheRead;
  a.cacheWrite5m += b.cacheWrite5m; a.cacheWrite1h += b.cacheWrite1h; a.unknown += b.unknown;
}

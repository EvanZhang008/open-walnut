/**
 * The real-use monitor's own file: `WALNUT_HOME/local/usage-watch.sqlite` (`/local/` stays on this
 * machine, out of sync and backups' content). Hourly rows per tool op, route and page-error kind,
 * the recent problems one by one, the watches tasks registered, and the ships Walnut saw.
 * Nothing in it is content: names, counts, sizes, times and error codes; task ids only in the
 * watches and ships tasks registered themselves, in the notes sent (with the titles of the
 * tasks they name, as the note said them), and with the session and host of each failed Walnut
 * tool call a session read (tool_errors: which op, which code, never its words). The cloud
 * companion's batches of rows are kept by their random ids, so a resent batch is added once.
 */
import fs from 'node:fs'
import path from 'node:path'
import Database, { type Database as DB } from '../../lib/sqlite.js'
import { reopenIfWiped } from '../../lib/sqlite-wiped.js'
import { WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import { backfillSides, emptyAgg, mergeAgg, type Agg, type UsageKind } from './agg.js'

export const RETAIN_HOURS = 30 * 24
export const RETAIN_EVENT_DAYS = 14
export const MAX_EVENTS = 5_000

let fileOverride: string | null = null
let db: DB | null = null

/** For tests: another file (null: the default). Closes the open one. */
export function setUsageWatchFile(file: string | null): void {
  closeUsageWatchStore()
  fileOverride = file
}

export function usageWatchFile(): string {
  return fileOverride ?? path.join(WALNUT_HOME, 'local', 'usage-watch.sqlite')
}

export function closeUsageWatchStore(): void {
  try { db?.close() } catch { /* already closed */ }
  db = null
}

function open(): DB {
  const file = usageWatchFile()
  // A test that wipes the data home under a kept handle gets a fresh file (src/lib/sqlite-wiped.ts).
  if (db) return (db = reopenIfWiped(file, db, () => create(file), (old) => old.close()))
  return (db = create(file))
}

function create(file: string): DB {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const d = new Database(file)
  d.pragma('journal_mode = WAL')
  d.exec(`
    CREATE TABLE IF NOT EXISTS hours (
      hour INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, agg TEXT NOT NULL,
      PRIMARY KEY (hour, kind, name));
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
      problem TEXT NOT NULL, code TEXT, chars INTEGER, ms INTEGER);
    CREATE INDEX IF NOT EXISTS events_name ON events (kind, name, at);
    CREATE TABLE IF NOT EXISTS watches (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, targets TEXT NOT NULL, checks TEXT NOT NULL, who TEXT NOT NULL,
      trigger_id TEXT, created_at INTEGER NOT NULL, ship_at INTEGER, check_at INTEGER NOT NULL, extended INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL, checked_at INTEGER, result TEXT, told TEXT, by TEXT, exempt TEXT);
    CREATE INDEX IF NOT EXISTS watches_task ON watches (task_id);
    CREATE TABLE IF NOT EXISTS ships (
      task_id TEXT NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL, how TEXT NOT NULL, state TEXT NOT NULL,
      PRIMARY KEY (task_id, key));
    CREATE TABLE IF NOT EXISTS sends (
      id TEXT PRIMARY KEY, recipient TEXT NOT NULL, family TEXT NOT NULL, day TEXT NOT NULL, seq INTEGER NOT NULL,
      due_at INTEGER NOT NULL, items TEXT NOT NULL, state TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0,
      sent_at INTEGER, detail TEXT);
    CREATE INDEX IF NOT EXISTS sends_day ON sends (recipient, family, day);
    CREATE TABLE IF NOT EXISTS alive (hour INTEGER PRIMARY KEY, minutes INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tool_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, sid TEXT NOT NULL, task_id TEXT,
      host TEXT NOT NULL, op TEXT NOT NULL, client TEXT NOT NULL, code TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS tool_errors_at ON tool_errors (at);
    CREATE TABLE IF NOT EXISTS companion_batches (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
  `)
  return d
}

/** Runs `fn` on the store; a broken file is logged and answers `fallback`, never throws to a recorder. */
export function withStore<T>(fallback: T, fn: (d: DB) => T): T {
  try {
    return fn(open())
  } catch (err) {
    log.obs.warn('usage watch: store unavailable', { error: err instanceof Error ? err.message : String(err) })
    closeUsageWatchStore()
    return fallback
  }
}

/** Adds an hour's deltas to what the file holds for that hour. */
export function addHours(rows: ReadonlyArray<{ hour: number; kind: UsageKind; name: string; agg: Agg }>): void {
  if (!rows.length) return
  withStore(undefined, (d) => {
    const get = d.prepare('SELECT agg FROM hours WHERE hour = ? AND kind = ? AND name = ?')
    const put = d.prepare('INSERT OR REPLACE INTO hours (hour, kind, name, agg) VALUES (?, ?, ?, ?)')
    d.transaction(() => {
      for (const r of rows) {
        const was = get.get(r.hour, r.kind, r.name) as { agg: string } | undefined
        const merged = was ? mergeAgg(parseAgg(was.agg), r.agg) : r.agg
        put.run(r.hour, r.kind, r.name, JSON.stringify(merged))
      }
    })()
  })
}

function parseAgg(text: string): Agg {
  try {
    const raw = JSON.parse(text) as Partial<Agg>
    const a = { ...emptyAgg(), ...raw }
    // A row from before the codes were kept by side: give them the side they can only be (agg.ts).
    if (raw.ownCodes === undefined && raw.callerCodes === undefined) backfillSides(a)
    return a
  } catch { return emptyAgg() }
}

/**
 * The cloud companion's rows (usage-watch/companion-uses.ts), added once per batch: the batch's id
 * is kept in the same transaction, so a resend after an answer lost to a restart adds nothing.
 * A name new to its hour once the hour holds `maxNames` names of its kind is added as `other`, as
 * the recorder does (record.ts). `failed` when the file did not take them: the box keeps the batch.
 */
export function addHoursOnce(batch: string, rows: ReadonlyArray<{ hour: number; kind: UsageKind; name: string; agg: Agg }>, maxNames: number, now = Date.now()): 'added' | 'duplicate' | 'failed' {
  return withStore<'added' | 'duplicate' | 'failed'>('failed', (d) => {
    const seen = d.prepare('SELECT 1 FROM companion_batches WHERE id = ?')
    const names = d.prepare('SELECT COUNT(*) AS n FROM hours WHERE hour = ? AND kind = ?')
    const get = d.prepare('SELECT agg FROM hours WHERE hour = ? AND kind = ? AND name = ?')
    const put = d.prepare('INSERT OR REPLACE INTO hours (hour, kind, name, agg) VALUES (?, ?, ?, ?)')
    return d.transaction((): 'added' | 'duplicate' => {
      if (seen.get(batch)) return 'duplicate'
      for (const r of rows) {
        let name = r.name
        let was = get.get(r.hour, r.kind, name) as { agg: string } | undefined
        if (!was && (names.get(r.hour, r.kind) as { n: number }).n >= maxNames) {
          name = 'other'
          was = get.get(r.hour, r.kind, name) as { agg: string } | undefined
        }
        put.run(r.hour, r.kind, name, JSON.stringify(was ? mergeAgg(parseAgg(was.agg), r.agg) : r.agg))
      }
      d.prepare('INSERT INTO companion_batches (id, at) VALUES (?, ?)').run(batch, now)
      return 'added'
    })()
  })
}

/** Every hour row from `sinceHour` on (epoch ms of the hour), optionally one kind and name. */
export function readHours(sinceHour: number, filter?: { kind?: UsageKind; name?: string }): Array<{ hour: number; kind: UsageKind; name: string; agg: Agg }> {
  return withStore([], (d) => {
    const where = ['hour >= ?']
    const args: unknown[] = [sinceHour]
    if (filter?.kind) { where.push('kind = ?'); args.push(filter.kind) }
    if (filter?.name) { where.push('name = ?'); args.push(filter.name) }
    const rows = d.prepare(`SELECT hour, kind, name, agg FROM hours WHERE ${where.join(' AND ')}`).all(...args) as Array<{ hour: number; kind: UsageKind; name: string; agg: string }>
    return rows.map((r) => ({ hour: r.hour, kind: r.kind, name: r.name, agg: parseAgg(r.agg) }))
  })
}

/** One problem call, for the owner to read: no session or task id, no content. */
export interface UsageEvent { at: number; kind: UsageKind; name: string; problem: string; code?: string; chars?: number; ms?: number }

export function addEvents(events: readonly UsageEvent[]): void {
  if (!events.length) return
  withStore(undefined, (d) => {
    const put = d.prepare('INSERT INTO events (at, kind, name, problem, code, chars, ms) VALUES (?, ?, ?, ?, ?, ?, ?)')
    d.transaction(() => {
      for (const e of events) put.run(e.at, e.kind, e.name, e.problem, e.code ?? null, e.chars ?? null, e.ms ?? null)
    })()
  })
}

export function readEvents(filter: { kind?: UsageKind; name?: string; since?: number; limit?: number } = {}): UsageEvent[] {
  return withStore([], (d) => {
    const where = ['at >= ?']
    const args: unknown[] = [filter.since ?? 0]
    if (filter.kind) { where.push('kind = ?'); args.push(filter.kind) }
    if (filter.name) { where.push('name = ?'); args.push(filter.name) }
    const rows = d.prepare(`SELECT at, kind, name, problem, code, chars, ms FROM events WHERE ${where.join(' AND ')} ORDER BY at DESC LIMIT ?`)
      .all(...args, Math.min(filter.limit ?? 50, 500)) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      at: Number(r.at), kind: r.kind as UsageKind, name: String(r.name), problem: String(r.problem),
      ...(r.code ? { code: String(r.code) } : {}), ...(r.chars != null ? { chars: Number(r.chars) } : {}),
      ...(r.ms != null ? { ms: Number(r.ms) } : {}),
    }))
  })
}

/** A session's failed Walnut tool call, as its agent read it (session-hook.ts). */
export interface ToolErrorRow { at: number; sid: string; taskId?: string; host: string; op: string; client: string; code: string }

export const MAX_TOOL_ERRORS = 50_000

export function addToolErrors(rows: readonly ToolErrorRow[]): void {
  if (!rows.length) return
  withStore(undefined, (d) => {
    const put = d.prepare('INSERT INTO tool_errors (at, sid, task_id, host, op, client, code) VALUES (?, ?, ?, ?, ?, ?, ?)')
    d.transaction(() => {
      for (const r of rows) put.run(r.at, r.sid, r.taskId ?? null, r.host, r.op, r.client, r.code)
    })()
  })
}

/** The failed calls since `since`, newest first, at most `limit`, of one session (an id or its start) when named. */
export function readToolErrors(filter: { since: number; session?: string; limit?: number }): ToolErrorRow[] {
  return withStore([], (d) => {
    const where = ['at >= ?']
    const args: unknown[] = [filter.since]
    if (filter.session) { where.push('(sid = ? OR sid LIKE ? OR task_id = ? OR task_id LIKE ?)'); args.push(filter.session, `${filter.session}%`, filter.session, `${filter.session}%`) }
    const rows = d.prepare(`SELECT at, sid, task_id, host, op, client, code FROM tool_errors WHERE ${where.join(' AND ')} ORDER BY at DESC LIMIT ?`)
      .all(...args, Math.min(filter.limit ?? MAX_TOOL_ERRORS, MAX_TOOL_ERRORS)) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      at: Number(r.at), sid: String(r.sid), ...(r.task_id ? { taskId: String(r.task_id) } : {}),
      host: String(r.host), op: String(r.op), client: String(r.client), code: String(r.code),
    }))
  })
}

/** When the oldest kept failed call was recorded (ms), or null with none: a report says where its data starts. */
export function oldestToolError(): number | null {
  return withStore(null, (d) => {
    const r = d.prepare('SELECT MIN(at) AS at FROM tool_errors').get() as { at?: number | null } | undefined
    return r?.at == null ? null : Number(r.at)
  })
}

/** One minute of this server recording, for telling a gap (the server was down) from no use. */
export function markAlive(now = Date.now()): void {
  withStore(undefined, (d) => {
    d.prepare('INSERT INTO alive (hour, minutes) VALUES (?, 1) ON CONFLICT(hour) DO UPDATE SET minutes = minutes + 1').run(Math.floor(now / 3_600_000) * 3_600_000)
  })
}

/** Minutes recorded per hour from `sinceHour` on. */
export function readAlive(sinceHour: number): Map<number, number> {
  return withStore(new Map(), (d) => new Map((d.prepare('SELECT hour, minutes FROM alive WHERE hour >= ?').all(sinceHour) as Array<{ hour: number; minutes: number }>).map((r) => [r.hour, r.minutes])))
}

/** Drops what is older than the retention, and events past the cap. */
export function pruneStore(now = Date.now()): void {
  withStore(undefined, (d) => {
    d.prepare('DELETE FROM hours WHERE hour < ?').run(now - RETAIN_HOURS * 3_600_000)
    d.prepare('DELETE FROM events WHERE at < ?').run(now - RETAIN_EVENT_DAYS * 86_400_000)
    d.prepare('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY at DESC LIMIT ?)').run(MAX_EVENTS)
    d.prepare('DELETE FROM sends WHERE due_at < ?').run(now - 7 * 86_400_000)
    d.prepare('DELETE FROM alive WHERE hour < ?').run(now - RETAIN_HOURS * 3_600_000)
    // A batch older than the rows a companion still sends (companion-uses.ts KEEP_HOURS) is never resent.
    d.prepare('DELETE FROM companion_batches WHERE at < ?').run(now - 8 * 86_400_000)
    d.prepare('DELETE FROM tool_errors WHERE at < ?').run(now - RETAIN_EVENT_DAYS * 86_400_000)
    d.prepare('DELETE FROM tool_errors WHERE id NOT IN (SELECT id FROM tool_errors ORDER BY at DESC LIMIT ?)').run(MAX_TOOL_ERRORS)
  })
}

/** The raw database for the watch, ship and send tables (watches.ts, ships.ts, owner-tell.ts). */
export function usageDb<T>(fallback: T, fn: (d: DB) => T): T {
  return withStore(fallback, fn)
}

/**
 * session-db.ts — SQLite foundation for the sessions store.
 *
 * Mirrors task-db.ts exactly in layout and semantics. Owns the singleton
 * SQLite connection (src/lib/sqlite.ts) for `sessions.sqlite`, schema initialization
 * (WAL + busy_timeout=5000 + NORMAL sync + wal_checkpoint(TRUNCATE) on open),
 * and the row↔SessionRecord (de)serialization helpers that the rest of the
 * sessions rewrite (session-tracker router, one-shot migration, bulk APIs)
 * builds on.
 *
 * Do NOT add business logic here. This file is the storage primitive only.
 * Liveness checks, triage filtering, status-history ring-buffer trimming, and
 * all other session semantics stay in session-tracker.ts on top of these
 * helpers.
 */

import Database, { type Database as DatabaseType } from '../lib/sqlite.js';
import fs from 'node:fs';
import path from 'node:path';
import { WALNUT_HOME } from '../constants.js';
import { log } from '../logging/index.js';
import { guardCopyHandle, openApplyConnection } from '../replica/copy-guard.js';
import { isHostReplica } from './server-role.js';
import { mergeLeaderCopy, rowOwnedHere } from './sessions/session-row-owner.js';
import { claimStart, isClaimed, releaseClaim } from './sessions/starting-claims.js';
import { prepared } from '../lib/sqlite-prepared.js';
import { reopenIfWiped } from '../lib/sqlite-wiped.js';
import { ensureLateIndexes, hasIndex, type LateIndex } from '../lib/sqlite-late-index.js';
import { lateIndexReport } from './late-index-report.js';
import type { SessionPromptRef, SessionRecord } from './types.js';
import {
  BLANK_CHARS_SQL, HAS_PROMPT_TEXT, PROMPT_KEYS, SPLIT_PROMPT_ROW, promptChangesOf, promptRefOf, promptSha256, promptsOf, standingRef, textRefsColumnOf,
  textRefsOf, withPromptStubs, withPromptTexts, type PromptChanges, type PromptKey, type SessionPrompts,
} from './session-prompts.js';
import { lookForHolders } from './blocking-calls.js';

/** SQLite file path. Sits next to the legacy sessions.json in WALNUT_HOME. */
export const SESSION_DB_PATH = path.join(WALNUT_HOME, 'sessions.sqlite');

/** How long a write waits for another connection's write lock in all (ms): the shared connection's busy_timeout. */
const BUSY_TIMEOUT_MS = 5_000;

/**
 * Columns that map directly onto a `SessionRecord` field.
 *
 * The SessionRecord `claudeSessionId` (camelCase) is stored as
 * `claude_session_id` (snake) and serves as PRIMARY KEY — same aliasing
 * pattern as `_syncedAt` / `_synced_at` in task-db.ts.
 *
 * Keep this list in sync with the schema below and the SessionRecord type in
 * types.ts. Any SessionRecord key not in this set is packed into `payload` on
 * write and merged back onto the record on read — that's the future-proof
 * fallback; we only add a dedicated column when we want to query or index
 * on that field.
 *
 * Not persisted here (by design):
 *   - `hostname`: resolved at runtime from config.hosts for display tooltips
 *   - `pendingPermission`, `status_history`: structured objects → payload
 */
const EXPLICIT_SESSION_COLUMNS = [
  'claude_session_id',
  'task_id',
  'project',
  'process_status',
  'mode',
  'provider',
  'type',
  'activity',
  'last_status_change',
  'started_at',
  'last_active_at',
  'message_count',
  'cwd',
  'host',
  'title',
  'description',
  'pid',
  'output_file',
  'plan_file',
  'plan_completed',
  'from_plan_session_id',
  'forked_from_session_id',
  'human_note',
  'model',
  'cli_model',
  'archived',
  'archive_reason',
  'plan_content',
  'error_message',
  'status_reason',
  'status_changed_by',
  'status_revision',
  'status_updated_at',
] as const;

/**
 * camelCase SessionRecord key ↔ snake_case column name. Used by both
 * `sessionToRow` and `rowToSession` so the mapping lives in exactly one place.
 *
 * Any SessionRecord key NOT in this map (and not `hostname`, which we never
 * persist) spills into `payload`. Any new scalar field added to SessionRecord
 * falls through to payload by default — add an entry here + a column below
 * only when we need to query/index on it.
 */
const FIELD_TO_COLUMN: Record<string, string> = {
  claudeSessionId: 'claude_session_id',
  taskId: 'task_id',
  project: 'project',
  process_status: 'process_status',
  mode: 'mode',
  provider: 'provider',
  type: 'type',
  activity: 'activity',
  last_status_change: 'last_status_change',
  startedAt: 'started_at',
  lastActiveAt: 'last_active_at',
  messageCount: 'message_count',
  cwd: 'cwd',
  host: 'host',
  title: 'title',
  description: 'description',
  pid: 'pid',
  outputFile: 'output_file',
  planFile: 'plan_file',
  planCompleted: 'plan_completed',
  fromPlanSessionId: 'from_plan_session_id',
  forkedFromSessionId: 'forked_from_session_id',
  human_note: 'human_note',
  model: 'model',
  cliModel: 'cli_model',
  archived: 'archived',
  archive_reason: 'archive_reason',
  planContent: 'plan_content',
  errorMessage: 'error_message',
  status_reason: 'status_reason',
  status_changed_by: 'status_changed_by',
  statusRevision: 'status_revision',
  statusUpdatedAt: 'status_updated_at',
};

const COLUMN_TO_FIELD: Record<string, string> = Object.fromEntries(
  Object.entries(FIELD_TO_COLUMN).map(([k, v]) => [v, k]),
);

/** Boolean columns — stored as INTEGER 0/1 in SQLite. */
const BOOLEAN_COLUMNS = new Set<string>(['plan_completed', 'archived']);

/** Explicit SessionRecord keys covered by a dedicated column. Built from FIELD_TO_COLUMN. */
const EXPLICIT_SESSION_KEYS = new Set<string>(Object.keys(FIELD_TO_COLUMN));

/**
 * Runtime-only keys that MUST NOT be persisted. `hostname` is resolved from
 * config.hosts on each read in session-tracker; persisting it would just bake
 * in a stale display name.
 */
const NON_PERSISTED_KEYS = new Set<string>(['hostname']);

// ── Singleton ──────────────────────────────────────────────────────────────
let db: DatabaseType | null = null;
let initAttempted = false;
// Rethrown on every call after a failed open — see task-db.ts for rationale
// (silent null degrades every caller to an uninformative "null.prepare").
let initError: unknown = null;
/** Bumped on every open: a cache built on an earlier handle is stale (data_version is per connection). */
let generation = 0;

/** Which open of the database the shared handle is (see `generation`). */
export function dbGeneration(): number {
  return generation;
}

/**
 * Return the shared SQLite handle, lazily opening + initializing it on the
 * first call.
 *
 * Pragmas mirror task-db.ts and usage/tracker.ts:
 *   - journal_mode=WAL          → readers don't block the single writer.
 *   - busy_timeout=5000         → retry for 5s on writer contention.
 *   - synchronous=NORMAL        → fsync only at checkpoint time. Session
 *                                 metadata is re-derivable from the JSONL
 *                                 stream + live processes on crash, so the
 *                                 tiny durability reduction is fine.
 *   - foreign_keys=ON           → future-proof for child tables.
 *
 * Also runs `wal_checkpoint(TRUNCATE)` on open to stop the WAL growing
 * unboundedly between restarts (same problem tasks.sqlite-wal hit at 80 MB).
 */
export function getDb(): DatabaseType | null {
  if (db) {
    const live = reopenIfWiped(SESSION_DB_PATH, db, openShared, closeShared);
    if (live !== db) { db = live; generation += 1; }
    return db;
  }
  if (initAttempted) throw initError; // previous open failed; rethrow the real cause (no hot-loop retry)
  initAttempted = true;
  try {
    db = openShared();
    generation += 1;
    return db;
  } catch (err) {
    initError = err;
    log.session.error('session-db open failed', { path: SESSION_DB_PATH, err: String(err) });
    throw err;
  }
}

// ── Which rows of the sessions table this connection changed ────────────────
//
// The session store's write lock patches the rows a section changed into its cached snapshot
// (session-tracker.ts withWriteLock). It used to compare SQLite's count of changed session rows
// with the distinct ids the section's helpers named, so a section that wrote one row twice (a host
// channel batch with two changes of one session) read as a change nobody named and dropped the
// whole snapshot: about 50 full scans of 7.7k rows in the first 10 minutes after a start
// (2026-11-25). Before that it counted every table of the file (1,314 scans in 21 minutes,
// 2026-11-23). Now temp triggers record the id of every row this connection inserts, updates or
// deletes, and the lock patches exactly those: a writer that names nothing (a bulk UPDATE) is
// patched too, and a rolled-back write leaves no id behind (the temp table is in the transaction).
// Another connection's commit is the data_version check's. A trigger body never meets a conflict
// (NOT EXISTS, not OR IGNORE: the outer statement's conflict policy would override a trigger's own),
// and names its table unqualified: SQLite before 3.53 (the macOS system library,
// WALNUT_SQLITE_LIBRARY=system) refuses `temp.` there, and the store would not open.
const recordingHandles = new WeakSet<DatabaseType>();

function recordChangedSessionRows(handle: DatabaseType): void {
  // A rowid table's TEXT PRIMARY KEY may hold NULL, the recorder's key may not: a row with no id
  // is no row of the snapshot (rowToSession keys by it), so it is not recorded, and its write never fails.
  const note = (id: string) => `INSERT INTO session_rows_changed (sid) SELECT ${id} WHERE ${id} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM session_rows_changed WHERE sid = ${id});`;
  handle.exec(`
    CREATE TEMP TABLE IF NOT EXISTS session_rows_changed (sid TEXT PRIMARY KEY) WITHOUT ROWID;
    CREATE TEMP TRIGGER IF NOT EXISTS session_rows_changed_insert AFTER INSERT ON main.sessions WHEN NEW.claude_session_id IS NOT NULL BEGIN ${note('NEW.claude_session_id')} END;
    CREATE TEMP TRIGGER IF NOT EXISTS session_rows_changed_update AFTER UPDATE ON main.sessions WHEN OLD.claude_session_id IS NOT NULL OR NEW.claude_session_id IS NOT NULL BEGIN ${note('OLD.claude_session_id')} ${note('NEW.claude_session_id')} END;
    CREATE TEMP TRIGGER IF NOT EXISTS session_rows_changed_delete AFTER DELETE ON main.sessions WHEN OLD.claude_session_id IS NOT NULL BEGIN ${note('OLD.claude_session_id')} END;
  `);
  recordingHandles.add(handle);
}

/**
 * The ids of the session rows `handle` changed since the last call, forgotten as they are read; null
 * when it does not record them (a host's own-row writer or its read-only copy) or the record cannot
 * be read (its temp table gone): the caller then drops what it cannot trust, never fails.
 * Call it outside a transaction: inside one, its rows are not stored yet.
 */
export function takeChangedSessionRows(handle: DatabaseType): string[] | null {
  if (!recordingHandles.has(handle)) return null;
  try {
    const ids = prepared(handle, 'SELECT sid FROM temp.session_rows_changed', 'pluck').all() as string[];
    if (ids.length > 0) prepared(handle, 'DELETE FROM temp.session_rows_changed').run();
    return ids;
  } catch (err) {
    log.session.warn('session-db: the changed-rows record could not be read', { err: String(err) });
    return null;
  }
}

/** Open and initialize the shared handle (getDb, and a test's reopen after a wipe). */
function openShared(): DatabaseType {
  fs.mkdirSync(path.dirname(SESSION_DB_PATH), { recursive: true });
  const handle = new Database(SESSION_DB_PATH);
  try {
    handle.pragma('journal_mode = WAL');
    handle.pragma('busy_timeout = 5000');
    // See task-db.ts for the wal_autocheckpoint rationale — on-stop/on-compact
    // hook child processes hold their own handles and never hit the explicit
    // wal_checkpoint below.
    handle.pragma('wal_autocheckpoint = 1000');
    handle.pragma('synchronous = NORMAL');
    handle.pragma('foreign_keys = ON');

    initSessionSchema(handle, SESSION_DB_PATH);
    // A host replica's file is the Mac's rows, kept by the follower apply
    // connection (sessions kind, replication/kinds/sessions.ts): its own data
    // fixes and WAL truncation would change the copy behind its hashes, so it
    // adds missing columns only (task-db.ts does the same).
    const copy = isHostReplica();
    ensureSessionStatusColumns(handle, undefined, { backfill: !copy });
    // After the column it names (an older file gets it just above).
    if (!copy) ensureLateIndexes(handle, [TEXT_ROWS_LATE_INDEX], { report: lateIndexReport(SESSION_DB_PATH) });

    // Truncate the WAL on open (see task-db.ts:128 — same rationale).
    let checkpoint: unknown = null;
    if (!copy) {
      try {
        checkpoint = handle.pragma('wal_checkpoint(TRUNCATE)');
      } catch (err) {
        log.session.warn('session-db: WAL checkpoint on open failed', { err: String(err) });
      }
    }

    if (!copy) recordChangedSessionRows(handle);
    // A host replica's copy reads only; its one writer is the apply connection (replica/copy-guard.ts).
    guardCopyHandle(handle, 'sessions');
    log.session.info('session-db opened', { path: SESSION_DB_PATH });
    log.session.info('session-db: WAL checkpoint on open', { result: checkpoint });
    return handle;
  } catch (err) {
    try { handle.close(); } catch { /* the open failed anyway */ }
    throw err;
  }
}

/** Close a shared handle a test's wipe replaced, with the apply connection on its file. */
function closeShared(old: DatabaseType): void {
  closeOwnRowWriter();
  if (applyHandle) {
    try { applyHandle.close(); } catch { /* replaced anyway */ }
    applyHandle = null;
  }
  old.close();
}

/** The follower apply connection of this store on a host replica (replica/copy-guard.ts). */
export function openCopyApplyConnection(): DatabaseType {
  getDb();
  return openApplyConnection(SESSION_DB_PATH, 'sessions');
}

let applyHandle: DatabaseType | null = null;

/**
 * The ids this store holds (the sessions copy's local keys). `exceptHost`: leave out the
 * sessions that run on that host (a host replica's own, which its purge keeps).
 */
export function sessionIdsInStore(opts: { exceptHost?: string } = {}): string[] {
  const handle = getDb();
  if (!handle) return [];
  if (opts.exceptHost) {
    return handle.prepare('SELECT claude_session_id FROM sessions WHERE host IS NULL OR host != ?').pluck().all(opts.exceptHost) as string[];
  }
  return handle.prepare('SELECT claude_session_id FROM sessions').pluck().all() as string[];
}

/**
 * The ids of the rows this host replica runs and judges itself (sessions/session-row-owner.ts
 * rowOwnedHere): host `hostKey`, `judge: 'host'` (kept in the payload).
 */
export function ownSessionIdsInStore(hostKey: string): string[] {
  const handle = getDb();
  if (!handle || !hostKey) return [];
  return handle.prepare(
    `SELECT claude_session_id FROM sessions WHERE host = ? AND instr(payload, '"judge"') > 0 AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.judge') END = 'host'`,
  ).pluck().all(hostKey) as string[];
}

/**
 * The session channel's position for one host (core/session-channel/channel.ts): the fact log
 * and the last record of it this leader applied. Written only by session-tracker's
 * applyHostChannelBatch, in the same transaction as the records' rows, so the position and the
 * rows it stands for never part. It lives in sessions.sqlite: it moves with the leader's data.
 */
export function loadChannelCursor(hostId: string): { logId: string; seq: number } | null {
  const handle = getDb();
  if (!handle || !hostId) return null;
  const row = handle.prepare('SELECT log_id, seq FROM session_channel_cursor WHERE host_id = ?').get(hostId) as { log_id: string; seq: number } | undefined;
  return row ? { logId: row.log_id, seq: Number(row.seq) || 0 } : null;
}

/** Inside the caller's write transaction: the host's stored position (applyHostChannelBatch reads it there). */
export function readChannelCursor(handle: DatabaseType, hostId: string): { logId: string; seq: number } | null {
  const row = prepared(handle, 'SELECT log_id, seq FROM session_channel_cursor WHERE host_id = ?').get(hostId) as { log_id: string; seq: number } | undefined;
  return row ? { logId: row.log_id, seq: Number(row.seq) || 0 } : null;
}

/** Inside the caller's write transaction: keep `cursor` as the host's position. */
export function writeChannelCursor(handle: DatabaseType, hostId: string, cursor: { logId: string; seq: number }): void {
  prepared(handle, 'INSERT OR REPLACE INTO session_channel_cursor (host_id, log_id, seq) VALUES (?, ?, ?)').run(hostId, cursor.logId, cursor.seq);
}

/** Has any host's channel ever applied here? False: no row of this store is a host's (judge-of.ts's fast path). */
export function anyChannelCursor(): boolean {
  const handle = getDb();
  if (!handle) return false;
  return handle.prepare('SELECT 1 FROM session_channel_cursor LIMIT 1').pluck().get() !== undefined;
}

/**
 * Who judges one session, without decoding its record: its host column and whether its payload
 * says `judge: 'host'` (a substring test first, so only such a row's payload is parsed). Null: no
 * such row.
 */
export function sessionJudgeInStore(claudeSessionId: string, handle: DatabaseType | null = getDb()): { host: string | null; judgedByHost: boolean } | null {
  if (!handle) return null;
  const row = prepared(handle, 
    `SELECT host, CASE WHEN instr(coalesce(payload, ''), '"judge":"host"') > 0 AND json_valid(payload) THEN json_extract(payload, '$.judge') = 'host' ELSE 0 END AS judged FROM sessions WHERE claude_session_id = ?`,
  ).get(claudeSessionId) as { host: string | null; judged: number } | undefined;
  return row ? { host: row.host, judgedByHost: row.judged === 1 } : null;
}

/**
 * A session's task and engine, and an ACP session's runtime id, without decoding its whole record
 * (a host-judged session's proxy; the runtime probe of a hand-over, host-handover.ts cliOnHost).
 */
export function sessionTaskAndEngineInStore(claudeSessionId: string): { taskId: string | null; engine: string | null; acpRuntimeId: string | null } | null {
  const handle = getDb();
  if (!handle) return null;
  const row = handle.prepare(
    `SELECT task_id, CASE WHEN json_valid(payload) THEN json_extract(payload, '$.engine') END AS engine, CASE WHEN json_valid(payload) THEN json_extract(payload, '$.acpRuntimeId') END AS runtime FROM sessions WHERE claude_session_id = ?`,
  ).get(claudeSessionId) as { task_id: string | null; engine: string | null; runtime: unknown } | undefined;
  return row ? { taskId: row.task_id, engine: row.engine, acpRuntimeId: typeof row.runtime === 'string' && row.runtime ? row.runtime : null } : null;
}

/**
 * Every host-judged ACP session's runtime id (judge-of.ts seedHostJudgedRuntimes, once at the leader
 * side's boot): only rows with a host, whose payload says `judge: 'host'` and names a runtime, are parsed.
 */
export function hostJudgedRuntimesInStore(): Array<{ sid: string; host: string; runtimeId: string }> {
  const handle = getDb();
  if (!handle) return [];
  const rows = handle.prepare(
    `SELECT claude_session_id AS sid, host, json_extract(payload, '$.acpRuntimeId') AS runtimeId FROM sessions
      WHERE host IS NOT NULL AND host <> '' AND instr(coalesce(payload, ''), '"judge":"host"') > 0
        AND instr(payload, '"acpRuntimeId"') > 0 AND json_valid(payload)`,
  ).all() as Array<{ sid: string; host: string; runtimeId: unknown }>;
  return rows.filter((r): r is { sid: string; host: string; runtimeId: string } => typeof r.runtimeId === 'string' && r.runtimeId !== '');
}

/** Every session id and ACP runtime id in the store, without decoding records (the ephemeral session gate's copied set). */
export function sessionIdentitiesInStore(): string[] {
  const handle = getDb();
  if (!handle) throw new Error('sessions store unavailable');
  return handle.prepare(
    `SELECT claude_session_id FROM sessions UNION
     SELECT json_extract(payload, '$.acpRuntimeId') FROM sessions WHERE instr(payload, '"acpRuntimeId"') > 0 AND json_valid(payload)`,
  ).pluck().all().filter((id): id is string => typeof id === 'string' && id !== '');
}

/**
 * The sessions copy's one write (replication/kinds/sessions.ts): rows in as
 * they came (INSERT OR REPLACE, every column), removed ids out, one
 * transaction. On a host replica it runs on the follower apply connection, the
 * only handle that may write the copy; session-tracker's read cache sees the
 * commit through `PRAGMA data_version`. Off a host replica (tests) it uses the
 * shared handle.
 */
/**
 * Own rows this host removed (a rename's old id, a drop). The leader's copy may still name one as
 * this host's until it applies the channel's record of it: such a row is never stored again
 * (applySessionCopy). A seed the leader hands this host for a start (its row marked this host's
 * before the host ever had it) is not among them and comes down as usual. A host that runs its
 * sessions keeps the list on disk next to its fact log (session-channel/gone-rows.ts, installed by
 * host-boot.ts); without one (tests) it is kept in memory for an hour.
 */
const ownRowsGone = new Map<string, number>()
const OWN_GONE_TTL_MS = 60 * 60_000
const OWN_GONE_MAX = 5_000
let ownGoneStore: { note(sid: string): void; has(sid: string): boolean } | null = null

/** The persisted list of removed own rows (host-boot.ts), or null. */
export function setOwnRowsGoneStore(store: { note(sid: string): void; has(sid: string): boolean } | null): void {
  ownGoneStore = store
}

/** The host removed its own row `sid` (port onRename / onDrop, session-channel/host-boot.ts). */
export function noteOwnRowGone(sid: string, now = Date.now()): void {
  if (!sid) return
  if (ownGoneStore) { ownGoneStore.note(sid); return }
  ownRowsGone.delete(sid)
  if (ownRowsGone.size >= OWN_GONE_MAX) ownRowsGone.delete(ownRowsGone.keys().next().value!)
  ownRowsGone.set(sid, now)
}

function ownRowGoneLately(sid: string, now = Date.now()): boolean {
  if (ownGoneStore) return ownGoneStore.has(sid)
  const at = ownRowsGone.get(sid)
  if (at === undefined) return false
  if (now - at > OWN_GONE_TTL_MS) { ownRowsGone.delete(sid); return false }
  return true
}

export function applySessionCopy(change: { rows?: readonly SessionRecord[]; removeIds?: readonly string[]; ownHost?: string }): { keptOwn: number; skippedOwn: number } {
  const shared = getDb();
  if (!shared) throw new Error('session-db: applySessionCopy() called before database was successfully opened');
  const handle = isHostReplica() ? (applyHandle ??= openCopyApplyConnection()) : shared;
  const del = handle.prepare('DELETE FROM sessions WHERE claude_session_id = ?');
  const get = handle.prepare('SELECT * FROM sessions WHERE claude_session_id = ?');
  // This host's own rows (judged here, sessions/session-row-owner.ts): never removed by the copy,
  // and only their leader fields take the leader's values. Read and written in one write
  // transaction, so a write of this host's own between the read and the write cannot be lost.
  const own = (change.ownHost ?? '').trim();
  const ownRow = (id: string): SessionRecord | null => {
    if (!own) return null;
    const raw = get.get(id) as Record<string, any> | undefined;
    if (!raw) return null;
    const rec = decodeSessionRow(raw);
    return rowOwnedHere(rec, own) ? rec : null;
  };
  let keptOwn = 0;
  let skippedOwn = 0;
  let disowned = 0;
  handle.transaction(() => {
    for (const id of change.removeIds ?? []) {
      if (ownRow(id)) { keptOwn++; continue; }
      deleteSessionPrompts(handle, id);
      del.run(id);
      forgetLeaderDisown(handle, id);
    }
    for (const r of change.rows ?? []) {
      const sid = r.claudeSessionId;
      const mine = ownRow(sid);
      // A row the leader holds as this host's own that this host removed (it renamed or dropped
      // it, and the leader has not applied that yet): never stored again, or it would read as an
      // own row and come back to the leader as a session born again.
      if (!mine && own && rowOwnedHere(r, own) && ownRowGoneLately(sid)) { skippedOwn++; continue; }
      // A session a start handed this host (starting-claims.ts): any copy of its row, even one from
      // before the leader marked it this host's, comes down as this host's, so the own-row writer
      // takes the session's first writes whatever order the copy and the start arrive in.
      const claimed = !mine && own && isClaimed(sid) && claimable(r, own);
      // Only a claim (a start or a resume this host took) or this host's own writer makes a row its
      // own: a copy that names the row this host's before either (a hand-over whose answer is still
      // out, the host never got it) stays the leader's copy here, so no send is taken for it and no
      // CLI of it resumed without the claim's checks.
      // A copy never carries a prompt (replication drops them): an own row keeps the ones it has.
      putSessionRow(handle, mine ? mergeLeaderCopy(mine, r) : claimed ? claimedCopy(r, own) : own && rowOwnedHere(r, own) ? { ...r, judge: undefined } : r);
      // The row is this host's here while the leader's version says it is not: kept, so the host
      // can give the row back to it once no session of this host holds it (stranded-own-rows.ts).
      if ((mine || claimed) && !rowOwnedHere(r, own)) { noteLeaderDisown(handle, r); disowned++; }
      else forgetLeaderDisown(handle, sid);
    }
  }).immediate();
  if (disowned > 0) try { disownNotice?.(); } catch { /* the sweep runs on its own clock too */ }
  return { keptOwn, skippedOwn };
}

/** A copied row as this host's own (host = its key, judge 'host'): the leader's mark, before its copy says it. */
function claimedCopy(r: SessionRecord, hostKey: string): SessionRecord {
  return { ...r, host: hostKey, judge: 'host' };
}

/** A start may claim only a row of no host or of this one: the leader hands a seed only to its own host (handSeedToHost). */
function claimable(r: Pick<SessionRecord, 'host'>, hostKey: string): boolean {
  return !r.host || r.host === hostKey;
}

// ── The leader's version of an own row that says it is not this host's ──
//
// The host's copy merges the leader's copy of an own row (mergeLeaderCopy) and so loses what the
// leader says of the row's owner: a start that failed (takeSeedBack on the leader), a host that
// stopped between a start's claim and its answer, a claim of a row the leader never marked. Each
// leaves a row this host holds as its own while no session here runs it. The leader's latest
// version of such a row is kept here, on disk with the copy, until the row is the leader's again
// or the leader's copy names it this host's (stranded-own-rows.ts reads it).

let disownNotice: (() => void) | null = null;

/** Called after a copy kept a leader version that disowns an own row (host-boot.ts: the sweep runs soon). */
export function setLeaderDisownNotice(fn: (() => void) | null): void {
  disownNotice = fn;
}

function noteLeaderDisown(handle: DatabaseType, leader: SessionRecord): void {
  prepared(handle, 'INSERT OR REPLACE INTO session_leader_disowns (claude_session_id, row, at) VALUES (?, ?, ?)')
    .run(leader.claudeSessionId, JSON.stringify(leader), Date.now());
}

function forgetLeaderDisown(handle: DatabaseType, sid: string): void {
  prepared(handle, 'DELETE FROM session_leader_disowns WHERE claude_session_id = ?').run(sid);
}

/**
 * The own rows of this host whose leader version says they are not this host's: each with that
 * version (`leader`, and `key` to hand it back with). A kept version whose row is no longer this
 * host's own goes.
 */
export function ownRowsTheLeaderDisowns(): Array<{ row: SessionRecord; leader: SessionRecord; key: string }> {
  const hostKey = ownRowHostKey();
  if (!hostKey) return [];
  const handle = applyHandle ??= openCopyApplyConnection();
  const kept = handle.prepare('SELECT claude_session_id AS sid, row FROM session_leader_disowns').all() as Array<{ sid: string; row: string }>;
  if (kept.length === 0) return [];
  const get = handle.prepare('SELECT * FROM sessions WHERE claude_session_id = ?');
  const out: Array<{ row: SessionRecord; leader: SessionRecord; key: string }> = [];
  const stale: string[] = [];
  for (const k of kept) {
    const raw = get.get(k.sid) as Record<string, any> | undefined;
    const row = raw ? decodeSessionRow(raw) : null;
    let leader: SessionRecord | null = null;
    try { leader = JSON.parse(k.row) as SessionRecord; } catch { /* unreadable: dropped below */ }
    if (!row || !leader || !rowOwnedHere(row, hostKey) || rowOwnedHere(leader, hostKey)) { stale.push(k.sid); continue; }
    out.push({ row, leader, key: k.row });
  }
  if (stale.length > 0) handle.transaction(() => { for (const sid of stale) forgetLeaderDisown(handle, sid); }).immediate();
  return out;
}

/**
 * Give an own row back to the leader: the leader's version `key` (ownRowsTheLeaderDisowns) becomes
 * the row, in one transaction that checks first that the row is still this host's own, that no
 * newer leader version came, and that no start claimed the session since. False: it did not.
 */
export function handOwnRowBack(sid: string, key: string): boolean {
  const hostKey = ownRowHostKey();
  if (!hostKey || !sid) return false;
  const handle = applyHandle ??= openCopyApplyConnection();
  return handle.transaction(() => {
    if (isClaimed(sid)) return false;
    const now = handle.prepare('SELECT row FROM session_leader_disowns WHERE claude_session_id = ?').pluck().get(sid) as string | undefined;
    if (now !== key) return false;
    const raw = handle.prepare('SELECT * FROM sessions WHERE claude_session_id = ?').get(sid) as Record<string, any> | undefined;
    if (!raw || !rowOwnedHere(decodeSessionRow(raw), hostKey)) return false;
    // The leader's version: no prompt (a copy never holds one), so the row's own go with it.
    putSessionRow(handle, JSON.parse(key) as SessionRecord, { appliedAppendSystemPrompt: null, systemPrompt: null });
    forgetLeaderDisown(handle, sid);
    return true;
  }).immediate();
}

/**
 * A start the leader handed this host names `sid` (session-channel/host-routes.ts): the session is
 * this host's from its first write. A copy of its row already here that is not this host's yet (an
 * older version of the leader's seed) becomes this host's now, on the copy's own connection, so the
 * own-row writer takes the runner's first write of it; a copy that comes later does the same
 * (applySessionCopy). The leader's version it adopted is kept (noteLeaderDisown), so a start that
 * ends without a session gives the row back as the leader has it now. A row of another host is
 * never claimed. Nothing to do off a host that runs its sessions. `leaderRow`: the leader's row a
 * resume gives, taken over a copy here that is not this host's own (its cwd, mode, model and last
 * stop resume it); a row this host owns keeps its own fields and takes only the leader's.
 */
export function claimStartingRow(sid: string, leaderRow?: SessionRecord): void {
  const key = ownRowHostKey();
  if (!key || !sid) return;
  const handle = applyHandle ??= openCopyApplyConnection();
  handle.transaction(() => {
    const raw = handle.prepare('SELECT * FROM sessions WHERE claude_session_id = ?').get(sid) as Record<string, any> | undefined;
    // A resume names the leader's row (host-routes.ts resume), as the leader had it the moment it
    // handed it over: newer than any copy here (a copy round may not have brought its last stop yet,
    // and the runtime fences the resume with that stop's id).
    // A row this host owns already keeps every field of its own; only the leader's fields follow.
    const here = raw ? decodeSessionRow(raw) : null;
    const given = leaderRow?.claudeSessionId === sid ? { ...leaderRow, judge: undefined } : null;
    if (here && rowOwnedHere(here, key)) {
      claimStart(sid);
      if (given) putSessionRow(handle, mergeLeaderCopy(here, given));
      return;
    }
    const rec = given ?? here;
    if (rec && !claimable(rec, key)) {
      log.session.warn('host start: the row a start names is another host\'s; not claimed', { sessionId: sid, host: rec.host });
      return;
    }
    claimStart(sid);
    if (!rec || rowOwnedHere(rec, key)) return;
    // The leader's row a resume gives is whole (host-resume.ts): its prompts come down with it.
    putSessionRow(handle, claimedCopy(rec, key), rec === given ? promptChangesOf(given, { whole: true }) : {});
    // The leader's version as the leader holds it: a resume's row it marked this host's is no
    // disown (the stranded sweep must not hand it back); a copy from before its mark is one.
    if (leaderRow && given && rowOwnedHere(leaderRow, key)) forgetLeaderDisown(handle, sid);
    else noteLeaderDisown(handle, rec);
  }).immediate();
}

/**
 * The start of `sid` ended without a session here: the claim goes. A row it made this host's goes
 * back to the leader's version through the sweep of rows the leader disowns (stranded-own-rows.ts),
 * which checks first that no session here holds it.
 */
export function releaseStartingRow(sid: string): void {
  releaseClaim(sid);
}

// ── The cloud companion's copy of the Mac's sessions (stage 2c of
// docs/plan/walnut-companion-unified-replica.md): its own file under the copy store,
// never the box's live registry, which holds the sessions the box runs itself. ──

let companionCopy: { path: string; handle: DatabaseType } | null = null;

function companionCopyHandle(dbPath: string): DatabaseType {
  if (companionCopy && companionCopy.path === dbPath) return companionCopy.handle;
  if (companionCopy) { try { companionCopy.handle.close(); } catch { /* reopened below */ } }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const handle = new Database(dbPath);
  handle.pragma('journal_mode = WAL');
  handle.pragma('busy_timeout = 5000');
  handle.pragma('synchronous = NORMAL');
  initSessionSchema(handle, dbPath);
  // The Mac's rows as they came: missing columns only, no data fixes.
  ensureSessionStatusColumns(handle, undefined, { backfill: false });
  companionCopy = { path: dbPath, handle };
  return handle;
}

/** The ids the companion's sessions copy at `dbPath` holds. */
export function companionSessionCopyIds(dbPath: string): string[] {
  return companionCopyHandle(dbPath).prepare('SELECT claude_session_id FROM sessions').pluck().all() as string[];
}

/**
 * The rows a list can show, kept parsed in memory (the copy is the Mac's whole store,
 * 5,000 rows and 18 MB of JSON measured, so a list never parses it per request): not
 * archived, and live or active in the last 30 days (the list's own window is 14).
 */
const COPY_LIST_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
let copyRows: { path: string; rows: Map<string, SessionRecord> } | null = null;
let copyRowsLoad: Promise<Map<string, SessionRecord>> | null = null;
/** Bumped when the copy is closed: a parse begun before that installs nothing. */
let copyGen = 0;
/** Writes that landed while the rows were being parsed: applied to them once parsed. */
let copyRowsPending: Array<{ rows?: readonly SessionRecord[]; removeIds?: readonly string[] }> = [];

function listableCopyRow(r: SessionRecord, now: number): boolean {
  if (r.archived) return false;
  if (r.process_status !== 'stopped' && r.process_status !== 'error') return true;
  const at = Date.parse(r.lastActiveAt ?? r.startedAt);
  return Number.isFinite(at) && at >= now - COPY_LIST_WINDOW_MS;
}

function applyToCopyRows(rows: Map<string, SessionRecord>, change: { rows?: readonly SessionRecord[]; removeIds?: readonly string[] }): void {
  const now = Date.now();
  for (const id of change.removeIds ?? []) rows.delete(id);
  for (const r of change.rows ?? []) {
    if (listableCopyRow(r, now)) rows.set(r.claudeSessionId, r);
    else rows.delete(r.claudeSessionId);
  }
}

async function loadCopyRows(dbPath: string): Promise<Map<string, SessionRecord>> {
  const gen = copyGen;
  const cutoff = new Date(Date.now() - COPY_LIST_WINDOW_MS).toISOString();
  // This read holds every write before it: only the ones from here on are pending.
  copyRowsPending = [];
  // One read of the raw rows (strings), then the JSON parsed in slices between turns of the loop.
  const raw = companionCopyHandle(dbPath)
    .prepare("SELECT * FROM sessions WHERE coalesce(archived, 0) = 0 AND (coalesce(process_status, '') NOT IN ('stopped', 'error') OR coalesce(nullif(last_active_at, ''), started_at) >= ?)")
    .all(cutoff) as Array<Record<string, unknown>>;
  const rows = new Map<string, SessionRecord>();
  for (let i = 0; i < raw.length; i++) {
    const r = decodeSessionRow(raw[i]!);
    rows.set(r.claudeSessionId, r);
    if (i % 50 === 49) await new Promise((done) => setImmediate(done));
  }
  if (gen !== copyGen) return rows;
  for (const change of copyRowsPending) applyToCopyRows(rows, change);
  copyRowsPending = [];
  copyRows = { path: dbPath, rows };
  return rows;
}

/** The companion's sessions copy's one write: rows in as they came, removed ids out, one transaction. */
export function applyCompanionSessionCopy(dbPath: string, change: { rows?: readonly SessionRecord[]; removeIds?: readonly string[] }): void {
  const handle = companionCopyHandle(dbPath);
  const del = handle.prepare('DELETE FROM sessions WHERE claude_session_id = ?');
  handle.transaction(() => {
    for (const id of change.removeIds ?? []) { deleteSessionPrompts(handle, id); del.run(id); }
    for (const r of change.rows ?? []) putSessionRow(handle, r);
  })();
  // The parsed rows follow the file only once it is written.
  if (copyRows && copyRows.path === dbPath) applyToCopyRows(copyRows.rows, change);
  else if (copyRowsLoad) copyRowsPending.push(change);
}

/** The sessions of the companion's copy at `dbPath` a list can show (see COPY_LIST_WINDOW_MS). */
export async function readCompanionSessionCopy(dbPath: string): Promise<SessionRecord[]> {
  if (copyRows && copyRows.path === dbPath) return [...copyRows.rows.values()];
  if (!fs.existsSync(dbPath)) return [];
  if (!copyRowsLoad) {
    const load = loadCopyRows(dbPath).finally(() => { if (copyRowsLoad === load) copyRowsLoad = null; });
    copyRowsLoad = load;
  }
  return [...(await copyRowsLoad).values()];
}

/** Close the companion's sessions copy and forget its parsed rows (the next read opens and parses it again). */
export function closeCompanionSessionCopy(): void {
  copyGen++;
  if (companionCopy) {
    try { companionCopy.handle.close(); } catch { /* closing anyway */ }
    companionCopy = null;
  }
  copyRows = null;
  copyRowsLoad = null;
  copyRowsPending = [];
}

/**
 * Close the handle. Safe to call when already closed or never opened.
 * Intended for test teardown and graceful shutdown.
 */
export function closeDb(): void {
  closeCompanionSessionCopy();
  closeOwnRowWriter();
  if (applyHandle) {
    try { applyHandle.close(); } catch (err) { log.session.warn('session-db apply connection close error', { err: String(err) }); }
    applyHandle = null;
  }
  if (db) {
    try { db.close(); } catch (err) { log.session.warn('session-db close error', { err: String(err) }); }
    db = null;
  }
  initAttempted = false;
  initError = null;
  // A new open keeps each prompt where it is again, until its own gate answers.
  promptPayloadMode = 'keep';
}

/**
 * Run `fn` inside a single SQLite transaction.
 *
 * Same semantics as task-db.ts: `better-sqlite3` is synchronous by design; do
 * not `await` inside the transaction — that breaks commit boundaries.
 */
export function transaction<T>(fn: (db: DatabaseType) => T): T {
  const handle = getDb();
  if (!handle) {
    throw new Error('session-db: transaction() called before database was successfully opened');
  }
  const tx = handle.transaction(fn);
  return tx(handle);
}

/** A wait this long or longer is logged (ms). */
const LOCK_WAIT_LOG_MS = 100;
const LOCK_RETRY_MAX_MS = 25;
/** Since boot: sections that waited, their total and longest wait, those that gave up, and every refused try. */
const lockWaitStats = { waits: 0, waitedMs: 0, maxMs: 0, gaveUp: 0, retries: 0 };
let lockBudgetMs = BUSY_TIMEOUT_MS;
/** Tests: a shorter budget than busy_timeout's 5 s (null restores it). */
export function _setSessionLockBudgetForTesting(ms: number | null): void { lockBudgetMs = ms ?? BUSY_TIMEOUT_MS; }
/** What the write sections waited for the lock since boot. */
export function sessionLockWaitStats(): Readonly<typeof lockWaitStats> { return { ...lockWaitStats }; }

function isBusy(err: unknown): boolean {
  return /^SQLITE_BUSY/.test(String((err as { code?: unknown } | null)?.code ?? ''));
}

/** BEGIN IMMEDIATE without SQLite's own wait: false when another connection holds the write lock. */
function tryBeginImmediate(handle: DatabaseType): boolean {
  handle.pragma('busy_timeout = 0');
  try {
    handle.exec('BEGIN IMMEDIATE');
    return true;
  } catch (err) {
    if (isBusy(err)) return false;
    throw err;
  } finally {
    handle.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  }
}

/**
 * Run `fn` in one IMMEDIATE transaction, waiting for the write lock with the
 * event loop free. SQLite's own wait (busy_timeout) blocks the calling thread
 * for as long as another connection holds the lock: on the Mac a 1.5 s hold
 * kept the server's loop thread 1.5 s inside one INSERT, 0.1 ms of it on the
 * CPU (2026-11-20). Here a held lock is tried again after 1, 2, 4 ... 25 ms
 * within the same 5 s budget, then fails with the same SQLITE_BUSY. The lock is
 * taken before `fn` runs, so a retry never repeats any of its work, and `fn`
 * stays synchronous: no await inside it.
 */
export function transactionWhenFree<T>(fn: (db: DatabaseType) => T): T | Promise<T> {
  const handle = openForWrite();
  // A host replica's copy is query_only (BEGIN IMMEDIATE is refused there): its sections only
  // read, except a host that runs its sessions, whose sections write its own rows through the
  // own-row writer (below), which refuses any other row.
  if (isHostReplica()) {
    const own = ownRowWriter();
    if (own) return own.inTransaction ? own.transaction(fn)(own) : own.transaction(fn).immediate(own);
    return handle.transaction(fn)(handle);
  }
  // Inside a caller's transaction the lock is held already: a savepoint, as transaction() does.
  if (handle.inTransaction) return handle.transaction(fn)(handle);
  // Free now (the usual case): it runs and commits before this returns, with no extra turn of
  // the loop, so a caller's order of events is what it was with transaction().
  if (tryBeginImmediate(handle)) return runLocked(handle, fn);
  return waitForLockThenRun(fn);
}

// ── A host's own rows (sessions/session-row-owner.ts rowOwnedHere) ──
//
// A host replica's sessions.sqlite is the leader's copy, read only (copy-guard.ts). A host that
// runs and judges its sessions writes its own rows there: through a connection of its own whose
// TEMP triggers refuse every write of a row that is not this host's (host = its key, judge
// 'host'), before and after the write, so the copy's other rows stay the leader's. The follower
// apply connection (applySessionCopy) stays the one writer of those.

/** What a write of another row is refused with. */
export const NOT_OWN_ROW = 'session-db: this host writes only its own session rows';

let ownRows: { hostKey: string; handle: DatabaseType | null } | null = null;

/** Turn the own-row writer on for `hostKey` (a host whose service runs its sessions), or off (null). */
export function allowOwnRowWrites(hostKey: string | null): void {
  const key = (hostKey ?? '').trim();
  if (ownRows?.handle && ownRows.hostKey !== key) {
    try { ownRows.handle.close(); } catch { /* replaced anyway */ }
    ownRows.handle = null;
  }
  ownRows = key ? { hostKey: key, handle: ownRows?.hostKey === key ? ownRows.handle : null } : null;
}

function closeOwnRowWriter(): void {
  if (!ownRows?.handle) return;
  try { ownRows.handle.close(); } catch { /* closing anyway */ }
  ownRows.handle = null;
}

function ownRowWriter(): DatabaseType | null {
  if (!ownRows || !isHostReplica()) return null;
  if (ownRows.handle) return ownRows.handle;
  getDb();
  const h = openApplyConnection(SESSION_DB_PATH, 'sessions (own rows)');
  // A REPLACE deletes the row it replaces: the delete trigger must see that too.
  h.pragma('recursive_triggers = ON');
  h.exec('CREATE TEMP TABLE IF NOT EXISTS own_host (k TEXT NOT NULL); DELETE FROM temp.own_host;');
  h.prepare('INSERT INTO temp.own_host (k) VALUES (?)').run(ownRows.hostKey);
  const own = (r: string) => `(${r}.host = (SELECT k FROM temp.own_host) AND ${r}.payload IS NOT NULL AND json_valid(${r}.payload) AND json_extract(${r}.payload, '$.judge') = 'host')`;
  const refuse = `SELECT RAISE(ABORT, '${NOT_OWN_ROW}');`;
  h.exec(`
    CREATE TEMP TRIGGER IF NOT EXISTS own_rows_insert BEFORE INSERT ON main.sessions WHEN NOT ${own('NEW')} BEGIN ${refuse} END;
    CREATE TEMP TRIGGER IF NOT EXISTS own_rows_update BEFORE UPDATE ON main.sessions WHEN NOT (${own('OLD')} AND ${own('NEW')}) BEGIN ${refuse} END;
    CREATE TEMP TRIGGER IF NOT EXISTS own_rows_delete BEFORE DELETE ON main.sessions WHEN NOT ${own('OLD')} BEGIN ${refuse} END;
  `);
  // A prompt row is its session's: only an own row's (putSessionRow writes the row first, and a
  // delete takes the prompts before the row).
  const ownPrompt = (r: string) => `EXISTS (SELECT 1 FROM sessions s WHERE s.claude_session_id = ${r}.claude_session_id AND ${own('s')})`;
  h.exec(`
    CREATE TEMP TRIGGER IF NOT EXISTS own_prompts_insert BEFORE INSERT ON main.session_prompts WHEN NOT ${ownPrompt('NEW')} BEGIN ${refuse} END;
    CREATE TEMP TRIGGER IF NOT EXISTS own_prompts_update BEFORE UPDATE ON main.session_prompts WHEN NOT (${ownPrompt('OLD')} AND ${ownPrompt('NEW')}) BEGIN ${refuse} END;
    CREATE TEMP TRIGGER IF NOT EXISTS own_prompts_delete BEFORE DELETE ON main.session_prompts WHEN NOT ${ownPrompt('OLD')} BEGIN ${refuse} END;
  `);
  ownRows.handle = h;
  return h;
}

/** The host key whose rows the own-row writer writes, or null (off, or not a host replica). */
export function ownRowHostKey(): string | null {
  return ownRows && isHostReplica() ? ownRows.hostKey : null;
}

/** The handle this process's session writes go through now (the own-row writer on a host that runs its sessions). */
export function sessionWriteHandle(): DatabaseType | null {
  return (isHostReplica() ? ownRowWriter() : null) ?? getDb();
}

function openForWrite(): DatabaseType {
  const handle = getDb();
  if (!handle) throw new Error('session-db: transactionWhenFree() called before database was successfully opened');
  return handle;
}

/** `fn` in the transaction BEGIN IMMEDIATE just opened on `handle`, then COMMIT (ROLLBACK on a throw). */
function runLocked<T>(handle: DatabaseType, fn: (db: DatabaseType) => T): T {
  try {
    const value = handle.transaction(fn)(handle);
    handle.exec('COMMIT');
    return value;
  } catch (err) {
    if (handle.inTransaction) {
      try { handle.exec('ROLLBACK'); } catch { /* the error below is the one to report */ }
    }
    throw err;
  }
}

async function waitForLockThenRun<T>(fn: (db: DatabaseType) => T): Promise<T> {
  const start = performance.now();
  let tries = 1;
  let delay = 1;
  let looked = false;
  lockWaitStats.retries += 1;
  for (;;) {
    const waited = performance.now() - start;
    // While the lock is still held: which processes have the store open (at most once a minute).
    if (!looked && waited >= LOCK_WAIT_LOG_MS) {
      looked = true;
      lookForHolders(SESSION_DB_PATH, 'BEGIN IMMEDIATE', waited);
    }
    if (waited >= lockBudgetMs) {
      lockWaitStats.gaveUp += 1;
      log.session.warn('session-db: write gave up waiting for the lock', { waitedMs: Math.round(waited), tries });
      throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(delay, lockBudgetMs - waited)));
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS);
    // A wipe or a close in the wait replaced the connection: try on the one there is now.
    const handle = openForWrite();
    if (tryBeginImmediate(handle)) {
      const total = performance.now() - start;
      lockWaitStats.waits += 1;
      lockWaitStats.waitedMs += total;
      if (total > lockWaitStats.maxMs) lockWaitStats.maxMs = total;
      if (total >= LOCK_WAIT_LOG_MS) log.session.info('session-db: write waited for the lock', { waitedMs: Math.round(total), tries });
      return runLocked(handle, fn);
    }
    tries += 1;
    lockWaitStats.retries += 1;
  }
}

/**
 * Idempotently add/backfill the versioned status projection columns.
 * Kept explicit because CREATE TABLE IF NOT EXISTS never alters old tables.
 */
export function ensureSessionStatusColumns(
  handle: DatabaseType,
  now = new Date().toISOString(),
  opts: { backfill?: boolean } = {},
): void {
  const columns = handle.pragma('table_info(sessions)') as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  const migrate = handle.transaction(() => {
    if (!names.has('status_revision')) {
      handle.exec(
        'ALTER TABLE sessions ADD COLUMN status_revision INTEGER NOT NULL DEFAULT 1',
      );
    }
    if (!names.has('status_updated_at')) {
      handle.exec('ALTER TABLE sessions ADD COLUMN status_updated_at TEXT');
    }
    // The stubs of the prompt texts the payload holds (session-prompts.ts textRefsColumnOf). A build
    // before the split never names it, so its write leaves it NULL: "measure the payload".
    if (!names.has(PROMPT_TEXT_REFS_COLUMN)) {
      handle.exec(`ALTER TABLE sessions ADD COLUMN ${PROMPT_TEXT_REFS_COLUMN} TEXT`);
    }
    if (opts.backfill === false) return;
    handle.prepare(`
      UPDATE sessions
      SET status_revision = 1
      WHERE status_revision IS NULL OR status_revision < 1
    `).run();
    handle.prepare(`
      UPDATE sessions
      SET status_updated_at = COALESCE(
        NULLIF(status_updated_at, ''),
        NULLIF(last_status_change, ''),
        NULLIF(last_active_at, ''),
        NULLIF(started_at, ''),
        ?
      )
      WHERE status_updated_at IS NULL OR status_updated_at = ''
    `).run(now);
  });
  migrate();
}

// ── (De)serialization ──────────────────────────────────────────────────────
//
// A row is one record in two places: its columns and `payload` here, and its two prompt texts in
// `session_prompts` (session-prompts.ts says why). A payload comes in two shapes, told row by row:
// an old shape holds a text (every build before the split wrote it so, and release A still does),
// a new shape holds only the text's stub. While a payload holds a text it is the newest one (a build
// before the split may have written it after the table's), so every reader prefers it.

/** The payload JSON of a row as an object, or {} (an unreadable one is logged and read as empty). */
function payloadOf(row: Record<string, any>): Record<string, any> {
  if (row.payload == null || row.payload === '') return {};
  try {
    const parsed = JSON.parse(row.payload);
    // A fresh object of its own (the callers build the record on it): no copy.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (err) {
    log.session.warn('rowToSession: payload JSON parse failed', { claudeSessionId: row.claude_session_id, err: String(err) });
  }
  return {};
}

/** The record of a row's columns over its parsed payload (columns win), with the required fallbacks. */
function recordOf(row: Record<string, any>, payload: Record<string, any>): SessionRecord {
  const record: Record<string, any> = payload;
  for (const col of EXPLICIT_SESSION_COLUMNS) {
    const val = row[col];
    if (val === undefined || val === null) continue;
    const field = COLUMN_TO_FIELD[col];
    if (!field) continue; // defensive — should never hit
    record[field] = BOOLEAN_COLUMNS.has(col) ? val === 1 || val === true : val;
  }
  // Required-field fallbacks — the DB may have NULL where SessionRecord expects a value
  // (pre-migration or partially written rows). Match the JSON-load defaults.
  if (typeof record.messageCount !== 'number') record.messageCount = 0;
  if (typeof record.startedAt !== 'string' || !record.startedAt) record.startedAt = record.lastActiveAt ?? new Date().toISOString();
  if (typeof record.lastActiveAt !== 'string' || !record.lastActiveAt) record.lastActiveAt = record.startedAt;
  return record as SessionRecord;
}

/**
 * The stubs of the texts the cache scan took out of a row's payload (sessionCacheRowsSql), else
 * none: from the row's `prompt_text_refs` column, or for a row a build before the split wrote, from
 * the sizes the scan measured.
 */
function scanStubsOf(row: Record<string, any>, inPayload: SessionPrompts): { appliedAppendSystemPrompt?: SessionPromptRef; systemPrompt?: SessionPromptRef } {
  if (row.cache_scan !== 1) return {};
  const column = row[PROMPT_TEXT_REFS_COLUMN];
  if (typeof column === 'string') {
    // The column names the texts the payload held; those the scan took out are not in it now.
    if (column === '{}' || (inPayload.appliedAppendSystemPrompt !== undefined && inPayload.systemPrompt !== undefined)) return {};
    const refs = textRefsOf(column);
    return {
      ...(inPayload.appliedAppendSystemPrompt === undefined && refs.appliedAppendSystemPrompt ? { appliedAppendSystemPrompt: refs.appliedAppendSystemPrompt } : {}),
      ...(inPayload.systemPrompt === undefined && refs.systemPrompt ? { systemPrompt: refs.systemPrompt } : {}),
    };
  }
  const out: { appliedAppendSystemPrompt?: SessionPromptRef; systemPrompt?: SessionPromptRef } = {};
  if (typeof row.aasp_bytes === 'number') out.appliedAppendSystemPrompt = { bytes: row.aasp_bytes };
  if (typeof row.persona_bytes === 'number') out.systemPrompt = { bytes: row.persona_bytes, blank: row.persona_blank === 1 };
  return out;
}

/**
 * The stub record of a row (the session store cache, a writer's read in its transaction): no text,
 * a stub of each text present. Reads nothing else: an old-shape payload's text makes its stub here
 * (a stub an older build kept beside a text it changed is stale; no hash, the text is beside it),
 * and the cache scan's row, whose texts SQLite took out, gets its stubs from the scan. A payload
 * stub stands for a text only when it was not written beside it (standingRef).
 */
export function decodeSessionRow(row: Record<string, any>, out?: { stored?: StoredPromptState }): SessionRecord {
  const payload = payloadOf(row);
  const prompts = promptsOf(payload);
  const scanned = scanStubsOf(row, prompts);
  const refs = {
    appliedAppendSystemPrompt: scanned.appliedAppendSystemPrompt ?? (prompts.appliedAppendSystemPrompt === undefined ? standingRef(payload.appliedAppendSystemPromptRef) : undefined),
    systemPrompt: scanned.systemPrompt ?? (prompts.systemPrompt === undefined ? standingRef(payload.profile?.systemPromptRef) : undefined),
  };
  // A writer that read this whole row in its transaction hands this on to putSessionRow, which
  // then reads nothing again (a status write's second read of both texts, 0.1 to 0.3 ms).
  if (out && row.cache_scan !== 1) out.stored = storedStateOf(prompts, payload);
  // The common row once stripped, or with no prompt: no text, and each stub it has is the one it
  // keeps. The payload is the record as it is (the full scan decodes every row this way).
  if (prompts.appliedAppendSystemPrompt === undefined && prompts.systemPrompt === undefined
    && refs.appliedAppendSystemPrompt === payload.appliedAppendSystemPromptRef && refs.systemPrompt === payload.profile?.systemPromptRef) {
    return recordOf(row, payload);
  }
  // A text still in the payload: its stub (no hash, see promptRefOf). A stub alone: as stored.
  return recordOf(row, withPromptStubs(payload, prompts, refs, false));
}

/**
 * The whole record of a row, as every build read it: both texts and no stub. A new-shape row's
 * texts come from `session_prompts` on `handle` (two primary-key reads); an old-shape row's from its
 * payload. A stub whose text is missing from the table stays, so a writer that builds on this record
 * keeps the stored text (promptChangesOf) instead of clearing it.
 */
export function rowToSession(row: Record<string, any>): SessionRecord {
  return wholeRecordOf(row, null);
}

/** rowToSession, its prompt table read on `handle` (a transaction's, another file's). */
export function rowToSessionIn(handle: DatabaseType, row: Record<string, any>): SessionRecord {
  return wholeRecordOf(row, handle);
}

function wholeRecordOf(row: Record<string, any>, handle: DatabaseType | null): SessionRecord {
  const payload = payloadOf(row);
  const inPayload = promptsOf(payload);
  // A stub written beside its text and found without it: cleared by a build before the split, so
  // the table's copy is stale and is not read back (standingRef).
  const wantAasp = inPayload.appliedAppendSystemPrompt === undefined && !!standingRef(payload.appliedAppendSystemPromptRef);
  const wantPersona = inPayload.systemPrompt === undefined && !!standingRef(payload.profile?.systemPromptRef);
  if (!wantAasp && !wantPersona) return recordOf(row, withPromptTexts(payload, inPayload));
  const db = handle ?? getDb();
  const table = db && typeof row.claude_session_id === 'string' ? tablePrompts(db, row.claude_session_id) : {};
  const prompts = { ...inPayload };
  if (wantAasp && table.appliedAppendSystemPrompt !== undefined) prompts.appliedAppendSystemPrompt = table.appliedAppendSystemPrompt;
  if (wantPersona && table.systemPrompt !== undefined) prompts.systemPrompt = table.systemPrompt;
  const whole = withPromptTexts(payload, prompts);
  // A stub the table has no text for: kept (see above).
  if (wantAasp && prompts.appliedAppendSystemPrompt === undefined) whole.appliedAppendSystemPromptRef = payload.appliedAppendSystemPromptRef;
  if (wantPersona && prompts.systemPrompt === undefined && whole.profile) whole.profile = { ...whole.profile, systemPromptRef: payload.profile.systemPromptRef };
  return recordOf(row, whole);
}

/**
 * The row of a record: its columns and a payload with the stubs of `prompts`, and beside each stub
 * of a prompt `shape` names its text too (a build before the split reads it there): 'both' names
 * every prompt, 'stubs' none, a list the ones it names (putSessionRow: payloadKeepsText). The
 * record's own texts and stubs are ignored: the caller says what the stored prompts are. `shape`
 * 'texts' is the shape before the split (texts, no stub): the down migration's.
 */
function encodeSessionRow(
  session: Partial<SessionRecord>, prompts: SessionPrompts, refs: StoredPromptState['refs'] = {},
  shape: 'stubs' | 'both' | 'texts' | readonly PromptKey[] = promptPayloadMode === 'stubs' ? 'stubs' : 'both',
): Record<string, any> {
  const row: Record<string, any> = {};
  for (const [field, col] of Object.entries(FIELD_TO_COLUMN)) {
    if (!(field in session)) continue;
    const val = (session as Record<string, any>)[field];
    if (val === undefined) continue;
    row[col] = BOOLEAN_COLUMNS.has(col) ? (val ? 1 : 0) : val;
  }
  // The texts the payload keeps (beside their stubs) and the ones only their stub stands for.
  const kept: SessionPrompts = {};
  const stubbed: SessionPrompts = {};
  if (shape !== 'texts') {
    const keeps = shape === 'both' ? PROMPT_KEYS : shape === 'stubs' ? [] : shape;
    for (const k of PROMPT_KEYS) if (prompts[k] !== undefined) (keeps.includes(k) ? kept : stubbed)[k] = prompts[k];
  }
  // A stub alone is what a comparison reads, with its hash. A stub beside its text needs no hash and
  // says it sits there (`inline`, see standingRef).
  const shaped = shape === 'texts' ? withPromptTexts(session, prompts) : withPromptStubs(session, stubbed, refs);
  if (shape === 'texts') {
    // A stub whose text the table lacks stays: the row still reads as split, and the checks say so.
    if (prompts.appliedAppendSystemPrompt === undefined && session.appliedAppendSystemPromptRef) shaped.appliedAppendSystemPromptRef = session.appliedAppendSystemPromptRef;
    if (prompts.systemPrompt === undefined && session.profile?.systemPromptRef && shaped.profile) shaped.profile = { ...shaped.profile, systemPromptRef: session.profile.systemPromptRef };
  }
  const inlineRef = (text: string, persona: boolean): SessionPromptRef => ({ ...promptRefOf(text, persona, false), inline: true });
  if (kept.appliedAppendSystemPrompt !== undefined) {
    (shaped as Partial<SessionRecord>).appliedAppendSystemPromptRef = inlineRef(kept.appliedAppendSystemPrompt, false);
    (shaped as Partial<SessionRecord>).appliedAppendSystemPrompt = kept.appliedAppendSystemPrompt;
  }
  if (kept.systemPrompt !== undefined && shaped.profile) {
    shaped.profile = { ...shaped.profile, systemPromptRef: inlineRef(kept.systemPrompt, true), systemPrompt: kept.systemPrompt };
  }
  const payload: Record<string, any> = {};
  let hasPayload = false;
  for (const key of Object.keys(shaped)) {
    if (EXPLICIT_SESSION_KEYS.has(key) || NON_PERSISTED_KEYS.has(key)) continue;
    const val = (shaped as Record<string, any>)[key];
    if (val === undefined) continue;
    payload[key] = val;
    hasPayload = true;
  }
  if (hasPayload) row.payload = JSON.stringify(payload);
  else if ('payload' in session) row.payload = null; // explicit clear request
  // The stubs of the texts this payload holds, for the cache scan (none in release B's shape).
  row[PROMPT_TEXT_REFS_COLUMN] = textRefsColumnOf(shape === 'texts' ? prompts : kept, !!shaped.profile);
  // Full legacy records may reach the writer without the versioned fields: safe initial values
  // instead of NULL (status_revision is NOT NULL).
  if (typeof session.claudeSessionId === 'string') {
    if (row.status_revision === undefined) row.status_revision = 1;
    if (row.status_updated_at === undefined) {
      row.status_updated_at = session.last_status_change ?? session.lastActiveAt ?? session.startedAt ?? new Date().toISOString();
    }
  }
  return row;
}

/**
 * The row of a whole record, its own texts as its prompts (a fixture's or a script's raw row: the
 * store's own writes go through putSessionRow, which also writes `session_prompts`).
 */
export function sessionToRow(session: Partial<SessionRecord>): Record<string, any> {
  return encodeSessionRow(session, promptsOf(session));
}

// Re-export the column list so callers can build prepared statements without
// duplicating the ordering.
export const SESSION_COLUMNS: readonly string[] = EXPLICIT_SESSION_COLUMNS;

// ── The prompt table ───────────────────────────────────────────────────────

/**
 * Where a write leaves each prompt's text: in the payload too (release A's shape, which every build
 * reads) or only in `session_prompts`, its stub in the payload. Set by the strip gate
 * (session-prompt-gate.ts), which the leader asks once per open, past the boot burst:
 *
 *   - 'keep': each open starts here, the gate not asked yet. A prompt stays where it is: a text its
 *     payload holds stays there, a stripped one stays stripped, a new row's texts go in its payload.
 *     Stripping here would strip every live row by its next status write, the rows whose persona a
 *     downgraded build needs first; putting a stripped text back would undo an earlier open's strip
 *     on every row this window writes (before 2026-11-27 it did: a host's rows, written every few
 *     seconds and replayed at each restart, came back whole after every boot, and that boot's strip
 *     pass moved them again). Neither shape is less readable after the write than before it.
 *   - 'texts': the gate is closed (a build this home can go back to may not read the split): every
 *     text in its payload, a stripped one carried back from the table, as release A did.
 *   - 'stubs': the gate opened: only the stubs, and the strip pass moves the rest.
 *
 * It holds for the rest of the open; closeDb starts the next one at 'keep'.
 */
let promptPayloadMode: 'keep' | 'texts' | 'stubs' = 'keep';
/** May a write of this open leave a prompt text in a payload? (false once the gate opened) */
export function promptTextsInPayload(): boolean { return promptPayloadMode !== 'stubs'; }
/** The gate opened: writes from now on leave only the stubs in a payload (until the store closes). */
export function letPromptTextsLeavePayload(): void { promptPayloadMode = 'stubs'; }
/** The gate is closed: writes from now on keep every text in its payload too (until the store closes). */
export function keepPromptTextsInPayload(): void { promptPayloadMode = 'texts'; }

/**
 * The one rule of where a write leaves prompt `k`'s text (promptPayloadMode): in the payload too,
 * or only in the table. `stripped`: the row as stored has `k` only as a stub that stands for the
 * table's text.
 */
function payloadKeepsText(stripped: boolean): boolean {
  return promptPayloadMode === 'texts' || (promptPayloadMode === 'keep' && !stripped);
}

/** The column with the stubs of the texts a row's payload holds (session-prompts.ts textRefsColumnOf). */
export const PROMPT_TEXT_REFS_COLUMN = 'prompt_text_refs';
const textRefsColumnOn = new WeakMap<DatabaseType, boolean>();
/** Does this handle's sessions table have it? (a fixture's own table may not; the store's always does) */
function hasTextRefsColumn(handle: DatabaseType): boolean {
  let has = textRefsColumnOn.get(handle);
  if (has === undefined) {
    has = (handle.pragma('table_info(sessions)') as Array<{ name: string }>).some((c) => c.name === PROMPT_TEXT_REFS_COLUMN);
    textRefsColumnOn.set(handle, has);
  }
  return has;
}

/** The table's field names of the two texts. */
const FIELD_OF: Record<PromptKey, string> = { appliedAppendSystemPrompt: 'appliedAppendSystemPrompt', systemPrompt: 'profile.systemPrompt' };
const KEY_OF: Record<string, PromptKey> = { appliedAppendSystemPrompt: 'appliedAppendSystemPrompt', 'profile.systemPrompt': 'systemPrompt' };

/** Each text the table keeps for `sid`. */
function tablePrompts(handle: DatabaseType, sid: string): SessionPrompts {
  const rows = prepared(handle, 'SELECT field, body FROM session_prompts WHERE claude_session_id = ?').all(sid) as Array<{ field: string; body: string }>;
  const out: SessionPrompts = {};
  for (const r of rows) {
    const k = KEY_OF[r.field];
    if (k && typeof r.body === 'string') out[k] = r.body;
  }
  return out;
}


/** What a row holds of its prompts now: each text its payload holds, the stub of each it does not, and whether it has a profile. */
export interface StoredPromptState {
  texts: SessionPrompts;
  refs: { appliedAppendSystemPrompt?: SessionPromptRef; systemPrompt?: SessionPromptRef };
  /** A stub written beside its text, found without it: cleared by a build before the split (its table row is stale). */
  cleared: PromptKey[];
  row: boolean;
}

/** A row's stored prompt state from its parsed payload (its texts, the stubs that stand for one, the cleared ones). */
function storedStateOf(texts: SessionPrompts, payload: Record<string, any>): StoredPromptState {
  const out: StoredPromptState = { texts: { ...texts }, refs: {}, cleared: [], row: true };
  const take = (k: PromptKey, ref: unknown) => {
    if (texts[k] !== undefined) return;
    const standing = standingRef(ref);
    if (standing) out.refs[k] = standing;
    else if (ref && typeof ref === 'object') out.cleared.push(k);
  };
  take('appliedAppendSystemPrompt', payload.appliedAppendSystemPromptRef);
  take('systemPrompt', payload.profile?.systemPromptRef);
  return out;
}

function storedPromptState(handle: DatabaseType, sid: string): StoredPromptState {
  // One parse in SQLite and one in JS: the four values as one JSON array (a writer reads this on
  // every write, so not one json_valid and json_extract per value).
  const r = prepared(handle, `SELECT 1 AS here, CASE WHEN instr(payload, 'ystemPrompt') > 0 AND json_valid(payload)
      THEN json_extract(payload, '$.appliedAppendSystemPrompt', '$.profile.systemPrompt', '$.appliedAppendSystemPromptRef', '$.profile.systemPromptRef') END AS v
    FROM sessions WHERE claude_session_id = ?`).get(sid) as { here: number; v: string | null } | undefined;
  const out: StoredPromptState = { texts: {}, refs: {}, cleared: [], row: !!r };
  if (!r?.v) return out;
  let a: unknown, p: unknown, ar: unknown, pr: unknown;
  try { [a, p, ar, pr] = JSON.parse(r.v) as unknown[]; } catch { return out; }
  const take = (k: PromptKey, text: unknown, ref: unknown) => {
    if (typeof text === 'string') { out.texts[k] = text; return; }
    const standing = standingRef(ref);
    if (standing) out.refs[k] = standing;
    else if (ref && typeof ref === 'object') out.cleared.push(k);
  };
  take('appliedAppendSystemPrompt', a, ar);
  take('systemPrompt', p, pr);
  return out;
}

/**
 * Both prompts of `sid` as stored, inside or outside a transaction on `handle`: a payload's text
 * where it holds one (it is the newer, see above), else the table's.
 */
export function readSessionPrompts(handle: DatabaseType, sid: string): SessionPrompts {
  const state = storedPromptState(handle, sid);
  if (!state.row) return {};
  const out: SessionPrompts = { ...state.texts };
  // The table only for a stub that stands for its text (never one a build before the split cleared).
  if (PROMPT_KEYS.some((k) => out[k] === undefined && state.refs[k])) {
    const table = tablePrompts(handle, sid);
    for (const k of PROMPT_KEYS) if (out[k] === undefined && state.refs[k] && table[k] !== undefined) out[k] = table[k];
  }
  return out;
}

/** What the writes of this process cost since it started (the `memory sample` line's sessionStore note). */
const writeStats = { writes: 0, writeMs: 0, writeMaxMs: 0, payloadBytesWritten: 0, promptRowsWritten: 0, shadowMismatches: 0 };
export function sessionRowWriteStats(): Readonly<typeof writeStats> { return { ...writeStats }; }
export function _resetSessionRowWriteStatsForTesting(): void { for (const k of Object.keys(writeStats) as (keyof typeof writeStats)[]) writeStats[k] = 0; }

/**
 * The one writer of a session row (every INSERT OR REPLACE of `sessions` is this one), and of its
 * prompt rows, in the caller's transaction on `handle`. `changes` names the prompts the caller sets
 * or clears; every other prompt stays as stored (`from`: the row to read it from, a rename's or a
 * copy's old id). A prompt row is written only when its text differs from the stored one. A
 * persona needs a profile: a record without one has none.
 */
export function putSessionRow(
  handle: DatabaseType, session: SessionRecord, changes: PromptChanges = {},
  opts: { from?: string; insert?: boolean; stored?: StoredPromptState } = {},
): void {
  const t0 = performance.now();
  const sid = session.claudeSessionId;
  const source = opts.from ?? sid;
  // `stored`: the writer's own read of this row in this transaction (decodeSessionRow's `out`).
  const stored = (!opts.from && opts.stored) || storedPromptState(handle, source);
  // Each prompt after this write (`after`: its text; `refs`: a stub whose text this write does not
  // read), the ones whose text the payload keeps (`kept`), and the table writes it takes.
  const after: SessionPrompts = {};
  const refs: StoredPromptState['refs'] = {};
  const kept: PromptKey[] = [];
  const sets: SessionPrompts = {};
  const clears: PromptKey[] = [];
  let table: SessionPrompts | null = null;
  const fromTable = (k: PromptKey): string | undefined => (table ??= tablePrompts(handle, source))[k];
  for (const k of PROMPT_KEYS) {
    const c = changes[k];
    if (k === 'systemPrompt' && !session.profile) {
      // A persona lives in its profile: a record without one has none.
      if (c != null || stored.texts.systemPrompt !== undefined || stored.refs.systemPrompt) clears.push(k);
      continue;
    }
    if (c === null) { clears.push(k); continue; }
    const inPayload = payloadKeepsText(stored.texts[k] === undefined && !!stored.refs[k]);
    if (inPayload) kept.push(k);
    if (typeof c === 'string') { after[k] = c; sets[k] = c; continue; }
    // Cleared by a build before the split: its stale table row goes too.
    if (stored.cleared.includes(k)) { clears.push(k); continue; }
    const text = stored.texts[k];
    if (text !== undefined) {
      after[k] = text;
      // A text only an old-shape payload holds moves into the table when the payload stops holding
      // it (release B), and goes with the row to its new id.
      if (!inPayload || opts.from) sets[k] = text;
      continue;
    }
    if (!stored.refs[k]) continue;
    // A new-shape row: a closed gate carries the table's text into the payload; a move takes it along.
    const t = inPayload || opts.from ? fromTable(k) : undefined;
    if (t === undefined) { refs[k] = stored.refs[k]; continue; }
    if (inPayload) after[k] = t;
    else refs[k] = stored.refs[k];
    if (opts.from) sets[k] = t;
  }
  const row = encodeSessionRow(session, after, refs, kept);
  const cols = [...EXPLICIT_SESSION_COLUMNS, 'payload', ...(hasTextRefsColumn(handle) ? [PROMPT_TEXT_REFS_COLUMN] : [])];
  const bound: Record<string, unknown> = {};
  for (const c of cols) bound[c] = row[c] === undefined ? null : row[c];
  const names = cols.join(', ');
  const values = cols.map((c) => '@' + c).join(', ');
  handle.prepare(opts.insert ? `INSERT INTO sessions (${names}) VALUES (${values})` : `INSERT OR REPLACE INTO sessions (${names}) VALUES (${values})`).run(bound);
  // After the row: a host's own-row triggers on the prompt table ask that the row is its own.
  for (const k of clears) {
    writeStats.promptRowsWritten += Number(prepared(handle, 'DELETE FROM session_prompts WHERE claude_session_id = ? AND field = ?').run(sid, FIELD_OF[k]).changes ?? 0);
  }
  for (const k of PROMPT_KEYS) {
    const text = sets[k];
    if (text === undefined) continue;
    if (!writePromptRow(handle, sid, k, text)) continue;
    writeStats.promptRowsWritten += 1;
    if (kept.includes(k)) shadowCheck(handle, sid, k);
  }
  const ms = performance.now() - t0;
  writeStats.writes += 1;
  writeStats.writeMs += ms;
  if (ms > writeStats.writeMaxMs) writeStats.writeMaxMs = ms;
  writeStats.payloadBytesWritten += typeof row.payload === 'string' ? Buffer.byteLength(row.payload, 'utf8') : 0;
}

/** Keep `text` as `sid`'s prompt `k`, unless the table holds it already (its hash). True: written. */
function writePromptRow(handle: DatabaseType, sid: string, k: PromptKey, text: string): boolean {
  const sha = promptSha256(text);
  if (prepared(handle, 'SELECT sha256 FROM session_prompts WHERE claude_session_id = ? AND field = ?', 'pluck').get(sid, FIELD_OF[k]) === sha) return false;
  prepared(handle, 'INSERT OR REPLACE INTO session_prompts (claude_session_id, field, body, sha256, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(sid, FIELD_OF[k], text, sha, new Date().toISOString());
  return true;
}

/** Release A's check after a prompt write: the table's text is the payload's. A mismatch is logged (zero over A's day gates B). */
function shadowCheck(handle: DatabaseType, sid: string, k: PromptKey): void {
  const path = k === 'appliedAppendSystemPrompt' ? '$.appliedAppendSystemPrompt' : '$.profile.systemPrompt';
  const r = prepared(handle, `SELECT (SELECT body FROM session_prompts WHERE claude_session_id = ?1 AND field = ?2) AS body,
      (SELECT CASE WHEN json_valid(payload) THEN json_extract(payload, ?3) END FROM sessions WHERE claude_session_id = ?1) AS text`)
    .get(sid, FIELD_OF[k], path) as { body: unknown; text: unknown } | undefined;
  if (r && r.body === r.text) return;
  writeStats.shadowMismatches += 1;
  log.session.warn('session prompts: the table and the payload differ after a prompt write', {
    sessionId: sid, field: FIELD_OF[k],
    tableBytes: typeof r?.body === 'string' ? Buffer.byteLength(r.body) : null, payloadBytes: typeof r?.text === 'string' ? Buffer.byteLength(r.text) : null,
  });
}

/** Delete `sid`'s prompt rows (with its row, in the same transaction, before the row goes: a host's triggers ask for its row). */
export function deleteSessionPrompts(handle: DatabaseType, sid: string): void {
  prepared(handle, 'DELETE FROM session_prompts WHERE claude_session_id = ?').run(sid);
}

/** Prompt rows whose session row is gone: nothing can read them. Returns how many went. */
export function sweepOrphanSessionPrompts(handle: DatabaseType): number {
  return Number(handle.prepare('DELETE FROM session_prompts WHERE claude_session_id NOT IN (SELECT claude_session_id FROM sessions)').run().changes ?? 0);
}

/** The marker a finished strip pass leaves (diagnostics and the rollback check; no reader gates on it). */
export const PROMPT_SPLIT_MARKER = 'prompt-split-v1';

/** One batch of a strip pass: what it did and where the next one starts. */
export interface PromptBatch { ids: string[]; lastRowid: number; done: boolean; rows: number; bytesMoved: number }

/**
 * One strip batch, in the caller's transaction on `handle`: the next rows after `afterRowid` whose
 * payload still holds a text, each written as the new shape (its texts in the table, the stubs in its
 * payload), until `maxRows` or `budgetMs`. A row whose text-like match was not a prompt is passed by.
 */
export function stripPromptBatch(handle: DatabaseType, afterRowid: number, maxRows = 25, budgetMs = 15): PromptBatch {
  return promptBatch(handle, afterRowid, maxRows, budgetMs, 'strip');
}

/**
 * One batch of the down migration (`walnut sessions-prompts unsplit`): the next rows whose payload
 * has a stub without its text get the table's text back in their payload, the old shape any build
 * reads. The table is kept.
 */
export function unsplitPromptBatch(handle: DatabaseType, afterRowid: number, maxRows = 25, budgetMs = 15): PromptBatch {
  return promptBatch(handle, afterRowid, maxRows, budgetMs, 'unsplit');
}

function promptBatch(handle: DatabaseType, afterRowid: number, maxRows: number, budgetMs: number, kind: 'strip' | 'unsplit'): PromptBatch {
  const t0 = performance.now();
  const where = kind === 'strip' ? HAS_PROMPT_TEXT : SPLIT_PROMPT_ROW;
  const rows = prepared(handle, `SELECT rowid AS rid, * FROM sessions WHERE rowid > ? AND (${where}) ORDER BY rowid LIMIT ?`).all(afterRowid, maxRows) as Array<Record<string, any>>;
  const out: PromptBatch = { ids: [], lastRowid: afterRowid, done: rows.length < maxRows, rows: 0, bytesMoved: 0 };
  for (const raw of rows) {
    out.lastRowid = Number(raw.rid);
    const sid = String(raw.claude_session_id);
    const before = typeof raw.payload === 'string' ? raw.payload : '';
    // The strip's row as stored: the texts its payload holds, and the stub of each text it does not
    // (a row a build before the split wrote one text into after a strip keeps the other only in the
    // table: that stub must stay, or nothing reads the table's text again).
    const parsed = kind === 'strip' ? payloadOf(raw) : null;
    const stored = parsed ? storedStateOf(promptsOf(parsed), parsed) : null;
    const prompts = stored ? stored.texts : readSessionPrompts(handle, sid);
    // Matched on a text-like string that is no prompt: nothing to move, the cursor passes it.
    if (kind === 'strip' && prompts.appliedAppendSystemPrompt === undefined && prompts.systemPrompt === undefined) continue;
    const record = decodeSessionRow(raw);
    const row = encodeSessionRow(record, prompts, stored?.refs ?? {}, kind === 'unsplit' ? 'texts' : 'stubs');
    if (hasTextRefsColumn(handle)) {
      prepared(handle, `UPDATE sessions SET payload = ?, ${PROMPT_TEXT_REFS_COLUMN} = ? WHERE claude_session_id = ?`).run(row.payload ?? null, row[PROMPT_TEXT_REFS_COLUMN], sid);
    } else prepared(handle, 'UPDATE sessions SET payload = ? WHERE claude_session_id = ?').run(row.payload ?? null, sid);
    if (kind === 'strip') for (const k of PROMPT_KEYS) if (prompts[k] !== undefined) writePromptRow(handle, sid, k, prompts[k]!);
    // A text a build before the split cleared beside its inline stub: its table row is stale.
    for (const k of stored?.cleared ?? []) prepared(handle, 'DELETE FROM session_prompts WHERE claude_session_id = ? AND field = ?').run(sid, FIELD_OF[k]);
    out.ids.push(sid);
    out.rows += 1;
    out.bytesMoved += Math.abs(Buffer.byteLength(before, 'utf8') - Buffer.byteLength(String(row.payload ?? ''), 'utf8'));
    if (performance.now() - t0 >= budgetMs) { out.done = false; break; }
  }
  if (rows.length === 0) out.done = true;
  return out;
}

/**
 * One batch of the column fill: the next rows whose `prompt_text_refs` is NULL (every row before
 * release A's first pass, and a row a build before the split wrote since) get the stubs of the texts
 * their payload holds, measured by SQLite (no text reaches JS). Only that column changes.
 */
export function fillTextRefsBatch(handle: DatabaseType, afterRowid: number, maxRows = 25, budgetMs = 15): PromptBatch {
  const t0 = performance.now();
  const out: PromptBatch = { ids: [], lastRowid: afterRowid, done: true, rows: 0, bytesMoved: 0 };
  if (!hasTextRefsColumn(handle)) return out;
  const rows = prepared(handle, `SELECT rid, claude_session_id, has_profile, ${TEXT_SIZE_COLUMNS} FROM (
      SELECT rowid AS rid, claude_session_id, payload, coalesce(${HAS_PROMPT_TEXT} AND json_valid(payload), 0) AS g,
        coalesce(json_valid(payload) AND json_type(payload, '$.profile') = 'object', 0) AS has_profile
      FROM sessions WHERE rowid > ? AND ${PROMPT_TEXT_REFS_COLUMN} IS NULL ORDER BY rowid LIMIT ? OFFSET 0)`)
    .all(afterRowid, maxRows) as Array<Record<string, any>>;
  out.done = rows.length < maxRows;
  const set = prepared(handle, `UPDATE sessions SET ${PROMPT_TEXT_REFS_COLUMN} = ? WHERE claude_session_id = ? AND ${PROMPT_TEXT_REFS_COLUMN} IS NULL`);
  for (const r of rows) {
    out.lastRowid = Number(r.rid);
    const refs: Record<string, SessionPromptRef> = {};
    if (typeof r.aasp_bytes === 'number') refs.appliedAppendSystemPrompt = { bytes: r.aasp_bytes };
    if (typeof r.persona_bytes === 'number' && r.has_profile === 1) refs.systemPrompt = { bytes: r.persona_bytes, blank: r.persona_blank === 1 };
    set.run(JSON.stringify(refs), String(r.claude_session_id));
    out.ids.push(String(r.claude_session_id));
    out.rows += 1;
    if (performance.now() - t0 >= budgetMs) { out.done = false; break; }
  }
  return out;
}

/**
 * After something rewrote prompt texts in place (the leader switch's path rewrite,
 * leader/switch/home-paths.ts): each prompt row's hash, each payload stub's size and hash, and
 * each row's `prompt_text_refs` made to match the texts again. Only what differs changes, so a
 * second run changes nothing. It reads every prompt and every row with one: for an offline home
 * (no server on it), run only when a text changed. Returns the rows changed.
 */
export function refreshPromptStubsIn(handle: DatabaseType, changedTables?: ReadonlySet<string>): number {
  // `changedTables`: the tables the caller changed; nothing to do unless one holds a prompt text.
  if (changedTables && !changedTables.has('sessions') && !changedTables.has('session_prompts')) return 0;
  const has = (t: string) => !!handle.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  if (!has('sessions')) return 0;
  let n = 0;
  const table = new Map<string, SessionPrompts>();
  if (has('session_prompts')) {
    const setSha = handle.prepare('UPDATE session_prompts SET sha256 = ? WHERE claude_session_id = ? AND field = ?');
    for (const r of handle.prepare('SELECT claude_session_id AS sid, field, body, sha256 FROM session_prompts').all() as Array<{ sid: string; field: string; body: unknown; sha256: unknown }>) {
      const k = KEY_OF[r.field];
      if (!k || typeof r.body !== 'string') continue;
      const sha = promptSha256(r.body);
      if (sha !== r.sha256) n += Number(setSha.run(sha, r.sid, r.field).changes ?? 0);
      if (!table.has(r.sid)) table.set(r.sid, {});
      table.get(r.sid)![k] = r.body;
    }
  }
  const column = hasTextRefsColumn(handle);
  const rows = handle.prepare(`SELECT claude_session_id AS sid, payload${column ? `, ${PROMPT_TEXT_REFS_COLUMN} AS refs` : ''}
    FROM sessions WHERE instr(payload, 'ystemPrompt') > 0 AND json_valid(payload)`).all() as Array<{ sid: string; payload: string; refs?: unknown }>;
  // json_set changes the stub only (a payload's other values keep their text, big numbers included).
  const setRef = handle.prepare('UPDATE sessions SET payload = json_set(payload, ?, json(?)) WHERE claude_session_id = ?');
  const setColumn = column ? handle.prepare(`UPDATE sessions SET ${PROMPT_TEXT_REFS_COLUMN} = ? WHERE claude_session_id = ?`) : null;
  for (const r of rows) {
    let p: Record<string, any>;
    try { p = JSON.parse(r.payload); } catch { continue; }
    const texts = promptsOf(p as SessionRecord);
    let changed = false;
    for (const k of PROMPT_KEYS) {
      const persona = k === 'systemPrompt';
      const ref = persona ? p.profile?.systemPromptRef : p.appliedAppendSystemPromptRef;
      if (!ref || typeof ref !== 'object') continue;
      // A stub beside its text (inline) follows that text; a stub that stands for the table's, the table's.
      const text = ref.inline ? texts[k] : texts[k] === undefined && standingRef(ref) ? table.get(r.sid)?.[k] : undefined;
      if (text === undefined) continue;
      const want = { ...ref, ...promptRefOf(text, persona, typeof ref.sha256 === 'string') };
      if (JSON.stringify(want) === JSON.stringify(ref)) continue;
      setRef.run(persona ? '$.profile.systemPromptRef' : '$.appliedAppendSystemPromptRef', JSON.stringify(want), r.sid);
      changed = true;
    }
    if (setColumn && typeof r.refs === 'string' && r.refs !== '{}') {
      const want = textRefsColumnOf(texts, !!p.profile && typeof p.profile === 'object');
      if (want !== r.refs) { setColumn.run(want, r.sid); changed = true; }
    }
    if (changed) n += 1;
  }
  return n;
}

/** Set or remove the strip marker (end of a strip pass; unsplit removes it). */
export function setPromptSplitMarker(handle: DatabaseType, on: boolean): void {
  handle.exec('CREATE TABLE IF NOT EXISTS session_migrations (id TEXT PRIMARY KEY)');
  if (on) prepared(handle, 'INSERT OR IGNORE INTO session_migrations (id) VALUES (?)').run(PROMPT_SPLIT_MARKER);
  else prepared(handle, 'DELETE FROM session_migrations WHERE id = ?').run(PROMPT_SPLIT_MARKER);
}

/**
 * The store cache's full scan of session rows (session-tracker.ts loadStoreRows): the columns, and a
 * payload SQLite already took both prompt texts out of, with their stubs from the row's
 * `prompt_text_refs` column (or, for a row a build before the split wrote, each text's size and a
 * persona's blankness measured here), so no text ever reaches JS through the scan. On the Mac
 * (2026-11-25, 7.7k rows) the payloads came to 75 MB, 59 MB of it these two texts. `lead`: extra
 * columns first; `from`: what follows the table name (an INDEXED BY). sessionCacheRows says when
 * every row goes through this and when only the few that may hold a text do.
 */
export function sessionCacheRowsSql(lead = '', from = ''): string {
  // A row release A or later wrote says in its own column whether its payload holds a text, so it
  // costs no instr, and its stubs come from the column. Only a NULL column (a build before the split
  // wrote the row, and the fill pass has not reached it) is tested and measured: one instr, then the
  // parses. On the Mac's rows (2026-11-26, 7.7k) the measuring cost 50 ms a scan, the column none.
  const known = `${PROMPT_TEXT_REFS_COLUMN} IS NOT NULL`;
  const remove = `json_remove(payload, '$.appliedAppendSystemPrompt', '$.profile.systemPrompt')`;
  const sizes = TEXT_SIZE_COLUMNS.replaceAll('WHEN g ', () => `WHEN ${PROMPT_TEXT_REFS_COLUMN} IS NULL AND ${HAS_PROMPT_TEXT} AND json_valid(payload) `);
  return `SELECT ${lead}${EXPLICIT_SESSION_COLUMNS.join(', ')},
      CASE WHEN ${known} THEN CASE WHEN ${PROMPT_TEXT_REFS_COLUMN} <> '{}' AND json_valid(payload) THEN ${remove} ELSE payload END
        WHEN ${HAS_PROMPT_TEXT} AND json_valid(payload) THEN ${remove} ELSE payload END AS payload,
      1 AS cache_scan, ${PROMPT_TEXT_REFS_COLUMN}, ${sizes}
    FROM sessions ${from}`;
}

/**
 * The rows whose payload may hold a prompt text: a NULL `prompt_text_refs` (a build before the split
 * wrote the row) or one that names a text (release A's shape, or a write before this open's gate
 * opened). `{}` says the payload holds none. Its partial index lists them without reading a payload.
 */
const TEXT_ROW = `coalesce(${PROMPT_TEXT_REFS_COLUMN}, '') <> '{}'`;
export const TEXT_ROWS_INDEX = 'sessions_prompt_text_rows';
const TEXT_ROWS_LATE_INDEX: LateIndex = {
  name: TEXT_ROWS_INDEX,
  table: 'sessions',
  sql: `CREATE INDEX IF NOT EXISTS ${TEXT_ROWS_INDEX} ON sessions(claude_session_id) WHERE ${TEXT_ROW}`,
  warm: `SELECT count(*) FROM sessions WHERE ${TEXT_ROW}`,
};
/**
 * Up to this many such rows, the scan splits in two: every other row's columns and payload as they
 * are, and these few through the guarded SQL (sessionCacheRowsSql), found by the index. More of
 * them (before the strip ran) and the guarded SQL reads every row, as one query.
 */
export const PLAIN_SCAN_MAX_TEXT_ROWS = 50;
const scanStats = { plain: 0, guarded: 0 };
export function sessionScanStats(): Readonly<typeof scanStats> { return { ...scanStats }; }

/**
 * The rows of the store cache's full scan (session-tracker.ts loadStoreRows), in rowid order, none
 * with a prompt text: decodeSessionRow makes each a record with only the stubs. Once the strip has
 * run (release B) almost no row holds a text, so almost every row is read plain, with no CASE, no
 * measured sizes and no JSON function; the few that may hold one (a NULL column: a build before the
 * split wrote it since; or a column naming a text) are listed by the partial index without reading
 * a payload, and SQLite takes their texts out. Before that (or before the index is built), the
 * guarded SQL reads every row.
 */
export function sessionCacheRows(handle: DatabaseType): Record<string, any>[] {
  // hasIndex remembers an index it once saw: one dropped since (by hand) fails its INDEXED BY, and
  // the guarded scan below reads every row instead.
  if (hasIndex(handle, TEXT_ROWS_INDEX)) {
    try {
      const n = Number(prepared(handle, `SELECT count(*) FROM sessions INDEXED BY ${TEXT_ROWS_INDEX} WHERE ${TEXT_ROW}`, 'pluck').get() ?? 0);
      if (n <= PLAIN_SCAN_MAX_TEXT_ROWS) {
        const plain = prepared(handle, `SELECT rowid AS scan_rowid, ${EXPLICIT_SESSION_COLUMNS.join(', ')}, payload FROM sessions WHERE NOT (${TEXT_ROW}) ORDER BY rowid`).all() as Record<string, any>[];
        const guarded = n === 0 ? [] : prepared(handle, `${sessionCacheRowsSql('rowid AS scan_rowid, ', `INDEXED BY ${TEXT_ROWS_INDEX}`)} WHERE ${TEXT_ROW} ORDER BY rowid`).all() as Record<string, any>[];
        scanStats.plain += 1;
        return guarded.length === 0 ? plain : mergeByRowid(plain, guarded);
      }
    } catch (err) {
      log.session.warn('session store scan: the text-rows index could not be used', { err: String(err) });
    }
  }
  scanStats.guarded += 1;
  return prepared(handle, sessionCacheRowsSql()).all() as Record<string, any>[];
}

/** Two lists in rowid order (scan_rowid) as one. */
function mergeByRowid(a: Record<string, any>[], b: Record<string, any>[]): Record<string, any>[] {
  const out: Record<string, any>[] = new Array(a.length + b.length);
  let i = 0, j = 0, k = 0;
  while (i < a.length && j < b.length) out[k++] = a[i].scan_rowid <= b[j].scan_rowid ? a[i++] : b[j++];
  while (i < a.length) out[k++] = a[i++];
  while (j < b.length) out[k++] = b[j++];
  return out;
}

/**
 * Each text's UTF-8 size and the persona's blankness (the same characters as isBlankText), for a
 * select whose rows have `payload` and the guard `g`.
 */
const TEXT_SIZE_COLUMNS = [
  `CASE WHEN g AND json_type(payload, '$.appliedAppendSystemPrompt') = 'text' THEN length(CAST(json_extract(payload, '$.appliedAppendSystemPrompt') AS BLOB)) END AS aasp_bytes`,
  `CASE WHEN g AND json_type(payload, '$.profile.systemPrompt') = 'text' THEN length(CAST(json_extract(payload, '$.profile.systemPrompt') AS BLOB)) END AS persona_bytes`,
  `CASE WHEN g AND json_type(payload, '$.profile.systemPrompt') = 'text' THEN trim(json_extract(payload, '$.profile.systemPrompt'), ${BLANK_CHARS_SQL}) = '' END AS persona_blank`,
].join(', ');

/**
 * The payload fields a query filters sessions by, each with its own partial
 * index (SCHEMA_SQL). A query uses that index only when its WHERE names the
 * same expression AND `json_valid(payload)` (the index's own condition, which
 * also keeps a malformed payload from raising on every write); without it the
 * query parses every payload in the table (7.7k rows, 75 MB on the Mac,
 * 50-150 ms of held loop each time, 2026-11-25).
 */
export const PAYLOAD_LANE = "json_extract(payload, '$.lane')";
export const PAYLOAD_STOP_REQUEST_STATE = "json_extract(payload, '$.stopRequest.state')";
export const PAYLOAD_TASK_COMPLETE_STOP_STATE = "json_extract(payload, '$.taskCompleteStop.state')";

/** The index of each payload field above (added 2026-11-25), built after the open
 *  (sqlite-late-index.ts). An older build keeps them up to date on its own writes and never reads them. */
const PAYLOAD_LATE_INDEXES: LateIndex[] = ([
  ['sessions_payload_lane', PAYLOAD_LANE],
  ['sessions_payload_stop_request', PAYLOAD_STOP_REQUEST_STATE],
  ['sessions_payload_task_complete_stop', PAYLOAD_TASK_COMPLETE_STOP_STATE],
] as const).map(([name, expr]) => ({
  name,
  table: 'sessions',
  sql: `CREATE INDEX IF NOT EXISTS ${name} ON sessions(${expr}) WHERE json_valid(payload)`,
  warm: 'SELECT max(length(payload)) FROM sessions',
}));

/** SCHEMA_SQL and the indexes built after it, on every handle that opens a sessions file. */
function initSessionSchema(handle: DatabaseType, file: string): void {
  handle.exec(SCHEMA_SQL);
  ensureLateIndexes(handle, PAYLOAD_LATE_INDEXES, { report: lateIndexReport(file) });
}

// ── Schema ─────────────────────────────────────────────────────────────────
// Idempotent. Safe to run on every open — matches the pattern in
// task-db.ts and notes-index.ts.
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
    claude_session_id TEXT PRIMARY KEY,
    task_id TEXT,
    project TEXT,
    process_status TEXT,
    mode TEXT,
    provider TEXT,
    type TEXT,
    activity TEXT,
    last_status_change TEXT,
    started_at TEXT,
    last_active_at TEXT,
    message_count INTEGER DEFAULT 0,
    cwd TEXT,
    host TEXT,
    title TEXT,
    description TEXT,
    pid INTEGER,
    output_file TEXT,
    plan_file TEXT,
    plan_completed INTEGER DEFAULT 0,
    from_plan_session_id TEXT,
    forked_from_session_id TEXT,
    human_note TEXT,
    model TEXT,
    cli_model TEXT,
    archived INTEGER DEFAULT 0,
    archive_reason TEXT,
    plan_content TEXT,
    error_message TEXT,
    status_reason TEXT,
    status_changed_by TEXT,
    status_revision INTEGER NOT NULL DEFAULT 1,
    status_updated_at TEXT,
    payload TEXT
  );
  CREATE INDEX IF NOT EXISTS sessions_task_id ON sessions(task_id);
  CREATE INDEX IF NOT EXISTS sessions_host ON sessions(host);
  CREATE INDEX IF NOT EXISTS sessions_process_status ON sessions(process_status);
  CREATE INDEX IF NOT EXISTS sessions_updated_at ON sessions(last_active_at);
  CREATE INDEX IF NOT EXISTS sessions_last_status_change ON sessions(last_status_change);
  -- A session's two prompt texts, one row each (session-prompts.ts): its row keeps only their stubs.
  -- No foreign key: a REPLACE of the session row would delete them through a cascade.
  CREATE TABLE IF NOT EXISTS session_prompts (
    claude_session_id TEXT NOT NULL,
    field TEXT NOT NULL CHECK (field IN ('appliedAppendSystemPrompt', 'profile.systemPrompt')),
    body TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (claude_session_id, field)
  );
  CREATE TABLE IF NOT EXISTS session_channel_cursor (
    host_id TEXT,
    log_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    PRIMARY KEY(host_id)
  );
  CREATE TABLE IF NOT EXISTS session_leader_drops (
    claude_session_id TEXT PRIMARY KEY,
    host_id TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session_leader_disowns (
    claude_session_id TEXT PRIMARY KEY,
    row TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session_host_handovers (
    claude_session_id TEXT PRIMARY KEY,
    host_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    since INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session_turn_ends (
    claude_session_id TEXT PRIMARY KEY,
    host_id TEXT NOT NULL,
    edge TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  -- The starts a leader handed its hosts (session-channel/handed-sessions.ts): sid NULL while the host names it.
  CREATE TABLE IF NOT EXISTS session_host_hands (
    id TEXT PRIMARY KEY,
    host_id TEXT NOT NULL,
    sid TEXT,
    task_id TEXT NOT NULL DEFAULT '',
    at INTEGER NOT NULL,
    until INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS session_host_hands_sid ON session_host_hands(sid);
  -- The queue rows a leader handed its hosts' sessions (session-channel/handed-sessions.ts): a host's
  -- fact names only these ids of its session.
  CREATE TABLE IF NOT EXISTS session_host_lines (
    id TEXT PRIMARY KEY,
    sid TEXT NOT NULL,
    at INTEGER NOT NULL
  );
`;

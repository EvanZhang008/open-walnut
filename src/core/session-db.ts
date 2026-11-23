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
import type { SessionRecord } from './types.js';
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

    handle.exec(SCHEMA_SQL);
    // A host replica's file is the Mac's rows, kept by the follower apply
    // connection (sessions kind, replication/kinds/sessions.ts): its own data
    // fixes and WAL truncation would change the copy behind its hashes, so it
    // adds missing columns only (task-db.ts does the same).
    const copy = isHostReplica();
    ensureSessionStatusColumns(handle, undefined, { backfill: !copy });

    // Truncate the WAL on open (see task-db.ts:128 — same rationale).
    let checkpoint: unknown = null;
    if (!copy) {
      try {
        checkpoint = handle.pragma('wal_checkpoint(TRUNCATE)');
      } catch (err) {
        log.session.warn('session-db: WAL checkpoint on open failed', { err: String(err) });
      }
    }

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
export function sessionJudgeInStore(claudeSessionId: string): { host: string | null; judgedByHost: boolean } | null {
  const handle = getDb();
  if (!handle) return null;
  const row = handle.prepare(
    `SELECT host, CASE WHEN instr(coalesce(payload, ''), '"judge":"host"') > 0 AND json_valid(payload) THEN json_extract(payload, '$.judge') = 'host' ELSE 0 END AS judged FROM sessions WHERE claude_session_id = ?`,
  ).get(claudeSessionId) as { host: string | null; judged: number } | undefined;
  return row ? { host: row.host, judgedByHost: row.judged === 1 } : null;
}

/** A session's task and engine, without decoding its whole record (a host-judged session's proxy). */
export function sessionTaskAndEngineInStore(claudeSessionId: string): { taskId: string | null; engine: string | null } | null {
  const handle = getDb();
  if (!handle) return null;
  const row = handle.prepare(
    `SELECT task_id, CASE WHEN json_valid(payload) THEN json_extract(payload, '$.engine') END AS engine FROM sessions WHERE claude_session_id = ?`,
  ).get(claudeSessionId) as { task_id: string | null; engine: string | null } | undefined;
  return row ? { taskId: row.task_id, engine: row.engine } : null;
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
  const cols = [...EXPLICIT_SESSION_COLUMNS, 'payload'];
  const ins = handle.prepare(`INSERT OR REPLACE INTO sessions (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`);
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
    const rec = rowToSession(raw);
    return rowOwnedHere(rec, own) ? rec : null;
  };
  let keptOwn = 0;
  let skippedOwn = 0;
  let disowned = 0;
  handle.transaction(() => {
    for (const id of change.removeIds ?? []) {
      if (ownRow(id)) { keptOwn++; continue; }
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
      const row = sessionToRow(mine ? mergeLeaderCopy(mine, r) : claimed ? claimedCopy(r, own) : own && rowOwnedHere(r, own) ? { ...r, judge: undefined } : r);
      const bound: Record<string, unknown> = {};
      for (const c of cols) bound[c] = row[c] === undefined ? null : row[c];
      ins.run(bound);
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
    const row = raw ? rowToSession(raw) : null;
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
    if (!raw || !rowOwnedHere(rowToSession(raw), hostKey)) return false;
    writeCopyRow(handle, sessionToRow(JSON.parse(key) as SessionRecord));
    forgetLeaderDisown(handle, sid);
    return true;
  }).immediate();
}

function writeCopyRow(handle: DatabaseType, raw: Record<string, unknown>): void {
  const cols = [...EXPLICIT_SESSION_COLUMNS, 'payload'];
  const bound: Record<string, unknown> = {};
  for (const c of cols) bound[c] = raw[c] === undefined ? null : raw[c];
  handle.prepare(`INSERT OR REPLACE INTO sessions (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`).run(bound);
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
    const here = raw ? rowToSession(raw) : null;
    const given = leaderRow?.claudeSessionId === sid ? { ...leaderRow, judge: undefined } : null;
    if (here && rowOwnedHere(here, key)) {
      claimStart(sid);
      if (given) writeCopyRow(handle, sessionToRow(mergeLeaderCopy(here, given)));
      return;
    }
    const rec = given ?? here;
    if (rec && !claimable(rec, key)) {
      log.session.warn('host start: the row a start names is another host\'s; not claimed', { sessionId: sid, host: rec.host });
      return;
    }
    claimStart(sid);
    if (!rec || rowOwnedHere(rec, key)) return;
    writeCopyRow(handle, sessionToRow(claimedCopy(rec, key)));
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
  handle.exec(SCHEMA_SQL);
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
    const r = rowToSession(raw[i]!);
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
  const cols = [...EXPLICIT_SESSION_COLUMNS, 'payload'];
  const ins = handle.prepare(`INSERT OR REPLACE INTO sessions (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`);
  const del = handle.prepare('DELETE FROM sessions WHERE claude_session_id = ?');
  handle.transaction(() => {
    for (const id of change.removeIds ?? []) del.run(id);
    for (const r of change.rows ?? []) {
      const row = sessionToRow(r);
      const bound: Record<string, unknown> = {};
      for (const c of cols) bound[c] = row[c] === undefined ? null : row[c];
      ins.run(bound);
    }
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

/**
 * Convert a SQLite row back to a `SessionRecord`. JSON `payload` is parsed
 * first so explicit columns can override any leftover keys; boolean columns
 * coerce 0/1 → false/true; snake_case columns map back to camelCase fields.
 *
 * Null/undefined columns are stripped so the returned object matches the
 * "JSON-loaded" shape the rest of the code expects. Callers (session-tracker)
 * do further normalization (type inference from title, status_history
 * trimming, etc.).
 */
export function rowToSession(row: Record<string, any>): SessionRecord {
  // Start from payload so explicit columns can override any leftover keys.
  let record: Record<string, any> = {};
  if (row.payload != null && row.payload !== '') {
    try {
      const parsed = JSON.parse(row.payload);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        record = { ...parsed };
      }
    } catch (err) {
      log.session.warn('rowToSession: payload JSON parse failed', {
        claudeSessionId: row.claude_session_id,
        err: String(err),
      });
    }
  }

  // Explicit columns → camelCase fields.
  for (const col of EXPLICIT_SESSION_COLUMNS) {
    const val = row[col];
    if (val === undefined || val === null) continue;
    const field = COLUMN_TO_FIELD[col];
    if (!field) continue; // defensive — should never hit
    if (BOOLEAN_COLUMNS.has(col)) {
      record[field] = val === 1 || val === true;
    } else {
      record[field] = val;
    }
  }

  // Required-field fallbacks — the DB may have NULL where SessionRecord
  // expects a value (pre-migration or partially written rows). Match the
  // JSON-load defaults the tracker code has always relied on.
  if (typeof record.messageCount !== 'number') record.messageCount = 0;
  if (typeof record.startedAt !== 'string' || !record.startedAt) {
    record.startedAt = record.lastActiveAt ?? new Date().toISOString();
  }
  if (typeof record.lastActiveAt !== 'string' || !record.lastActiveAt) {
    record.lastActiveAt = record.startedAt;
  }

  return record as SessionRecord;
}

/**
 * Convert a `SessionRecord` (or a partial patch) to a row suitable for
 * prepared INSERT / UPDATE statements. Explicit fields are mapped to their
 * snake_case columns; anything else (not a runtime-only key) is
 * JSON-stringified into the `payload` column so fields without a dedicated
 * column aren't silently dropped.
 *
 * Returns a `Record<string, any>` keyed by column name. Bind these by name
 * with `@col` placeholders (`stmt.run(row)`).
 */
export function sessionToRow(session: Partial<SessionRecord>): Record<string, any> {
  const row: Record<string, any> = {};

  // Explicit fields → columns.
  for (const [field, col] of Object.entries(FIELD_TO_COLUMN)) {
    if (!(field in session)) continue;
    const val = (session as Record<string, any>)[field];
    if (val === undefined) continue;
    if (BOOLEAN_COLUMNS.has(col)) {
      row[col] = val ? 1 : 0;
    } else {
      row[col] = val;
    }
  }

  // Everything left that isn't a runtime-only key goes to payload. That
  // includes objects (pendingPermission), arrays (status_history), and any
  // future SessionRecord field we haven't given a column yet.
  const payload: Record<string, any> = {};
  let hasPayload = false;
  for (const key of Object.keys(session)) {
    if (EXPLICIT_SESSION_KEYS.has(key)) continue;
    if (NON_PERSISTED_KEYS.has(key)) continue;
    const val = (session as Record<string, any>)[key];
    if (val === undefined) continue;
    payload[key] = val;
    hasPayload = true;
  }
  if (hasPayload) {
    row.payload = JSON.stringify(payload);
  } else if ('payload' in session) {
    // Explicit clear request.
    row.payload = null;
  }

  // Full legacy records may reach bulk INSERT helpers without the versioned
  // fields. Bind safe initial values instead of NULL (status_revision is
  // NOT NULL); partial UPDATE patches do not carry claudeSessionId and are
  // intentionally left untouched.
  if (typeof session.claudeSessionId === 'string') {
    if (row.status_revision === undefined) row.status_revision = 1;
    if (row.status_updated_at === undefined) {
      row.status_updated_at = session.last_status_change
        ?? session.lastActiveAt
        ?? session.startedAt
        ?? new Date().toISOString();
    }
  }

  return row;
}

// Re-export the column list so callers can build prepared statements without
// duplicating the ordering.
export const SESSION_COLUMNS: readonly string[] = EXPLICIT_SESSION_COLUMNS;

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
`;

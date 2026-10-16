/**
 * The applied-ops ledger (docs/plan/walnut-replica-servers-impl.md sections 3 and 5).
 *
 * Every client write carries an op id (`x-walnut-op-id`), and a host journal record
 * keeps it. The same user action can reach this server twice: a forward the Mac
 * answered too late (the client retried it, the replica journaled the retry), or a
 * web client retrying a timed-out write about 300 ms after it gave up, while the
 * first attempt is still in its handler. The ledger makes that one apply:
 *
 *   - durable rows `(hostKey, home, opId, rev)` with appliedAt and the outcome, in
 *     `WALNUT_HOME/cache/applied-ops.sqlite`, kept 30 days; written RIGHT AFTER an
 *     apply (there is no shared transaction with tasks.sqlite; a crash in between is
 *     harmless because every kind is idempotent on its own, section 5);
 *   - in-memory reservations `(hostKey, home, opId)` taken when a request arrives: a
 *     duplicate that arrives while the first is still running waits for the first
 *     answer and returns it, never applying again.
 *
 * The key carries the host: two journals both holding `v1-<hash>` style ids (or two
 * replicas minting the same id by chance) never shadow each other.
 *
 * A row says who wrote it (`source`: the HTTP middleware or a drain) and, for a direct
 * write, its route: a journaled retry of a write the Mac REFUSED over HTTP is lettered on
 * drain (its answer never reached the user), and the same id on another route is caught.
 * An answer naming a credential is never stored (a duplicate gets its status only), and
 * the file is owner-only. A second table keeps the ids this Mac re-minted for a host's
 * creates whose id was taken, so later records of that task follow it in every drain.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';

/** The host a write came through: a daemon's host key, or LOCAL_HOST for this server's own clients. */
export const LOCAL_HOST = 'local';
/** How long an applied op id is remembered. */
export const LEDGER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A stored HTTP answer larger than this keeps only its status (the duplicate gets a short body). */
const MAX_STORED_BODY = 16 * 1024;
/**
 * A JSON answer naming any of these keys is never stored: a duplicate gets its status and
 * a short body. A device pairing answers its live bearer token once, and the token itself
 * is never kept anywhere (device-store.ts); the ledger must not become the place it is.
 */
const SECRET_KEYS = /"(token|accessToken|refreshToken|bearer|secret|clientSecret|password|passphrase|apiKey|api_key|pairingURI|pairingUri|privateKey|private_key|credentials?)"\s*:/i;

export interface LedgerKey {
  hostKey: string;
  home: string;
  opId: string;
  /** A journal record's rev (a coalesced save appends rev + 1); a direct write is rev 1. */
  rev?: number;
}

/** What happened to an op: applied (or a no-op that equals applied), refused by this server, or given up. */
export interface LedgerOutcome {
  outcome: 'applied' | 'refused' | 'given-up' | 'noop';
  /** The HTTP answer a direct write got, so a duplicate gets the same one. */
  status?: number;
  body?: string;
  contentType?: string;
  /** A short reason, for the log and the conflict letter. */
  detail?: string;
  /** Who recorded it: a direct HTTP write (the middleware) or a host drain. */
  source?: 'http' | 'drain';
  /** `METHOD /path` of the direct write, so the same id on another route is caught. */
  route?: string;
}

export interface LedgerEntry extends LedgerOutcome {
  appliedAt: number;
}

let db: DatabaseType | null = null;
let dbFile = '';
/** Rows kept in memory when the file cannot be opened: dedupe still works until a restart. */
const memoryRows = new Map<string, LedgerEntry>();
let lastPruneAt = 0;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

/** The ledger file. Tests point it elsewhere with `_setLedgerFileForTesting`. */
function ledgerFile(): string {
  return dbFile || path.join(WALNUT_HOME, 'cache', 'applied-ops.sqlite');
}

function open(): DatabaseType | null {
  if (db) return db;
  const file = ledgerFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const handle = new Database(file);
    // Answers may name task content: owner-only, like the rest of WALNUT_HOME's caches.
    for (const f of [file, `${file}-wal`, `${file}-shm`]) { try { fs.chmodSync(f, 0o600); } catch { /* not there yet */ } }
    handle.pragma('journal_mode = WAL');
    handle.pragma('busy_timeout = 2000');
    handle.pragma('synchronous = NORMAL');
    handle.exec(`CREATE TABLE IF NOT EXISTS applied_ops (
      host_key TEXT NOT NULL, home TEXT NOT NULL, op_id TEXT NOT NULL, rev INTEGER NOT NULL,
      applied_at INTEGER NOT NULL, outcome TEXT NOT NULL,
      PRIMARY KEY (host_key, home, op_id, rev)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS applied_ops_at ON applied_ops (applied_at);
    CREATE INDEX IF NOT EXISTS applied_ops_op ON applied_ops (op_id);
    CREATE TABLE IF NOT EXISTS create_remap (
      host_key TEXT NOT NULL, home TEXT NOT NULL, minted TEXT NOT NULL, task_id TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (host_key, home, minted)
    ) WITHOUT ROWID;`);
    for (const f of [`${file}-wal`, `${file}-shm`]) { try { fs.chmodSync(f, 0o600); } catch { /* not there yet */ } }
    db = handle;
    return db;
  } catch (err) {
    log.web.error('applied-ops ledger: could not open its file; op ids are remembered in memory until a restart', {
      file, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function rowKey(k: LedgerKey): string {
  return JSON.stringify([k.hostKey, k.home, k.opId, k.rev ?? 1]);
}

/** The entry for this exact `(hostKey, home, opId, rev)`, or null. Expired rows read as absent. */
export function lookupApplied(key: LedgerKey, now = Date.now()): LedgerEntry | null {
  if (!key.opId) return null;
  const handle = open();
  if (!handle) {
    const hit = memoryRows.get(rowKey(key));
    return hit && now - hit.appliedAt < LEDGER_TTL_MS ? hit : null;
  }
  try {
    const row = handle.prepare('SELECT applied_at, outcome FROM applied_ops WHERE host_key = ? AND home = ? AND op_id = ? AND rev = ?')
      .get(key.hostKey, key.home, key.opId, key.rev ?? 1) as { applied_at: number; outcome: string } | undefined;
    if (!row || now - row.applied_at >= LEDGER_TTL_MS) return null;
    return { ...(JSON.parse(row.outcome) as LedgerOutcome), appliedAt: row.applied_at };
  } catch (err) {
    log.web.warn('applied-ops ledger: read failed; the op is treated as new', { ...key, error: err instanceof Error ? err.message : String(err) });
    return memoryRows.get(rowKey(key)) ?? null;
  }
}

/**
 * A host drain's row for this op id, any rev, under `hostKey` or, when it is omitted,
 * under ANY host. A client that sent an action through a replica (which journaled it, and
 * a drain applied it) and then retries it straight at this server arrives as LOCAL_HOST:
 * the middleware must still find that apply, or the action runs twice. Only drain rows:
 * an HTTP row is keyed by the host its request came through. Expired rows read as absent.
 */
export function lookupDrained(home: string, opId: string, hostKey?: string, now = Date.now()): LedgerEntry | null {
  if (!opId) return null;
  const pick = (rows: Array<{ hostKey: string; entry: LedgerEntry }>): LedgerEntry | null => {
    const hits = rows.filter((r) => (hostKey === undefined || r.hostKey === hostKey) && r.entry.source === 'drain' && now - r.entry.appliedAt < LEDGER_TTL_MS);
    return hits.sort((a, b) => b.entry.appliedAt - a.entry.appliedAt)[0]?.entry ?? null;
  };
  const fromMemory = (): LedgerEntry | null => pick([...memoryRows.entries()].flatMap(([k, entry]) => {
    const [h, hm, op] = JSON.parse(k) as [string, string, string];
    return hm === home && op === opId ? [{ hostKey: h, entry }] : [];
  }));
  const handle = open();
  if (!handle) return fromMemory();
  try {
    const rows = handle.prepare('SELECT host_key, applied_at, outcome FROM applied_ops WHERE op_id = ? AND home = ?')
      .all(opId, home) as Array<{ host_key: string; applied_at: number; outcome: string }>;
    return pick(rows.map((r) => ({ hostKey: r.host_key, entry: { ...(JSON.parse(r.outcome) as LedgerOutcome), appliedAt: r.applied_at } }))) ?? fromMemory();
  } catch (err) {
    log.web.warn('applied-ops ledger: read failed; the op is treated as new', { home, opId, error: err instanceof Error ? err.message : String(err) });
    return fromMemory();
  }
}

/** Record an op as applied (or refused / given up). Called right after the apply. Never throws. */
export function recordApplied(key: LedgerKey, outcome: LedgerOutcome, now = Date.now()): void {
  if (!key.opId) return;
  const stored: LedgerOutcome = { ...outcome };
  if (stored.body !== undefined && (stored.body.length > MAX_STORED_BODY || SECRET_KEYS.test(stored.body))) delete stored.body;
  const handle = open();
  if (!handle) {
    memoryRows.set(rowKey(key), { ...stored, appliedAt: now });
    return;
  }
  try {
    handle.prepare('INSERT OR REPLACE INTO applied_ops (host_key, home, op_id, rev, applied_at, outcome) VALUES (?, ?, ?, ?, ?, ?)')
      .run(key.hostKey, key.home, key.opId, key.rev ?? 1, now, JSON.stringify(stored));
    if (now - lastPruneAt > PRUNE_EVERY_MS) {
      lastPruneAt = now;
      handle.prepare('DELETE FROM applied_ops WHERE applied_at < ?').run(now - LEDGER_TTL_MS);
      handle.prepare('DELETE FROM create_remap WHERE at < ?').run(now - LEDGER_TTL_MS);
    }
  } catch (err) {
    log.web.warn('applied-ops ledger: write failed; kept in memory', { ...key, error: err instanceof Error ? err.message : String(err) });
    memoryRows.set(rowKey(key), { ...stored, appliedAt: now });
  }
}

// -- Re-minted create ids (hostKey, home, minted id) -> the id this server gave the task --

/** Rows kept in memory when the file cannot be opened. */
const memoryRemap = new Map<string, string>();

/**
 * Remember that a task a host created while away (id `minted`) is `taskId` here: its id
 * was taken. Durable, so a later drain (after a stop, a restart) routes the host's later
 * records of that task to it, never to the task that owned the id. Throws when the row
 * cannot be written: the create must not be applied without it.
 */
export function recordRemap(hostKey: string, home: string, minted: string, taskId: string, now = Date.now()): void {
  const handle = open();
  const k = JSON.stringify([hostKey, home, minted]);
  if (!handle) { memoryRemap.set(k, taskId); return; }
  handle.prepare('INSERT OR REPLACE INTO create_remap (host_key, home, minted, task_id, at) VALUES (?, ?, ?, ?, ?)')
    .run(hostKey, home, minted, taskId, now);
}

/** The id this server gave a host's created task whose id `minted` was taken, or undefined. */
export function lookupRemap(hostKey: string, home: string, minted: string): string | undefined {
  const k = JSON.stringify([hostKey, home, minted]);
  const handle = open();
  if (!handle) return memoryRemap.get(k);
  try {
    const row = handle.prepare('SELECT task_id FROM create_remap WHERE host_key = ? AND home = ? AND minted = ?')
      .get(hostKey, home, minted) as { task_id: string } | undefined;
    return row?.task_id ?? memoryRemap.get(k);
  } catch {
    return memoryRemap.get(k);
  }
}

// -- In-flight reservations (hostKey, home, opId) --

interface Reservation {
  done: Promise<LedgerOutcome | null>;
  resolve: (o: LedgerOutcome | null) => void;
}
const inFlight = new Map<string, Reservation>();

function flightKey(k: LedgerKey): string {
  return JSON.stringify([k.hostKey, k.home, k.opId]);
}

/**
 * Take the op for this caller. `owner: true`: run it, then `finish(outcome)` (null when
 * nothing was applied and a retry may apply it). `owner: false`: another request with
 * the same id is running; `wait` resolves with its outcome (null when it applied nothing).
 */
export type Reserved =
  | { owner: true; finish: (outcome: LedgerOutcome | null) => void }
  | { owner: false; wait: Promise<LedgerOutcome | null> };

export function reserveOp(key: LedgerKey): Reserved {
  const k = flightKey(key);
  const running = inFlight.get(k);
  if (running) return { owner: false, wait: running.done };
  let resolve!: (o: LedgerOutcome | null) => void;
  const done = new Promise<LedgerOutcome | null>((r) => { resolve = r; });
  const res: Reservation = { done, resolve };
  inFlight.set(k, res);
  let finished = false;
  return {
    owner: true,
    finish: (outcome) => {
      if (finished) return;
      finished = true;
      if (inFlight.get(k) === res) inFlight.delete(k);
      resolve(outcome);
    },
  };
}

/** Is a request with this op id running right now? */
export function opInFlight(key: LedgerKey): boolean {
  return inFlight.has(flightKey(key));
}

/** Tests only: point the ledger at a file (or back to the default) and forget everything in memory. */
export function _setLedgerFileForTesting(file: string | null): void {
  try { db?.close(); } catch { /* closed */ }
  db = null;
  dbFile = file ?? '';
  memoryRows.clear();
  memoryRemap.clear();
  lastPruneAt = 0;
  for (const r of inFlight.values()) r.resolve(null);
  inFlight.clear();
}

// -- A journaled record's op, wherever its direct write was recorded --

/**
 * The keys a journaled record's op id may already be recorded under: its host's, and this
 * server's own clients' (LOCAL_HOST). The op-id middleware keys a forwarded write by the
 * host its socket is tagged with (`tagForwardedSocket(socket, conn.hostKey)`, the forward
 * lane's contract, with exactly the daemon connection's hostKey the drain uses); a forward
 * on a socket nobody tagged is recorded under LOCAL_HOST, and the drain must still find it
 * there, or the forward and its journaled retry both apply.
 */
export function journaledKeys(key: LedgerKey): LedgerKey[] {
  return key.hostKey === LOCAL_HOST ? [key] : [key, { ...key, hostKey: LOCAL_HOST }];
}

/** The ledger entry of a journaled record's op under any of its keys, or null. */
export function lookupJournaled(key: LedgerKey, now = Date.now()): LedgerEntry | null {
  for (const k of journaledKeys(key)) {
    const hit = lookupApplied(k, now);
    if (hit) return hit;
  }
  return null;
}

/** Take a journaled record's op under every key: owner only when none is running. */
export function reserveJournaled(key: LedgerKey): Reserved {
  const taken: Array<Extract<Reserved, { owner: true }>> = [];
  for (const k of journaledKeys(key)) {
    const r = reserveOp(k);
    if (!r.owner) {
      for (const t of taken) t.finish(null);
      return r;
    }
    taken.push(r);
  }
  return { owner: true, finish: (outcome) => { for (const t of taken) t.finish(outcome); } };
}

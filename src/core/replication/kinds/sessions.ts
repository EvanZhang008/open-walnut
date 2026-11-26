/**
 * The `sessions` copy kind (docs/plan/walnut-replica-servers-impl.md, section 4
 * and WP4): every row of the Mac's sessions.sqlite on each host replica, so the
 * replica lists sessions while the Mac is away.
 *
 *   leader    session-tracker's rows, each sent as its projection: no pid, no
 *             output file, no process group, no field that names a process or
 *             a position in one (PROCESS_FIELDS); `process_status` stays as a
 *             label, and so does `stopRequest` (the stop the user asked for, which
 *             the companion's stop fence reads). The hash leaves the volatile
 *             fields out (lastActiveAt, activity, contextTokens), so a busy
 *             session costs no put until something else about it changes.
 *   follower  the replica's OWN sessions.sqlite (never the Mac's file), written
 *             only through session-db's apply connection; rows are projected
 *             again before they are stored, so a row that names a pid never
 *             lands, and a host replica's live store leaves `stopRequest` out too
 *             (HOST_STORE_DROPPED_FIELDS). The cloud companion keeps them in a
 *             file of its own (stage 2c of docs/plan/walnut-companion-unified-replica.md).
 *             Refuses on the plain host server and the leader (`404 unknown_kind`).
 *
 * Unordered, half rule from 200 rows, digest (copy-kind.ts shortcut).
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../../constants.js'
import { log } from '../../../logging/index.js'
import type { SessionRecord } from '../../types.js'
import { HASH_SLICE, sha12 } from '../kind.js'
import { createRowSetFollower, serialChain, writeCopyFile, type RowSetFollower, type RowSetState } from '../kind-follower.js'
import type { CopyKind } from './copy-kind.js'
import { copyPath, copyRefusal, markCopyOff } from './gate.js'
import { followerKind } from '../../server-role.js'

export const SESSIONS_SCHEMA_VERSION = 1
export const SESSIONS_REMOVAL_FLOOR = 200

/**
 * Fields that name a process, a file or offset inside one, or a process
 * action. None reaches a copy. Any other field whose name ends in `pid`/`Pid`
 * or names a process group is stripped too (isProcessField), so a field added
 * later cannot carry a pid across by accident.
 */
export const PROCESS_FIELDS: readonly string[] = [
  'pid', 'outputFile', 'pgid', 'costWatermark', 'costWatermarkPid', 'lineLifecyclePid', 'lineQueuedPid',
  'consumedOffset', 'streamEpoch', 'acpRuntimeId', 'acpJournalPath', 'pendingResumeSessionAt',
  // The spawn prompt and its stub (session-prompts.ts): a copy holds no prompt, so no stub of one either.
  'appliedAppendSystemPrompt', 'appliedAppendSystemPromptRef', 'autoRecover', 'mcpMountStatus', 'hostname',
  // The spawn bundle (system prompt, MCP servers with their env): it only feeds
  // the Mac's argv builder, and an MCP server's env may hold a credential.
  'profile',
]
const PROCESS_SET = new Set(PROCESS_FIELDS)

export function isProcessField(key: string): boolean {
  return PROCESS_SET.has(key) || /(^|_)pid$|[a-z0-9]Pid$|pgid|Pgid/.test(key) || /(^|_)output_?[fF]ile$|[a-z]OutputFile$/.test(key)
}

/**
 * Sent, hashed, and kept by the companion's copy file, but never written to a host
 * replica's live store: a pending stop there would be acted on as the replica's own
 * (session-stop.ts takes every pending `stopRequest` in its store and asks the daemon
 * again). The companion's copy is read by nothing that acts, only by its readers
 * (the stop fence, the session's host lookup).
 */
export const HOST_STORE_DROPPED_FIELDS: readonly string[] = ['stopRequest']

function forHostStore(row: SessionRecord): SessionRecord {
  const out: Record<string, unknown> = { ...row }
  for (const f of HOST_STORE_DROPPED_FIELDS) delete out[f]
  return out as unknown as SessionRecord
}

/** Left out of the hash (still sent with the next real change). */
export const VOLATILE_SESSION_FIELDS: readonly string[] = ['lastActiveAt', 'activity', 'contextTokens', 'promptCache']
const VOLATILE_SET = new Set(VOLATILE_SESSION_FIELDS)

/** What a session copy row is: the record without its process fields. Idempotent. */
export function projectSession(row: SessionRecord): SessionRecord {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined || isProcessField(k)) continue
    out[k] = v
  }
  return out as unknown as SessionRecord
}

/** The copy hash of a projected row: everything but the volatile fields. Both sides use it. */
export function sessionCopyHash(row: SessionRecord): string {
  const kept: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined || VOLATILE_SET.has(k) || isProcessField(k)) continue
    kept[k] = v
  }
  return sha12(JSON.stringify(kept))
}

// The store keeps an unchanged row's object between writes: project and hash it once.
const projected = new WeakMap<object, SessionRecord>()
const hashes = new WeakMap<object, string>()

function projectedOf(row: SessionRecord): SessionRecord {
  let p = projected.get(row)
  if (!p) {
    p = projectSession(row)
    projected.set(row, p)
  }
  return p
}

function hashOf(row: SessionRecord): string {
  let h = hashes.get(row)
  if (h === undefined) {
    h = sessionCopyHash(row)
    hashes.set(row, h)
  }
  return h
}

/** The leader's side. */
export const SESSIONS_KIND: CopyKind<SessionRecord> = {
  kind: 'sessions',
  schemaVersion: SESSIONS_SCHEMA_VERSION,
  key: (s) => s.claudeSessionId,
  hash: hashOf,
  ordered: false,
  digest: true,
  choice: 'sessions',
  owners: (s) => [`task:${s.taskId}`, s.legacyTaskId && `task:${s.legacyTaskId}`, `session:${s.claudeSessionId}`],
  rows: async () => {
    const all = await (await import('../../session-tracker.js')).sessionRowsForReplica()
    // Projected in slices: after a full rescan of the store every row is a new object.
    const out: SessionRecord[] = []
    for (let i = 0; i < all.length; i++) {
      out.push(projectedOf(all[i]))
      if (i % HASH_SLICE === HASH_SLICE - 1) await new Promise((r) => setImmediate(r))
    }
    return out
  },
  watch: (soon) => {
    let stop: (() => void) | null = null
    let stopped = false
    void import('../../session-tracker.js').then(({ onSessionStoreWrite }) => {
      if (!stopped) stop = onSessionStoreWrite(soon)
    })
    return () => { stopped = true; stop?.() }
  },
}

// --- Follower ---

const STATE_FILE = () => path.join(WALNUT_HOME, 'cache', 'replica', 'sessions.json')
let state: RowSetState | null = null
let serial = serialChain()

async function load(): Promise<RowSetState> {
  if (state) return state
  let s: RowSetState = { asOf: 0, at: 0, order: [], hashes: {} }
  try {
    const raw = JSON.parse(await fsp.readFile(STATE_FILE(), 'utf8')) as Partial<RowSetState> & { v?: number; carried?: unknown }
    if (raw && raw.v === 1 && raw.hashes && typeof raw.hashes === 'object') {
      s = { asOf: Number(raw.asOf) || 0, at: Number(raw.at) || 0, order: [], hashes: raw.hashes }
      carriedAt.clear()
      // An older Walnut writes no `carried` and reads past it: the file stays v1 both ways.
      if (raw.carried && typeof raw.carried === 'object') {
        for (const [k, at] of Object.entries(raw.carried as Record<string, unknown>)) if (typeof at === 'number' && at > 0) carriedAt.set(k, at)
      }
    }
  } catch { /* none yet: ask for every row */ }
  state = s
  return s
}

async function save(): Promise<void> {
  // The order of an unordered kind is not kept (5,000 ids rewritten on every step for nothing).
  if (state) {
    await writeCopyFile(STATE_FILE(), {
      v: 1, asOf: state.asOf, at: state.at, hashes: state.hashes,
      ...(carriedAt.size > 0 ? { carried: Object.fromEntries(carriedAt) } : {}),
    })
  }
}

function isRow(v: unknown): v is SessionRecord {
  const r = v as Partial<SessionRecord> | null
  return !!r && typeof r === 'object' && !Array.isArray(r) && typeof r.claudeSessionId === 'string' && r.claudeSessionId.length > 0
    && r.claudeSessionId.length <= 200
}

/**
 * No bus event: a session status event reaches hooks and projections, which
 * must never act on a copied row, and while the Mac answers the replica's
 * pages read the Mac's own (the forward). session-tracker's read cache sees
 * the apply connection's commit by `PRAGMA data_version`.
 */
function changed(): void {}

let follower: RowSetFollower | null = null
/** This host's own session ids, as the last manifest step read them (localKeys). */
let ownIds: ReadonlySet<string> = new Set()
/** This host replica's own host key ('' anywhere else): its judged rows are its own. */
const ownHostKey = (): string => (process.env.WALNUT_HOST_KEY ?? '').trim()

const onCompanion = (): boolean => followerKind() === 'companion'
/** The companion's copy: `cache/replica/home/sessions.sqlite` (gate.ts copyPath), never the live registry. */
export const companionCopyFile = (): string => copyPath(path.join(WALNUT_HOME, 'sessions.sqlite'))

/** The Mac's sessions a list can show, as the companion's copy holds them (stage 2c); [] anywhere else. */
export async function readCompanionSessions(): Promise<SessionRecord[]> {
  if (!onCompanion()) return []
  return (await import('../../session-db.js')).readCompanionSessionCopy(companionCopyFile())
}

/** The follower's side: the replica's own sessions.sqlite through session-db's apply connection. */
export function sessionsFollower(): RowSetFollower {
  follower ??= createRowSetFollower<SessionRecord>({
    kind: 'sessions',
    schemaVersion: SESSIONS_SCHEMA_VERSION,
    label: 'sessions copy',
    log: log.session,
    removalFloor: SESSIONS_REMOVAL_FLOOR,
    ordered: false,
    digest: true,
    serial: (fn) => serial(fn),
    // The replica program on a host keeps it in its live store; the cloud companion in
    // its copy store (stage 2c), apart from the sessions it runs itself (gate.ts).
    refuse: copyRefusal,
    load,
    save,
    isRow,
    key: (r) => r.claudeSessionId,
    hash: sessionCopyHash,
    localKeys: async () => {
      const db = await import('../../session-db.js')
      if (onCompanion()) { ownIds = new Set(); return db.companionSessionCopyIds(companionCopyFile()) }
      // This host's own rows (sessions/session-row-owner.ts) stay listed, so their leader
      // fields still come down, but are never counted for removal (keptBy below).
      const own = ownHostKey()
      ownIds = own ? new Set(db.ownSessionIdsInStore(own)) : new Set()
      return db.sessionIdsInStore()
    },
    keptBy: (id) => ownIds.has(id),
    apply: async ({ rows, removeIds }) => {
      const db = await import('../../session-db.js')
      // Projected again here: whatever a leader sends, no stored row names a process.
      const projected = (rows ?? []).map(projectSession)
      if (onCompanion()) { db.applyCompanionSessionCopy(companionCopyFile(), { rows: projected, removeIds }); return { skipped: [] } }
      // A put of a round whose manifest the leader built before a start's carried rows were read
      // (their `at`) may hold an older copy of them: those stay as carried, asked for again next
      // round (a manifest built after the carry). Every other row is read after the manifest.
      const asOf = state?.asOf ?? 0
      const skipped = projected.filter((r) => (carriedAt.get(r.claudeSessionId) ?? 0) > asOf).map((r) => r.claudeSessionId)
      const skip = new Set(skipped)
      const take = projected.filter((r) => !skip.has(r.claudeSessionId))
      db.applySessionCopy({ rows: take.map(forHostStore), removeIds, ownHost: ownHostKey() })
      for (const r of take) { noteLanded(r.claudeSessionId, asOf); carriedAt.delete(r.claudeSessionId) }
      for (const id of removeIds ?? []) carriedAt.delete(id)
      return { skipped }
    },
    held: async () => (await import('../../../replica/journal-overlay.js')).journalHeld('sessions'),
    changed,
    purge: async () => {
      const db = await import('../../session-db.js')
      // A host replica's own sessions (the ones that run on it) are its own work, always
      // kept: the purge takes only the Mac's others (docs/plan/walnut-control-plane.md).
      const own = onCompanion() ? '' : (process.env.WALNUT_HOST_KEY ?? '').trim()
      const ids = onCompanion() ? db.companionSessionCopyIds(companionCopyFile()) : db.sessionIdsInStore(own ? { exceptHost: own } : {})
      if (ids.length > 0) {
        if (onCompanion()) db.applyCompanionSessionCopy(companionCopyFile(), { removeIds: ids })
        else db.applySessionCopy({ removeIds: ids })
      }
      await markCopyOff('sessions')
      state = null
      carriedAt.clear()
      return { removed: ids.length }
    },
  })
  return follower
}

/**
 * When the leader read each row this host holds, both clocks the leader's own, each a lower bound
 * (the time is taken before the read; copy-kind.ts takes a manifest's `asOf` before it reads the
 * rows, as the copies' age needs: never newer than the truth, kind-follower.ts copiesAsOf):
 *
 *   landedAt   a round's put: its manifest's `asOf` (its rows are read after it). This process only.
 *   carriedAt  a start's carried rows: their `taskRowsAt`. Persisted beside the hashes, until a round
 *              built after it brings the row (the put above), so a restart keeps it.
 *
 * A carried row is skipped when a copy here was read at or after it (the newer one stays). Two lower
 * bounds cannot order two reads that overlap: a carried row taken over a put row read a moment
 * later is older than the leader's, so its hash differs from the next manifest's and that round
 * brings the leader's row again; nothing stays stale past one round.
 *
 * After a host restart landedAt is empty: a carry is taken over any row a round stored before
 * (the same one-round heal). carriedAt is read back, so a round that began before a carry still
 * never writes its older copy over the carried row, and a start reads the rows it just carried
 * whichever way that goes.
 */
const landedAt = new Map<string, number>()
const carriedAt = new Map<string, number>()
const LANDED_MAX = 20_000
const CARRIED_MAX = 2_000

function noteLanded(key: string, at: number): void {
  if (landedAt.size >= LANDED_MAX && !landedAt.has(key)) landedAt.clear()
  landedAt.set(key, Math.max(at, landedAt.get(key) ?? 0))
}

function noteCarried(key: string, at: number): void {
  if (carriedAt.size >= CARRIED_MAX && !carriedAt.has(key)) {
    // The oldest go first: a round long since brought the leader's row of each.
    const oldest = [...carriedAt].sort((a, b) => a[1] - b[1]).slice(0, Math.ceil(CARRIED_MAX / 4))
    for (const [k] of oldest) carriedAt.delete(k)
  }
  carriedAt.set(key, Math.max(at, carriedAt.get(key) ?? 0))
}

/**
 * Rows of the leader's store a start or a resume carried (session-channel/start-task-rows.ts), read
 * by the leader at `at` (its clock), taken here as a round's put takes them: projected, this host's
 * own rows taking only their leader fields, a row this host holds (its journal's) left as it is, and
 * a row a copy here was read at or after `at` left as it is too (it is newer). On the kind's serial
 * chain. Each taken row's hash is noted (what this host now holds), so a later manifest whose hash
 * differs brings the row again. Only a host replica's live store takes them: anywhere else 0.
 */
export async function applyLeaderSessionRows(rows: readonly SessionRecord[], at: number): Promise<number> {
  if (rows.length === 0 || onCompanion() || !ownHostKey()) return 0
  if (await copyRefusal()) return 0
  return serial(async () => {
    const held = await (await import('../../../replica/journal-overlay.js')).journalHeld('sessions')
    const s = await load()
    const readAt = (k: string) => Math.max(landedAt.get(k) ?? -1, carriedAt.get(k) ?? -1)
    const taken = rows
      .filter((r) => isRow(r) && !held.has(r.claudeSessionId) && readAt(r.claudeSessionId) < at)
      .map(projectSession)
    if (taken.length === 0) return 0
    ;(await import('../../session-db.js')).applySessionCopy({ rows: taken.map(forHostStore), ownHost: ownHostKey() })
    for (const r of taken) {
      s.hashes[r.claudeSessionId] = sessionCopyHash(r)
      noteCarried(r.claudeSessionId, at)
    }
    await save()
    return taken.length
  })
}

/** Tests only. */
export function _resetSessionsCopyForTesting(): void {
  state = null
  landedAt.clear()
  carriedAt.clear()
  follower = null
  serial = serialChain()
}

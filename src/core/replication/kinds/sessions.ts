/**
 * The `sessions` copy kind (docs/plan/walnut-replica-servers-impl.md, section 4
 * and WP4): every row of the Mac's sessions.sqlite on each host replica, so the
 * replica lists sessions while the Mac is away.
 *
 *   leader    session-tracker's rows, each sent as its projection: no pid, no
 *             output file, no process group, no field that names a process or
 *             a position in one (PROCESS_FIELDS); `process_status` stays as a
 *             label. The hash leaves the volatile fields out (lastActiveAt,
 *             activity, contextTokens), so a busy session costs no put until
 *             something else about it changes.
 *   follower  the replica's OWN sessions.sqlite (never the Mac's file), written
 *             only through session-db's apply connection; rows are projected
 *             again before they are stored, so a row that names a pid never
 *             lands. Refuses everywhere but the replica program on a host (`404 unknown_kind`,
 *             what the companion and the leader answered before this kind).
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
import { copyRefusal, markCopyOff } from './gate.js'

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
  'appliedAppendSystemPrompt', 'stopRequest', 'autoRecover', 'mcpMountStatus', 'hostname',
  // The spawn bundle (system prompt, MCP servers with their env): it only feeds
  // the Mac's argv builder, and an MCP server's env may hold a credential.
  'profile',
]
const PROCESS_SET = new Set(PROCESS_FIELDS)

export function isProcessField(key: string): boolean {
  return PROCESS_SET.has(key) || /(^|_)pid$|[a-z0-9]Pid$|pgid|Pgid/.test(key) || /(^|_)output_?[fF]ile$|[a-z]OutputFile$/.test(key)
}

/** Left out of the hash (still sent with the next real change). */
export const VOLATILE_SESSION_FIELDS: readonly string[] = ['lastActiveAt', 'activity', 'contextTokens']
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
    const raw = JSON.parse(await fsp.readFile(STATE_FILE(), 'utf8')) as Partial<RowSetState> & { v?: number }
    if (raw && raw.v === 1 && raw.hashes && typeof raw.hashes === 'object') {
      s = { asOf: Number(raw.asOf) || 0, at: Number(raw.at) || 0, order: [], hashes: raw.hashes }
    }
  } catch { /* none yet: ask for every row */ }
  state = s
  return s
}

async function save(): Promise<void> {
  // The order of an unordered kind is not kept (5,000 ids rewritten on every step for nothing).
  if (state) await writeCopyFile(STATE_FILE(), { v: 1, asOf: state.asOf, at: state.at, hashes: state.hashes })
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
    // Only the replica program on a host keeps it (gate.ts): the companion keeps its own projection (WP13 moves it).
    refuse: copyRefusal,
    load,
    save,
    isRow,
    key: (r) => r.claudeSessionId,
    hash: sessionCopyHash,
    localKeys: async () => (await import('../../session-db.js')).sessionIdsInStore(),
    apply: async ({ rows, removeIds }) => {
      const db = await import('../../session-db.js')
      // Projected again here: whatever a leader sends, no stored row names a process.
      db.applySessionCopy({ rows: (rows ?? []).map(projectSession), removeIds })
      return { skipped: [] }
    },
    held: async () => (await import('../../../replica/journal-overlay.js')).journalHeld('sessions'),
    changed,
    purge: async () => {
      const db = await import('../../session-db.js')
      const ids = db.sessionIdsInStore()
      if (ids.length > 0) db.applySessionCopy({ removeIds: ids })
      await markCopyOff('sessions')
      state = null
      return { removed: ids.length }
    },
  })
  return follower
}

/** Tests only. */
export function _resetSessionsCopyForTesting(): void {
  state = null
  follower = null
  serial = serialChain()
}

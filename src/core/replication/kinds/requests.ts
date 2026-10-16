/**
 * The `requests` copy kind (docs/plan/walnut-replica-servers-impl.md, section 4
 * and WP4): the Mac's session-requests.json (pending and recently settled reply
 * requests between sessions) on each host replica, in the same file there.
 *
 * A request's status only moves forward on apply (section 7): once the copy
 * holds a final status (replied, notified, expired), a leader row that says
 * otherwise does not take it back, and the leader's hash is still recorded so
 * the round ends (a settle the copy made itself reaches the Mac through the
 * journal, WP10). `withdrawn` is not final: the Mac restores a withdrawn ask
 * to pending when its task reopens (session-requests.ts restoreRequest).
 *
 * Unordered, half rule from 50 rows, no digest (at most 500 rows).
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../../constants.js'
import { log } from '../../../logging/index.js'
import type { SessionRequest, SessionRequestStatus } from '../../session-requests.js'
import { sha12 } from '../kind.js'
import { createRowSetFollower, serialChain, writeCopyFile, type RowSetFollower, type RowSetState } from '../kind-follower.js'
import type { CopyKind } from './copy-kind.js'
import { copyRefusal, markCopyOff } from './gate.js'

export const REQUESTS_SCHEMA_VERSION = 1
export const REQUESTS_REMOVAL_FLOOR = 50

const FINAL: ReadonlySet<SessionRequestStatus> = new Set(['replied', 'notified', 'expired'])

/**
 * The row the copy keeps when the leader sends `incoming` for a row it holds
 * as `local`: the leader's, unless the copy settled it here (a final status)
 * and the leader has not yet (pending or withdrawn). Two final statuses: the
 * leader's, since a final status never changes on the Mac and its hash is the
 * one this side records (keeping the local one would never be asked again).
 */
export function forwardRequest(local: SessionRequest | undefined, incoming: SessionRequest): SessionRequest {
  if (local && FINAL.has(local.status) && !FINAL.has(incoming.status)) return local
  return incoming
}

const hashes = new WeakMap<object, string>()
function hashOf(row: SessionRequest): string {
  let h = hashes.get(row)
  if (h === undefined) {
    h = sha12(JSON.stringify(row))
    hashes.set(row, h)
  }
  return h
}

export const REQUESTS_KIND: CopyKind<SessionRequest> = {
  kind: 'requests',
  schemaVersion: REQUESTS_SCHEMA_VERSION,
  key: (r) => r.id,
  hash: hashOf,
  ordered: false,
  digest: false,
  choice: 'requests',
  rows: async () => (await import('../../session-requests.js')).listAllSessionRequests(),
  watch: (soon) => {
    let stop: (() => void) | null = null
    let stopped = false
    void import('../../session-requests.js').then(({ onSessionRequestsWritten }) => {
      if (!stopped) stop = onSessionRequestsWritten(soon)
    })
    return () => { stopped = true; stop?.() }
  },
}

// --- Follower ---

const STATE_FILE = () => path.join(WALNUT_HOME, 'cache', 'replica', 'requests.json')
/** The same file the Mac keeps (session-requests.ts REQUESTS_FILE). */
const STORE_FILE = () => path.join(WALNUT_HOME, 'session-requests.json')
let state: RowSetState | null = null
let serial = serialChain()

async function load(): Promise<RowSetState> {
  if (state) return state
  let s: RowSetState = { asOf: 0, at: 0, order: [], hashes: {} }
  try {
    const raw = JSON.parse(await fsp.readFile(STATE_FILE(), 'utf8')) as Partial<RowSetState> & { v?: number }
    if (raw?.v === 1 && raw.hashes && typeof raw.hashes === 'object') s = { asOf: Number(raw.asOf) || 0, at: Number(raw.at) || 0, order: [], hashes: raw.hashes }
  } catch { /* none yet */ }
  state = s
  return s
}

async function save(): Promise<void> {
  if (state) await writeCopyFile(STATE_FILE(), { v: 1, asOf: state.asOf, at: state.at, hashes: state.hashes })
}

async function readStore(): Promise<SessionRequest[]> {
  try {
    const raw = JSON.parse(await fsp.readFile(STORE_FILE(), 'utf8')) as { requests?: unknown }
    return Array.isArray(raw?.requests) ? raw.requests.filter(isRow) : []
  } catch { return [] }
}

function isRow(v: unknown): v is SessionRequest {
  const r = v as Partial<SessionRequest> | null
  return !!r && typeof r === 'object' && typeof r.id === 'string' && !!r.id && typeof r.fromSessionId === 'string'
    && typeof r.status === 'string' && typeof r.createdAt === 'string'
}

let follower: RowSetFollower | null = null

export function requestsFollower(): RowSetFollower {
  follower ??= createRowSetFollower<SessionRequest>({
    kind: 'requests',
    schemaVersion: REQUESTS_SCHEMA_VERSION,
    label: 'requests copy',
    log: log.session,
    removalFloor: REQUESTS_REMOVAL_FLOOR,
    ordered: false,
    serial: (fn) => serial(fn),
    refuse: copyRefusal,
    load,
    save,
    isRow,
    key: (r) => r.id,
    localKeys: async () => (await readStore()).map((r) => r.id),
    apply: async ({ rows, removeIds }) => {
      const byId = new Map((await readStore()).map((r) => [r.id, r]))
      for (const id of removeIds ?? []) byId.delete(id)
      for (const r of rows ?? []) {
        const kept = forwardRequest(byId.get(r.id), r)
        if (kept !== r) log.session.info('requests copy: kept a settled request the leader has not settled yet', { requestId: r.id, local: kept.status, leader: r.status })
        byId.set(r.id, kept)
      }
      await writeCopyFile(STORE_FILE(), { requests: [...byId.values()] })
      return { skipped: [] }
    },
    held: async () => (await import('../../../replica/journal-overlay.js')).journalHeld('requests'),
    changed: () => {},
    purge: async () => {
      const removed = (await readStore()).length
      await fsp.rm(STORE_FILE(), { force: true })
      await markCopyOff('requests')
      state = null
      return { removed }
    },
  })
  return follower
}

/** Tests only. */
export function _resetRequestsCopyForTesting(): void {
  state = null
  follower = null
  serial = serialChain()
}

/**
 * Which host may bring which new session to this leader (docs/plan/one-service-every-host.md,
 * phase 2): a host's channel writes a row on the leader only for a session id that is that host's.
 * One is when the leader holds the host's row of it already (judge 'host', host = it); the other
 * is when the leader handed it the session, recorded here before the start goes out, with the task
 * the start is for:
 *
 *   seeded start   the leader names the id (preassignedSessionId): a hand naming that id
 *   unseeded start the host names the id (an ACP engine's, say): an open hand of that host. The
 *                  start carries the hand's id (`startHand`); the host echoes it on the born row of
 *                  that start (host-emitter.ts), and only that row takes the hand. The start's
 *                  answer names the id too (settleAnswer): the hand then names it, and the row
 *                  comes on a resync. A host that does not echo (one older than this) keeps only
 *                  that answer path: its born row is refused, the answer names the id, the leader
 *                  asks for the row whole (host-judged-runner.ts), and the records it sent before
 *                  the answer are not said here (the row and everything after it are).
 *   a rename       of a row the host owns here, into an id no other host was handed (mayRenameInto)
 *
 * A born row whose task is not its hand's task is refused too: a host never links its session to a
 * task the leader did not start it for (session-tracker.ts keeps a held row's task as well).
 *
 * Anything else (a born row of an id nobody handed it, an id handed to another host, a rename into
 * another session's row) is refused and never applied: a host can never take a session of another
 * host, a legacy session, or an id the leader is about to hand someone else.
 *
 * The hands live in sessions.sqlite (session_host_hands, session-db.ts SCHEMA_SQL), so a start whose
 * answer a restart lost still finds its hand when the host's born row comes after the restart. A
 * hand goes when its born row is written, when its start is refused or never sent, when its
 * hand-over is taken back (host-handover.ts takeStartBack: a refusal, the lost check, a host that
 * disowns it), and in any case after HAND_MS. A resume (host-resume.ts) hands its session the same
 * way, through the same hand-over: the leader's row is the host's from then on (handSeedToHost),
 * and the hand covers the host's row should the leader's be gone meanwhile.
 *
 * A host is a machine, not one of its names: one machine can be in the config under several host
 * keys (an ssh row and the row it joined the host network as, reaching one daemon). A hand written
 * under one of them is that machine's, whichever of its names the channel that brings the session
 * comes in under (revoked-hosts.ts sameMachine, the one notion of "one machine" the ban uses too).
 * A genuinely different machine is still another host.
 */
import crypto from 'node:crypto'
import type { Database as DatabaseType } from '../../lib/sqlite.js'
import { getDb, sessionJudgeInStore, transactionWhenFree } from '../session-db.js'
import { prepared } from '../../lib/sqlite-prepared.js'
import { sameMachine } from './revoked-hosts.js'

/** How long a hand stands with no born row (a start in flight, one whose answer a restart lost). */
export const HAND_MS = 24 * 60 * 60_000

interface HandRow { id: string; host_id: string; sid: string | null; task_id: string }

const COLS = 'id, host_id, sid, task_id'

function handOf(handle: DatabaseType, sid: string, now: number): HandRow | undefined {
  return prepared(handle, `SELECT ${COLS} FROM session_host_hands WHERE sid = ? AND until > ? ORDER BY at LIMIT 1`).get(sid, now) as HandRow | undefined
}

/** Is a hand or row written under host key `owner` this host's (`hostId`, any name of its machine)? */
export function hostOwns(owner: string | null | undefined, hostId: string): boolean {
  return !!owner && sameMachine(owner, hostId)
}

function openHand(handle: DatabaseType, hostId: string, id: string, now: number): HandRow | undefined {
  const h = prepared(handle, `SELECT ${COLS} FROM session_host_hands WHERE id = ? AND sid IS NULL AND until > ?`).get(id, now) as HandRow | undefined
  return h && hostOwns(h.host_id, hostId) ? h : undefined
}

/** The hands naming `sid` that are `hostId`'s machine's, oldest first. */
function handsOfFor(handle: DatabaseType, hostId: string, sid: string, now: number): HandRow[] {
  return (prepared(handle, `SELECT ${COLS} FROM session_host_hands WHERE sid = ? AND until > ? ORDER BY at`).all(sid, now) as HandRow[])
    .filter((h) => hostOwns(h.host_id, hostId))
}

function dropById(handle: DatabaseType, id: string): void {
  prepared(handle, 'DELETE FROM session_host_hands WHERE id = ?').run(id)
}

function insertHand(handle: DatabaseType, id: string, hostId: string, sid: string | null, taskId: string, now: number): void {
  prepared(handle, 'INSERT INTO session_host_hands (id, host_id, sid, task_id, at, until) VALUES (?, ?, ?, ?, ?, ?)').run(id, hostId, sid, taskId, now, now + HAND_MS)
}

/** Run `fn` in one write transaction of the sessions store; null when there is no store (nothing kept). */
function inStore<T>(fn: (handle: DatabaseType) => T): Promise<T | null> {
  if (!getDb()) return Promise.resolve(null)
  return Promise.resolve(transactionWhenFree(fn))
}

/** A hand's id (host-api.ts HAND_ID is its shape). */
const newId = (): string => crypto.randomBytes(9).toString('hex')

/**
 * The leader hands `hostId` a start for task `taskId`: `sid` the id it names (a seeded start), null
 * when the host names it (an open hand). The hand's id, to settle or drop it with, and the one the
 * start carries for the host to echo; '' when no store keeps it.
 */
export async function handStart(hostId: string, sid: string | null, o: { taskId?: string; now?: number } = {}): Promise<string> {
  const id = newId()
  const now = o.now ?? Date.now()
  const kept = await inStore((handle) => {
    prepared(handle, 'DELETE FROM session_host_hands WHERE until <= ?').run(now)
    insertHand(handle, id, hostId, sid, o.taskId ?? '', now)
    return true
  })
  return kept ? id : ''
}

/** The start did not go (refused, never sent, failed as lost): its hand goes. */
export async function dropHand(id: string): Promise<void> {
  if (!id) return
  await inStore((handle) => dropById(handle, id))
}

export type HandRefusal = 'other' | 'none' | 'task'

/**
 * Inside the channel's apply transaction (session-tracker applyHostChannelBatch): `hostId` sends a
 * whole row of `sid` for task `taskId`, which the leader has no row of; `echo`: the hand id the row
 * carries (its start's `startHand`). `hand`: the hand that lets it in, the hand naming `sid` or the
 * open hand the row echoes (useHand once the row is written, in the same transaction). 'other':
 * `sid` was handed to another host; 'task': its hand was for another task; 'none': nobody handed it.
 */
export function handForNewSession(handle: DatabaseType, hostId: string, sid: string, o: { echo?: string; taskId?: string } = {}, now = Date.now()): { hand: string } | { refused: HandRefusal } {
  const h = handOf(handle, sid, now) ?? (o.echo ? openHand(handle, hostId, o.echo, now) : undefined)
  if (!h) return { refused: 'none' }
  if (!hostOwns(h.host_id, hostId)) return { refused: 'other' }
  // Exactly its start's task: a hand with none admits a row with none, never one that names a task.
  if (h.task_id !== (o.taskId ?? '')) return { refused: 'task' }
  return { hand: h.id }
}

/** Inside the apply transaction: does a hand of `hostId` name `sid` (its row is expected, worth a resync)? */
export function handedTo(handle: DatabaseType, hostId: string, sid: string, now = Date.now()): boolean {
  return hostOwns(handOf(handle, sid, now)?.host_id, hostId)
}

/** Inside the apply transaction: the row a hand let in is written; the hand is used up. */
export function useHand(handle: DatabaseType, id: string): void {
  dropById(handle, id)
}

/** Inside the apply transaction: may `hostId` rename a row it owns into `to`, which has no row here (no other host was handed it)? */
export function mayRenameInto(handle: DatabaseType, hostId: string, to: string, now = Date.now()): boolean {
  const h = handOf(handle, to, now)
  if (!h) return true
  if (!hostOwns(h.host_id, hostId)) return false
  dropById(handle, h.id)
  return true
}

/** Inside the apply transaction: `hostId`'s row of `sid` was written; a hand naming it is done. */
export function settleHandsOf(handle: DatabaseType, hostId: string, sid: string): void {
  for (const h of handsOfFor(handle, hostId, sid, 0)) dropById(handle, h.id)
}

/**
 * The host answered a start the leader handed it (hand `handId`, for task `taskId`) with `sid`.
 * True when `sid` is that host's: its row here is the host's, or nobody else was handed it (the
 * start's hand now names it, the one hand of the start: a seeded hand of another id is moved to
 * it, never left beside it). False: the answer names another host's session or a session that is
 * not a host's (the caller refuses the start). `row`: the leader holds a row of `sid` already.
 */
export async function settleAnswer(hostId: string, sid: string, handId: string, o: { taskId?: string; now?: number } = {}): Promise<{ ok: boolean; row: boolean }> {
  const now = o.now ?? Date.now()
  const out = await inStore((handle) => {
    const row = sessionJudgeInStore(sid, handle)
    if (row) {
      if (!row.judgedByHost || !hostOwns(row.host, hostId)) return { ok: false, row: true }
      if (handId) dropById(handle, handId)
      return { ok: true, row: true }
    }
    const h = handOf(handle, sid, now)
    if (h && !hostOwns(h.host_id, hostId)) return { ok: false, row: false }
    if (h) { if (handId && handId !== h.id) dropById(handle, handId); return { ok: true, row: false } }
    const mine = handId ? prepared(handle, `SELECT ${COLS} FROM session_host_hands WHERE id = ?`).get(handId) as HandRow | undefined : undefined
    const named = mine && hostOwns(mine.host_id, hostId) ? prepared(handle, 'UPDATE session_host_hands SET sid = ? WHERE id = ?').run(sid, mine.id).changes : 0
    if (named === 0) insertHand(handle, newId(), hostId, sid, o.taskId ?? '', now)
    return { ok: true, row: false }
  })
  // No store to check against: nothing here could take the session from anyone either.
  return out ?? { ok: true, row: false }
}

/** How long the leader remembers which session a queue row it made belongs to (a request can wait weeks). */
export const LINES_MS = 30 * 24 * 60 * 60_000
const PRUNE_EVERY_MS = 60 * 60_000
let prunedAt = 0

/**
 * The session each queue row this leader made or handed a host is for: its queue's enqueue (every
 * row, while any host runs its sessions: leader-boot.ts) and host-judged-send.ts deliver (a row
 * moved to another session names it now). A host's fact of `sid` may name a row of `sid`, or one
 * this leader never made (the companion's or the phone's line while the Mac was away); never a
 * row of another session (linesNotOthers).
 */
export async function noteLinesHanded(sid: string, ids: readonly string[], now = Date.now()): Promise<void> {
  if (!sid || ids.length === 0) return
  await inStore((handle) => {
    if (now - prunedAt >= PRUNE_EVERY_MS) { prunedAt = now; prepared(handle, 'DELETE FROM session_host_lines WHERE at <= ?').run(now - LINES_MS) }
    const put = prepared(handle, 'INSERT INTO session_host_lines (id, sid, at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET sid = excluded.sid, at = excluded.at')
    for (const id of ids) if (id) put.run(id, sid, now)
  })
}

/** Of `ids`, the ones no other session's row is (a sync read: the channel's apply asks it per fact). */
export function linesNotOthers(sid: string, ids: readonly string[], now = Date.now()): string[] {
  if (ids.length === 0) return []
  const handle = getDb()
  // No store to ask: nothing can be told apart, so nothing is kept.
  if (!handle) return []
  const get = prepared(handle, 'SELECT sid FROM session_host_lines WHERE id = ? AND at > ?')
  return ids.filter((id) => {
    const owner = (get.get(id, now - LINES_MS) as { sid: string } | undefined)?.sid
    return owner === undefined || owner === sid
  })
}

/** The id of the hand naming `sid` for `hostId` ('' when none stands): a seeded start's, for its answer (settleAnswer). */
export function handIdOf(hostId: string, sid: string, now = Date.now()): string {
  const handle = getDb()
  if (!handle) return ''
  return handsOfFor(handle, hostId, sid, now)[0]?.id ?? ''
}

/** A hand-over of `sid` to `hostId` was taken back (host-handover.ts takeStartBack): no hand of it stands for that host. */
export async function dropHandsOf(hostId: string, sid: string): Promise<void> {
  await inStore((handle) => { for (const h of handsOfFor(handle, hostId, sid, 0)) dropById(handle, h.id) })
}

/** Tests: the next note prunes again. */
export function _resetLinesPruneForTesting(): void { prunedAt = 0 }

/** The hands standing now (tests, the Mac's probe). */
export function handsNow(now = Date.now()): Array<{ host: string; sid: string | null }> {
  const handle = getDb()
  if (!handle) return []
  return (handle.prepare('SELECT host_id, sid FROM session_host_hands WHERE until > ? ORDER BY at').all(now) as Array<{ host_id: string; sid: string | null }>)
    .map((r) => ({ host: r.host_id, sid: r.sid }))
}

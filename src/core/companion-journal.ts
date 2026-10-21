/**
 * The companion's journal v2 (docs/plan/walnut-companion-unified-replica.md,
 * stage 3): the writes it takes while the Mac is away, in the same journal core a
 * host keeps (providers/offline-journal-core.ts), run in this server. The Mac
 * drains it with the handover a host gets (core/offline-handover.ts, host key
 * `companion`) through `POST /bridge/journal` (web/routes/bridge-journal.ts).
 *
 *   dir      cache/journal/ (never git): the journal, its state, its lock
 *   home     one fixed home: the companion has one Mac, so the door answers the
 *            Mac's `home` with this journal whatever path it names
 *   kinds    a record is written only for a kind the Mac said it drains (the
 *            `kinds` of its last `offline.drain`, kept in `drains.json`); before
 *            any drain, or for a kind it did not name, the caller keeps its old
 *            queue (an older Mac never sees a record it cannot take)
 *
 * Slice 3a writes `task-fields` (a task update whose fields the Mac merges), 3b
 * `session-meta` (a session's title, archive flag, note, output mode, thread
 * fields); the other queues are unchanged until their slice. A record carries no device actor
 * yet: the companion's pairing ids are not always the Mac's, and the Mac drops a
 * record whose device it does not know.
 *
 * Cloud companion only: a call anywhere else is a programming error.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { WALNUT_HOME } from '../constants.js'
import { log } from '../logging/index.js'
import { createOfflineJournal, type AppendResult, type JournalRecord, type OfflineJournal } from '../providers/offline-journal-core.js'
import { writeJsonFile } from '../utils/fs.js'
import { followerKind } from './server-role.js'

/** The one home this journal keeps (its files are named by it). */
export const COMPANION_JOURNAL_HOME = 'mac'
/** The handover's host key on the Mac (offline-merge/companion-op.ts uses the same one). */
export const COMPANION_JOURNAL_HOST = 'companion'
/** A drain's batch, as a host's. */
export const COMPANION_DRAIN_BATCH = 200

export const companionJournalDir = (): string => path.join(WALNUT_HOME, 'cache', 'journal')
const drainsFile = (): string => path.join(companionJournalDir(), 'drains.json')

const onCompanion = (): boolean => followerKind() === 'companion'

let journal: OfflineJournal | null = null
let drains: Set<string> | null = null
const listeners = new Set<() => void>()

function journalOf(): OfflineJournal {
  if (!onCompanion()) throw new Error('companion journal: not a cloud companion')
  if (!journal) {
    fs.mkdirSync(companionJournalDir(), { recursive: true, mode: 0o700 })
    journal = createOfflineJournal({
      fs, path, dir: companionJournalDir(),
      now: Date.now,
      randomHex: (bytes) => crypto.randomBytes(bytes).toString('hex'),
      keyOf: (home) => crypto.createHash('sha1').update(home).digest('hex').slice(0, 16),
      sha256: (body) => crypto.createHash('sha256').update(body).digest('hex'),
      log: (level, msg, data) => log.session[level](`companion ${msg}`, data),
      keepOpen: true,
    })
    // Read from disk once: this process is the journal's one writer, so `records`
    // answers from memory after it (records left by the last process included).
    try { journal.pending(COMPANION_JOURNAL_HOME) } catch (err) {
      log.session.warn('companion journal: could not read the journal left on disk', { error: err instanceof Error ? err.message : String(err) })
    }
  }
  return journal
}

function readDrains(): Set<string> {
  if (drains) return drains
  try {
    const raw = JSON.parse(fs.readFileSync(drainsFile(), 'utf8')) as { kinds?: unknown }
    drains = new Set(Array.isArray(raw?.kinds) ? raw.kinds.filter((k): k is string => typeof k === 'string') : [])
  } catch {
    drains = new Set()
  }
  return drains
}

/** True when the Mac said it drains `kind` (its last drain named it). */
export function macDrains(kind: string): boolean {
  return onCompanion() && readDrains().has(kind)
}

/** Records the Mac has not acked yet (handed out or not). */
export function companionJournalRecords(): JournalRecord[] {
  if (!onCompanion()) return []
  // A box that never wrote a record has no journal: asking never makes one.
  if (!journal && !fs.existsSync(companionJournalDir())) return []
  try { return journalOf().records(COMPANION_JOURNAL_HOME) } catch { return [] }
}

/** True when records wait for the Mac. */
export function companionJournalDue(): boolean {
  return companionJournalRecords().length > 0
}

/** Tasks a record still names (their rows are held against copy rounds until the Mac has them). */
export function companionJournalTaskIds(): Set<string> {
  const out = new Set<string>()
  for (const r of companionJournalRecords()) if (typeof r.taskId === 'string') out.add(r.taskId)
  return out
}

/** Called after every append (the trigger tells the Mac when it answers). Returns the stop. */
export function onCompanionJournal(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/**
 * Save one task update the Mac merges by field: `task-fields`, op `task_update`.
 * `opId` is the writer's (the queue's op id); a retry with it is answered with the
 * first record. Null when the Mac does not drain the kind: the caller queues as before.
 */
export function journalTaskFields(input: {
  opId: string
  taskId: string
  fields: Record<string, { base: unknown; value: unknown; at?: number }>
}): AppendResult | null {
  if (!macDrains('task-fields')) return null
  const r = journalOf().append(COMPANION_JOURNAL_HOME, {
    kind: 'task-fields', op: 'task_update', taskId: input.taskId, fields: input.fields,
  }, { opId: input.opId, coalesce: true, limit: true })
  if (r.ok) {
    log.task.info('companion journal: saved a task write for the Mac', { taskId: input.taskId, opId: r.opId, seq: r.seq, ...(r.coalesced ? { coalesced: true } : {}), ...(r.duplicate ? { duplicate: true } : {}) })
    for (const fn of listeners) { try { fn() } catch { /* a listener never loses the record */ } }
  } else {
    log.task.error('companion journal: a task write was refused', { taskId: input.taskId, opId: input.opId, code: r.code, why: r.why, error: r.message })
  }
  return r
}

/**
 * The fields a session metadata record carries: the v1 PATCH's metadata (never `mode`,
 * which acts on the live CLI and only the session's host can accept).
 */
export const SESSION_META_FIELDS: ReadonlySet<string> = new Set(['title', 'archived', 'human_note', 'output_mode', 'thread_anchors', 'thread_meta'])

/**
 * Save one session metadata patch for the Mac: `session-meta` (slice 3b). Null when the
 * Mac does not drain the kind, or the patch names a field it does not carry: the caller
 * queues as before (control-queue.ts).
 */
export function journalSessionMeta(input: { sessionId: string; patch: Record<string, unknown> }): AppendResult | null {
  if (!macDrains('session-meta')) return null
  const keys = Object.keys(input.patch)
  if (keys.length === 0 || keys.some((k) => !SESSION_META_FIELDS.has(k))) return null
  const r = journalOf().append(COMPANION_JOURNAL_HOME, { kind: 'session-meta', sid: input.sessionId, patch: input.patch }, { limit: true })
  if (r.ok) {
    log.session.info('companion journal: saved a session change for the Mac', { sessionId: input.sessionId, opId: r.opId, seq: r.seq, fields: keys })
    for (const fn of listeners) { try { fn() } catch { /* a listener never loses the record */ } }
  } else {
    log.session.error('companion journal: a session change was refused', { sessionId: input.sessionId, code: r.code, why: r.why, error: r.message })
  }
  return r
}

/** Sessions a record still names (their queued patches wait behind them). */
export function companionJournalSessionIds(): Set<string> {
  const out = new Set<string>()
  for (const r of companionJournalRecords()) if (r.kind === 'session-meta' && typeof r.sid === 'string') out.add(r.sid)
  return out
}

// --- the trigger ---

/** The queues' sweep: records that still wait are announced again this often. */
export const JOURNAL_DUE_SWEEP_MS = 60_000
let telling = false

/**
 * Tell the Mac that records wait (`server.journal.due` over the primary relay, the
 * queues' path); it drains them over /bridge/journal. False when nothing waits or
 * the Mac did not answer (the next sweep asks again). One ask at a time.
 *
 * `always`: ask with nothing waiting too. The bridge connecting asks so: the drain
 * is how this box learns which kinds the Mac drains (a Mac that never drained gets
 * no record, so it would never be asked), and a Mac that updated may drain more.
 * An older Mac refuses the action; nothing else happens.
 */
export async function tellMacJournalDue(why: string, always = false): Promise<boolean> {
  if (!onCompanion() || telling || (!always && !companionJournalDue())) return false
  telling = true
  try {
    const { callPrimaryControl } = await import('../web/routes/v1-control-relay.js')
    const r = await callPrimaryControl('server.journal.due', '__server__', { records: companionJournalRecords().length }, 15_000)
    if (r.ok) log.session.info('companion journal: asked the Mac to drain', { why, records: companionJournalRecords().length })
    else if (why !== 'sweep') log.session.info('companion journal: the Mac did not take the ask', { why, kind: r.failure.kind })
    return r.ok
  } catch {
    return false
  } finally {
    telling = false
  }
}

/**
 * The bridge to the Mac connecting, a frame from the Mac (at most every 15 s: a Mac
 * that slept wakes on a socket that never closed), and the 60 s sweep. Returns the stop.
 */
export function startCompanionJournalDue(): { stop: () => void } {
  const timer = setInterval(() => { void tellMacJournalDue('sweep') }, JOURNAL_DUE_SWEEP_MS)
  timer.unref?.()
  const unhooks: Array<() => void> = []
  let stopped = false
  void import('../web/ws/bridge-registry.js').then(({ addPrimaryBridgeConnectedHandler, addPrimaryBridgeActivityHandler }) => {
    if (stopped) return
    unhooks.push(addPrimaryBridgeConnectedHandler(() => { void tellMacJournalDue('bridge-connected', true) }))
    unhooks.push(addPrimaryBridgeActivityHandler(() => { void tellMacJournalDue('bridge-activity') }))
  }).catch(() => { /* the sweep still asks */ })
  // A boot with records left: ask once the bridge had a moment to connect.
  const first = setTimeout(() => { void tellMacJournalDue('boot') }, 10_000)
  first.unref?.()
  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
      clearTimeout(first)
      for (const u of unhooks.splice(0)) u()
      // The server is going down: let go of the journal's file (a later write opens it again).
      try { journal?.close() } catch { /* closed */ }
      journal = null
    },
  }
}

// --- the door's side (web/routes/bridge-journal.ts) ---

/** The Mac's next batch; `kinds` (what it applies) is kept for the writers. */
export async function drainCompanionJournal(kinds: string[] | null): Promise<{ ok: boolean; records: JournalRecord[]; more: boolean; now: number; error?: string; why?: string }> {
  if (kinds) {
    const next = [...new Set(kinds)].sort()
    const have = [...readDrains()].sort()
    if (next.join(',') !== have.join(',')) {
      await writeJsonFile(drainsFile(), { v: 1, kinds: next, at: Date.now() }, { mode: 0o600 })
      drains = new Set(next)
    }
  }
  const out = journalOf().drain(COMPANION_JOURNAL_HOME, { kinds, batch: COMPANION_DRAIN_BATCH })
  if (out.error) return { ok: false, ...out }
  if (out.records.length) log.session.info('companion journal: drained', { records: out.records.length, more: out.more, firstSeq: out.records[0].seq, lastSeq: out.records[out.records.length - 1].seq })
  return { ok: true, ...out }
}

export function ackCompanionJournal(seqs: unknown): { ok: boolean; remaining: number; ignored?: number[]; error?: string } {
  const r = journalOf().ack(COMPANION_JOURNAL_HOME, { seqs })
  if (r.error) return { ok: false, remaining: r.remaining, error: r.error }
  if (r.acked.length) {
    log.session.info('companion journal: the Mac took records', { acked: r.acked.length, remaining: r.remaining })
    // Queued ops held behind those records (task-queue.ts, control-queue.ts) go now.
    void import('./task-queue.js').then((m) => m.flushTaskQueue()).catch(() => {})
    void import('./control-queue.js').then((m) => m.flushControlQueue()).catch(() => {})
  }
  return { ok: true, remaining: r.remaining, ...(r.ignored.length ? { ignored: r.ignored } : {}) }
}

export function readCompanionJournalBlob(sha: unknown, offset: unknown): ReturnType<OfflineJournal['readBlob']> {
  return journalOf().readBlob(sha, offset)
}

/** Tests only. */
export function _resetCompanionJournalForTesting(): void {
  try { journal?.close() } catch { /* closed */ }
  journal = null
  drains = null
  listeners.clear()
}

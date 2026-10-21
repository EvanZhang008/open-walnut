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
 * fields), 3c `inbox-state` (a letter's read, pinned or archived flag), 3d
 * `task-create` (a task born here), 4c `note` (a note saved here, its bodies as
 * blobs: companion-notes.ts), 3e `chat-turn` (a chat turn this box answered itself, its
 * texts as blobs: companion-chat-turns.ts), 4d `memory` (MEMORY.md or USER.md saved here:
 * companion-memory.ts), 4d `note-move` (a note moved or renamed here:
 * companion-note-paths.ts); the other queues are unchanged until their slice. A record carries no device actor
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
      maxRecords: COMPANION_JOURNAL_MAX_RECORDS,
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
 * Save one task born here for the Mac: `task-create` (slice 3d), with the id this box
 * minted and the fields and placement of a host's create (offline-host-core.ts), so the
 * Mac's create rules place it (offline-merge/apply-v2.ts applyTaskCreate). `opId` is the
 * queue's: a live send that did land leaves the task with that `created_by_op`, and the
 * Mac then skips this record. Null when the Mac does not drain the kind: the caller
 * queues as before.
 */
export function journalTaskCreate(input: {
  opId: string
  taskId: string
  fields: Record<string, unknown>
  placement: { parentTaskId?: string; project?: string; groupId?: string; tier?: string }
}): AppendResult | null {
  if (!macDrains('task-create')) return null
  const r = journalOf().append(COMPANION_JOURNAL_HOME, {
    kind: 'task-create', taskId: input.taskId, fields: input.fields, placement: input.placement,
  }, { opId: input.opId, limit: true })
  if (r.ok) {
    log.task.info('companion journal: saved a new task for the Mac', { taskId: input.taskId, opId: r.opId, seq: r.seq, ...(r.duplicate ? { duplicate: true } : {}) })
    for (const fn of listeners) { try { fn() } catch { /* a listener never loses the record */ } }
  } else {
    log.task.error('companion journal: a new task was refused', { taskId: input.taskId, opId: input.opId, code: r.code, why: r.why, error: r.message })
  }
  return r
}

/**
 * Save one note change for the Mac (slice 4c): a `note` record with its bodies as blobs
 * (offline-journal-core.ts appendNote, coalesced by path), merged on the Mac with the
 * notes merge. Null when the Mac does not drain the kind: the caller keeps the old path.
 * The checks (the lock hash, the size, the note's id) are the caller's (companion-notes.ts).
 */
export function journalNote(note: Parameters<OfflineJournal['appendNote']>[1], opts: { coalesce?: boolean } = {}): AppendResult | null {
  if (!macDrains('note')) return null
  // `coalesce: false`: a save on a path a pending move names (it must land after the move).
  const r = journalOf().appendNote(COMPANION_JOURNAL_HOME, note, { limit: true, ...(opts.coalesce === false ? { coalesce: false } : {}) })
  if (r.ok) {
    log.session.info('companion journal: saved a note change for the Mac', { path: note.path, mode: note.mode, opId: r.opId, seq: r.seq, ...(r.coalesced ? { coalesced: true } : {}), ...(r.dropped ? { dropped: true } : {}) })
    for (const fn of listeners) { try { fn() } catch { /* a listener never loses the record */ } }
  } else {
    log.session.error('companion journal: a note change was refused', { path: note.path, code: r.code, why: r.why, error: r.message })
  }
  return r
}

/**
 * Save one MEMORY.md or USER.md change for the Mac (stage 4d): a `memory` record naming
 * the text it was made on and the new text as blobs, merged on the Mac three-way
 * (offline-merge/apply-memory.ts). Never coalesced (the core folds notes and task fields
 * only): each save is a record whose base is the one before it. Null when the Mac does
 * not drain the kind: the caller keeps the old path. The lock check is the caller's
 * (companion-memory.ts).
 */
export function journalMemory(input: { doc: 'global' | 'user'; baseHash: string | null; base: Buffer | null; ours: Buffer; oursHash: string }): AppendResult | null {
  if (!macDrains('memory')) return null
  const j = journalOf()
  // A body stored before its record is safe from the orphan sweep for an hour.
  const base = input.base ? j.putBlob(COMPANION_JOURNAL_HOME, input.base) : null
  if (base && !base.ok) return base
  const ours = j.putBlob(COMPANION_JOURNAL_HOME, input.ours)
  if (!ours.ok) return ours
  const r = j.append(COMPANION_JOURNAL_HOME, {
    kind: 'memory', doc: input.doc, baseHash: input.baseHash, baseBlob: base ? base.sha : null, oursBlob: ours.sha, oursHash: input.oursHash,
  }, { limit: true })
  if (r.ok) {
    log.memory.info('companion journal: saved a memory change for the Mac', { doc: input.doc, opId: r.opId, seq: r.seq })
    for (const fn of listeners) { try { fn() } catch { /* a listener never loses the record */ } }
  } else {
    log.memory.error('companion journal: a memory change was refused', { doc: input.doc, code: r.code, why: r.why, error: r.message })
  }
  return r
}

/**
 * Save one note moved or renamed here for the Mac (stage 4d): a `note-move` record naming
 * both vault paths and the note's id, applied on the Mac where the note is now
 * (offline-merge/apply-note-move.ts). Null when the Mac does not drain the kind: the
 * caller keeps the old path. The checks are the caller's (companion-note-paths.ts).
 */
export function journalNoteMove(input: { from: string; to: string; noteId?: string }): AppendResult | null {
  if (!macDrains('note-move')) return null
  const r = journalOf().append(COMPANION_JOURNAL_HOME, {
    kind: 'note-move', from: input.from, to: input.to, ...(input.noteId ? { noteId: input.noteId } : {}),
  }, { limit: true, coalesce: false })
  if (r.ok) {
    log.session.info('companion journal: saved a note move for the Mac', { from: input.from, to: input.to, opId: r.opId, seq: r.seq })
    for (const fn of listeners) { try { fn() } catch { /* a listener never loses the record */ } }
  } else {
    log.session.error('companion journal: a note move was refused', { from: input.from, to: input.to, code: r.code, why: r.why, error: r.message })
  }
  return r
}

/** Unacked records the journal takes at most (the core's per-home limit). */
export const COMPANION_JOURNAL_MAX_RECORDS = 1000

/** A note body the journal keeps, by its sha256 (a pending save's text), or null. */
export function companionJournalBlobBody(sha: unknown): Buffer | null {
  if (!onCompanion() || (!journal && !fs.existsSync(companionJournalDir()))) return null
  try { return journalOf().blobBody(sha) } catch { return null }
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

/**
 * Save one inbox flag the human set (slice 3c): `inbox-state`, `madeAt` the human's
 * moment on this box's clock (the Mac judges it against its own later changes, as a
 * relayed replay's `since`). Null when the Mac does not drain the kind: the caller
 * queues as before (human-inbox/replica-state.ts).
 */
export function journalInboxState(input: { letterId: string; field: 'read' | 'pinned' | 'archived'; value: boolean; madeAt: number }): AppendResult | null {
  if (!macDrains('inbox-state')) return null
  const r = journalOf().append(COMPANION_JOURNAL_HOME, {
    kind: 'inbox-state', letterId: input.letterId, field: input.field, value: input.value, madeAt: input.madeAt,
  }, { limit: true })
  if (r.ok) {
    log.notif.info('companion journal: saved an inbox change for the Mac', { letterId: input.letterId, field: input.field, value: input.value, opId: r.opId, seq: r.seq })
    for (const fn of listeners) { try { fn() } catch { /* a listener never loses the record */ } }
  } else {
    log.notif.error('companion journal: an inbox change was refused', { letterId: input.letterId, field: input.field, code: r.code, why: r.why, error: r.message })
  }
  return r
}

/**
 * Save one chat turn this box answered itself while the Mac did not answer (slice 3e):
 * `chat-turn`, the user's words and the answer as blobs (`userBlob`, `answerBlob`), op id
 * `chat-<turnId>` (a retry is answered with the first record). The Mac adopts it as it
 * adopted an outbox turn (offline-merge/apply-chat-turn.ts). Null when the Mac does not
 * drain the kind: the caller keeps the turn in the outbox (cloud-chat-outbox.ts).
 */
export function journalChatTurn(input: {
  turnId: string; agentId: string; conversationId: string; userText: string; userAt: string; engine: string
  answerText?: string; answeredAt?: string; error?: string
}): AppendResult | null {
  if (!macDrains('chat-turn')) return null
  const texts: Record<string, Uint8Array> = { userBlob: Buffer.from(input.userText, 'utf8') }
  if (input.answerText) texts.answerBlob = Buffer.from(input.answerText, 'utf8')
  const r = journalOf().appendBlobs(COMPANION_JOURNAL_HOME, {
    kind: 'chat-turn', turnId: input.turnId, agentId: input.agentId, conversationId: input.conversationId,
    userAt: input.userAt, engine: input.engine,
    ...(input.answerText ? { answeredAt: input.answeredAt ?? input.userAt } : { error: input.error ?? '' }),
  }, texts, { opId: `chat-${input.turnId}`, limit: true })
  if (r.ok) {
    log.agent.info('companion journal: saved a chat turn for the Mac', { turnId: input.turnId, conversationId: input.conversationId, answered: !!input.answerText, opId: r.opId, seq: r.seq, ...(r.duplicate ? { duplicate: true } : {}) })
    for (const fn of listeners) { try { fn() } catch { /* a listener never loses the record */ } }
  } else {
    log.agent.error('companion journal: a chat turn was refused', { turnId: input.turnId, conversationId: input.conversationId, code: r.code, why: r.why, error: r.message })
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

/** `macNow`: the Mac's clock after it applied them (the handover sends it with the ack). */
export async function ackCompanionJournal(seqs: unknown, macNow?: unknown): Promise<{ ok: boolean; remaining: number; ignored?: number[]; error?: string }> {
  // An inbox flag the Mac took stays on the box's inbox until its copy shows it
  // (replica-state.ts): written before the record goes, so a read between the two
  // never shows the flag as it was.
  const named = new Set(Array.isArray(seqs) ? seqs : [])
  const acked = companionJournalRecords().filter((x) => named.has(x.seq))
  const flags = acked.filter((x) => x.kind === 'inbox-state')
  const at = typeof macNow === 'number' ? macNow : Date.now()
  if (flags.length) {
    const { noteJournalStateAcked } = await import('./human-inbox/replica-state.js')
    await noteJournalStateAcked(flags, at)
  }
  // A note the Mac took stays over the copy until a copy round from after the ack (4c).
  const notes = acked.filter((x) => x.kind === 'note' || x.kind === 'note-move')
  if (notes.length) (await import('./companion-notes.js')).companionNotesAcked(notes, at)
  // A chat turn the Mac took stays in the box's reads until its copy names it (3e); its
  // texts are read here, before the ack frees them.
  const turns = acked.filter((x) => x.kind === 'chat-turn')
  if (turns.length) (await import('./companion-chat-turns.js')).companionChatTurnsAcked(turns)
  // A memory doc the same way (4d).
  const memory = acked.filter((x) => x.kind === 'memory')
  if (memory.length) (await import('./companion-memory.js')).companionMemoryAcked(memory, at)
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

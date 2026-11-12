/**
 * Queue rows written into a CLI's stdin, held until the CLI says what it did
 * with their line.
 *
 * A user line written while a turn runs waits in the CLI's own command queue,
 * which lives only in that process: a crash drops it unseen, and on --resume
 * the CLI does not replay it. So for a CLI that reports its command queue
 * (stream-json `command_lifecycle`, named by the line's uuid) a row leaves
 * Walnut's queue only on the CLI's own word: `completed` (the turn ran),
 * `started` (the model has it; with a daemon that judges answers, the rows
 * then wait for the answer, see "Lines the CLI took" below), `cancelled` (a
 * Stop dropped it). `discarded` and `refused`
 * mean it never ran, and the user is told. Nothing else counts: no turn count,
 * no timer. A CLI that has not reported lifecycle keeps the old rule (the write
 * is the last word), see ClaudeCodeSession.writeMessage.
 *
 * One exception, and it never settles a row by itself: a line the CLI has not
 * named at all (not even `queued`) is challenged after a grace period
 * (ClaudeCodeSession.checkLineAck, send-lost-line-v1). The CLI's answer to a
 * request written after the line proves it read past it; only then do the rows
 * go back to pending, to be written again under the same uuid.
 *
 * When the process dies first, its untaken rows go back to pending and are
 * delivered again under the same uuid (QueuedMessage.lineUuid, persisted): the
 * CLI skips a uuid its transcript already holds, and the daemon skips a resend
 * into the process that already has the line (send-dedupe-v1).
 *
 * In memory only. After a server restart the rows are pending again with their
 * uuid and try count, and their next delivery asks the daemon, which answers
 * from the CLI's lifecycle frames in the stream file (line-fate-core.ts). That
 * the CLI reports its queue survives the restart twice over: on the rows
 * (QueuedMessage.lineTracked) and on the session record (lineLifecyclePid), so a
 * line the daemon says still waits in the live CLI is registered here again and
 * comes back if that process dies before taking it.
 */
import type { QueuedMessage } from '../core/session-message-queue.js'

interface Line { rows: QueuedMessage[]; pid: number | null }

export interface UntakenLine { uuid: string; rows: QueuedMessage[] }

/** What the CLI reported for a line, in its own words. */
export type LineState = 'queued' | 'started' | 'completed' | 'cancelled' | 'discarded' | 'refused'

const bySession = new Map<string, Map<string, Line>>()
/** Bound per session: a CLI that never reports on its lines must not pin memory. */
const MAX_LINES = 64

/**
 * The last state each recent uuid reported, so a report that beats its
 * registration is not lost, with the process that reported it (null: unknown).
 */
const seen = new Map<string, Map<string, { state: LineState; pid: number | null }>>()
const MAX_SEEN = 256

/**
 * Register a line before it is written, so a lifecycle event that beats the
 * send ack still finds it. `pid`: the process it is written into (null when
 * not yet known), so a death reclaims only that process's lines. Returns the
 * state the CLI already reported for this uuid, if it did (the caller then
 * settles the rows at once).
 *
 * `onEvicted`: past the bound, the oldest line leaves the registry and nothing
 * would ever settle its rows again. They go to this callback, which settles
 * them by the old rule (the write was the last word).
 */
export function awaitLine(
  sessionId: string, uuid: string, rows: QueuedMessage[], pid: number | null = null,
  onEvicted?: (rows: QueuedMessage[]) => void,
): LineState | undefined {
  if (!sessionId || !uuid || rows.length === 0) return undefined
  const word = seen.get(sessionId)?.get(uuid)
  // A `started` another process said is no word on this write into `pid`: that
  // process took the line and is gone, and whether it answered is the daemon's
  // to read (line-answer-v1), never taken as this process's start.
  const stale = !!word && word.state === 'started' && word.pid != null && pid != null && word.pid !== pid
  const already = word && !stale ? word.state : undefined
  if (already && already !== 'queued') return already
  let lines = bySession.get(sessionId)
  if (!lines) { lines = new Map(); bySession.set(sessionId, lines) }
  lines.delete(uuid)
  lines.set(uuid, { rows: [...rows], pid })
  if (lines.size > MAX_LINES) {
    const oldest = lines.keys().next().value!
    const evicted = lines.get(oldest)!.rows
    lines.delete(oldest)
    onEvicted?.(evicted)
  }
  return undefined
}

/** The CLI took, cancelled or dropped this line: its rows, now off the waiting list. */
export function takeLine(sessionId: string | null | undefined, uuid: string): QueuedMessage[] {
  if (!sessionId) return []
  const lines = bySession.get(sessionId)
  const line = lines?.get(uuid)
  if (!lines || !line) return []
  lines.delete(uuid)
  if (lines.size === 0) bySession.delete(sessionId)
  return line.rows
}

/** The rows of a line still waiting for the CLI's word, left registered (empty: none). */
export function lineRows(sessionId: string | null | undefined, uuid: string): QueuedMessage[] {
  const line = sessionId ? bySession.get(sessionId)?.get(uuid) : undefined
  return line ? [...line.rows] : []
}

/** The write failed: the caller's failure path owns the rows again. */
export function dropLine(sessionId: string | null | undefined, uuid: string): void {
  takeLine(sessionId, uuid)
}

/** Remember what the CLI said about a uuid (registered or not). */
export function noteLineState(sessionId: string | null | undefined, uuid: string, state: LineState, pid: number | null = null): void {
  if (!sessionId || !uuid) return
  let states = seen.get(sessionId)
  if (!states) { states = new Map(); seen.set(sessionId, states) }
  states.delete(uuid)
  states.set(uuid, { state, pid })
  if (states.size > MAX_SEEN) states.delete(states.keys().next().value!)
}

/**
 * Forget what the CLI said about a uuid: a line its process took and never
 * answered goes back to pending, and its resend must ask the daemon (which reads
 * whether that process answered) instead of finding `started` here (line-answer-v1).
 */
export function forgetLineState(sessionId: string | null | undefined, uuid: string): void {
  const states = sessionId ? seen.get(sessionId) : undefined
  if (!states) return
  states.delete(uuid)
  if (states.size === 0) seen.delete(sessionId!)
}

/** Is any line of this session waiting for the CLI to take it? */
export function hasUntakenLines(sessionId: string | null | undefined): boolean {
  return !!sessionId && (bySession.get(sessionId)?.size ?? 0) > 0
}

/** Is this line still waiting for the CLI's word (registered, never taken, cancelled or dropped)? */
export function isLineAwaited(sessionId: string | null | undefined, uuid: string): boolean {
  return !!sessionId && !!bySession.get(sessionId)?.has(uuid)
}

/** The lines still waiting, oldest first, with the process each went into. Nothing is removed. */
export function awaitedLines(sessionId: string | null | undefined): Array<{ uuid: string; pid: number | null }> {
  const lines = sessionId ? bySession.get(sessionId) : undefined
  return lines ? [...lines].map(([uuid, line]) => ({ uuid, pid: line.pid })) : []
}

/**
 * Lines still waiting, oldest first, removed from the registry. With `pid`,
 * only the lines written into that process (or before its pid was known): the
 * ones a death of that process took with it.
 */
export function untakenLines(sessionId: string | null | undefined, pid?: number | null): UntakenLine[] {
  if (!sessionId) return []
  const lines = bySession.get(sessionId)
  if (!lines) return []
  const out: UntakenLine[] = []
  for (const [uuid, line] of lines) {
    if (pid != null && line.pid != null && line.pid !== pid) continue
    out.push({ uuid, rows: line.rows })
    lines.delete(uuid)
  }
  if (lines.size === 0) bySession.delete(sessionId)
  return out
}

// ── Lines the CLI took, waiting for its answer (line-answer-v1) ──
//
// `started` says the CLI took the line for a turn, not that it answered: a CLI
// killed before its first word leaves a message nobody answers. With a daemon
// that judges answers (line-answer-v1), a taken line's rows stay queued here
// until the process that took it prints its answer (an assistant message or a
// result, line-fate-core.ts lineAnswerFrame). When that process ends first,
// they go back to pending under their uuid, and the next delivery asks the
// daemon, which reads the CLI's stdout and says whether it answered (ran) or
// not (unanswered: sent once more under a new uuid). Kept apart from the lines
// waiting to be taken: nothing here is challenged, cancelled by a Stop, or
// handed back to the composer.

/**
 * `after`: how many answers the reader had counted when it read the line's
 * `started` frame (or its process's first init, for a resume's first line), so
 * only a later answer is the line's. Null: the line's start was not read here
 * (a daemon's word that the process took it), so no answer counts until the
 * reader reaches that frame (orderAnswer): the daemon's word and the stream are
 * not ordered, and an answer read before the frame belongs to an earlier turn.
 */
interface AnsweringLine extends Line { after: number | null }

const answering = new Map<string, Map<string, AnsweringLine>>()

/**
 * The CLI took this line in process `pid`: its rows wait for that process's
 * answer. Past the bound the oldest line leaves and goes to `onEvicted`, which
 * settles it by the old rule (taken is delivered), so no row is stranded.
 */
export function awaitAnswer(
  sessionId: string | null | undefined, uuid: string, rows: QueuedMessage[], pid: number | null,
  after: number | null, onEvicted?: (rows: QueuedMessage[]) => void,
): void {
  if (!sessionId || !uuid || rows.length === 0) return
  let lines = answering.get(sessionId)
  if (!lines) { lines = new Map(); answering.set(sessionId, lines) }
  lines.delete(uuid)
  lines.set(uuid, { rows: [...rows], pid, after })
  if (lines.size > MAX_LINES) {
    const oldest = lines.keys().next().value!
    const evicted = lines.get(oldest)!.rows
    lines.delete(oldest)
    onEvicted?.(evicted)
  }
}

/** The reader reached the `started` frame of a line waiting for its answer: answers from here on are its. */
export function orderAnswer(sessionId: string | null | undefined, uuid: string, after: number): void {
  const line = sessionId ? answering.get(sessionId)?.get(uuid) : undefined
  if (line && line.after === null) line.after = after
}

/**
 * Process `pid` printed an answer, the reader's `count`-th: every line it took
 * whose start came before that answer is answered, removed and returned.
 */
export function answeredLines(sessionId: string | null | undefined, pid: number | null, count: number): UntakenLine[] {
  const lines = sessionId ? answering.get(sessionId) : undefined
  if (!lines) return []
  const out: UntakenLine[] = []
  for (const [uuid, line] of lines) {
    if (pid != null && line.pid != null && line.pid !== pid) continue
    if (line.after === null || count <= line.after) continue
    out.push({ uuid, rows: line.rows })
    lines.delete(uuid)
  }
  if (lines.size === 0) answering.delete(sessionId!)
  return out
}

/** Lines still waiting for an answer from `pid` (or any process), removed: that process ended. */
export function unansweredLines(sessionId: string | null | undefined, pid?: number | null): UntakenLine[] {
  return drainAnswering(sessionId, pid ?? null)
}

/** One line's wait for its answer ends (the CLI said `completed`): its rows, or none. */
export function takeAnswering(sessionId: string | null | undefined, uuid: string): QueuedMessage[] {
  const lines = sessionId ? answering.get(sessionId) : undefined
  const line = lines?.get(uuid)
  if (!lines || !line) return []
  lines.delete(uuid)
  if (lines.size === 0) answering.delete(sessionId!)
  return line.rows
}

/** Is any line of this session waiting for an answer (optionally from process `pid`)? */
export function hasAnsweringLines(sessionId: string | null | undefined, pid?: number | null): boolean {
  const lines = sessionId ? answering.get(sessionId) : undefined
  if (!lines) return false
  if (pid == null) return lines.size > 0
  for (const line of lines.values()) if (line.pid == null || line.pid === pid) return true
  return false
}

/**
 * The ids of this session's queue rows whose line the CLI took and has not
 * answered yet: the model has them, they are only still queued for the answer.
 * The queue card reads them as taken (sessions/queue-row-view.ts). Memory only.
 */
export function takenRowIds(sessionId: string | null | undefined): Set<string> {
  const out = new Set<string>()
  const lines = sessionId ? answering.get(sessionId) : undefined
  if (!lines) return out
  for (const line of lines.values()) for (const row of line.rows) out.add(row.id)
  return out
}

/**
 * The ids of this session's queue rows whose line is registered for the CLI's
 * word (written, or being written, into its stdin; not taken yet). Memory only.
 */
export function awaitedRowIds(sessionId: string | null | undefined): Set<string> {
  const out = new Set<string>()
  const lines = sessionId ? bySession.get(sessionId) : undefined
  if (!lines) return out
  for (const line of lines.values()) for (const row of line.rows) out.add(row.id)
  return out
}

function drainAnswering(sessionId: string | null | undefined, pid: number | null): UntakenLine[] {
  const lines = sessionId ? answering.get(sessionId) : undefined
  if (!lines) return []
  const out: UntakenLine[] = []
  for (const [uuid, line] of lines) {
    if (pid != null && line.pid != null && line.pid !== pid) continue
    out.push({ uuid, rows: line.rows })
    lines.delete(uuid)
  }
  if (lines.size === 0) answering.delete(sessionId!)
  return out
}

// ── What the user was told about a row's delivery ──
//
// A row is reported delivered once: at the first proof that a CLI has its line,
// whichever comes first (the write's plain answer, the daemon's word that the
// line ran, or the CLI naming it started or completed). A later proof for the
// same row says nothing. Once the user is told the row failed or is unconfirmed
// (markUnconfirmed), the next proof reports it delivered again (the failed bubble
// would otherwise invite a Retry of a message that ran).

const told = new Map<string, Set<string>>()

/** The user was told these rows are not delivered (failed, unconfirmed, parked): the next proof reports them. */
export function markUnconfirmed(sessionId: string, rowIds: string[]): void {
  const ids = sessionId ? told.get(sessionId) : undefined
  if (!ids) return
  for (const id of rowIds) ids.delete(id)
  if (ids.size === 0) told.delete(sessionId)
}

/** Of these rows, the ones not yet reported delivered. From now on they count as reported. */
export function takeUntold(sessionId: string, rowIds: string[]): string[] {
  if (!sessionId || rowIds.length === 0) return []
  let ids = told.get(sessionId)
  if (!ids) { ids = new Set(); told.set(sessionId, ids) }
  const out: string[] = []
  for (const id of rowIds) {
    if (ids.has(id) || out.includes(id)) continue
    out.push(id)
    ids.add(id)
  }
  while (ids.size > MAX_SEEN) ids.delete(ids.values().next().value!)
  return out
}

// ── A cold resume's first line, in the new process's stdin until it boots ──
//
// The spawn carried the line and the user is told it is delivered (settleResumeSuccess),
// but the process reads it only once it has loaded the session (its init). The queue read
// shows these rows as written meanwhile, never waiting: a read in that window flipped the
// web's Delivered bubble back to Queued for the CLI's whole boot (2026-11-11, about 7 s on
// a dev host). Set and cleared with the session's own hold (ClaudeCodeSession._resumeLineHold).

const resumeHeld = new Map<string, Set<string>>()

/** The rows a resumed process holds as its unread first line (null: none any more). */
export function noteResumeLine(sessionId: string | null | undefined, rowIds: string[] | null): void {
  if (!sessionId) return
  if (rowIds && rowIds.length > 0) resumeHeld.set(sessionId, new Set(rowIds))
  else resumeHeld.delete(sessionId)
}

/** The rows of this session's resume line still to be read by its new process. Memory only. */
export function resumeLineRowIds(sessionId: string | null | undefined): Set<string> {
  return new Set(sessionId ? resumeHeld.get(sessionId) ?? [] : [])
}

// ── Rows held behind a line whose delivery is being confirmed ──
//
// The web shows these as waiting, also after a reload: session:get-queue reads
// them here. An entry ends when its line is written or settled, or when its rows
// start a new delivery attempt.

const held = new Map<string, Map<string, string>>()

/** Why a queued message waits while the session's permission prompt is unanswered (holdBehindPrompt). */
export const PROMPT_HOLD_REASON = 'Waiting for the permission prompt to be answered'

export function noteHeld(sessionId: string, rowIds: string[], reason: string): void {
  if (!sessionId || rowIds.length === 0) return
  let ids = held.get(sessionId)
  if (!ids) { ids = new Map(); held.set(sessionId, ids) }
  for (const id of rowIds) { ids.delete(id); ids.set(id, reason) }
  while (ids.size > MAX_SEEN) ids.delete(ids.keys().next().value!)
}

export function releaseHeld(sessionId: string | null | undefined, rowIds: string[]): void {
  const ids = sessionId ? held.get(sessionId) : undefined
  if (!ids) return
  for (const id of rowIds) ids.delete(id)
  if (ids.size === 0) held.delete(sessionId!)
}

/** Why each held row of this session waits (row id → reason). */
export function heldRows(sessionId: string): ReadonlyMap<string, string> | undefined {
  return held.get(sessionId)
}

// ── Reclaimed lines ──
//
// A process that died without a turn event (between turns, or quietly) leaves
// nothing to drive the queue: the runner listens here to deliver what it held.
// `lost`: the live process read past a line without taking it (another reader
// of its stdin took the bytes, send-lost-line-v1); its rows are pending again
// and go out even while Walnut still counts the turn that line was to open.

export type ReclaimReason = 'death' | 'lost'
type ReclaimListener = (sessionId: string, why: ReclaimReason) => void
let reclaimListener: ReclaimListener | null = null

export function onLinesReclaimed(listener: ReclaimListener): () => void {
  reclaimListener = listener
  return () => { if (reclaimListener === listener) reclaimListener = null }
}

export function announceReclaimed(sessionId: string, why: ReclaimReason = 'death'): void {
  reclaimListener?.(sessionId, why)
}

/** Test-only reset. */
export function resetLineConsumption(): void {
  bySession.clear()
  answering.clear()
  seen.clear()
  told.clear()
  resumeHeld.clear()
  held.clear()
  reclaimListener = null
}

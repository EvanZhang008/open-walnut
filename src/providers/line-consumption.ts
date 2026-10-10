/**
 * Queue rows written into a CLI's stdin, held until the CLI says what it did
 * with their line.
 *
 * A user line written while a turn runs waits in the CLI's own command queue,
 * which lives only in that process: a crash drops it unseen, and on --resume
 * the CLI does not replay it. So for a CLI that reports its command queue
 * (stream-json `command_lifecycle`, named by the line's uuid) a row leaves
 * Walnut's queue only on the CLI's own word: `started` or `completed` (the
 * model has it), `cancelled` (a Stop dropped it). `discarded` and `refused`
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

/** The last state each recent uuid reported, so a report that beats its registration is not lost. */
const seen = new Map<string, Map<string, LineState>>()
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
  const already = seen.get(sessionId)?.get(uuid)
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

/** The write failed: the caller's failure path owns the rows again. */
export function dropLine(sessionId: string | null | undefined, uuid: string): void {
  takeLine(sessionId, uuid)
}

/** Remember what the CLI said about a uuid (registered or not). */
export function noteLineState(sessionId: string | null | undefined, uuid: string, state: LineState): void {
  if (!sessionId || !uuid) return
  let states = seen.get(sessionId)
  if (!states) { states = new Map(); seen.set(sessionId, states) }
  states.delete(uuid)
  states.set(uuid, state)
  if (states.size > MAX_SEEN) states.delete(states.keys().next().value!)
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

// ── Rows held behind a line whose delivery is being confirmed ──
//
// The web shows these as waiting, also after a reload: session:get-queue reads
// them here. An entry ends when its line is written or settled, or when its rows
// start a new delivery attempt.

const held = new Map<string, Map<string, string>>()

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
  seen.clear()
  told.clear()
  held.clear()
  reclaimListener = null
}

/**
 * Stream→archive convergence sentinel (P3-lite of the reliability plan).
 *
 * The one invariant that matters at a turn boundary: every assistant message
 * the user WATCHED stream (identified by its API `msg_…` id, threaded through
 * the whole pipeline by the ACP-dialect work) must exist in the persisted
 * canonical history shortly after the turn ends. A streamed-but-never-persisted
 * id is the "reply visible while streaming, gone when done" class
 * (inc-1783357192826) caught at the moment it happens instead of via a user
 * report hours later.
 *
 * Direction matters: we only check streamed ⊆ persisted. The reverse
 * (persisted id never streamed) is normal — replayed turns, mid-turn
 * reconnects, and subagent output all persist without streaming through this
 * client's buffer.
 *
 * Only TEXT ids are checked. Thinking is frequently redacted from persisted
 * history by design (see promote-blocks.thinkingMsgIds), so its absence is not
 * a defect.
 */

import { log } from '../../logging/index.js'

/** Streamed text msgIds that have no persisted twin. */
export interface ConvergenceDiff {
  /** Ids streamed to the client but absent from persisted history. */
  missing: string[]
  /** How many streamed ids were checked (0 = nothing to verify, vacuously converged). */
  checked: number
}

/**
 * Pure comparison: which streamed text ids never made it into persisted
 * history? `persistedMsgIds` is the full id set of the current history parse —
 * position within it is irrelevant (a /compact may reorder/renumber freely;
 * only id PRESENCE matters, which is the whole point of stable ids).
 */
export function diffStreamedVsPersisted(
  streamedTextMsgIds: readonly string[],
  persistedMsgIds: ReadonlySet<string>,
): ConvergenceDiff {
  const unique = new Set(streamedTextMsgIds)
  const missing: string[] = []
  for (const id of unique) {
    if (!persistedMsgIds.has(id)) missing.push(id)
  }
  return { missing, checked: unique.size }
}

/** Delay before the check runs: covers the archive flush after `result` plus a
 *  slow remote (SSH) history read. A turn's messages not persisted after this
 *  long is a defect, not lag. */
const CHECK_DELAY_MS = 15_000
/** Per-session incident dedupe window — a flapping session opens ONE case file. */
const INCIDENT_DEDUPE_MS = 30 * 60_000

const lastIncidentAt = new Map<string, number>()

/**
 * Arm a one-shot convergence check for a just-finished turn. Called from the
 * server's session:result path with the text ids captured from the stream
 * buffer BEFORE clearSoon wipes it. Fire-and-forget: never throws, never
 * blocks the turn pipeline; an unreadable history (SSH down, daemon timeout)
 * skips silently rather than false-alarming.
 */
export function armStreamConvergenceCheck(sessionId: string, streamedTextMsgIds: string[]): void {
  if (streamedTextMsgIds.length === 0) return
  const timer = setTimeout(() => {
    void runCheck(sessionId, streamedTextMsgIds).catch((err) => {
      log.obs.warn('stream-convergence check failed', {
        sessionId, error: err instanceof Error ? err.message : String(err),
      })
    })
  }, CHECK_DELAY_MS)
  timer.unref?.()
}

async function runCheck(sessionId: string, streamedTextMsgIds: string[]): Promise<void> {
  const { getSessionByClaudeId } = await import('../session-tracker.js')
  const record = await getSessionByClaudeId(sessionId)
  if (!record) return // session archived/deleted since — nothing to verify against

  const { readSessionHistory } = await import('../session-history.js')
  let messages
  try {
    messages = await readSessionHistory(sessionId, record.cwd, record.host)
  } catch {
    return // history unreadable (SSH down / daemon timeout) — skip, don't false-alarm
  }
  if (!messages || messages.length === 0) return // empty parse ≠ proof of loss

  const persisted = new Set<string>()
  for (const m of messages) {
    if (m.msgId) persisted.add(m.msgId)
  }
  const diff = diffStreamedVsPersisted(streamedTextMsgIds, persisted)
  if (diff.missing.length === 0) {
    log.obs.debug('stream-convergence: converged', { sessionId, checked: diff.checked })
    return
  }

  // The whole turn vanishing is the P0 class; a partial miss may be a parse
  // edge — both are case files, severity tells them apart.
  const fullLoss = diff.missing.length === diff.checked
  log.obs.error('stream-convergence VIOLATION: streamed message(s) missing from persisted history', {
    sessionId,
    missing: diff.missing,
    checked: diff.checked,
    persistedCount: persisted.size,
    host: record.host ?? '__local__',
  })

  const now = Date.now()
  const last = lastIncidentAt.get(sessionId) ?? 0
  if (now - last < INCIDENT_DEDUPE_MS) return
  lastIncidentAt.set(sessionId, now)

  try {
    const { createIncident } = await import('./incidents.js')
    await createIncident({
      sessionId,
      taskId: record.taskId,
      trigger: 'invariant',
      label: 'stream-convergence',
      summary: `${diff.missing.length}/${diff.checked} streamed message(s) never persisted (${fullLoss ? 'full turn lost' : 'partial'})`,
      severity: fullLoss ? 'error' : 'warn',
    })
  } catch (err) {
    log.obs.warn('stream-convergence: incident creation failed', {
      sessionId, error: err instanceof Error ? err.message : String(err),
    })
  }
}

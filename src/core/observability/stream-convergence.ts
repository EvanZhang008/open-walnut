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
 *
 * The parse we compare against may be a WINDOW, not the whole file: a transcript
 * over DaemonFileReader's byte ceiling degrades to its last 4 MiB
 * (readSessionHistory → readSessionHistoryTailWindow), and one long agentic turn
 * easily writes more than that (tool results included). Treating that window as
 * the full persisted set flagged every id written before the window started as
 * "missing" — 6/59 on a 42 MB remote session, 13/19 on a 155 MB local one, all
 * of them verifiably in the file a few MB before the window. The window is a
 * SUFFIX of the file and the CLI appends in stream order, so presence inside it
 * is monotonic: once one streamed id is in the window, every id streamed after
 * it must be too. Ids before that first hit are unverifiable from the window
 * (counted, not flagged); ids from it onward are checked exactly as before.
 */

import { log } from '../../logging/index.js'

/** Streamed text msgIds that have no persisted twin. */
export interface ConvergenceDiff {
  /** Ids streamed to the client but absent from persisted history. */
  missing: string[]
  /** How many streamed ids were checked (0 = nothing to verify, vacuously converged). */
  checked: number
  /**
   * Streamed ids written BEFORE a windowed parse's first line, in stream order
   * ahead of the first id the window holds — the window cannot say whether they
   * persisted. Always 0 for a full parse. Reported, never flagged.
   */
  unverifiable: number
}

export interface DiffOptions {
  /** The persisted set came from a bounded tail window (isWindowedHistory). */
  windowed?: boolean
}

/**
 * Pure comparison: which streamed text ids never made it into persisted
 * history? `persistedMsgIds` is the id set of the current history parse —
 * position within it is irrelevant (a /compact may reorder/renumber freely;
 * only id PRESENCE matters, which is the whole point of stable ids).
 *
 * `streamedTextMsgIds` must be in STREAM order (the stream buffer's block order)
 * for the windowed rule to hold: with `windowed`, ids ahead of the first one the
 * window holds are unverifiable rather than missing. A window holding NONE of
 * them is still a full loss: the turn's LAST text is the newest thing in the
 * file when the turn ends, so 15 s later it cannot sit outside the last 4 MiB.
 */
export function diffStreamedVsPersisted(
  streamedTextMsgIds: readonly string[],
  persistedMsgIds: ReadonlySet<string>,
  opts?: DiffOptions,
): ConvergenceDiff {
  const unique = [...new Set(streamedTextMsgIds)]
  let from = 0
  if (opts?.windowed) {
    const firstHit = unique.findIndex((id) => persistedMsgIds.has(id))
    if (firstHit > 0) from = firstHit
  }
  const missing: string[] = []
  for (let i = from; i < unique.length; i++) {
    if (!persistedMsgIds.has(unique[i])) missing.push(unique[i])
  }
  return { missing, checked: unique.length - from, unverifiable: from }
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

  const { readSessionHistory, isWindowedHistory } = await import('../session-history.js')
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
  // Ask about the exact array we were handed: a whale transcript's parse is a
  // bounded tail window, and only the ids inside it can be judged (see header).
  const windowed = isWindowedHistory(messages)
  const diff = diffStreamedVsPersisted(streamedTextMsgIds, persisted, { windowed })
  if (diff.missing.length === 0) {
    log.obs.debug('stream-convergence: converged', {
      sessionId, checked: diff.checked, windowed, unverifiable: diff.unverifiable,
    })
    return
  }

  // The whole turn vanishing is the P0 class; a partial miss may be a parse
  // edge — both are case files, severity tells them apart.
  const fullLoss = diff.missing.length === diff.checked
  log.obs.error('stream-convergence VIOLATION: streamed message(s) missing from persisted history', {
    sessionId,
    missing: diff.missing,
    checked: diff.checked,
    unverifiable: diff.unverifiable,
    windowed,
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

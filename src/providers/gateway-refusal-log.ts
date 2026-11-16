/**
 * One line per caller and reason, not one per refused call.
 *
 * A caller in a loop (a script calling an op for thousands of ids, a session past its write
 * budget) is refused the same way again and again. Each refusal used to write its own warn line,
 * so one looping caller alone tipped the health monitor's log-spike alarm (2026-11-15: 2,947
 * "throttled" lines from one caller in a few minutes). The relay still answers every call; only
 * the log is folded: the first refusal of a caller for a reason is written, the same ones within
 * the window are counted, and the count is written when the window ends (`sweep`) or on the next
 * line for that pair, whichever comes first, so a burst's size is never lost.
 */

export const REFUSAL_LOG_WINDOW_MS = 5 * 60_000
const MAX_KEYS = 500

interface Slot { host: string; callerSid: string; code: string; until: number; suppressed: number }

export interface RefusalLogDecision {
  /** Write this line. */
  write: boolean
  /** Same refusals left out since the last written line for this caller and reason. */
  suppressed: number
}

/** A window that ended with refusals left out: what its summary line says. */
export interface RefusalLogSummary { host: string; callerSid: string; code: string; suppressed: number }

export function createRefusalLog(windowMs = REFUSAL_LOG_WINDOW_MS, maxKeys = MAX_KEYS) {
  const slots = new Map<string, Slot>()
  const ended: RefusalLogSummary[] = []
  const end = (key: string, slot: Slot) => {
    slots.delete(key)
    if (slot.suppressed > 0) ended.push({ host: slot.host, callerSid: slot.callerSid, code: slot.code, suppressed: slot.suppressed })
  }
  return {
    /** Whether to write a refusal of `callerSid` on `host` for `code` now. */
    admit(host: string, callerSid: string, code: string, now = Date.now()): RefusalLogDecision {
      const key = `${host}\u0000${callerSid}\u0000${code}`
      const slot = slots.get(key)
      if (slot && now < slot.until) {
        slot.suppressed++
        return { write: false, suppressed: slot.suppressed }
      }
      const suppressed = slot?.suppressed ?? 0
      slots.delete(key)
      if (slots.size >= maxKeys) {
        for (const [k, s] of slots) if (now >= s.until) end(k, s)
        // Still full of live callers: end the oldest early, which only costs one extra line later.
        if (slots.size >= maxKeys) {
          const oldest = slots.keys().next().value as string
          end(oldest, slots.get(oldest)!)
        }
      }
      slots.set(key, { host, callerSid, code, until: now + windowMs, suppressed: 0 })
      return { write: true, suppressed }
    },
    /** Windows that ended with refusals left out, each once: the caller may have stopped. */
    sweep(now = Date.now()): RefusalLogSummary[] {
      for (const [k, s] of slots) if (now >= s.until) end(k, s)
      return ended.splice(0)
    },
    size: () => slots.size,
  }
}

/**
 * An op's own answer, not a refusal: the API looked and said no (a missing id, a conflict, bad
 * arguments). 401 and 403 are not here: a policy refusing the caller (a task-only op called
 * from outside a task, 2026-11-14) must still read as a refusal. Timeouts and too-many neither.
 */
const OP_ANSWER_STATUSES = new Set([400, 404, 409, 410, 412, 422])
export function isOpAnswerStatus(status: unknown): status is number {
  return typeof status === 'number' && OP_ANSWER_STATUSES.has(status)
}

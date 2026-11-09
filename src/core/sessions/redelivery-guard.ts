/**
 * A queue row taken for delivery again and again within seconds is a loop, not a
 * retry. Every honest retry in the runner waits on a clock of 5 s or more (held
 * send, budget check, slow host), and a steer that falls back to a prompt takes a
 * row twice. So a row taken more than MAX_TAKES_IN_WINDOW times inside
 * TAKE_WINDOW_MS is parked for the user with words they can read, and Retry sends
 * it again.
 *
 * 2026-11-09: one Codex message was taken about 30,000 times in 37 minutes. Each
 * refused steer came back as a turn error, the turn-error path drove the queue at
 * once, and the queue steered the same row again. Each take wrote the whole queue
 * file under its lock, so every other session's queue write timed out.
 *
 * In memory, per runner: a restart starts every count again, which is the safe
 * direction (a loop gets parked again within a second).
 */

export const TAKE_WINDOW_MS = 30_000
export const MAX_TAKES_IN_WINDOW = 8

export const REDELIVERY_LOOP_REASON =
  `Walnut stopped sending this message: it tried ${MAX_TAKES_IN_WINDOW} times in ${TAKE_WINDOW_MS / 1000} seconds `
  + 'and every try ended at once. Retry sends it again.'

const key = (sessionId: string, messageId: string) => `${sessionId}\u0000${messageId}`

export class RedeliveryGuard {
  private takes = new Map<string, number[]>()

  /**
   * Record that these rows were taken for delivery now. Returns the ids taken more
   * than the cap inside the window; their history is cleared, so a Retry after the
   * park starts a fresh count.
   */
  take(sessionId: string, messageIds: readonly string[], now = Date.now()): string[] {
    const over: string[] = []
    for (const id of messageIds) {
      const k = key(sessionId, id)
      const recent = (this.takes.get(k) ?? []).filter((at) => now - at < TAKE_WINDOW_MS)
      recent.push(now)
      if (recent.length > MAX_TAKES_IN_WINDOW) {
        over.push(id)
        this.takes.delete(k)
      } else {
        this.takes.set(k, recent)
      }
    }
    if (this.takes.size > 2_000) this.prune(now)
    return over
  }

  /** How many times a row was taken inside the window (tests, diagnostics). */
  count(sessionId: string, messageId: string, now = Date.now()): number {
    return (this.takes.get(key(sessionId, messageId)) ?? []).filter((at) => now - at < TAKE_WINDOW_MS).length
  }

  clear(): void { this.takes.clear() }

  private prune(now: number): void {
    for (const [k, at] of this.takes) {
      if (at.every((t) => now - t >= TAKE_WINDOW_MS)) this.takes.delete(k)
    }
  }
}

/**
 * Cloud REPLICA: the order a session's phone sends are handed over in.
 *
 * A message the phone was told was taken (2xx) must reach the CLI before any
 * message sent after that answer, whatever path each one takes: the relay to
 * the Mac's queue, the companion's bank, or the host's direct path. The bank
 * keeps its rows in acceptance order (send-queue.ts mints row ids from the
 * time a send reached the companion), and this registry covers the stretch
 * before a send is answered:
 *  - a later send of the session waits for every earlier one to be answered,
 *    up to its own answer deadline, and is held behind an earlier one that is
 *    still out (session-stream-v1.ts);
 *  - the sweep holds a session's rows while a send accepted before them is
 *    still being handed over (send-queue-sweep.ts), so a held row never runs
 *    ahead of a message that is only slow to answer.
 *
 * In memory only: a restart answers nothing in flight, and every row it left
 * in the bank is ordered by its acceptance time.
 */

interface Entry { messageId: string; acceptedAt: number; settled: Promise<void> }

const inFlight = new Map<string, Entry[]>()

export interface SessionSendTurn {
  /** Until every earlier send of the session has been answered, or until `by` (epoch ms). */
  waitForEarlier(by: number): Promise<void>
  /** Is a send of the session accepted before this one still being handed over? */
  earlierInFlight(): boolean
  /** This send has been answered, whatever the answer. Idempotent. */
  leave(): void
}

/** Register a send the moment it reaches the companion. */
export function enterSessionOrder(sessionId: string, messageId: string, acceptedAt: number): SessionSendTurn {
  let settle!: () => void
  const entry: Entry = { messageId, acceptedAt, settled: new Promise<void>((resolve) => { settle = resolve }) }
  const list = inFlight.get(sessionId) ?? []
  // Everything already registered came in first (a tie on the clock included).
  const before = [...list]
  list.push(entry)
  inFlight.set(sessionId, list)
  let left = false
  const live = (e: Entry) => (inFlight.get(sessionId) ?? []).includes(e)
  return {
    async waitForEarlier(by: number): Promise<void> {
      const pending = before.filter(live)
      const ms = by - Date.now()
      if (pending.length === 0 || ms <= 0) return
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        Promise.all(pending.map((e) => e.settled)),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); timer.unref?.() }),
      ])
      if (timer) clearTimeout(timer)
    },
    earlierInFlight: () => before.some(live),
    leave(): void {
      if (left) return
      left = true
      const rest = (inFlight.get(sessionId) ?? []).filter((e) => e !== entry)
      if (rest.length) inFlight.set(sessionId, rest)
      else inFlight.delete(sessionId)
      settle()
    },
  }
}

/** When the earliest send of the session still being handed over reached the companion, or null. */
export function earliestSendInFlight(sessionId: string): number | null {
  const list = inFlight.get(sessionId)
  if (!list?.length) return null
  return Math.min(...list.map((e) => e.acceptedAt))
}

/**
 * Relays the route left running when it answered at its deadline (the send is
 * held): the sweep leaves such a row alone until that relay settles, rather
 * than relaying it a second time beside the first (each would hold the host's
 * pass for up to the relay's own 50 s). Its quick re-drain picks the row up.
 */
const relaysOut = new Set<string>()

export function noteRelayOut(messageId: string, settled: Promise<unknown>): void {
  relaysOut.add(messageId)
  void settled.catch(() => {}).finally(() => { relaysOut.delete(messageId) })
}

export function relayStillOut(messageId: string): boolean {
  return relaysOut.has(messageId)
}

/** Tests: forget every registration. */
export function resetSendOrderForTest(): void {
  inFlight.clear()
  relaysOut.clear()
}

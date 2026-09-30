/**
 * The per-agent turn slot a running turn holds, and the one way to give it up
 * while that turn waits on something that is not the agent's own work.
 *
 * Each console agent runs one turn at a time (web/agent-turn-queue.ts). A lane
 * turn that has to wait for an EARLIER turn on its own lane (a stalled turn whose
 * CLI is still running, core/sessions/lane-turn.ts) used to wait inside its slot,
 * so every other conversation of that agent, on the phone and in the web console,
 * waited too: up to an hour (gate finding N2, 2026-09-30). The waiter now hands
 * the slot back for the length of the wait and takes it again before it sends.
 *
 * Carried in an AsyncLocalStorage so every producer that runs a lane turn inside
 * the queue (chat, the REST turn, triage, the cloud fallback) gets it without
 * threading a parameter through each of them; code outside the queue has no slot
 * and simply waits.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export interface TurnSlot {
  /**
   * Give the slot up while `wait` is pending, then take it back ahead of turns
   * queued in the meantime (this turn was running before they arrived). Resolves
   * or rejects with `wait`, always after the slot is held again. A no-op wrapper
   * when the slot is not held (already released, or the turn has ended).
   */
  releaseWhile<T>(wait: Promise<T>): Promise<T>
}

const current = new AsyncLocalStorage<TurnSlot>()

/** Run `fn` as the holder of `slot` (agent-turn-queue.ts only). */
export function runHoldingTurnSlot<T>(slot: TurnSlot, fn: () => Promise<T>): Promise<T> {
  return current.run(slot, fn)
}

/**
 * Wait for `wait`, without holding the caller's turn slot meanwhile (if it has one).
 *
 * Await it directly from the turn's own flow, and let the turn go on only once it
 * has resolved: the slot is taken back before this promise settles, and that is
 * what keeps the agent to one turn at a time. Never call it from a timer or any
 * callback that can fire while the turn is running elsewhere, and never put it in
 * a Promise.race (or anything else that lets the turn continue first): the turn
 * would then run without its slot while another turn of the agent holds it.
 */
export function releaseTurnSlotWhile<T>(wait: Promise<T>): Promise<T> {
  const slot = current.getStore()
  return slot ? slot.releaseWhile(wait) : wait
}

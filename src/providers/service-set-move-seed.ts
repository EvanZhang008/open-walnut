/**
 * The triggers' memory a service set move still owes the set's daemon (service-set-move.ts `owed`),
 * handed over before a connect's first trigger push there (ServiceSetLink.beforeTriggerPush) and by
 * the move itself after its flip (`carry`). The set's daemon takes a seed only for a trigger it does
 * not hold yet, so no trigger is pushed there while memory is owed.
 *
 * A seed ends in one of three ways: taken (or kept there already), refused for good (a revoked host,
 * a daemon with no seed, a trigger it holds already: logged, and those start afresh there), or not
 * finished (a link cut, a 15 s timeout, a write that failed there). What did not finish stays owed:
 * that connect pushes no trigger, Walnut Health says the triggers wait, and the push asks again after
 * a minute, then less often, and at every connect. A kept copy that cannot be read is never taken as
 * no memory: the link points back at the shared daemon, which still keeps it (pointBack).
 */
import { log } from '../logging/index.js'
import { seedOwed, type MoveDeps } from './service-set-move.js'
import { seedRefusedForGood, seedTriggerMemory, type MoveCheckLink, type TriggerMemory } from './service-set-move-checks.js'
import type { SetLinkConn, SetLinkDeps } from './service-set-move-link.js'

/** A seed that did not finish is asked again after this, doubling up to SEED_RETRY_MAX_MS. */
const SEED_RETRY_FIRST_MS = 60_000
const SEED_RETRY_MAX_MS = 15 * 60_000

export interface SeederDeps {
  c: Pick<SetLinkConn, 'hostKey' | 'connected' | 'helloSet' | 'notice' | 'pushTriggers'>
  seedMemory?: SetLinkDeps['seedMemory']
  checkLink(): MoveCheckLink
  store(): MoveDeps['store']
  now(): number
  noticeKey: string
  /** The kept copy cannot be read: the link goes back to the shared daemon. */
  pointBack(): Promise<void>
}

export class OwedMemorySeeder {
  private timer: ReturnType<typeof setTimeout> | null = null
  private retryMs = 0
  private noticed = false
  private stopped = false

  constructor(private readonly d: SeederDeps) {}

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Hand `memory` to the daemon the link reaches now (the set's); what is still owed comes back. */
  async seed(memory: TriggerMemory[]): Promise<TriggerMemory[]> {
    const host = this.d.c.hostKey
    try {
      const out = await (this.d.seedMemory ?? ((m: TriggerMemory[]) => seedTriggerMemory(this.d.checkLink(), m)))(memory)
      if (out?.refused.length) log.session.warn('service set: the set\'s daemon refused some triggers\' memory; those start afresh there', { host, refused: out.refused })
      return out?.left ?? []
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      if (seedRefusedForGood(err)) {
        log.session.warn('service set: the triggers\' memory cannot reach the set\'s daemon; they start afresh there', { host, error })
        return []
      }
      log.session.warn('service set: the triggers\' memory did not reach the set\'s daemon yet; it is handed over again', { host, error })
      return memory
    }
  }

  /** Before a connect's first trigger push (`live`: the triggers it pushes, null when not known). False: push nothing. */
  async beforePush(live: readonly string[] | null): Promise<boolean> {
    const c = this.d.c
    if (!c.connected || !c.helloSet()) return true
    const owed = await seedOwed({ set: c.helloSet(), store: this.d.store(), now: this.d.now, seed: (m) => this.seed(m), live })
    if (owed === 'retry') { this.later(); return false }
    if (owed === 'lost') { await this.d.pointBack(); return false }
    this.retryMs = 0
    if (owed === 'seeded' && this.noticed) { this.noticed = false; c.notice(this.d.noticeKey, null) }
    return true
  }

  /** No trigger starts on the set without its memory: Walnut Health says so, and the push asks again. */
  private later(): void {
    const c = this.d.c
    this.retryMs = Math.min(Math.max(SEED_RETRY_FIRST_MS, this.retryMs * 2), SEED_RETRY_MAX_MS)
    log.session.warn('service set: the triggers\' memory did not all reach this Walnut\'s own service; its triggers wait for it there', { host: c.hostKey, inMs: this.retryMs })
    if (!this.noticed) {
      this.noticed = true
      c.notice(this.d.noticeKey, `This Walnut's triggers on ${c.hostKey} wait to start on its own service there: what they have already reported did not all reach it yet. Walnut hands it over again, then starts them.`)
    }
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.stopped && c.connected) c.pushTriggers?.()
    }, this.retryMs)
    this.timer.unref?.()
  }
}

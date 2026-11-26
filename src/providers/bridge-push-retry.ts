/**
 * A bridge.configure push that was refused or failed is tried again soon, on a short backoff,
 * instead of waiting for the 5-minute re-push tick (DaemonConnection.BRIDGE_REPUSH_INTERVAL_MS).
 *
 * Why: a new leader's first push to each host comes before it holds the write permission, so no
 * machine token is minted and the push throws (cloud-bridge-config.ts getBridgeConfigForHost).
 * With only the tick, a host's bridge stood up about five minutes later (2026-11-26 drill: 280 s).
 *
 * One retry waits at a time: a failure while one waits adds nothing, and the retry itself goes
 * through pushBridgeConfig's in-flight guard, so it never stacks with a push out or the tick.
 * After the last delay nothing more is scheduled; the tick carries it from there. A push that
 * went through resets it, and the connection closing clears it.
 */

import { log } from '../logging/index.js'

export const BRIDGE_RETRY_DELAYS_MS: readonly number[] = [10_000, 20_000, 40_000, 80_000]

let delays: readonly number[] = BRIDGE_RETRY_DELAYS_MS

/** Tests only: shorter delays (null: the real ones). */
export function _setBridgeRetryDelaysForTesting(d: readonly number[] | null): void {
  delays = d ?? BRIDGE_RETRY_DELAYS_MS
}

export class BridgePushRetry {
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  /** `host`: the connection's host, read when it logs. */
  constructor(private readonly retry: () => void, private readonly host: () => string = () => '') {}

  /** A push was refused or failed: try again after the next delay, unless one waits already or the delays are spent. */
  failed(): void {
    if (this.timer || this.attempt >= delays.length) return
    const ms = delays[this.attempt++]
    log.session.info('DaemonConnection: bridge config push tried again soon', { host: this.host(), attempt: this.attempt, inMs: ms })
    this.timer = setTimeout(() => {
      this.timer = null
      this.retry()
    }, ms)
    // Never keep the process alive for a bridge retry.
    this.timer.unref?.()
  }

  /** A push went through: nothing waits, and the next failure starts from the first delay. */
  succeeded(): void {
    this.clear()
  }

  /** The connection closed: nothing waits, and the next connection starts afresh. */
  clear(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.attempt = 0
  }

  /** A retry is scheduled. */
  get pending(): boolean {
    return this.timer !== null
  }
}

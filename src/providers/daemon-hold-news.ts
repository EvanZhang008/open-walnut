/**
 * Which daemon-update holds are worth a warning.
 *
 * A held update is asked again on a clock (every minute while work runs), and every ask logs why
 * it still waits. The hold is bounded (daemon-update-behind.ts), so a wait that lasts is the
 * design working, not a fault: said at warn level once, then at info, and again at warn only
 * after HOLD_REWARN_MS of the same hold. 2026-11-12: three host_exec runs on a remote host held
 * its update for over an hour and logged a warning a minute; 2026-11-15: one long host_exec run
 * on the Mac did the same for the local daemon (30 an hour), each raising the log-spike alarm.
 *
 * Every hold's log line in the daemon files goes through `holdLog`
 * (tests/providers/daemon-update-holds-ratchet.test.ts finds a new one that does not).
 */
import { log } from '../logging/index.js'

export const HOLD_REWARN_MS = 30 * 60_000

export class HoldNews {
  /** When each hold of `expected` was last said at warn level. */
  private noted: { expected: string; at: Map<string, number> } | null = null

  /** `rewarnMs`: how long the same hold stays not news (Infinity: once per build). */
  constructor(private readonly rewarnMs: number = HOLD_REWARN_MS) {}

  /**
   * Whether this hold is news: a new build, a new kind of reason (counts set aside, so
   * "3 host_exec runs" and "2 host_exec runs" are one hold), or the same hold still going after
   * `rewarnMs`. Holds that alternate are each news once.
   */
  isNews(expected: string, reason: string, now: number = Date.now()): boolean {
    if (this.noted?.expected !== expected) this.noted = { expected, at: new Map() }
    const kind = reason.replace(/\d+/g, '#')
    const last = this.noted.at.get(kind)
    if (last !== undefined && now - last < this.rewarnMs) return false
    this.noted.at.set(kind, now)
    return true
  }

  /** A hold that ended (no host_exec run left): its next start is news again. */
  forget(reason: RegExp): void {
    for (const kind of [...(this.noted?.at.keys() ?? [])]) if (reason.test(kind)) this.noted!.at.delete(kind)
  }
}

/** Log a hold at warn when it is news, else at info. `reason` is what makes two holds differ. */
export function holdLog(news: HoldNews, expected: string, reason: string, message: string, fields: Record<string, unknown>): void {
  if (news.isNews(expected, reason)) log.session.warn(message, fields)
  else log.session.info(message, fields)
}

/**
 * Claude subscription limits per host (src/core/sessions/subscription-limits.ts).
 *
 *   GET /api/subscription-limits             every host that reported a reading
 *   GET /api/subscription-limits?host=<key>  one host ('__local__' or an alias)
 *
 * Answers `{ hosts: HostLimitFrame[] }`. Nothing here reaches a host: the
 * readings arrive on the session streams and live in memory (loaded once from a
 * small cache file). The read still has a deadline and answers 204 past it, so
 * a slow disk never pins a browser connection. Live updates ride the
 * `host:subscription-limits` WS event.
 */
import { Router } from 'express'
import { log } from '../../logging/index.js'
import { readSubscriptionLimits } from '../../core/sessions/subscription-limits.js'

export const subscriptionLimitsRouter = Router()

export const READ_DEADLINE_MS = 3_000
let deadlineMs = READ_DEADLINE_MS

/** Test seam: a shorter deadline (null restores the default). */
export function _setReadDeadlineForTest(ms: number | null): void {
  deadlineMs = ms ?? READ_DEADLINE_MS
}

subscriptionLimitsRouter.get('/', async (req, res, next) => {
  try {
    const host = typeof req.query.host === 'string' ? req.query.host.trim().slice(0, 200) : ''
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<'deadline'>((resolve) => { timer = setTimeout(() => resolve('deadline'), deadlineMs) })
    const read = readSubscriptionLimits(host || undefined)
    const result = await Promise.race([read, deadline]).finally(() => clearTimeout(timer))
    if (result === 'deadline') {
      log.web.warn('subscription limits read passed its deadline', { host: host || undefined, deadlineMs })
      read.catch(() => {})
      res.status(204).end()
      return
    }
    res.json({ hosts: result })
  } catch (err) {
    next(err)
  }
})

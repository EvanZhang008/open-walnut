/**
 * What each session costs its machine (src/core/sessions/session-resources.ts).
 *
 *   GET /api/resources                 every connected host's last frame
 *   GET /api/resources?fresh=1         sample now (a read younger than 1.5s is reused)
 *   GET /api/resources?host=<key>      one host ('__local__' or an alias)
 *   GET /api/resources?history=1       attach each session's recent points
 *   GET /api/resources?watch=1         someone is watching: tick fast for a minute
 *
 * `watch` is the Machine readout's (it is open); a menu that wants one fresh
 * reading sends only `fresh`, so opening it does not speed up every host. Each
 * host gets READ_DEADLINE_MS, then answers its last frame marked `stale`: a
 * stuck host never pins the request. The live frames arrive as the
 * `session:resources` WS event, so a client that only shows the badge never polls.
 */

import { Router } from 'express'
import { getSessionResourceSampler, READ_DEADLINE_MS } from '../../core/sessions/session-resources.js'

export const resourcesRouter = Router()

function flag(v: unknown): boolean {
  return v === '1' || v === 'true'
}

resourcesRouter.get('/', async (req, res, next) => {
  try {
    const sampler = getSessionResourceSampler()
    if (!sampler) {
      // A replica, vitest, or WALNUT_SESSION_RESOURCES=0: the readout says so instead of hanging.
      res.status(204).end()
      return
    }
    const fresh = flag(req.query.fresh)
    const history = flag(req.query.history)
    const host = typeof req.query.host === 'string' ? req.query.host.trim() : ''
    if (flag(req.query.watch)) sampler.markWatched()
    const opts = { fresh, history, deadlineMs: READ_DEADLINE_MS }
    const hosts = host ? [await sampler.read(host, opts)] : await sampler.readAll(opts)
    res.json({ hosts, watching: sampler.watching() })
  } catch (err) {
    next(err)
  }
})

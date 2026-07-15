/**
 * Bug report route — one-shot, curl-able diagnostic bundle.
 *
 *   GET /api/bug-report?windowMins=30 → 200 text/plain
 *
 * Design notes:
 *  - text/plain (not JSON): the artifact IS pasteable text; it also makes
 *    `curl localhost:3456/api/bug-report` usable when the SPA itself is broken.
 *  - NEVER 500s: the caller is by definition already debugging — a generation
 *    failure still returns 200 with the failure inlined.
 *  - Standard /api auth applies (LAN bypass locally, device token in cloud;
 *    machine tokens are rejected globally by cloudAuthMiddleware). NOT in
 *    CLOUD_EXEMPT_PATHS — the bundle names hosts and credential provenance.
 *  - 5s throttle: generation reads whole log files; don't let a stuck client
 *    hammer it.
 */

import { Router, type Request, type Response } from 'express'
import { buildBugReportText } from '../../core/observability/bug-report.js'
import { getSystemHealth } from '../server.js'
import { log } from '../../logging/index.js'

export const bugReportRouter = Router()

const THROTTLE_MS = 5_000
let lastGeneratedAt = 0

bugReportRouter.get('/', async (req: Request, res: Response) => {
  const now = Date.now()
  if (now - lastGeneratedAt < THROTTLE_MS) {
    res.status(429).json({ error: 'Bug report was just generated — retry in a few seconds' })
    return
  }
  lastGeneratedAt = now

  const windowMins = req.query.windowMins !== undefined
    ? parseInt(String(req.query.windowMins), 10)
    : undefined

  let text: string
  try {
    text = await buildBugReportText({ windowMins, systemHealth: getSystemHealth() })
  } catch (err) {
    // buildBugReportText never throws by contract; this is a belt-and-braces
    // guard so even a contract violation still hands the user SOMETHING.
    const msg = err instanceof Error ? err.message : String(err)
    text = `WALNUT DIAGNOSTIC BUNDLE (server)\n(generation failed: ${msg})`
  }

  log.web.info('bug report generated', {
    bytes: Buffer.byteLength(text, 'utf-8'),
    windowMins: windowMins ?? 30,
    reqId: req.reqId,
  })
  res.status(200).type('text/plain; charset=utf-8').send(text)
})

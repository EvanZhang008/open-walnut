/**
 * /api/devices/tailscale: the guided "Reach Walnut from anywhere" card in
 * Settings, Phones & Cloud. Primary only (a cloud companion has nothing to
 * install and no tailnet of its own): 404 there.
 *
 *   GET  /            this Mac on the tailnet, its peers and the install job
 *                     (`?refresh=1` asks the CLI again, at most every 3s)
 *   POST /install     brew install --cask tailscale-app (core/tailscale-install.ts)
 *   POST /open        open -a Tailscale, so the sign-in window appears
 *
 * Auth is the global /api middleware: the loopback console, or a device token.
 * The two POSTs go further: only the console on this machine may run an
 * installer or open an app here, never a paired phone's token (a phone that
 * wants Tailscale is told to set it up on the Mac), nor a loopback self-call
 * this server makes for a caller off this Mac (a remote host session's `api`
 * op, a plugin running for a phone), which says so in x-walnut-origin and is
 * refused like that caller (request-origin.ts). Every handler is bounded:
 * the CLI probe has a 3s deadline, the install runs in the background and is
 * only read here.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { tailscaleDetail } from '../../core/tailnet.js'
import { openTailscaleApp, startTailscaleInstall, tailscaleInstallState } from '../../core/tailscale-install.js'
import { log } from '../../logging/index.js'
import { requestOrigin } from '../middleware/request-origin.js'
import { isLocalOrigin } from '../../lib/caller-origin.js'

export const devicesTailscaleRouter = Router()

const OWN_ROUTES = new Set(['GET /', 'POST /install', 'POST /open'])

/** A request this machine trusts (local-trust.ts) that also acts for a caller on this Mac. */
function requireLocalConsole(req: Request, res: Response, next: NextFunction): void {
  if (isLocalOrigin(requestOrigin(req))) {
    next()
    return
  }
  res.status(403).json({ error: 'Only the Walnut console on this machine can install or open Tailscale.' })
}

devicesTailscaleRouter.use((req: Request, res: Response, next: NextFunction) => {
  if (!CLOUD_MODE) return next()
  // Only this router's own three answers are refused; anything else under the
  // path (a device that happens to be named "tailscale") goes on to devicesRouter.
  if (OWN_ROUTES.has(`${req.method} ${req.path}`)) {
    res.status(404).json({ error: 'Not found' })
    return
  }
  next('router')
})

// GET → { installed, running, dnsName?, address?, loginUrl?, peers: [{ hostName, os, online }],
//         install: { brew, macOS, job: null | { state, startedAt, log, error? } } }
devicesTailscaleRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const [detail, install] = await Promise.all([
      tailscaleDetail({ refresh: req.query.refresh === '1' }),
      tailscaleInstallState(),
    ])
    res.json({ ...detail, install })
  } catch (err) {
    next(err)
  }
})

// POST /install → 202 { job } | 400 (no Homebrew, already installed, not macOS) | 403 (not the local console) | 409 (one runs)
devicesTailscaleRouter.post('/install', requireLocalConsole, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const started = await startTailscaleInstall()
    if (!started.ok) {
      res.status(started.status).json({ error: started.error })
      return
    }
    log.web.info('devices: tailscale install started via console')
    res.status(202).json({ job: started.job })
  } catch (err) {
    next(err)
  }
})

// POST /open → { opened: true } | 403 (not the local console) | 501 off macOS | 500 when `open` fails
devicesTailscaleRouter.post('/open', requireLocalConsole, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const opened = await openTailscaleApp()
    if (!opened.ok) {
      res.status(opened.status).json({ error: opened.error })
      return
    }
    res.json({ opened: true })
  } catch (err) {
    next(err)
  }
})

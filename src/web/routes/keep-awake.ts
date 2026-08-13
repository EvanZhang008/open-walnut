/**
 * Keep-Awake routes — live status for the settings UI.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { getKeepAwakeState, pollKeepAwakeOnce, getSudoSetupCommand, listHotspotCandidates } from '../../core/keep-awake.js'

export const keepAwakeRouter = Router()

// GET /api/keep-awake — current monitor state (cheap, no side effects)
keepAwakeRouter.get('/', (_req: Request, res: Response) => {
  res.json({ state: getKeepAwakeState(), sudoSetupCommand: getSudoSetupCommand() })
})

// POST /api/keep-awake/poll — force an immediate re-evaluation (after a
// settings change, so the toggle takes effect without waiting out the minute).
keepAwakeRouter.post('/poll', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const state = await pollKeepAwakeOnce()
    res.json({ state, sudoSetupCommand: getSudoSetupCommand() })
  } catch (err) {
    next(err)
  }
})

// GET /api/keep-awake/hotspot-candidates — the Mac's saved Wi-Fi networks,
// hotspot-looking names first, so the settings UI can offer a picker instead
// of making the user type an SSID with special characters by hand.
keepAwakeRouter.get('/hotspot-candidates', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ candidates: await listHotspotCandidates() })
  } catch (err) {
    next(err)
  }
})

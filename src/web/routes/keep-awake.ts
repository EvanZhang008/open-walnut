/**
 * Keep-Awake routes — live status for the settings UI.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { getKeepAwakeState, pollKeepAwakeOnce, getSudoSetupCommand, listHotspotCandidates, runSudoSetup, checkSudoSetup } from '../../core/keep-awake.js'

export const keepAwakeRouter = Router()

// GET /api/keep-awake — current monitor state. Refreshes the sudoers-installed
// probe inline (sudo -n -l: local, ~ms, prompts nothing) so the settings badge
// is truthful on first page load, before any poll has run.
keepAwakeRouter.get('/', async (_req: Request, res: Response) => {
  const setupDone = await checkSudoSetup().catch(() => false)
  res.json({ state: { ...getKeepAwakeState(), setupDone, needsSudo: !setupDone }, sudoSetupCommand: getSudoSetupCommand() })
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

// POST /api/keep-awake/setup — one-click sudoers install via the NATIVE macOS
// password dialog (osascript administrator privileges). On success, re-polls
// so a pending hold engages and the UI flips green immediately.
keepAwakeRouter.post('/setup', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await runSudoSetup()
    const state = result.ok ? await pollKeepAwakeOnce() : getKeepAwakeState()
    res.json({ ...result, state })
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

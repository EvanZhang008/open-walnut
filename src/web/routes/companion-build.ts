/**
 * /api/cloud/companion-build: whether the cloud companion runs this Mac's build
 * (docs/plan/walnut-companion-unified-replica.md, stage 1; core/companion-build/mac.ts).
 *
 *   GET  /        → CompanionBuildView
 *   POST /retry   look again now, a build this Mac gave up on included → CompanionBuildView
 *   PUT  /        { auto_update: boolean } → CompanionBuildView
 *
 * Reading is for any caller the auth middleware let in. Changing it installs a
 * build on the companion, so it is for the person at this machine
 * (routes/expose.ts isPersonAtThisMachine). Mounted on the leader only.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { getConfig, updateConfig } from '../../core/config-manager.js'
import { bus, EventNames } from '../../core/event-bus.js'
import {
  companionAutoUpdateChanged, refreshCompanionBuildView, retryCompanionBuild, companionBuildView,
} from '../../core/companion-build/mac.js'
import { log } from '../../logging/index.js'
import { isPersonAtThisMachine } from './expose.js'

export const companionBuildRouter = Router()

function refuse(res: Response): void {
  res.status(403).json({ error: 'Only you, at this computer, can change how the cloud companion is updated (Settings, Cloud Companion).', code: 'person_at_this_machine' })
}

companionBuildRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await refreshCompanionBuildView())
  } catch (err) {
    next(err)
  }
})

companionBuildRouter.post('/retry', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isPersonAtThisMachine(req)) return refuse(res)
    await retryCompanionBuild()
    res.json(companionBuildView())
  } catch (err) {
    next(err)
  }
})

companionBuildRouter.put('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isPersonAtThisMachine(req)) return refuse(res)
    const on = (req.body as { auto_update?: unknown } | undefined)?.auto_update
    if (typeof on !== 'boolean') {
      res.status(400).json({ error: 'auto_update is true or false' })
      return
    }
    const before = (await getConfig()).cloud_bridge ?? {}
    await updateConfig({ cloud_bridge: { ...before, auto_update: on } })
    // A narrow notice (a key, no config): every open Settings reads config again on it.
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'cloud_bridge' }, ['web-ui'], { source: 'api' })
    log.web.info('companion build setting changed', { auto_update: on })
    res.json(companionAutoUpdateChanged(on))
  } catch (err) {
    next(err)
  }
})

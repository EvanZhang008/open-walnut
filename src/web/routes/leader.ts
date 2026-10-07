/**
 * GET /api/leader: who leads this Walnut's hosts right now
 * (docs/plan/walnut-control-plane.md). Read-only, both boxes.
 *  - primary: per host, the lead it saw or took back on its last connect, and
 *    whether the companion may lead while this box is away;
 *  - companion: the hosts it leads now, when it last heard the primary, and
 *    its last decision.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'

export const leaderRouter = Router()

leaderRouter.get('/leader', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (CLOUD_MODE) {
      const { getBackupLeader } = await import('../../core/leader/backup-leader.js')
      const leader = await getBackupLeader()
      res.json({ role: 'backup', ...(leader ? leader.status() : {}) })
      return
    }
    const { backupLeaderAllowed, hostLeaderStates } = await import('../../core/leader/primary-leader.js')
    res.json({ role: 'primary', backupAllowed: await backupLeaderAllowed(), hosts: hostLeaderStates() })
  } catch (err) {
    next(err)
  }
})

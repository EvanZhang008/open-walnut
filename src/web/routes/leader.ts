/**
 * GET /api/leader: who leads this Walnut's hosts right now
 * (docs/plan/walnut-control-plane.md). Read-only, both boxes.
 *  - primary: per host, the lead it saw or took back on its last connect, and
 *    whether the companion may lead while this box is away;
 *  - a replica: whether its leader answers (`leader`), and with the backup-leader
 *    capability (the companion) the hosts it leads now, when it last heard the
 *    primary, and its last decision. The companion keeps `role: 'backup'` (what
 *    older readers know it by); a host replica says `role: 'replica'`, though its
 *    route table sends this read to the Mac, or answers needs_leader while it is away.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { isCompanion, isFollower, leaderPresence } from '../../core/server-role.js'

export const leaderRouter = Router()

leaderRouter.get('/leader', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (isFollower()) {
      const { getBackupLeader } = await import('../../core/leader/backup-leader.js')
      const leader = await getBackupLeader()
      // The companion's own forward to the Mac (it goes with slice 5b).
      const { bootPolicy } = await import('../../core/boot-policy.js')
      const forward = bootPolicy('v1-forward') ? (await import('../v1-forward/proxy.js')).getV1Forward().status() : undefined
      res.json({
        role: isCompanion() ? 'backup' : 'replica',
        leader: leaderPresence(),
        ...(leader ? leader.status() : {}),
        ...(forward ? { forward } : {}),
      })
      return
    }
    const { backupLeaderAllowed, hostLeaderStates } = await import('../../core/leader/primary-leader.js')
    res.json({ role: 'primary', backupAllowed: await backupLeaderAllowed(), hosts: hostLeaderStates() })
  } catch (err) {
    next(err)
  }
})

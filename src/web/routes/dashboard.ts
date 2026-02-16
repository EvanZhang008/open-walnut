/**
 * Dashboard route — aggregates stats, grouped tasks, and recent sessions.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { getDashboardData } from '../../core/task-manager.js'
import { getRecentSessions } from '../../core/session-tracker.js'

export const dashboardRouter = Router()

// GET /api/dashboard
dashboardRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await getDashboardData()
    const recentSessions = await getRecentSessions(5)

    res.json({
      ...data,
      recent_sessions: recentSessions,
    })
  } catch (err) {
    next(err)
  }
})

/**
 * Ordering routes — the project display order (single grouping layer), stored
 * flat in config as `ordering.projects: string[]`.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { getConfig, updateConfig } from '../../core/config-manager.js'
import { bus, EventNames } from '../../core/event-bus.js'

export const orderingRouter = Router()

// GET /api/ordering
orderingRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await getConfig()
    res.json({ projects: config.ordering?.projects ?? [] })
  } catch (err) {
    next(err)
  }
})

// PUT /api/ordering/projects — replace the flat project order
orderingRouter.put('/projects', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { order } = req.body as { order: string[] }
    if (!Array.isArray(order) || !order.every((p) => typeof p === 'string')) {
      res.status(400).json({ error: 'order must be an array of strings' })
      return
    }
    const config = await getConfig()
    if (!config.ordering) config.ordering = {}
    config.ordering.projects = order
    await updateConfig({ ordering: config.ordering })
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'ordering' }, ['web-ui'])
    res.json({ projects: config.ordering.projects })
  } catch (err) {
    next(err)
  }
})

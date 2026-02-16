/**
 * Ordering routes — manage category/project display order via config.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { getConfig, saveConfig } from '../../core/config-manager.js'
import { bus, EventNames } from '../../core/event-bus.js'

export const orderingRouter = Router()

// GET /api/ordering
orderingRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await getConfig()
    res.json({
      categories: config.ordering?.categories ?? [],
      projects: config.ordering?.projects ?? {},
    })
  } catch (err) {
    next(err)
  }
})

// PUT /api/ordering/categories — replace category order
orderingRouter.put('/categories', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { order } = req.body as { order: string[] }
    if (!Array.isArray(order)) {
      res.status(400).json({ error: 'order must be an array of strings' })
      return
    }
    const config = await getConfig()
    if (!config.ordering) config.ordering = {}
    config.ordering.categories = order
    await saveConfig(config)
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'ordering' }, ['web-ui'])
    res.json({ categories: config.ordering.categories })
  } catch (err) {
    next(err)
  }
})

// PUT /api/ordering/projects/:category — replace project order within a category
orderingRouter.put('/projects/:category', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const category = decodeURIComponent(req.params.category as string)
    const { order } = req.body as { order: string[] }
    if (!Array.isArray(order)) {
      res.status(400).json({ error: 'order must be an array of strings' })
      return
    }
    const config = await getConfig()
    if (!config.ordering) config.ordering = {}
    if (!config.ordering.projects) config.ordering.projects = {}
    config.ordering.projects[category] = order
    await saveConfig(config)
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'ordering' }, ['web-ui'])
    res.json({ projects: config.ordering.projects })
  } catch (err) {
    next(err)
  }
})

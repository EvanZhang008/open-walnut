/**
 * Config routes — read/write application configuration.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { getConfig, updateConfig } from '../../core/config-manager.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { VALID_PRIORITIES } from '../../core/types.js'

export const configRouter = Router()

// GET /api/config
configRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await getConfig()
    res.json({ config })
  } catch (err) {
    next(err)
  }
})

// PUT /api/config
configRouter.put('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body

    if (body.version !== undefined && body.version !== 1) {
      res.status(400).json({ error: 'version must be 1' })
      return
    }
    if (body.defaults !== undefined) {
      if (typeof body.defaults !== 'object' || body.defaults === null) {
        res.status(400).json({ error: 'defaults must be an object' })
        return
      }
      if (body.defaults.priority !== undefined && !VALID_PRIORITIES.includes(body.defaults.priority)) {
        res.status(400).json({ error: `defaults.priority must be one of: ${VALID_PRIORITIES.join(', ')}` })
        return
      }
    }

    await updateConfig(body)
    // Re-read merged config so the event carries the full picture
    const merged = await getConfig()
    bus.emit(EventNames.CONFIG_CHANGED, { config: merged }, ['web-ui', 'main-agent', 'heartbeat-config'], { source: 'api' })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

/**
 * Focus Bar routes — manage pinned tasks via config (max 3).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { getConfig, saveConfig } from '../../core/config-manager.js'
import { bus, EventNames } from '../../core/event-bus.js'

const MAX_PINNED = 3

export const focusRouter = Router()

// GET /api/focus/tasks — list pinned task IDs
focusRouter.get('/tasks', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await getConfig()
    res.json({ pinned_tasks: config.focus_bar?.pinned_tasks ?? [] })
  } catch (err) {
    next(err)
  }
})

// POST /api/focus/tasks/:id — pin a task (max 3)
focusRouter.post('/tasks/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const taskId = req.params.id as string
    const config = await getConfig()
    if (!config.focus_bar) config.focus_bar = {}
    if (!config.focus_bar.pinned_tasks) config.focus_bar.pinned_tasks = []

    // Already pinned — no-op
    if (config.focus_bar.pinned_tasks.includes(taskId)) {
      res.json({ pinned_tasks: config.focus_bar.pinned_tasks })
      return
    }

    // Max 3 guard
    if (config.focus_bar.pinned_tasks.length >= MAX_PINNED) {
      res.status(400).json({ error: `Maximum ${MAX_PINNED} pinned tasks allowed. Unpin one first.` })
      return
    }

    config.focus_bar.pinned_tasks.push(taskId)
    await saveConfig(config)
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'focus_bar' }, ['web-ui'])
    res.json({ pinned_tasks: config.focus_bar.pinned_tasks })
  } catch (err) {
    next(err)
  }
})

// DELETE /api/focus/tasks/:id — unpin a task
focusRouter.delete('/tasks/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const taskId = req.params.id as string
    const config = await getConfig()
    if (!config.focus_bar) config.focus_bar = {}
    config.focus_bar.pinned_tasks = (config.focus_bar.pinned_tasks ?? []).filter((id) => id !== taskId)
    await saveConfig(config)
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'focus_bar' }, ['web-ui'])
    res.json({ pinned_tasks: config.focus_bar.pinned_tasks })
  } catch (err) {
    next(err)
  }
})

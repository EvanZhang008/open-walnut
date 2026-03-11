/**
 * Focus Bar routes — manage pinned tasks via task-level fields.
 *
 * Pin state lives on each Task object (pinned + pin_order fields),
 * similar to starred. On first request, auto-migrates legacy pin data
 * from config.yaml focus_bar.pinned_tasks to task fields.
 *
 * Users can pin any number of tasks. The Focus Dock UI shows only the first 3;
 * the Todo Sidebar pinned section shows all.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { getConfig, updateConfig } from '../../core/config-manager.js'
import { togglePin, reorderPins, getPinnedTasks } from '../../core/task-manager.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { log } from '../../logging/index.js'

// ── One-time migration from config.yaml → task fields ──

let migrated = false

async function ensureMigrated(): Promise<void> {
  if (migrated) return
  migrated = true
  try {
    const config = await getConfig()
    // Check for legacy config-based pin list
    const legacyIds = config.focus_bar?.pinned_tasks
    if (!legacyIds || legacyIds.length === 0) {
      // Also check very old location under plugins.focus-bar
      const pluginIds = (config.plugins as Record<string, Record<string, unknown>> | undefined)
        ?.['focus-bar']?.pinned_tasks as string[] | undefined
      if (pluginIds && pluginIds.length > 0) {
        // Migrate from plugins location
        for (let i = 0; i < pluginIds.length; i++) {
          try { await togglePin(pluginIds[i]) } catch { /* task may not exist */ }
        }
        log.web.info(`Migrated ${pluginIds.length} pinned tasks from plugins.focus-bar to task fields`)
      }
      return
    }
    // Check if tasks already have pin data (idempotent)
    const existing = await getPinnedTasks()
    if (existing.length > 0) {
      // Already migrated — just clear config
      await updateConfig({ focus_bar: { pinned_tasks: undefined as unknown as string[] } })
      return
    }
    // Migrate: pin each task in order
    for (let i = 0; i < legacyIds.length; i++) {
      try { await togglePin(legacyIds[i]) } catch { /* task may have been deleted */ }
    }
    // Clear the config key
    await updateConfig({ focus_bar: { pinned_tasks: undefined as unknown as string[] } })
    log.web.info(`Migrated ${legacyIds.length} pinned tasks from config.yaml to task fields`)
  } catch (err) {
    log.web.warn('Focus bar migration failed (will retry next request)', err)
    migrated = false // retry next time
  }
}

export const focusRouter = Router()

// GET /api/focus/tasks — list pinned task IDs (sorted by pin_order)
focusRouter.get('/tasks', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureMigrated()
    const pinned = await getPinnedTasks()
    res.json({ pinned_tasks: pinned.map((t) => t.id) })
  } catch (err) {
    next(err)
  }
})

// POST /api/focus/tasks/:id — pin a task
focusRouter.post('/tasks/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureMigrated()
    const taskId = req.params.id as string
    // Check if already pinned
    const current = await getPinnedTasks()
    if (current.some((t) => t.id === taskId)) {
      res.json({ pinned_tasks: current.map((t) => t.id) })
      return
    }
    const result = await togglePin(taskId)
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'focus_bar' }, ['web-ui'])
    res.json({ pinned_tasks: result.pinned_tasks })
  } catch (err) {
    next(err)
  }
})

// DELETE /api/focus/tasks/:id — unpin a task
focusRouter.delete('/tasks/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureMigrated()
    const taskId = req.params.id as string
    // Check if actually pinned
    const current = await getPinnedTasks()
    if (!current.some((t) => t.id === taskId)) {
      res.json({ pinned_tasks: current.map((t) => t.id) })
      return
    }
    const result = await togglePin(taskId)
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'focus_bar' }, ['web-ui'])
    res.json({ pinned_tasks: result.pinned_tasks })
  } catch (err) {
    next(err)
  }
})

// PUT /api/focus/reorder — reorder pinned tasks
focusRouter.put('/reorder', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureMigrated()
    const { task_ids } = req.body as { task_ids: string[] }
    if (!Array.isArray(task_ids)) {
      res.status(400).json({ error: 'task_ids must be an array of strings' })
      return
    }
    const ordered = await reorderPins(task_ids)
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'focus_bar' }, ['web-ui'])
    res.json({ pinned_tasks: ordered })
  } catch (err) {
    next(err)
  }
})

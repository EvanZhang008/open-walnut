/**
 * Focus Bar routes — manage pinned tasks via config (max 3).
 *
 * Uses updateConfig() (partial merge) instead of saveConfig() (full replacement)
 * so that concurrent config writes from other routes never drop focus_bar data.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { getConfig, updateConfig } from '../../core/config-manager.js'
import { bus, EventNames } from '../../core/event-bus.js'

const MAX_PINNED = 3

/** Read current pinned IDs, falling back to legacy plugins.focus-bar location. */
async function readPinnedIds(): Promise<string[]> {
  const config = await getConfig()
  const ids = config.focus_bar?.pinned_tasks
  // If focus_bar.pinned_tasks exists (even empty []), it's authoritative — don't fall back
  if (ids !== undefined) return ids
  // One-time legacy migration: old data lived under plugins.focus-bar
  const legacy = (config.plugins as Record<string, Record<string, unknown>> | undefined)
    ?.['focus-bar']?.pinned_tasks as string[] | undefined
  if (legacy && legacy.length > 0) {
    await writePinnedIds(legacy).catch(() => {})
    return legacy
  }
  return []
}

/** Persist pinned IDs via partial config merge (race-safe for other keys). */
async function writePinnedIds(ids: string[]): Promise<void> {
  await updateConfig({ focus_bar: { pinned_tasks: ids } })
}

export const focusRouter = Router()

// GET /api/focus/tasks — list pinned task IDs
focusRouter.get('/tasks', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ pinned_tasks: await readPinnedIds() })
  } catch (err) {
    next(err)
  }
})

// POST /api/focus/tasks/:id — pin a task (max 3)
focusRouter.post('/tasks/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const taskId = req.params.id as string
    const current = await readPinnedIds()

    // Already pinned — no-op
    if (current.includes(taskId)) {
      res.json({ pinned_tasks: current })
      return
    }

    // Max 3 guard
    if (current.length >= MAX_PINNED) {
      res.status(400).json({ error: `Maximum ${MAX_PINNED} pinned tasks allowed. Unpin one first.` })
      return
    }

    const updated = [...current, taskId]
    await writePinnedIds(updated)
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'focus_bar' }, ['web-ui'])
    res.json({ pinned_tasks: updated })
  } catch (err) {
    next(err)
  }
})

// DELETE /api/focus/tasks/:id — unpin a task
focusRouter.delete('/tasks/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const taskId = req.params.id as string
    const current = await readPinnedIds()
    const updated = current.filter((id) => id !== taskId)
    await writePinnedIds(updated)
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'focus_bar' }, ['web-ui'])
    res.json({ pinned_tasks: updated })
  } catch (err) {
    next(err)
  }
})

/**
 * Focus Bar routes — manage pinned tasks via task-level fields.
 *
 * Pin state lives on each Task object (pinned + pin_order + focus_tier fields).
 * Built-in tiers: focus (current sprint), satellite (needs doing soon; the
 * default), backlog (someday), wait (parked).
 * Users can add custom tiers (ct_* ids) via the /tiers routes below.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import {
  togglePin, reorderPins, getPinnedTasks, setFocusTier, getTierSplit,
  getCustomTiers, createCustomTier, renameCustomTier, deleteCustomTier,
} from '../../core/task-manager.js'
import { bus, EventNames } from '../../core/event-bus.js'

export const focusRouter = Router()

// GET /api/focus/tasks — list pinned task IDs with tier split (built-ins + customs).
// Single source of the four-bucket split: task-manager's splitTiers via getTierSplit.
focusRouter.get('/tasks', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await getTierSplit())
  } catch (err) {
    next(err)
  }
})

// POST /api/focus/tasks/:id — pin a task
focusRouter.post('/tasks/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const taskId = req.params.id as string
    const current = await getPinnedTasks()
    if (current.some((t) => t.id === taskId)) {
      res.json({ pinned_tasks: current.map((t) => t.id) })
      return
    }
    const result = await togglePin(taskId)
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'focus_bar' }, ['web-ui'])
    res.json({ pinned_tasks: result.pinned_tasks })
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Cannot pin a completed task')) {
      res.status(409).json({ error: err.message })
      return
    }
    next(err)
  }
})

// DELETE /api/focus/tasks/:id — unpin a task
focusRouter.delete('/tasks/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const taskId = req.params.id as string
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
    const { task_ids } = req.body as { task_ids: string[] }
    if (!Array.isArray(task_ids)) {
      res.status(400).json({ error: 'task_ids must be an array of strings' })
      return
    }
    // Return the FULL tier snapshot (pinned + all built-in and custom buckets). A pinned-only
    // payload made the client's applyFocusData() treat focus/wait as empty and wipe
    // every task's tier to satellite — Focus tasks vanished until refetch.
    const result = await reorderPins(task_ids)
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'focus_bar' }, ['web-ui'])
    // pins:true marks a focus-bar order op — on a REPLICA the outbox subscriber
    // relays it to the primary as a 'reorder-pins' op (reorderPins itself is
    // emit-silent, so this is the one interception point).
    bus.emit(EventNames.TASK_REORDERED, { pins: true, taskIds: task_ids }, ['web-ui'], { source: 'api' })
    res.json(result)
  } catch (err) {
    next(err)
  }
})

const BUILTIN_TIERS = ['focus', 'satellite', 'backlog', 'wait']

// PUT /api/focus/tasks/:id/tier — set tier (built-in or registered custom id)
focusRouter.put('/tasks/:id/tier', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const taskId = req.params.id as string
    const { tier } = req.body as { tier: string }
    const customIds = (await getCustomTiers()).map((t) => t.id)
    if (!BUILTIN_TIERS.includes(tier) && !customIds.includes(tier)) {
      res.status(400).json({ error: `tier must be one of: ${[...BUILTIN_TIERS, ...customIds].join(', ')}` })
      return
    }
    const result = await setFocusTier(taskId, tier)
    res.json(result)
  } catch (err) {
    if (err instanceof Error && (err.message.startsWith('Task not found') || err.message.startsWith('Task is not pinned'))) {
      res.status(400).json({ error: err.message })
      return
    }
    next(err)
  }
})

// ── Custom tier registry ──

// GET /api/focus/tiers — list custom tiers (ordered)
focusRouter.get('/tiers', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ tiers: await getCustomTiers() })
  } catch (err) {
    next(err)
  }
})

// POST /api/focus/tiers — create a custom tier
focusRouter.post('/tiers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { label } = req.body as { label?: string }
    const result = await createCustomTier(typeof label === 'string' ? label : '')
    res.json(result)
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Tier label')) {
      res.status(400).json({ error: err.message })
      return
    }
    if (err instanceof Error && err.message.startsWith('Too many custom tiers')) {
      res.status(400).json({ error: err.message })
      return
    }
    next(err)
  }
})

// PUT /api/focus/tiers/:id — rename a custom tier
focusRouter.put('/tiers/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { label } = req.body as { label?: string }
    const result = await renameCustomTier(req.params.id as string, typeof label === 'string' ? label : '')
    res.json(result)
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Tier not found')) {
      res.status(404).json({ error: err.message })
      return
    }
    if (err instanceof Error && err.message.startsWith('Tier label')) {
      res.status(400).json({ error: err.message })
      return
    }
    next(err)
  }
})

// DELETE /api/focus/tiers/:id — delete a custom tier (member tasks → satellite)
focusRouter.delete('/tiers/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Built-ins would otherwise fall through to a misleading 404 "Tier not found".
    if (BUILTIN_TIERS.includes(req.params.id as string)) {
      res.status(400).json({ error: 'Built-in tiers cannot be deleted' })
      return
    }
    const result = await deleteCustomTier(req.params.id as string)
    res.json(result)
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Tier not found')) {
      res.status(404).json({ error: err.message })
      return
    }
    next(err)
  }
})

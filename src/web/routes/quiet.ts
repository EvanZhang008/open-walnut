/**
 * Quiet mode routes: the human's own do-not-disturb toggle.
 *
 *   GET /api/quiet → QuietState
 *   PUT /api/quiet { on: boolean; minutes?: number; allowPermissions?: boolean } → QuietState
 *
 * The human's hold is source `user`; plugins hold their own through
 * `walnut.notifications.quiet`, and turning the toggle off clears only `user`, so
 * a running focus timer keeps its quiet (the state lists every hold that remains).
 * State lives in src/core/quiet/quiet-state.ts.
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { clearQuiet, getQuiet, setQuiet } from '../../core/quiet/quiet-state.js'

export const quietRouter = Router()

/** A week. Longer is almost certainly a units mistake, and "until I turn it off" is `minutes` absent. */
const MAX_MINUTES = 7 * 24 * 60

quietRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await getQuiet())
  } catch (err) {
    next(err)
  }
})

quietRouter.put('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body ?? {}) as { on?: unknown; minutes?: unknown; allowPermissions?: unknown }
    if (typeof body.on !== 'boolean') {
      res.status(400).json({ error: '`on` must be a boolean' })
      return
    }
    if (!body.on) {
      res.json(await clearQuiet('user'))
      return
    }
    if (body.minutes !== undefined
      && (typeof body.minutes !== 'number' || !Number.isFinite(body.minutes) || body.minutes <= 0 || body.minutes > MAX_MINUTES)) {
      res.status(400).json({ error: `\`minutes\` must be a number in (0, ${MAX_MINUTES}]` })
      return
    }
    if (body.allowPermissions !== undefined && typeof body.allowPermissions !== 'boolean') {
      res.status(400).json({ error: '`allowPermissions` must be a boolean' })
      return
    }
    res.json(await setQuiet({
      source: 'user',
      ...(typeof body.minutes === 'number' ? { until: Date.now() + Math.round(body.minutes * 60_000) } : {}),
      ...(typeof body.allowPermissions === 'boolean' ? { allowPermissions: body.allowPermissions } : {}),
    }))
  } catch (err) {
    next(err)
  }
})

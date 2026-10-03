/**
 * Per-turn snapshots of a session's working tree, and the rewind guard.
 *
 *   GET  /api/sessions/:sessionId/turns                       the snapshot list
 *   GET  /api/sessions/:sessionId/turns/:n/diff?path=&against= one file's diff
 *   POST /api/sessions/:sessionId/turns/:n/restore             { paths?, dry_run? }
 *   POST /api/sessions/:sessionId/rewind/guard                 { files }
 *
 * Thin edges over src/core/turn-snapshots/service.ts; the work runs in the
 * session's daemon. Every route answers within its deadline: a host still
 * connecting past a bounded wait answers 503 (list, diff, restore) or
 * `guard: null`, and a daemon that does not answer in time is a 504.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { SessionControlError } from '../../core/sessions/session-controls.js'
import {
  listSessionTurns, sessionTurnDiff, restoreSessionTurn, rewindGuard,
} from '../../core/turn-snapshots/service.js'

export const sessionTurnsRouter = Router()

function sendError(res: Response, err: unknown, next: NextFunction): void {
  if (err instanceof SessionControlError) {
    const extra = err.extra ?? {}
    res.status(err.statusCode).json({ error: err.message, ...extra })
    return
  }
  next(err)
}

function turnNumber(raw: unknown): number | null {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 && n < 1_000_000 ? n : null
}

sessionTurnsRouter.get('/:sessionId/turns', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await listSessionTurns(String(req.params.sessionId)))
  } catch (err) {
    sendError(res, err, next)
  }
})

sessionTurnsRouter.get('/:sessionId/turns/:n/diff', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const n = turnNumber(req.params.n)
    const path = typeof req.query.path === 'string' ? req.query.path : ''
    if (n === null || !path) { res.status(400).json({ error: 'turn number and path are required', code: 'bad_request' }); return }
    const against = req.query.against === 'worktree' ? 'worktree' : 'previous'
    res.json(await sessionTurnDiff(String(req.params.sessionId), n, path, against))
  } catch (err) {
    sendError(res, err, next)
  }
})

sessionTurnsRouter.post('/:sessionId/turns/:n/restore', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const n = turnNumber(req.params.n)
    if (n === null) { res.status(400).json({ error: 'turn number is required', code: 'bad_request' }); return }
    const body = (req.body ?? {}) as { paths?: unknown; dry_run?: unknown }
    const paths = Array.isArray(body.paths) ? body.paths.filter((p): p is string => typeof p === 'string') : undefined
    res.json(await restoreSessionTurn(String(req.params.sessionId), n, {
      ...(paths ? { paths } : {}),
      dryRun: body.dry_run === true,
    }))
  } catch (err) {
    sendError(res, err, next)
  }
})

sessionTurnsRouter.post('/:sessionId/rewind/guard', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body ?? {}) as { files?: unknown }
    res.json(await rewindGuard(String(req.params.sessionId), body.files))
  } catch (err) {
    sendError(res, err, next)
  }
})

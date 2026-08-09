/**
 * /api/v1 routines endpoints (additive, Wave 2) — list/detail/CRUD/toggle/
 * run-now plus the actions/status/executors reads. Semantics are identical to
 * the web routes (src/web/routes/cron.ts) because both call the SAME shared
 * core (src/core/routines/routines-core.ts).
 *
 *   GET    /routines?includeDisabled=true → { jobs }
 *   GET    /routines/actions             → { actions }
 *   GET    /routines/status              → engine status
 *   GET    /routines/executors           → { executors, options }
 *   GET    /routines/:id                 → { job }
 *   POST   /routines                     → 201 { job }
 *   PATCH  /routines/:id                 → { job }
 *   DELETE /routines/:id                 → 204
 *   POST   /routines/:id/toggle          → { job }
 *   POST   /routines/:id/run             → { result }
 *
 * Cloud companion (REPLICA): Class B — the PRIMARY's cron engine is the
 * single writer of cron-jobs.json (a replica-local write would recreate the
 * dual-engine blind-write storm), so EVERY endpoint relays over the bridge
 * via `server.routines.*` actions on the existing `session.control` command.
 * Failure ladder identical to the Wave-1 relays (needs_upgrade /
 * bridge_offline / verbatim error passthrough).
 *
 * The NL draft route (POST /api/routines/draft) is deliberately NOT here —
 * it is an LLM call classified Wave 3.
 *
 * Frozen-contract note: everything here is additive (docs/reference/api-v1.md).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import { relayControlAction, sendV1Error as sendError, v1ErrorCode } from './v1-control-relay.js'

export const routinesV1Router = Router()

/** Placeholder sessionId for the box-level `server.*` relay actions. */
const SERVER_RELAY_SID = '__server__'

/** Routine ids ride relay params and URLs — restrict to the safe id alphabet. */
const RID_RE = /^[A-Za-z0-9_-]+$/

function validRid(req: Request, res: Response): string | null {
  const id = String(req.params.id ?? '')
  if (!RID_RE.test(id)) {
    sendError(res, 400, 'bad_request', 'Invalid routine id')
    return null
  }
  return id
}

/** Local-path runner: map SessionControlError onto the frozen v1 shape. */
async function runLocal(
  res: Response,
  next: NextFunction,
  successStatus: number,
  fn: () => Promise<unknown>,
): Promise<void> {
  const { SessionControlError } = await import('../../core/sessions/session-controls.js')
  try {
    const result = await fn()
    if (successStatus === 204) {
      res.status(204).end()
      return
    }
    res.status(successStatus).json(result)
  } catch (err) {
    if (err instanceof SessionControlError) {
      sendError(res, err.statusCode, v1ErrorCode(err.statusCode), err.message)
      return
    }
    next(err)
  }
}

// GET /api/v1/routines?includeDisabled=true
routinesV1Router.get('/routines', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const includeDisabled = req.query.includeDisabled === 'true'
    if (CLOUD_MODE) {
      await relayControlAction(res, 'server.routines', SERVER_RELAY_SID, { includeDisabled }, 200)
      return
    }
    const { listRoutines } = await import('../../core/routines/routines-core.js')
    await runLocal(res, next, 200, () => listRoutines(includeDisabled))
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/routines/actions — registered action catalog (form dropdowns).
routinesV1Router.get('/routines/actions', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (CLOUD_MODE) {
      await relayControlAction(res, 'server.routines.actions', SERVER_RELAY_SID, undefined, 200)
      return
    }
    const { listRoutineActions } = await import('../../core/routines/routines-core.js')
    await runLocal(res, next, 200, () => listRoutineActions())
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/routines/status — scheduler status.
routinesV1Router.get('/routines/status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (CLOUD_MODE) {
      await relayControlAction(res, 'server.routines.status', SERVER_RELAY_SID, undefined, 200)
      return
    }
    const { getRoutinesStatus } = await import('../../core/routines/routines-core.js')
    await runLocal(res, next, 200, () => getRoutinesStatus())
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/routines/executors — executor definitions + form options.
routinesV1Router.get('/routines/executors', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (CLOUD_MODE) {
      await relayControlAction(res, 'server.routines.executors', SERVER_RELAY_SID, undefined, 200)
      return
    }
    const { listRoutineExecutors } = await import('../../core/routines/routines-core.js')
    await runLocal(res, next, 200, () => listRoutineExecutors())
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/routines/:id — single routine.
routinesV1Router.get('/routines/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = validRid(req, res)
    if (!id) return
    if (CLOUD_MODE) {
      await relayControlAction(res, 'server.routines.get', SERVER_RELAY_SID, { id }, 200)
      return
    }
    const { getRoutine } = await import('../../core/routines/routines-core.js')
    await runLocal(res, next, 200, () => getRoutine(id))
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/routines — create a routine. Body = the same normalized shape
// the web form posts (schedule + payload at minimum).
routinesV1Router.post('/routines', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (CLOUD_MODE) {
      await relayControlAction(res, 'server.routines.create', SERVER_RELAY_SID, { body: req.body ?? {} }, 201)
      return
    }
    const { createRoutine } = await import('../../core/routines/routines-core.js')
    await runLocal(res, next, 201, () => createRoutine(req.body))
  } catch (err) {
    next(err)
  }
})

// PATCH /api/v1/routines/:id — edit a routine.
routinesV1Router.patch('/routines/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = validRid(req, res)
    if (!id) return
    if (CLOUD_MODE) {
      await relayControlAction(res, 'server.routines.patch', SERVER_RELAY_SID, { id, body: req.body ?? {} }, 200)
      return
    }
    const { patchRoutine } = await import('../../core/routines/routines-core.js')
    await runLocal(res, next, 200, () => patchRoutine(id, req.body))
  } catch (err) {
    next(err)
  }
})

// DELETE /api/v1/routines/:id — 204; 404 not_found for an unknown id (unlike
// the tolerant legacy web route, a phone delete should fail loudly).
routinesV1Router.delete('/routines/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = validRid(req, res)
    if (!id) return
    if (CLOUD_MODE) {
      await relayControlAction(res, 'server.routines.delete', SERVER_RELAY_SID, { id }, 200)
      return
    }
    const { deleteRoutine } = await import('../../core/routines/routines-core.js')
    await runLocal(res, next, 204, () => deleteRoutine(id))
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/routines/:id/toggle — enable/disable (high-value mobile action).
routinesV1Router.post('/routines/:id/toggle', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = validRid(req, res)
    if (!id) return
    if (CLOUD_MODE) {
      await relayControlAction(res, 'server.routines.toggle', SERVER_RELAY_SID, { id }, 200)
      return
    }
    const { toggleRoutine } = await import('../../core/routines/routines-core.js')
    await runLocal(res, next, 200, () => toggleRoutine(id))
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/routines/:id/run — run now (forced trigger).
routinesV1Router.post('/routines/:id/run', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = validRid(req, res)
    if (!id) return
    if (CLOUD_MODE) {
      await relayControlAction(res, 'server.routines.run', SERVER_RELAY_SID, { id }, 200)
      return
    }
    const { runRoutineNow } = await import('../../core/routines/routines-core.js')
    await runLocal(res, next, 200, () => runRoutineNow(id))
  } catch (err) {
    next(err)
  }
})

// Router-level error funnel — keeps unexpected failures in the frozen shape.
routinesV1Router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log.web.error('api-v1 routines route error', {
    error: err instanceof Error ? err.message : String(err),
  })
  if (res.headersSent) {
    res.end()
    return
  }
  sendError(res, 500, 'internal', 'Internal server error')
})

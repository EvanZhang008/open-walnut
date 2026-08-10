/**
 * Routine routes — CRUD, control, drafting, and executor discovery.
 *
 * Mounted at BOTH /api/routines (canonical) and /api/cron (back-compat alias).
 * "Routine" is the product name for a scheduled job with an executor; the
 * underlying engine and WS event names (cron:job-*) are unchanged.
 *
 * Thin shell: all list/CRUD/toggle/run/status/executors logic lives in the
 * shared core (src/core/routines/routines-core.ts), reused verbatim by the
 * /api/v1 mobile router and the cloud control relay. Only the NL draft route
 * (LLM call) stays here — it is primary-web-only.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { log } from '../../logging/index.js'
import type { CronService } from '../../core/cron/index.js'
import { SessionControlError } from '../../core/sessions/session-controls.js'
import {
  listRoutines, getRoutine, createRoutine, patchRoutine, deleteRoutine,
  toggleRoutine, runRoutineNow, getRoutinesStatus, listRoutineActions,
  listRoutineExecutors,
} from '../../core/routines/routines-core.js'

// ── Module-level service accessor (for agent tools + the shared core) ──

let _cronService: CronService | null = null

export function setCronService(service: CronService | null): void {
  _cronService = service
}

export function getCronService(): CronService | null {
  return _cronService
}

// ── Router factory ──

/** Map shared-core errors onto this router's legacy `{ error }` shape. */
function handleCoreError(res: Response, next: NextFunction, err: unknown): void {
  if (err instanceof SessionControlError) {
    res.status(err.statusCode).json({ error: err.message })
    return
  }
  next(err)
}

export function createCronRouter(cronServiceArg: CronService): Router {
  // Register the instance so the shared core (and agent tools) resolve the
  // same service this router serves — callers (server.ts, tests) don't have
  // to remember a separate setCronService step.
  setCronService(cronServiceArg)
  const router = Router()

  // GET /api/cron — list jobs
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await listRoutines(req.query.includeDisabled === 'true'))
    } catch (err) {
      handleCoreError(res, next, err)
    }
  })

  // GET /api/cron/actions — list registered actions (for frontend dropdowns)
  router.get('/actions', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await listRoutineActions())
    } catch (err) {
      handleCoreError(res, next, err)
    }
  })

  // GET /api/cron/status — scheduler status
  router.get('/status', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await getRoutinesStatus())
    } catch (err) {
      handleCoreError(res, next, err)
    }
  })

  // GET /api/routines/executors — executor definitions + dynamic form options
  router.get('/executors', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await listRoutineExecutors())
    } catch (err) {
      handleCoreError(res, next, err)
    }
  })

  // POST /api/routines/draft — natural language → populated routine draft
  router.post('/draft', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { draftRoutineFromText } = await import('../../core/routines/routines-core.js')
      res.json(await draftRoutineFromText(req.body?.text))
    } catch (err) {
      if (err instanceof SessionControlError) {
        // Keep the legacy debug field: `raw` (unparseable LLM output) rides extra.
        res.status(err.statusCode).json({ error: err.message, ...(err.extra ?? {}) })
        return
      }
      next(err)
    }
  })

  // GET /api/cron/:id — single job
  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await getRoutine(req.params.id as string))
    } catch (err) {
      handleCoreError(res, next, err)
    }
  })

  // POST /api/cron — create job
  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await createRoutine(req.body)
      res.status(201).json(result)
    } catch (err) {
      handleCoreError(res, next, err)
    }
  })

  // PATCH /api/cron/:id — update job
  router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await patchRoutine(req.params.id as string, req.body))
    } catch (err) {
      handleCoreError(res, next, err)
    }
  })

  // DELETE /api/cron/:id — delete job
  router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      await deleteRoutine(req.params.id as string)
      res.status(204).end()
    } catch (err) {
      // Legacy behavior: DELETE was tolerant of unknown ids (204 either way).
      if (err instanceof SessionControlError && err.statusCode === 404) {
        res.status(204).end()
        return
      }
      handleCoreError(res, next, err)
    }
  })

  // POST /api/cron/:id/toggle — toggle enabled/disabled
  router.post('/:id/toggle', async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await toggleRoutine(req.params.id as string))
    } catch (err) {
      handleCoreError(res, next, err)
    }
  })

  // POST /api/cron/:id/run — manual trigger
  router.post('/:id/run', async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await runRoutineNow(req.params.id as string))
    } catch (err) {
      handleCoreError(res, next, err)
    }
  })

  return router
}

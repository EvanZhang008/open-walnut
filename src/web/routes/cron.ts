/**
 * Routine routes — CRUD, control, drafting, and executor discovery.
 *
 * Mounted at BOTH /api/routines (canonical) and /api/cron (back-compat alias).
 * "Routine" is the product name for a scheduled job with an executor; the
 * underlying engine and WS event names (cron:job-*) are unchanged.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { log } from '../../logging/index.js'
import type { CronService } from '../../core/cron/index.js'
import { normalizeCronJobCreate, normalizeCronJobPatch, listActions } from '../../core/cron/index.js'
import { getConfig } from '../../core/config-manager.js'

// ── Module-level service accessor (for agent tools) ──

let _cronService: CronService | null = null

export function setCronService(service: CronService | null): void {
  _cronService = service
}

export function getCronService(): CronService | null {
  return _cronService
}

// ── Router factory ──

export function createCronRouter(cronService: CronService): Router {
  const router = Router()

  // GET /api/cron — list jobs
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const includeDisabled = req.query.includeDisabled === 'true'
      const jobs = await cronService.list({ includeDisabled })
      res.json({ jobs })
    } catch (err) {
      next(err)
    }
  })

  // GET /api/cron/actions — list registered actions (for frontend dropdowns)
  router.get('/actions', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const actions = await listActions()
      res.json({ actions })
    } catch (err) {
      next(err)
    }
  })

  // GET /api/cron/status — scheduler status
  router.get('/status', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const status = await cronService.status()
      res.json(status)
    } catch (err) {
      next(err)
    }
  })

  // GET /api/routines/executors — executor definitions + dynamic form options
  router.get('/executors', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const { listExecutors } = await import('../../core/routines/index.js')
      const config = await getConfig()
      const hosts = Object.entries(config.hosts ?? {}).map(([alias, def]) => ({
        value: alias,
        label: (def as { label?: string })?.label ?? alias,
      }))
      const { SESSION_MODELS } = await import('../../core/types.js')
      const models = SESSION_MODELS.map((m) => ({ value: m.id, label: m.label }))
      res.json({
        executors: listExecutors().map((e) => ({
          type: e.type,
          label: e.label,
          description: e.description,
          configSchema: e.configSchema,
        })),
        options: { hosts, models },
      })
    } catch (err) {
      next(err)
    }
  })

  // POST /api/routines/draft — natural language → populated routine draft
  router.post('/draft', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const text = typeof req.body?.text === 'string' ? req.body.text : ''
      if (!text.trim()) {
        res.status(400).json({ error: 'text is required' })
        return
      }
      const { draftRoutine } = await import('../../core/routines/draft.js')
      const config = await getConfig()
      const { SESSION_MODELS } = await import('../../core/types.js')
      const result = await draftRoutine(text, {
        hosts: Object.keys(config.hosts ?? {}),
        models: SESSION_MODELS.map((m) => m.id),
      })
      if (!result.ok) {
        log.web.warn('routine draft failed', { error: result.error })
        res.status(422).json({ error: result.error, raw: result.raw })
        return
      }
      res.json({ draft: result.draft })
    } catch (err) {
      next(err)
    }
  })

  // GET /api/cron/:id — single job
  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as string
      const jobs = await cronService.list({ includeDisabled: true })
      const job = jobs.find((j) => j.id === id)
      if (!job) {
        res.status(404).json({ error: `Cron job not found: ${id}` })
        return
      }
      res.json({ job })
    } catch (err) {
      next(err)
    }
  })

  // POST /api/cron — create job
  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = normalizeCronJobCreate(req.body)
      if (!input) {
        res.status(400).json({ error: 'Invalid input. Provide at least schedule and payload.' })
        return
      }
      const job = await cronService.add(input)
      log.web.info('cron job created via REST', { jobId: job.id, name: job.name })
      res.status(201).json({ job })
    } catch (err) {
      next(err)
    }
  })

  // PATCH /api/cron/:id — update job
  router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as string
      const patch = normalizeCronJobPatch(req.body)
      if (!patch) {
        res.status(400).json({ error: 'Invalid patch input.' })
        return
      }
      const job = await cronService.update(id, patch)
      log.web.info('cron job updated via REST', { jobId: id })
      res.json({ job })
    } catch (err) {
      next(err)
    }
  })

  // DELETE /api/cron/:id — delete job
  router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as string
      await cronService.remove(id)
      log.web.info('cron job deleted via REST', { jobId: id })
      res.status(204).end()
    } catch (err) {
      next(err)
    }
  })

  // POST /api/cron/:id/toggle — toggle enabled/disabled
  router.post('/:id/toggle', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as string
      const job = await cronService.toggle(id)
      res.json({ job })
    } catch (err) {
      next(err)
    }
  })

  // POST /api/cron/:id/run — manual trigger
  router.post('/:id/run', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as string
      const result = await cronService.run(id, 'force')
      log.web.info('cron job triggered via REST', { jobId: id })
      res.json({ result })
    } catch (err) {
      next(err)
    }
  })

  return router
}

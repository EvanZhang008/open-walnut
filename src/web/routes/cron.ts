/**
 * Cron job routes — CRUD and control for scheduled jobs.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { log } from '../../logging/index.js'
import type { CronService } from '../../core/cron/index.js'
import { normalizeCronJobCreate, normalizeCronJobPatch, listActions } from '../../core/cron/index.js'

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

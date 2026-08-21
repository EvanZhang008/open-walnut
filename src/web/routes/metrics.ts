/**
 * Metrics HTTP route — read-only view of the in-process metrics registry
 * (src/core/observability/metrics.ts).
 *
 * GET /api/metrics            → every series (lifetime + current window)
 * GET /api/metrics?name=llm.  → prefix filter (e.g. all llm.* series)
 *
 * The registry is process-local: this shows THIS server process only. The
 * durable, restart-surviving record is the per-window `metric` wide log lines
 * in /tmp/open-walnut/ (walnut-logs.sh metrics).
 */

import { Router, type Request, type Response } from 'express'
import { snapshot } from '../../core/observability/metrics.js'

export const metricsRouter = Router()

metricsRouter.get('/', (req: Request, res: Response) => {
  const snap = snapshot()
  const prefix = typeof req.query.name === 'string' ? req.query.name : undefined
  const series = prefix ? snap.series.filter((s) => s.name.startsWith(prefix)) : snap.series
  res.json({
    sinceMs: snap.sinceMs,
    uptimeMs: Date.now() - snap.sinceMs,
    droppedSeries: snap.droppedSeries,
    series,
  })
})

/**
 * GET /api/time/timeline?date= | from=&to=: one serial timeline per day from
 * every timeline source (Walnut attention, Mac apps, sleep, workouts, calendar,
 * places, and any plugin's), with plan-vs-actual per calendar block. See
 * core/time-tracking/timeline/.
 *
 * This Mac only: the answer carries places and health, which never leave it. At
 * most TIMELINE_MAX_DAYS per call; every source runs under its own deadline, so a
 * slow one is reported in `sources[]` instead of holding the connection.
 */

import { Router, type Request, type Response } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import { dayBoundsMs, localDateKey } from '../../core/time-tracking/index.js'
import { shiftDateKey } from '../../core/time-tracking/rollup.js'
import { buildTimeline, TIMELINE_MAX_DAYS } from '../../core/time-tracking/timeline/build.js'
import { registerCoreTimelineSources } from '../../core/time-tracking/timeline/core-sources.js'
import { parseWorkHours, resolveWorkHours, WorkHoursError } from '../../core/time-tracking/work-hours.js'
import { systemTz } from '../../core/health/day-key.js'
import { thisMachineGuard } from '../middleware/health-access.js'

export const TIMELINE_LOCAL_ONLY_MESSAGE = 'The day timeline includes places and health, so it is only available to sessions on this Mac'

export const timeTimelineRouter = Router()

/** The days the user can ask about (the time-tracking window). */
const WINDOW_DAYS = 90

const q = (req: Request, name: string): string | undefined => {
  const v = req.query[name]
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

timeTimelineRouter.get('/timeline', thisMachineGuard('time timeline', TIMELINE_LOCAL_ONLY_MESSAGE), async (req: Request, res: Response) => {
  if (CLOUD_MODE) {
    res.status(501).json({ error: 'not_supported_cloud', message: 'the timeline is built on the primary box only' })
    return
  }
  const today = localDateKey(new Date())
  const date = q(req, 'date')
  let from = q(req, 'from') ?? date ?? today
  let to = q(req, 'to') ?? date ?? (q(req, 'from') ? today : from)
  if (date && (q(req, 'from') || q(req, 'to'))) {
    res.status(400).json({ error: 'bad_request', message: 'use date, or from/to, not both' })
    return
  }
  for (const [name, value] of [['from', from], ['to', to]] as const) {
    if (!dayBoundsMs(value)) {
      res.status(400).json({ error: 'bad_request', message: `${name} must be a real YYYY-MM-DD` })
      return
    }
  }
  if (from > to) {
    res.status(400).json({ error: 'bad_request', message: 'from must not be after to' })
    return
  }
  if (to > today) to = today
  if (from > today) {
    res.status(400).json({ error: 'bad_request', message: 'the range is in the future' })
    return
  }
  if (shiftDateKey(from, TIMELINE_MAX_DAYS - 1) < to) {
    res.status(400).json({ error: 'bad_request', message: `at most ${TIMELINE_MAX_DAYS} days per timeline: split the range` })
    return
  }
  const oldest = shiftDateKey(today, -(WINDOW_DAYS - 1))
  if (from < oldest) from = oldest
  try {
    const { getConfig } = await import('../../core/config-manager.js')
    const config = await getConfig().catch(() => undefined)
    const stored = resolveWorkHours(config?.time?.work_hours)
    let workHours = stored.workHours
    let source: string = stored.source
    const start = q(req, 'work_start')
    const end = q(req, 'work_end')
    if (start || end) {
      workHours = parseWorkHours({ start, end }, stored.workHours)
      source = 'args'
    }
    registerCoreTimelineSources()
    const started = Date.now()
    const answer = await buildTimeline(from, to, { workHours, workHoursSource: source, tz: systemTz() })
    log.web.debug('time timeline served', { days: answer.days.length, sources: answer.sources.length, ms: Date.now() - started })
    res.json({ ...answer, today })
  } catch (err) {
    if (err instanceof WorkHoursError) {
      res.status(400).json({ error: 'bad_request', message: err.message })
      return
    }
    log.web.warn('time timeline failed', { error: err instanceof Error ? err.message : String(err) })
    res.status(500).json({ error: 'internal', message: err instanceof Error ? err.message : String(err) })
  }
})

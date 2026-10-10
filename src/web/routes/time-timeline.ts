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
import { calendarSegments, registerCoreTimelineSources } from '../../core/time-tracking/timeline/core-sources.js'
import { ignoreList, loadMeetingContext, setMeetingAnswer } from '../../core/time-tracking/timeline/meeting-context.js'
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
    const ignore = ignoreList(config?.time?.meetings?.ignore)
    const answer = await buildTimeline(from, to, {
      workHours, workHoursSource: source, tz: systemTz(),
      meetings: (range) => loadMeetingContext(range, calendarSegments, ignore),
    })
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

const MAX_EVENT_ID = 200

// POST /api/time/meetings/attendance { event_id, attended: true | false | null }
// The user's own answer for one meeting occurrence; null clears it. Kept on this Mac.
timeTimelineRouter.post('/meetings/attendance', thisMachineGuard('meeting attendance', TIMELINE_LOCAL_ONLY_MESSAGE), async (req: Request, res: Response) => {
  if (CLOUD_MODE) {
    res.status(501).json({ error: 'not_supported_cloud', message: 'meeting answers are kept on the primary box only' })
    return
  }
  const body = (req.body ?? {}) as { event_id?: unknown; attended?: unknown }
  const eventId = typeof body.event_id === 'string' ? body.event_id.trim() : ''
  if (!eventId || eventId.length > MAX_EVENT_ID) {
    res.status(400).json({ error: 'bad_request', message: 'event_id is the eventId of a meeting in time_timeline' })
    return
  }
  if (body.attended !== true && body.attended !== false && body.attended !== null) {
    res.status(400).json({ error: 'bad_request', message: 'attended must be true, false, or null to clear the answer' })
    return
  }
  try {
    res.json(await setMeetingAnswer(eventId, body.attended))
  } catch (err) {
    log.web.warn('meeting answer failed', { error: err instanceof Error ? err.message : String(err) })
    res.status(500).json({ error: 'internal', message: 'could not save the answer' })
  }
})

// POST /api/time/meetings/ignore { patterns: string[] }  replaces time.meetings.ignore.
timeTimelineRouter.post('/meetings/ignore', async (req: Request, res: Response) => {
  if (CLOUD_MODE) {
    res.status(501).json({ error: 'not_supported_cloud', message: 'settings are changed on the primary box' })
    return
  }
  const raw = (req.body ?? {}) as { patterns?: unknown }
  if (!Array.isArray(raw.patterns) || raw.patterns.some((p) => typeof p !== 'string' || p.length > 120) || raw.patterns.length > 50) {
    res.status(400).json({ error: 'bad_request', message: 'patterns is a list of at most 50 title words or phrases (120 characters each); [] clears it' })
    return
  }
  try {
    const { getConfig, updateConfig } = await import('../../core/config-manager.js')
    const config = await getConfig()
    const time = { ...config.time }
    const patterns = (raw.patterns as string[]).map((p) => p.trim()).filter(Boolean)
    if (patterns.length) time.meetings = { ...time.meetings, ignore: patterns }
    else delete time.meetings
    // updateConfig replaces the whole `time` key, so its siblings ride along.
    await updateConfig({ time })
    res.json({ ignore: patterns })
  } catch (err) {
    log.web.warn('meeting ignore update failed', { error: err instanceof Error ? err.message : String(err) })
    res.status(500).json({ error: 'internal', message: 'could not save the list' })
  }
})

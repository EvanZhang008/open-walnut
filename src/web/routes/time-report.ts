/**
 * Time over a RANGE of days, for an agent answering "where did my time go":
 *
 *   GET  /api/time/report?from=&to=&last_days=&kinds=&include_outside=&group_by=
 *        &work_start=&work_end=&work_days=&top=&merge_gap_min=&long_min=
 *   GET  /api/time/work-hours   the user's work hours (config time.work_hours)
 *   POST /api/time/work-hours   { start?, end?, days?, reset? } sets them
 *
 * Mounted under /api/time by routes/time.ts. The fold is pure
 * (core/time-tracking/report.ts); this route reads the day files one day at a
 * time (every read is async and joins the store's write chain, so a compaction can
 * never be read half-renamed), joins task titles in one query, and answers.
 *
 * Bounded twice: at most MAX_RANGE_DAYS per call (a heavy day is ~1 MB of
 * foreground samples), and a deadline after which the days not read yet are
 * listed in `incompleteDates` with `degraded: true` instead of holding the
 * connection.
 */

import { Router, type Request, type Response } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import {
  dayBoundsMs, localDateKey, outsideDayRecords, readDayRecords, recentDateKeys, TIME_KINDS,
  type TimeKind, type TimeRecord,
} from '../../core/time-tracking/index.js'
import type { OutsideRecord } from '../../core/time-tracking/outside-store.js'
import type { CallInterval } from '../../core/time-tracking/calls.js'
import { readCalls } from '../../core/time-tracking/calls-store.js'
import { walnutHostsFor } from '../../core/time-tracking/walnut-hosts.js'
import { readDetailDay, type DetailLine } from '../../core/time-tracking/detail-store.js'
import {
  buildTimeReport, REPORT_DEFAULTS, REPORT_GROUPS, type ReportGroup, type ReportTaskMeta,
} from '../../core/time-tracking/report.js'
import { shiftDateKey } from '../../core/time-tracking/rollup.js'
import {
  parseWorkHours, resolveWorkHours, workHoursLabel, workHoursToConfig, WorkHoursError, type WorkHours,
} from '../../core/time-tracking/work-hours.js'

export const timeReportRouter = Router()

/** Most days one report reads. */
export const MAX_RANGE_DAYS = 31
/** The store keeps a 90-day window (store.ts HYDRATE_DAYS). */
const WINDOW_DAYS = 90
const DEFAULT_DAYS = 7
/** Past this, the days not read yet are reported as incomplete. */
const REPORT_DEADLINE_MS = 15_000
const MAX_TOP = 100

/** What every report says about how the numbers were measured. Kept short: it rides on every answer. */
export const REPORT_NOTES = [
  'walnutMin = attention leased by real interaction (click, key, scroll, selection) in a Walnut session, triage row, chat or plugin view (kind app): each grants 60 s, a switch banks the old context at the switch; the phone app reports the same way (phoneMin). Seconds another Mac app was frontmost are cut (overlapMin), so no second counts twice.',
  'readingMin = inferred: Walnut frontmost with no click or key, credited to the context used last, at most 15 min after it and only while Walnut stayed frontmost. Counted in attention, never in walnutMin.',
  'agentMin = an agent running on its own. It costs the user no attention and is never part of walnutMin or attention.',
  'outside = the Mac foreground sampler: the frontmost app every ~5 s, idle over 120 s and the lock screen excluded. Walnut\'s own foreground is walnutForegroundMin, a cross-check that is not added.',
  'callMin = a call app (Zoom, Teams, Webex, FaceTime) holding a call on this Mac, from macOS power assertions: a call in progress, not proof of listening. It overlaps screen time; do not add it to attention.',
  'Invisible: the phone\'s other apps, paper, in-person talks, anything away from the Mac.',
]

class ReportArgError extends Error {}

function q(req: Request, name: string): string | undefined {
  const v = req.query[name]
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function csv(raw: string | undefined): string[] | undefined {
  return raw === undefined ? undefined : raw.split(',').map((s) => s.trim()).filter(Boolean)
}

/** A list query parameter: `a,b`, or the same name repeated (`?group_by=a&group_by=b`). */
function listArg(req: Request, name: string): string | undefined {
  const v = req.query[name]
  if (Array.isArray(v)) {
    const joined = v.filter((x): x is string => typeof x === 'string').join(',')
    return joined.trim() ? joined : undefined
  }
  return q(req, name)
}

function intArg(req: Request, name: string, min: number, max: number): number | undefined {
  const raw = q(req, name)
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) throw new ReportArgError(`${name} must be a whole number from ${min} to ${max}`)
  return n
}

function boolArg(req: Request, name: string, fallback: boolean): boolean {
  const raw = q(req, name)
  if (raw === undefined) return fallback
  if (/^(1|true|yes)$/i.test(raw)) return true
  if (/^(0|false|no)$/i.test(raw)) return false
  throw new ReportArgError(`${name} must be true or false`)
}

/** Every date key from `from` to `to`, inclusive. */
function datesBetween(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from; d <= to && out.length <= MAX_RANGE_DAYS; d = shiftDateKey(d, 1)) out.push(d)
  return out
}

function resolveRange(req: Request, today: string): string[] {
  const from = q(req, 'from')
  const to = q(req, 'to')
  const lastDays = intArg(req, 'last_days', 1, MAX_RANGE_DAYS)
  if (from !== undefined && !dayBoundsMs(from)) throw new ReportArgError('from must be a real YYYY-MM-DD')
  if (to !== undefined && !dayBoundsMs(to)) throw new ReportArgError('to must be a real YYYY-MM-DD')
  if (lastDays !== undefined && (from !== undefined || to !== undefined)) throw new ReportArgError('use from/to or last_days, not both')
  let dates: string[]
  if (from === undefined && to === undefined) {
    dates = recentDateKeys(today, lastDays ?? DEFAULT_DAYS)
  } else {
    const end = to ?? (from! > today ? from! : today)
    const start = from ?? shiftDateKey(end, -(DEFAULT_DAYS - 1))
    if (start > end) throw new ReportArgError('from must not be after to')
    dates = datesBetween(start, end)
    if (dates.length > MAX_RANGE_DAYS) throw new ReportArgError(`at most ${MAX_RANGE_DAYS} days per report: split the range`)
  }
  const oldest = shiftDateKey(today, -(WINDOW_DAYS - 1))
  if (dates[0]! < oldest) throw new ReportArgError(`time tracking keeps ${WINDOW_DAYS} days: the oldest date is ${oldest}`)
  if (dates[0]! > today) throw new ReportArgError('the range is in the future')
  return dates.filter((d) => d <= today)
}

function resolveKinds(raw: string | undefined): TimeKind[] {
  const list = csv(raw)
  if (!list || list.length === 0) return [...REPORT_DEFAULTS.kinds]
  const bad = list.filter((k) => !(TIME_KINDS as readonly string[]).includes(k))
  if (bad.length) throw new ReportArgError(`unknown kind(s): ${bad.join(', ')} (use ${TIME_KINDS.join(', ')})`)
  return [...new Set(list)] as TimeKind[]
}

function resolveGroups(raw: string | undefined): ReportGroup[] {
  const list = csv(raw)
  if (!list || list.length === 0) return [...REPORT_DEFAULTS.groupBy]
  // `day` is always answered (the `days` rows), so asking for it is fine.
  const named = list.filter((g) => g !== 'day')
  const bad = named.filter((g) => !(REPORT_GROUPS as readonly string[]).includes(g))
  if (bad.length) throw new ReportArgError(`unknown group(s): ${bad.join(', ')} (use day, ${REPORT_GROUPS.join(', ')})`)
  return [...new Set(named)] as ReportGroup[]
}

async function readConfig(): Promise<import('../../core/types.js').Config | undefined> {
  const { getConfig } = await import('../../core/config-manager.js')
  return getConfig().catch(() => undefined)
}

/** Work hours: the request's override on top of the stored setting. */
function workHoursFor(req: Request, stored: ReturnType<typeof resolveWorkHours>): { wh: WorkHours; source: 'config' | 'default' | 'args' } {
  const start = q(req, 'work_start')
  const end = q(req, 'work_end')
  const days = csv(listArg(req, 'work_days'))
  if (start === undefined && end === undefined && days === undefined) return { wh: stored.workHours, source: stored.source }
  try {
    return { wh: parseWorkHours({ start, end, days }, stored.workHours), source: 'args' }
  } catch (err) {
    throw new ReportArgError(err instanceof Error ? err.message : String(err))
  }
}

async function taskMeta(ids: string[]): Promise<Map<string, ReportTaskMeta>> {
  const out = new Map<string, ReportTaskMeta>()
  if (ids.length === 0) return out
  try {
    const { listTasksByIds } = await import('../../core/task-manager.js')
    for (const t of await listTasksByIds(ids)) {
      out.set(t.id, {
        title: t.title, project: t.project ?? '', phase: t.phase, createdAt: t.created_at,
        ...(t.completed_at ? { completedAt: t.completed_at } : {}),
        ...(t.parent_task_id ? { parentTaskId: t.parent_task_id } : {}),
        ...(t.source && t.source !== 'local' ? { source: t.source } : {}),
      })
    }
  } catch (err) {
    log.web.warn('time report: task join failed', { error: err instanceof Error ? err.message : String(err) })
  }
  return out
}

timeReportRouter.get('/report', async (req: Request, res: Response) => {
  if (CLOUD_MODE) {
    res.status(501).json({ error: 'not_supported_cloud', message: 'time tracking lives on the primary box only' })
    return
  }
  const started = Date.now()
  try {
    const today = localDateKey(new Date())
    const dates = resolveRange(req, today)
    const kinds = resolveKinds(listArg(req, 'kinds'))
    const groupBy = resolveGroups(listArg(req, 'group_by'))
    const includeOutside = boolArg(req, 'include_outside', true)
    const top = intArg(req, 'top', 1, MAX_TOP) ?? REPORT_DEFAULTS.top
    const mergeGapMin = intArg(req, 'merge_gap_min', 1, 120)
    const longMin = intArg(req, 'long_min', 5, 480)
    const config = await readConfig()
    const stored = resolveWorkHours(config?.time?.work_hours)
    const { wh, source } = workHoursFor(req, stored)

    // One day at a time: each read is async, so the loop yields between days and a
    // long range never holds the event loop for more than one day's parse.
    const end = started + REPORT_DEADLINE_MS
    const records = new Map<string, TimeRecord[]>()
    const outside = new Map<string, OutsideRecord[]>()
    const incomplete: string[] = []
    for (const date of dates) {
      if (Date.now() > end) { incomplete.push(date); continue }
      records.set(date, await readDayRecords(date))
      if (includeOutside) outside.set(date, await outsideDayRecords(date))
    }
    // Mac-local extras: calls and the detail file (files, plugin items, sent markers).
    let calls: CallInterval[] | undefined
    const detail = new Map<string, DetailLine[]>()
    if (includeOutside && dates.length) {
      const first = dayBoundsMs(dates[0]!)
      const last = dayBoundsMs(dates[dates.length - 1]!)
      if (first && last && Date.now() <= end) calls = (await readCalls(first.startMs, last.endMs)).calls
      for (const date of dates) {
        if (Date.now() > end) break
        detail.set(date, await readDetailDay(date))
      }
    }
    const ids = new Set<string>()
    for (const recs of records.values()) for (const r of recs) if (r.taskId) ids.add(r.taskId)
    for (const lines of detail.values()) for (const l of lines) if (l.taskId) ids.add(l.taskId)
    const tasks = await taskMeta([...ids])

    const report = buildTimeReport({ records, outside, tasks, ...(calls ? { calls } : {}), ...(includeOutside ? { detail } : {}) }, {
      dates, kinds, workHours: wh, workHoursSource: source, groupBy, top,
      mergeGapMs: (mergeGapMin ?? REPORT_DEFAULTS.mergeGapMs / 60_000) * 60_000,
      longStretchMs: (longMin ?? REPORT_DEFAULTS.longStretchMs / 60_000) * 60_000,
      glanceMs: REPORT_DEFAULTS.glanceMs,
      includeOutside,
      walnutHosts: await walnutHostsFor(config),
    })
    log.web.debug('time report served', { days: dates.length, tasks: ids.size, ms: Date.now() - started })
    res.json({
      ...report,
      today,
      ...(stored.invalid ? { workHoursInvalid: `time.work_hours in the config is invalid (${stored.invalid}); the default was used` } : {}),
      ...(incomplete.length ? { degraded: true, incompleteDates: incomplete } : {}),
      notes: REPORT_NOTES,
    })
  } catch (err) {
    if (err instanceof ReportArgError) {
      res.status(400).json({ error: 'bad_request', message: err.message })
      return
    }
    log.web.warn('time report failed', { error: err instanceof Error ? err.message : String(err) })
    res.status(500).json({ error: 'internal', message: err instanceof Error ? err.message : String(err) })
  }
})

function workHoursBody(resolved: ReturnType<typeof resolveWorkHours>): Record<string, unknown> {
  return {
    ...workHoursToConfig(resolved.workHours),
    label: workHoursLabel(resolved.workHours),
    source: resolved.source,
    ...(resolved.invalid ? { invalid: resolved.invalid } : {}),
  }
}

timeReportRouter.get('/work-hours', async (_req: Request, res: Response) => {
  const config = await readConfig()
  res.json(workHoursBody(resolveWorkHours(config?.time?.work_hours)))
})

timeReportRouter.post('/work-hours', async (req: Request, res: Response) => {
  if (CLOUD_MODE) {
    res.status(501).json({ error: 'not_supported_cloud', message: 'settings are changed on the primary box' })
    return
  }
  const body = (req.body ?? {}) as { start?: unknown; end?: unknown; days?: unknown; reset?: unknown }
  if (body.reset !== true && body.start === undefined && body.end === undefined && body.days === undefined) {
    res.status(400).json({ error: 'bad_request', message: 'give start, end and/or days, or reset: true for the default' })
    return
  }
  try {
    const { getConfig, updateConfig } = await import('../../core/config-manager.js')
    const config = await getConfig()
    const time = { ...config.time }
    if (body.reset === true) {
      delete time.work_hours
    } else {
      // Fields left out keep their stored (or default) value.
      const current = resolveWorkHours(config.time?.work_hours).workHours
      const next = parseWorkHours({
        ...(body.start !== undefined ? { start: body.start as string } : {}),
        ...(body.end !== undefined ? { end: body.end as string } : {}),
        ...(body.days !== undefined ? { days: body.days as Array<string | number> } : {}),
      }, current)
      time.work_hours = workHoursToConfig(next)
    }
    // updateConfig replaces the whole `time` key, so its siblings ride along.
    await updateConfig({ time })
    res.json(workHoursBody(resolveWorkHours(time.work_hours)))
  } catch (err) {
    if (err instanceof WorkHoursError) {
      res.status(400).json({ error: 'bad_request', message: err.message })
      return
    }
    log.web.warn('work hours update failed', { error: err instanceof Error ? err.message : String(err) })
    res.status(500).json({ error: 'internal', message: 'could not save the work hours' })
  }
})

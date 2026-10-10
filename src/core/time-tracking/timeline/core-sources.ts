/**
 * The timeline sources core owns. Each reads its own store for the range and
 * returns segments plus what it could see (coverage). They run on the Walnut host
 * only (places and health never leave it), and the route that calls them is
 * this-Mac-only for the same reason.
 *
 *   walnut    100  the attention lease (session, triage, chat; phone included)
 *   mac-apps   90  the foreground sampler, Walnut's own foreground left out
 *   calls      85  a call app holding a call on this Mac (power assertions): shows
 *                  a call the user listened to with the Mac idle
 *   sleep      70  nights and naps (Apple Health)
 *   workouts   60  workouts (Apple Health): below sleep, so a watch left running
 *                  overnight does not hide the night
 *   calendar   50  meetings and planned blocks, read through the calendar op
 *                  (a bridge: the calendar plugin's own source replaces it)
 *   places     --  where the user was (iPhone visits), plus travel between them
 */

import { log } from '../../../logging/index.js'
import { readDayRecords } from '../store.js'
import { outsideDayRecords } from '../outside-store.js'
import { WALNUT_DESKTOP_BUNDLE_ID } from '../outside-view.js'
import { walnutHostsFor } from '../walnut-hosts.js'
import { shiftDateKey } from '../rollup.js'
import { seriesIdOf } from './meetings.js'
import { registerTimelineSource } from './registry.js'
import type { TimelineRange, TimelineSegmentInput, TimelineSourceResult } from './types.js'

const HUMAN_KINDS = new Set(['session', 'triage', 'chat', 'app'])
/** Same task, same device, closer than this: one segment (a missed beat is not a switch). */
const WALNUT_JOIN_MS = 90_000
/** Same app (and site), closer than this: one segment (the sampler runs every ~5 s). */
const APP_JOIN_MS = 15_000
/** A workout this long is more likely a watch left running than a workout. */
const LONG_WORKOUT_MIN = 240
/** Two visits this close in time with different places: the gap is travel. */
const TRAVEL_MAX_MS = 3 * 3_600_000
/** A workout the watch kept recording into the night is shown as its first this-long. */
export const LEFT_RUNNING_KEEP_MS = 2 * 3_600_000

/**
 * A workout that runs into a night of sleep is a watch left running (2026-10-07: a
 * pickleball game "lasted" from 20:41 to 08:11). Sleep already wins the night, but
 * the hours between the game and bed, and between waking and the stop, were still
 * drawn as exercise. Keep the first LEFT_RUNNING_KEEP_MS, ending at bedtime when that
 * comes first. A workout that starts inside a night is left as it is (sleep covers it).
 */
export function trimLeftRunningWorkout(startMs: number, endMs: number, sleeps: ReadonlyArray<readonly [number, number]>): { endMs: number; trimmed: boolean } {
  const night = sleeps.filter(([s, e]) => startMs < e && endMs > s).sort((x, y) => x[0] - y[0])[0]
  if (!night || night[0] <= startMs) return { endMs, trimmed: false }
  const end = Math.min(endMs, startMs + LEFT_RUNNING_KEEP_MS, night[0])
  return { endMs: end, trimmed: end < endMs }
}

function datesOf(range: TimelineRange): string[] {
  const out: string[] = []
  for (let d = range.from; d <= range.to && out.length < 40; d = shiftDateKey(d, 1)) out.push(d)
  return out
}

interface Run { startMs: number; endMs: number; key: string; seg: TimelineSegmentInput }

/** Join consecutive same-key intervals closer than `joinMs`. Input sorted by start. */
function joinRuns(items: Array<{ startMs: number; endMs: number; key: string; make: () => TimelineSegmentInput }>, joinMs: number): TimelineSegmentInput[] {
  const runs: Run[] = []
  for (const it of items) {
    const last = runs[runs.length - 1]
    const same = last && last.key === it.key && it.startMs - last.endMs <= joinMs ? last : undefined
    if (same) { same.endMs = Math.max(same.endMs, it.endMs); continue }
    const run = { startMs: it.startMs, endMs: it.endMs, key: it.key, seg: it.make() }
    runs.push(run)
  }
  return runs.map((r) => ({ ...r.seg, start: r.startMs, end: r.endMs }))
}

async function walnutSegments(range: TimelineRange): Promise<TimelineSourceResult> {
  const items: Array<{ startMs: number; endMs: number; taskId: string; device: string; app?: string }> = []
  let compactedMs = 0
  for (const date of datesOf(range)) {
    for (const rec of await readDayRecords(date)) {
      if (!HUMAN_KINDS.has(rec.kind)) continue
      if (!rec.ts || rec.ts === `${date}T00:00:00.000Z`) { compactedMs += rec.durationMs; continue }
      const startMs = Date.parse(rec.ts)
      if (!Number.isFinite(startMs)) continue
      items.push({
        startMs, endMs: startMs + rec.durationMs, taskId: rec.taskId ?? '', device: rec.source === 'ios' ? 'phone' : 'mac',
        ...(rec.kind === 'app' ? { app: rec.app ?? 'a plugin' } : {}),
      })
    }
  }
  items.sort((a, b) => a.startMs - b.startMs)
  const ids = [...new Set(items.map((i) => i.taskId).filter(Boolean))]
  const titles = new Map<string, string>()
  if (ids.length) {
    try {
      const { listTasksByIds } = await import('../../task-manager.js')
      for (const t of await listTasksByIds(ids)) titles.set(t.id, t.title)
    } catch { /* an unnamed segment still says when */ }
  }
  const segments = joinRuns(items.map((i) => ({
    startMs: i.startMs, endMs: i.endMs, key: `${i.taskId}\u0000${i.device}\u0000${i.app ?? ''}`,
    make: (): TimelineSegmentInput => ({
      start: i.startMs, end: i.endMs, kind: 'walnut', confidence: 'measured',
      label: i.app ? `${i.app} in Walnut` : i.taskId ? (titles.get(i.taskId) ?? 'a deleted task') : 'Walnut (no task)',
      detail: { taskId: i.taskId || null, device: i.device, ...(i.app ? { app: i.app } : {}) },
    }),
  })), WALNUT_JOIN_MS)
  return {
    segments,
    coverage: {
      available: true,
      ...(compactedMs > 0 ? { note: `${Math.round(compactedMs / 60_000)} min on compacted days have no time of day and are not drawn` } : {}),
    },
  }
}

async function appSegments(range: TimelineRange): Promise<TimelineSourceResult> {
  const { getConfig } = await import('../../config-manager.js')
  const config = await getConfig().catch(() => undefined)
  const walnutHosts = new Set(await walnutHostsFor(config))
  const items: Array<{ startMs: number; endMs: number; key: string; app: string; host: string }> = []
  for (const date of datesOf(range)) {
    for (const rec of await outsideDayRecords(date)) {
      if (rec.bundleId === WALNUT_DESKTOP_BUNDLE_ID || (rec.host && walnutHosts.has(rec.host))) continue
      const startMs = Date.parse(rec.ts)
      if (!Number.isFinite(startMs)) continue
      items.push({ startMs, endMs: startMs + rec.durationMs, key: `${rec.bundleId ?? rec.app}\u0000${rec.host ?? ''}`, app: rec.app, host: rec.host ?? '' })
    }
  }
  items.sort((a, b) => a.startMs - b.startMs)
  const segments = joinRuns(items.map((i) => ({
    startMs: i.startMs, endMs: i.endMs, key: i.key,
    make: (): TimelineSegmentInput => ({
      start: i.startMs, end: i.endMs, kind: 'app', confidence: 'measured',
      // A browser is told apart by its site: "slack.com" says more than "Google Chrome".
      label: i.host ? `${i.host} (${i.app})` : i.app,
      ...(i.host ? { detail: { app: i.app, host: i.host } } : { detail: { app: i.app } }),
    }),
  })), APP_JOIN_MS)
  const enabled = config?.time?.outside?.enabled === true
  return {
    segments,
    coverage: segments.length > 0 || enabled
      ? { available: true, ...(enabled ? {} : { note: 'Mac app sampling is off now; these are older samples' }) }
      : { available: false, note: 'Mac app sampling is off (Time app settings), so apps outside Walnut are not seen' },
  }
}

const isoOrNull = (v: unknown): number | null => {
  if (typeof v !== 'string') return null
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? ms : null
}

const titleCase = (s: string): string => s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

interface HealthRead { segments: TimelineSegmentInput[]; sleeps: Array<[number, number]>; note?: string; available: boolean }

/** One read of Apple Health for the range: nights (by wake date) and workouts. */
async function readHealth(range: TimelineRange): Promise<HealthRead> {
  const fs = await import('node:fs')
  const { healthDbPath } = await import('../../health/db.js')
  if (!fs.existsSync(healthDbPath())) return { segments: [], sleeps: [], available: false, note: 'Apple Health is not connected' }
  const health = await import('../../health/index.js')
  const { localDate, systemTz } = await import('../../health/day-key.js')
  const today = localDate(Date.now(), systemTz())
  const nextDay = shiftDateKey(range.to, 1)
  // Nights by WAKE date: the night after the last day ends the morning after it.
  const sleep = await health.healthSleep({ from: range.from, to: nextDay <= today ? nextDay : range.to })
  const daily = await health.healthDaily({ from: shiftDateKey(range.from, -1), to: range.to, metrics: 'workouts' })
  const status = health.healthStatus()
  const segments: TimelineSegmentInput[] = []
  const sleeps: Array<[number, number]> = []
  for (const n of sleep.nights as Array<Record<string, unknown>>) {
    const bed = isoOrNull(n.bedtime)
    const wake = isoOrNull(n.wake)
    if (bed !== null && wake !== null && wake > bed) {
      const flags: string[] = []
      if (n.status === 'in_bed_only') flags.push('only time in bed was recorded')
      if (Array.isArray(n.unrecordedGaps) && n.unrecordedGaps.length) flags.push('the recording has a gap: do not state this night\'s bedtime or wake as fact')
      segments.push({
        start: bed, end: wake, kind: 'sleep', label: 'Sleep', confidence: 'measured',
        detail: { asleepMin: typeof n.asleepMin === 'number' ? n.asleepMin : null, wakeDate: String(n.date ?? '') },
        ...(flags.length ? { flags } : {}),
      })
      sleeps.push([bed, wake])
    }
    for (const nap of Array.isArray(n.naps) ? n.naps as Array<Record<string, unknown>> : []) {
      const a = isoOrNull(nap.start)
      const b = isoOrNull(nap.end)
      if (a !== null && b !== null && b > a) segments.push({ start: a, end: b, kind: 'nap', label: 'Nap', confidence: 'measured' })
    }
  }
  const seen = new Set<string>()
  for (const day of daily.days as Array<Record<string, unknown>>) {
    for (const w of Array.isArray(day.workouts) ? day.workouts as Array<Record<string, unknown>> : []) {
      const a = isoOrNull(w.start)
      const b = isoOrNull(w.end)
      if (a === null || b === null || b <= a) continue
      const key = `${a}:${String(w.activity)}`
      if (seen.has(key)) continue
      seen.add(key)
      const flags: string[] = []
      const durationMin = Math.round((b - a) / 60_000)
      const trim = trimLeftRunningWorkout(a, b, sleeps)
      if (trim.trimmed) {
        flags.push(`recorded for ${durationMin} min into a night of sleep: the watch was left running, so only the first ${Math.round((trim.endMs - a) / 60_000)} min are shown`)
      } else if (sleeps.some(([s, e]) => a < e && b > s)) {
        flags.push('overlaps a night of sleep: the watch was probably left running; sleep is shown for that part')
      } else if (durationMin > LONG_WORKOUT_MIN) flags.push('very long: the watch may have been left running')
      segments.push({
        start: a, end: trim.endMs, kind: 'workout', label: typeof w.activity === 'string' && w.activity ? titleCase(w.activity) : 'Workout',
        confidence: 'measured',
        detail: { durationMin, energyKcal: typeof w.energyKcal === 'number' ? Math.round(w.energyKcal) : null },
        ...(flags.length ? { flags } : {}),
      })
    }
  }
  const missing = (daily.days as Array<Record<string, unknown>>).filter((d) => d.status === 'missing' && String(d.date) >= range.from).map((d) => String(d.date))
  const connected = (status as { connected?: unknown }).connected
  const note = connected === false ? 'the phone has not synced Apple Health for 3 days or more'
    : missing.length ? `nothing synced from Apple Health for ${missing.join(', ')}` : undefined
  return { segments, sleeps, available: true, ...(note ? { note } : {}) }
}

/** The two health sources of one timeline call share one read (they run side by side). */
let healthMemo: { key: string; at: number; read: Promise<HealthRead> } | undefined
const HEALTH_MEMO_MS = 5_000

function sharedHealthRead(range: TimelineRange): Promise<HealthRead> {
  const key = `${range.startMs}:${range.endMs}`
  const now = Date.now()
  if (healthMemo && healthMemo.key === key && now - healthMemo.at < HEALTH_MEMO_MS) return healthMemo.read
  const read = readHealth(range)
  healthMemo = { key, at: now, read }
  return read
}

/** Sleep and workouts are two sources of one read: sleep outranks a workout (a watch left running overnight). */
function healthSource(kinds: ReadonlySet<string>) {
  return async (range: TimelineRange): Promise<TimelineSourceResult> => {
    const read = await sharedHealthRead(range)
    return {
      segments: read.segments.filter((s) => kinds.has(s.kind)),
      coverage: { available: read.available, ...(read.note ? { note: read.note } : {}) },
    }
  }
}

export async function calendarSegments(range: TimelineRange): Promise<TimelineSourceResult> {
  const { executeOp, getOp } = await import('../../../ops/index.js')
  if (!getOp('calendar_query')) return { segments: [], coverage: { available: false, note: 'the calendar plugin is not installed or turned off' } }
  const { LOCAL_ORIGIN } = await import('../../../lib/caller-origin.js')
  const out = await executeOp('calendar_query', { from: range.from, to: range.to }, { origin: LOCAL_ORIGIN })
  if (!out.ok) return { segments: [], coverage: { available: false, note: `the calendar did not answer: ${out.message.slice(0, 160)}` } }
  let body = out.result as Record<string, unknown> | string
  if (typeof body === 'string') {
    try { body = JSON.parse(body) as Record<string, unknown> } catch { body = {} }
  }
  const events = Array.isArray((body as Record<string, unknown>).events) ? (body as { events: Array<Record<string, unknown>> }).events : []
  const segments: TimelineSegmentInput[] = []
  for (const e of events) {
    if (e.allDay === true || e.status === 'canceled' || e.selfStatus === 'declined' || e.hidden === true) continue
    const a = isoOrNull(e.start)
    const b = isoOrNull(e.end)
    if (a === null || b === null || b <= a) continue
    const title = typeof e.title === 'string' && e.title.trim() ? e.title.trim() : '(untitled event)'
    const where = typeof e.location === 'string' ? e.location : ''
    // A call link, a room booking or other people invited is a meeting; anything
    // else is a block the user planned.
    const meeting = /https?:\/\/|zoom|chime|teams|meet\./i.test(where) || /^booked for /i.test(title) || e.hasAttendees === true
    const id = typeof e.id === 'string' ? e.id : ''
    const recurring = e.recurring === true
    segments.push({
      start: a, end: b, kind: meeting ? 'meeting' : 'plan', label: title.replace(/^Booked for "(.*)" via .*$/i, '$1'),
      confidence: 'planned',
      detail: {
        ...(typeof e.calendar === 'string' ? { calendar: e.calendar } : {}),
        ...(id ? { eventId: id, ...(recurring ? { seriesId: seriesIdOf(id) } : {}) } : {}),
        ...(recurring ? { recurring: true } : {}),
      },
    })
  }
  return { segments, coverage: { available: true } }
}

/**
 * A call app's process name as people say it. Any other process got here through
 * a WebRTC assertion (a browser tab, a chat app's huddle), which can also be a
 * real-time web app that is not a call: the label says so.
 */
export function callAppLabel(app: string): string {
  if (/^zoom/i.test(app)) return 'Zoom'
  if (/teams/i.test(app)) return 'Teams'
  if (/webex/i.test(app)) return 'Webex'
  if (/^facetime$/i.test(app)) return 'FaceTime'
  return `${app} WebRTC`
}

async function callSegments(range: TimelineRange): Promise<TimelineSourceResult> {
  const { readCalls } = await import('../calls-store.js')
  const { calls, coverage } = await readCalls(range.startMs, range.endMs)
  const segments: TimelineSegmentInput[] = calls.map((c) => ({
    start: c.startMs, end: c.endMs, kind: 'call', label: `${callAppLabel(c.app)} call`, confidence: 'measured', detail: { app: c.app },
  }))
  if (coverage.length === 0) {
    return { segments, coverage: { available: segments.length > 0, note: 'calls are recorded on this Mac while outside activity is on; none were watched in this range' } }
  }
  const first = coverage[0]![0]
  const note = first > range.startMs + 3_600_000 ? `calls were watched from ${new Date(first).toISOString()}` : undefined
  return { segments, coverage: { available: true, ...(note ? { note } : {}) } }
}

async function placeSegments(range: TimelineRange): Promise<TimelineSourceResult> {
  const places = await import('../../places/index.js')
  if (!places.placesStoreExists()) return { segments: [], coverage: { available: false, note: 'Places is off: no visits on this Mac (Walnut on the iPhone records them once turned on)' } }
  const body = places.placesVisits({ from: range.from, to: range.to, limit: 1000 }) as { visits?: Array<Record<string, unknown>>; recording?: boolean; message?: string }
  const status = places.placesStatus()
  const visits = (body.visits ?? []).map((v) => ({
    v,
    start: isoOrNull(v.arrival) ?? isoOrNull(v.departure),
    end: isoOrNull(v.departure) ?? (v.status === 'ongoing' ? Date.now() : null),
    label: typeof v.label === 'string' ? v.label : typeof v.name === 'string' && v.name ? v.name : 'an unnamed place',
  })).filter((x) => x.start !== null).sort((a, b) => a.start! - b.start!)
  const segments: TimelineSegmentInput[] = []
  for (let i = 0; i < visits.length; i++) {
    const x = visits[i]!
    const flags: string[] = []
    if (x.v.status === 'departure_unknown') flags.push('departure unknown: the length is not known')
    if (x.v.arrivalUnknown === true) flags.push('arrival unknown')
    if (x.end !== null && x.end > x.start!) {
      segments.push({
        start: x.start!, end: x.end, kind: 'place', label: x.label, confidence: 'measured', lane: 'place',
        detail: { category: typeof x.v.labelKind === 'string' ? x.v.labelKind : null, visitId: String(x.v.id ?? '') },
        ...(flags.length ? { flags } : {}),
      })
    }
    const next = visits[i + 1]
    if (next && x.end !== null && next.start! > x.end && next.start! - x.end <= TRAVEL_MAX_MS && next.label !== x.label) {
      segments.push({
        start: x.end, end: next.start!, kind: 'travel', label: `${x.label} to ${next.label}`, confidence: 'inferred', lane: 'place',
      })
    }
  }
  const first = status.firstVisitAt ? status.firstVisitAt.slice(0, 10) : null
  const notes: string[] = []
  if (first && range.from < first) notes.push(`Places recording began ${first}: days before it have no places`)
  if (!status.recording) notes.push(status.message ?? 'Places is not recording now')
  if (!first) notes.push('no visit recorded yet')
  return { segments, coverage: { available: visits.length > 0, ...(notes.length ? { note: notes.join('. ') } : {}) } }
}

let registered = false

/** Register core's sources (idempotent). Called from the timeline route on first use. */
export function registerCoreTimelineSources(): void {
  if (registered) return
  registered = true
  const wrap = (id: string, fn: (r: TimelineRange) => Promise<TimelineSourceResult>) => async (r: TimelineRange) => {
    try {
      return await fn(r)
    } catch (err) {
      log.web.warn('timeline source failed', { source: id, error: err instanceof Error ? err.message : String(err) })
      throw err
    }
  }
  registerTimelineSource('core', { id: 'walnut', label: 'Walnut attention', lane: 'activity', priority: 100, segments: wrap('walnut', walnutSegments) })
  registerTimelineSource('core', { id: 'mac-apps', label: 'Mac apps (foreground)', lane: 'activity', priority: 90, segments: wrap('mac-apps', appSegments) })
  registerTimelineSource('core', { id: 'calls', label: 'Calls (call apps on this Mac)', lane: 'activity', priority: 85, segments: wrap('calls', callSegments) })
  registerTimelineSource('core', { id: 'sleep', label: 'Apple Health sleep', lane: 'activity', priority: 70, segments: wrap('sleep', healthSource(new Set(['sleep', 'nap']))) })
  registerTimelineSource('core', { id: 'workouts', label: 'Apple Health workouts', lane: 'activity', priority: 60, segments: wrap('workouts', healthSource(new Set(['workout']))) })
  registerTimelineSource('core', { id: 'calendar', label: 'Calendar', lane: 'activity', priority: 50, segments: wrap('calendar', calendarSegments) }, { replaceableByOwner: 'calendar' })
  registerTimelineSource('core', { id: 'places', label: 'Places (iPhone visits)', lane: 'place', priority: 0, segments: wrap('places', placeSegments) })
}

/** Tests: let the next registerCoreTimelineSources() run again. */
export function resetCoreTimelineSources(): void {
  registered = false
}

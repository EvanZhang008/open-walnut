/**
 * day_review: one day read from the EXISTING endpoints, in parallel, each
 * section compacted for an agent. A source that is off, missing or failing lands
 * in `unavailable` with its reason, so the model reports a gap instead of
 * inventing a section. Pure at import time (registry rule): all I/O is `call`.
 */

import type { HttpBinding } from './registry.js'
import { addDays, isValidTz, localDate, localParts, systemTz, zonedMidnight } from '../core/health/day-key.js'

type Call = (method: HttpBinding['method'], path: string, body?: unknown) => Promise<unknown>

export const DAY_REVIEW_SECTIONS = ['tasks', 'time', 'apps', 'screentime', 'calendar', 'focus', 'sleep', 'activity'] as const
type Section = (typeof DAY_REVIEW_SECTIONS)[number]

/** `timezone`: the phone's zone could not be read, so this machine's was used for every date bound. */
interface Unavailable { section: Section | 'timezone'; reason: string }
type SectionResult = { ok: true; value: unknown } | { ok: false; reason: string }
/**
 * What health_status says. `connected` is ITS answer (false once nothing has synced
 * for 3 days): the sleep and daily reads only say `connected: false` when no store
 * exists at all, so a phone that stopped syncing would otherwise read as "missing".
 */
interface HealthState { tz: string | null; connected: boolean | null; lastSyncAt: string | null }
/**
 * When and where the review is read: `tz` is the phone's zone when a health store
 * exists. `health` settles by the zone lookup's deadline; null = unknown.
 */
interface ReviewCtx { now: number; tz: string; health: Promise<HealthState | null> }

const MIN = 60_000
/**
 * ONE deadline for the whole review, the zone lookup included: every section runs
 * against the same end instant, so one slow source cannot hold the review, and a
 * slow zone lookup cannot push the sections past it either (it gets at most half
 * the budget, then this machine's zone is used and the review says so). A first
 * calendar read on a fresh install compiles and signs a native helper (measured
 * 30s on a loaded box); the review still answers, with that section listed as
 * unavailable.
 */
export const DAY_REVIEW_TIMEOUT_MS = 10_000
/** A night counts as completed this long after its last sample (same rule as health:sleep-ready). */
const NIGHT_SETTLED_MS = 30 * MIN

/**
 * Default review date: today, or yesterday while it is still morning, in `tz`
 * (the phone's zone when a health store exists, else this machine's).
 */
export function defaultReviewDate(now = new Date(), tz?: string): string {
  const zone = tz && isValidTz(tz) ? tz : systemTz()
  const ms = now.getTime()
  const today = localDate(ms, zone)
  return localParts(ms, zone).hour < 12 ? addDays(today, -1) : today
}

/**
 * The health store's status: the phone's zone (null when there is no store or it
 * has no zone yet: this machine's zone is then the right answer, not a gap) and
 * whether the phone is still syncing. `null` when the route is absent; a thrown
 * error when the lookup itself failed or timed out.
 */
async function readHealthState(call: Call): Promise<HealthState | null> {
  let status: Record<string, unknown>
  try {
    status = rec(await call('GET', '/api/health/status'))
  } catch (err) {
    if (reasonOf(err) === 'not installed or turned off') return null
    throw err
  }
  return {
    tz: isValidTz(status.tz) ? status.tz : null,
    connected: typeof status.connected === 'boolean' ? status.connected : null,
    lastSyncAt: typeof status.lastUploadAt === 'string' ? status.lastUploadAt : null,
  }
}

/** The reason for a missing night or day when the phone is not syncing, or null when it is (or nobody knows). */
async function notConnected(ctx: ReviewCtx): Promise<string | null> {
  const health = await ctx.health
  if (health?.connected !== false) return null
  const last = health.lastSyncAt ? Date.parse(health.lastSyncAt) : Number.NaN
  return Number.isFinite(last)
    ? `Apple Health is not connected: nothing has synced since ${localDate(last, ctx.tz)}`
    : 'Apple Health is not connected: the phone has never synced'
}

/** The date's local day in `tz`, as instants. */
function localDayBounds(date: string, tz: string): { from: string; until: string } {
  return { from: new Date(zonedMidnight(date, tz)).toISOString(), until: new Date(zonedMidnight(addDays(date, 1), tz)).toISOString() }
}

/** Whole days from `date` back to today in `tz` (0 = today, negative = the future). */
function daysAgo(date: string, now: number, tz: string): number {
  const utc = (key: string): number => {
    const [y, m, d] = key.split('-').map(Number)
    return Date.UTC(y, m - 1, d)
  }
  return Math.round((utc(localDate(now, tz)) - utc(date)) / 86_400_000)
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(rec) : [])
const minutes = (ms: unknown): number => Math.round((typeof ms === 'number' ? ms : 0) / MIN)

function reasonOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/\(404\)|not_found|was not found|Cannot GET|Cannot POST/i.test(message)) return 'not installed or turned off'
  if (/not_supported_cloud|\(501\)/i.test(message)) return 'only available on the primary box'
  return message.slice(0, 200)
}

async function tasksSection(call: Call, date: string, ctx: ReviewCtx): Promise<SectionResult> {
  const { from, until } = localDayBounds(date, ctx.tz)
  const qs = new URLSearchParams({
    time_basis: 'completed', time_from: from, time_until: until, fields: 'list', limit: '200', sort: 'completed_desc',
  })
  const body = rec(await call('GET', `/api/tasks?${qs}`))
  const tasks = list(body.tasks).map((t) => ({ id: t.id, title: t.title, project: t.project ?? '', completedAt: t.completed_at ?? null }))
  return { ok: true, value: { completed: tasks.length, tasks } }
}

async function timeSection(call: Call, date: string, ctx: ReviewCtx): Promise<SectionResult> {
  const back = daysAgo(date, ctx.now, ctx.tz)
  if (back < 0) return { ok: false, reason: 'the date is in the future' }
  if (back >= 90) return { ok: false, reason: 'time tracking keeps a 90-day window' }
  // Time tracking keys days by this machine's calendar, which may run a day ahead
  // of the phone's: ask for one more day and pick the date by its key.
  const body = rec(await call('GET', `/api/time/summary?days=${Math.min(90, back + 2)}`))
  const day = list(body.days).find((d) => d.date === date)
  if (!day || (!day.humanMs && !day.agentMs)) return { ok: false, reason: 'no time was recorded that day' }
  const top = list(day.tasks).sort((a, b) => Number(b.humanMs ?? 0) - Number(a.humanMs ?? 0)).slice(0, 5)
  return {
    ok: true,
    value: {
      humanMin: minutes(day.humanMs), agentMin: minutes(day.agentMs), phoneMin: minutes(day.iosMs),
      topTasks: top.map((t) => ({ taskId: t.taskId || null, humanMin: minutes(t.humanMs), agentMin: minutes(t.agentMs) })),
    },
  }
}

async function appsSection(call: Call, date: string): Promise<SectionResult> {
  const body = rec(await call('GET', `/api/time/apps?date=${date}`))
  if (body.enabled !== true && !Number(body.totalMs ?? 0)) return { ok: false, reason: 'Mac app sampling is off (Time app settings)' }
  if (!Number(body.totalMs ?? 0)) return { ok: false, reason: 'no Mac app time was recorded that day' }
  return {
    ok: true,
    value: {
      totalMin: minutes(body.totalMs), walnutMin: minutes(body.walnutMs),
      topApps: list(body.apps).slice(0, 8).map((a) => ({ app: a.app, min: minutes(a.ms) })),
    },
  }
}

async function screentimeSection(call: Call, date: string): Promise<SectionResult> {
  const body = rec(await call('GET', `/api/time/screentime?date=${date}`))
  if (body.enabled !== true) return { ok: false, reason: 'Screen Time import is off (Time app settings)' }
  const devices = list(body.devices).filter((d) => Number(d.totalMs ?? 0) > 0)
  if (devices.length === 0) return { ok: false, reason: 'no Screen Time was recorded that day' }
  return {
    ok: true,
    value: devices.map((d) => ({
      device: d.deviceName, totalMin: minutes(d.totalMs), pickups: d.pickups ?? null,
      topApps: list(d.apps).slice(0, 5).map((a) => ({ app: a.bundleId, min: minutes(a.ms) })),
    })),
  }
}

async function calendarSection(call: Call, date: string): Promise<SectionResult> {
  const body = rec(await call('GET', `/api/plugins/calendar/events?from=${date}&to=${date}`))
  const events = list(body.events)
    .filter((e) => e.status !== 'canceled' && e.selfStatus !== 'declined')
    .slice(0, 40)
    .map((e) => ({ title: e.title, start: e.start, end: e.end, allDay: e.allDay === true }))
  return { ok: true, value: { events: events.length, items: events } }
}

async function focusSection(call: Call, date: string): Promise<SectionResult> {
  const reply = rec(await call('POST', '/api/plugin-runtime/walnut-rhythm/ops/walnut_rhythm_status', {}))
  if (reply.ok !== true) return { ok: false, reason: String(reply.message ?? 'Rhythm did not answer').slice(0, 200) }
  const today = rec(rec(reply.result).today)
  if (today.date !== date) return { ok: false, reason: 'Rhythm keeps only today\'s focus log' }
  return {
    ok: true,
    value: {
      focusMin: today.focusMinutes ?? 0, blocks: Array.isArray(today.focusBlocks) ? today.focusBlocks.length : 0,
      stoppedBlocks: today.stoppedBlocks ?? 0, breaksTaken: today.breaksTaken ?? 0,
      standRemindersFired: today.remindersFired ?? 0, standRemindersDone: today.remindersDone ?? 0,
      longestSittingMin: minutes(today.longestStreakMs),
    },
  }
}

/**
 * "Last night" = the most recent COMPLETED night as of the review: the night that
 * ended on the morning after `date` once it has settled (so a review of yesterday
 * read at breakfast reports the night just slept), else the night that ended on
 * `date` itself. An In-Bed-only night is a night, reported as such.
 */
async function sleepSection(call: Call, date: string, ctx: ReviewCtx): Promise<SectionResult> {
  const today = localDate(ctx.now, ctx.tz)
  const next = addDays(date, 1)
  const to = next <= today ? next : date
  const body = rec(await call('GET', `/api/health/sleep?from=${date}&to=${to}`))
  if (body.connected === false) return { ok: false, reason: 'Apple Health is not connected' }
  const nights = list(body.nights)
  const settled = (n: Record<string, unknown>): boolean => (n.status === 'ok' || n.status === 'in_bed_only')
    && typeof n.wake === 'string' && Date.parse(n.wake) <= ctx.now - NIGHT_SETTLED_MS
  const night = [...nights].reverse().find(settled)
  // A night on record is reported whatever the sync state; only a gap needs the reason.
  if (night) {
    const { hypnogram: _h, otherSources: _o, ...rest } = night
    const notes = [
      ...(night.status === 'in_bed_only' ? ['Only time in bed was recorded'] : []),
      ...(Array.isArray(night.unrecordedGaps) && night.unrecordedGaps.length
        ? ['Sleep was recorded close to this night with nothing recorded in between (unrecordedGaps): do not state its wake time or bedtime as fact']
        : []),
    ]
    return {
      ok: true,
      value: {
        ...rest,
        wakeDate: night.date,
        ...(notes.length ? { note: notes.join('. ') } : {}),
        caveats: body.caveats,
      },
    }
  }
  const own = nights.find((n) => n.date === date)
  if (own?.status === 'no_main_night') {
    const naps = list(own.naps).length
    return { ok: false, reason: naps ? `no main night was recorded, only ${naps} nap${naps === 1 ? '' : 's'}` : 'no main night was recorded' }
  }
  return { ok: false, reason: await notConnected(ctx) ?? 'no night was recorded for this wake date' }
}

async function activitySection(call: Call, date: string, ctx: ReviewCtx): Promise<SectionResult> {
  const body = rec(await call('GET', `/api/health/daily?from=${date}&to=${date}&metrics=activity,vitals,workouts,mind`))
  if (body.connected === false) return { ok: false, reason: 'Apple Health is not connected' }
  const day = list(body.days)[0]
  if (!day || day.status !== 'ok') {
    return { ok: false, reason: await notConnected(ctx) ?? 'nothing has synced from Apple Health for this day' }
  }
  return { ok: true, value: { ...day, units: body.units } }
}

const RUNNERS: Record<Section, (call: Call, date: string, ctx: ReviewCtx) => Promise<SectionResult>> = {
  tasks: tasksSection, time: timeSection, apps: appsSection, screentime: screentimeSection,
  calendar: calendarSection, focus: focusSection, sleep: sleepSection, activity: activitySection,
}

const budgetText = (ms: number): string => (ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`)

/** Settle `work` by the instant `end`; past it, reject naming the whole review's budget. */
function byDeadline<T>(work: Promise<T>, end: number, budgetMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`did not answer within ${budgetText(budgetMs)}`)), Math.max(0, end - Date.now()))
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

/** Sections whose date bounds depend on the zone even when the date is given. */
const ZONED: ReadonlySet<Section> = new Set(['tasks', 'time', 'sleep'])
/** Sections that ask health_status whether the phone still syncs, to explain a gap. */
const HEALTH_SECTIONS: ReadonlySet<Section> = new Set(['sleep', 'activity'])

export async function runDayReview(
  args: Record<string, unknown>,
  call: Call,
  opts: { timeoutMs?: number; now?: number } = {},
): Promise<Record<string, unknown>> {
  const now = opts.now ?? Date.now()
  const asked = typeof args.sections === 'string' && args.sections.trim()
    ? args.sections.split(',').map((s) => s.trim()).filter(Boolean)
    : [...DAY_REVIEW_SECTIONS]
  const unknown = asked.filter((s) => !(DAY_REVIEW_SECTIONS as readonly string[]).includes(s))
  if (unknown.length) throw new Error(`unknown section(s): ${unknown.join(', ')} (use ${DAY_REVIEW_SECTIONS.join(', ')})`)
  const wanted = asked as Section[]
  const budget = opts.timeoutMs ?? DAY_REVIEW_TIMEOUT_MS
  const end = Date.now() + budget
  const unavailable: Unavailable[] = []

  // The phone's zone decides "today" and every day's bounds whenever the store knows
  // it: the Mac may sit in another zone. The lookup shares the review's one deadline.
  const givenDate = typeof args.date === 'string' ? args.date : null
  const needTz = givenDate === null || wanted.some((s) => ZONED.has(s))
  const needStatus = needTz || wanted.some((s) => HEALTH_SECTIONS.has(s))
  // The lookup may spend at most half the budget, so the sections that wait for it
  // keep time to answer; everything still ends at the one `end`.
  const tzBudget = Math.floor(budget / 2)
  const statusLookup: Promise<HealthState | null | { failed: unknown }> = !needStatus
    ? Promise.resolve(null)
    : byDeadline(readHealthState(call), Date.now() + tzBudget, tzBudget).catch((err: unknown) => ({ failed: err }))
  const health = statusLookup.then((st) => (st && 'failed' in st ? null : st))
  const tzLookup: Promise<string> = !needTz
    ? Promise.resolve(systemTz())
    : statusLookup.then((st) => {
      if (!st || !('failed' in st)) return st?.tz ?? systemTz()
      const fallback = systemTz()
      unavailable.push({ section: 'timezone', reason: `the phone's time zone could not be read (${reasonOf(st.failed)}): this machine's zone (${fallback}) was used` })
      return fallback
    })
  const dateOf = async (): Promise<string> => givenDate ?? defaultReviewDate(new Date(now), await tzLookup)

  // A section that needs neither the zone nor a default date starts at once.
  const run = async (s: Section): Promise<SectionResult> => {
    const zoned = givenDate === null || ZONED.has(s)
    const tz = zoned ? await tzLookup : systemTz()
    return RUNNERS[s](call, await dateOf(), { now, tz, health })
  }
  const settled = await Promise.allSettled(wanted.map((s) => byDeadline(run(s), end, budget)))
  const tz = await tzLookup
  const date = await dateOf()
  const sections: Record<string, unknown> = {}
  settled.forEach((result, i) => {
    const section = wanted[i]
    if (result.status === 'rejected') unavailable.push({ section, reason: reasonOf(result.reason) })
    else if (!result.value.ok) unavailable.push({ section, reason: result.value.reason })
    else sections[section] = result.value.value
  })
  return {
    date,
    tz,
    sections,
    unavailable,
    note: 'Report every section in `unavailable` as missing with its reason. Never fill one in from memory or guesswork.',
  }
}

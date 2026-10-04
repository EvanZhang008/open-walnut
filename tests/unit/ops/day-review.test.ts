/**
 * day_review reads the existing endpoints in parallel and compacts each one. A
 * source that is off, missing or failing lands in `unavailable` with a reason, so
 * the agent reports a gap instead of inventing a section. The `call` seam is
 * faked: every source present, every source missing, a hanging source, and the
 * sleep rules (the most recent completed night, In Bed only, naps only, the
 * phone's time zone for the default date). Dates and times are fixed.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { DAY_REVIEW_SECTIONS, DAY_REVIEW_TIMEOUT_MS, defaultReviewDate, runDayReview } from '../../../src/ops/day-review.js'

const DATE = '2026-09-21'
const NEXT = '2026-09-22'
/** Breakfast on the morning after DATE, New York. */
const NOW = Date.parse('2026-09-22T09:00:00-04:00')
const MIN = 60_000

type Answer = unknown | Error
function fakeCall(routes: Record<string, Answer>) {
  const seen: string[] = []
  const call = async (method: string, path: string): Promise<unknown> => {
    seen.push(`${method} ${path}`)
    const key = Object.keys(routes).find((prefix) => path.startsWith(prefix))
    if (!key) throw new Error(`Cannot ${method} ${path} (404)`)
    const answer = routes[key]
    if (answer instanceof Error) throw answer
    return typeof answer === 'function' ? (answer as (p: string) => unknown)(path) : answer
  }
  return { call, seen }
}

const night = (date: string, over: Record<string, unknown> = {}) => ({
  date, status: 'ok', asleepMin: 420, bedtime: `${date}T00:10:00-04:00`, wake: `${date}T07:10:00-04:00`,
  hypnogram: [{ stage: 'core' }], otherSources: [], naps: [], ...over,
})

const PRESENT: Record<string, Answer> = {
  '/api/health/status': { connected: true, tz: 'America/New_York' },
  '/api/tasks': { tasks: [{ id: 't1', title: 'Draft the plan', project: 'marina', completed_at: `${DATE}T15:00:00Z` }] },
  '/api/time/summary': { days: [{ date: DATE, humanMs: 90 * MIN, agentMs: 30 * MIN, iosMs: 10 * MIN, tasks: [{ taskId: 't1', humanMs: 60 * MIN, agentMs: 5 * MIN }] }] },
  '/api/time/apps': { enabled: true, totalMs: 120 * MIN, walnutMs: 40 * MIN, apps: [{ app: 'Editor', ms: 80 * MIN }] },
  '/api/time/screentime': { enabled: true, devices: [{ deviceName: 'Phone', totalMs: 50 * MIN, pickups: 12, apps: [{ bundleId: 'org.example.reader', ms: 20 * MIN }] }] },
  '/api/plugins/calendar/events': { events: [
    { title: 'Standup', start: `${DATE}T16:00:00Z`, end: `${DATE}T16:15:00Z` },
    { title: 'Declined', start: `${DATE}T18:00:00Z`, end: `${DATE}T19:00:00Z`, selfStatus: 'declined' },
  ] },
  '/api/plugin-runtime/walnut-rhythm/ops/walnut_rhythm_status': { ok: true, result: { today: {
    date: DATE, focusMinutes: 75, focusBlocks: [{}, {}], stoppedBlocks: 0, breaksTaken: 2, remindersFired: 3, remindersDone: 2, longestStreakMs: 50 * MIN,
  } } },
  '/api/health/sleep': { nights: [night(DATE), night(NEXT, { asleepMin: 400 })], caveats: ['estimate'] },
  '/api/health/daily': { days: [{ date: DATE, status: 'ok', activity: { steps: 8000 } }], units: { steps: 'count' } },
}

afterEach(() => { vi.useRealTimers() })

describe('day_review', () => {
  it('with every source present, returns every section compacted and nothing unavailable', async () => {
    const { call, seen } = fakeCall(PRESENT)
    const out = await runDayReview({ date: DATE }, call as never, { now: NOW }) as any
    expect(out.unavailable).toEqual([])
    expect(Object.keys(out.sections).sort()).toEqual([...DAY_REVIEW_SECTIONS].sort())
    expect(out.sections.tasks.completed).toBe(1)
    expect(out.sections.time).toMatchObject({ humanMin: 90, agentMin: 30, phoneMin: 10 })
    expect(out.sections.apps).toMatchObject({ totalMin: 120, walnutMin: 40 })
    expect(out.sections.screentime[0]).toMatchObject({ device: 'Phone', totalMin: 50, pickups: 12 })
    expect(out.sections.calendar.events).toBe(1)
    expect(out.sections.focus).toMatchObject({ focusMin: 75, blocks: 2, longestSittingMin: 50 })
    // The hypnogram and the other-sources list stay out of the compact review.
    expect(out.sections.sleep).toMatchObject({ caveats: ['estimate'] })
    expect(out.sections.sleep).not.toHaveProperty('hypnogram')
    expect(out.sections.activity).toMatchObject({ activity: { steps: 8000 }, units: { steps: 'count' } })
    expect(out.note).toMatch(/Never fill one in/)
    // One status read for the phone's zone, then one read per section.
    expect(seen).toHaveLength(DAY_REVIEW_SECTIONS.length + 1)
    expect(out.tz).toBe('America/New_York')
  })

  it('"last night" is the most recent completed night: the one ending the morning after the date', async () => {
    const { call, seen } = fakeCall(PRESENT)
    const out = await runDayReview({ date: DATE, sections: 'sleep' }, call as never, { now: NOW }) as any
    expect(seen).toContain(`GET /api/health/sleep?from=${DATE}&to=${NEXT}`)
    expect(out.sections.sleep).toMatchObject({ wakeDate: NEXT, asleepMin: 400 })
    // Before that night has settled (07:10 wake, read at 07:20) the date's own night is the latest completed one.
    const early = await runDayReview({ date: DATE, sections: 'sleep' }, call as never, { now: Date.parse('2026-09-22T07:20:00-04:00') }) as any
    expect(early.sections.sleep).toMatchObject({ wakeDate: DATE, asleepMin: 420 })
    // Reviewing today never asks for tomorrow's night.
    const today = fakeCall(PRESENT)
    await runDayReview({ date: NEXT, sections: 'sleep' }, today.call as never, { now: NOW })
    expect(today.seen).toContain(`GET /api/health/sleep?from=${NEXT}&to=${NEXT}`)
  })

  it('an In-Bed-only night is reported as such, never as "no night"', async () => {
    const inBed = night(NEXT, { status: 'in_bed_only', asleepMin: null, inBedMin: 465, caveat: 'Only time in bed was recorded for this night' })
    const { call } = fakeCall({ ...PRESENT, '/api/health/sleep': { nights: [night(DATE, { status: 'missing', wake: null }), inBed] } })
    const out = await runDayReview({ date: DATE, sections: 'sleep' }, call as never, { now: NOW }) as any
    expect(out.unavailable).toEqual([])
    expect(out.sections.sleep).toMatchObject({ status: 'in_bed_only', inBedMin: 465, asleepMin: null, note: 'Only time in bed was recorded' })
  })

  it('a naps-only date says so', async () => {
    const napsOnly = night(DATE, { status: 'no_main_night', wake: null, naps: [{ asleepMin: 40 }, { asleepMin: 25 }] })
    const { call } = fakeCall({ ...PRESENT, '/api/health/sleep': { nights: [napsOnly] } })
    const out = await runDayReview({ date: DATE, sections: 'sleep' }, call as never, { now: Date.parse('2026-09-21T15:00:00-04:00') }) as any
    expect(out.unavailable).toEqual([{ section: 'sleep', reason: 'no main night was recorded, only 2 naps' }])
  })

  it('the default date follows the phone\'s zone, not the Mac\'s', async () => {
    // 02:30Z is 11:30 on the 22nd in Tokyo: before noon there, so the 21st.
    const at = Date.parse('2026-09-22T02:30:00Z')
    const tokyo = fakeCall({ ...PRESENT, '/api/health/status': { connected: true, tz: 'Asia/Tokyo' } })
    const out = await runDayReview({ sections: 'tasks' }, tokyo.call as never, { now: at }) as any
    expect(out).toMatchObject({ date: '2026-09-21', tz: 'Asia/Tokyo' })
    // 06:30Z is 15:30 on the 22nd in Tokyo (the 22nd), but still the 21st, or before noon on the
    // 22nd, for a Mac in the Americas or on UTC: only the phone's zone answers the 22nd.
    const late = await runDayReview({ sections: 'tasks' }, tokyo.call as never, { now: Date.parse('2026-09-22T06:30:00Z') }) as any
    expect(late.date).toBe('2026-09-22')
    // No store: this machine's zone.
    const none = fakeCall({ ...PRESENT, '/api/health/status': { connected: false } })
    const local = await runDayReview({ sections: 'tasks' }, none.call as never, { now: at }) as any
    expect(local.tz).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    // No store is an answer, not a gap: nothing is listed as unavailable.
    expect(local.unavailable).toEqual([])
  })

  it('the day\'s task bounds and the time window follow the phone\'s zone too', async () => {
    const tokyo = fakeCall({
      ...PRESENT,
      '/api/health/status': { connected: true, tz: 'Asia/Tokyo' },
      '/api/time/summary': { days: [{ date: '2026-09-22', humanMs: 30 * MIN, agentMs: 0, tasks: [] }] },
    })
    // 02:30Z: the 22nd in Tokyo, still the 21st in the Americas.
    const out = await runDayReview({ date: '2026-09-22', sections: 'tasks,time' }, tokyo.call as never, { now: Date.parse('2026-09-22T02:30:00Z') }) as any
    const tasks = tokyo.seen.find((r) => r.startsWith('GET /api/tasks?'))!
    const qs = new URLSearchParams(tasks.split('?')[1])
    expect(qs.get('time_from')).toBe('2026-09-21T15:00:00.000Z')
    expect(qs.get('time_until')).toBe('2026-09-22T15:00:00.000Z')
    // Today in the phone's zone, not "the future" by a Mac in another zone; one day of
    // slack because time tracking keys days by the Mac's calendar.
    expect(out.sections.time).toMatchObject({ humanMin: 30 })
    expect(tokyo.seen).toContain('GET /api/time/summary?days=2')
    expect(out.unavailable).toEqual([])
  })

  it('shares ONE deadline between the zone lookup and the sections', async () => {
    vi.useFakeTimers()
    const { call } = fakeCall(PRESENT)
    const slow = async (method: string, path: string): Promise<unknown> => {
      if (path.startsWith('/api/health/status')) return new Promise((resolve) => setTimeout(() => resolve({ connected: true, tz: 'America/New_York' }), 30))
      if (path.startsWith('/api/plugins/calendar')) return new Promise(() => {})
      return call(method, path)
    }
    let done = false
    const review = runDayReview({ date: DATE }, slow as never, { timeoutMs: 80, now: NOW }).then((out) => { done = true; return out as any })
    // One budget: the review is over at 80ms, not 30ms (the zone) plus 80ms (the sections).
    await vi.advanceTimersByTimeAsync(81)
    expect(done).toBe(true)
    const out = await review
    expect(out.unavailable).toEqual([{ section: 'calendar', reason: 'did not answer within 80ms' }])
    expect(out.tz).toBe('America/New_York')
  })

  it('a zone lookup that does not answer is listed in unavailable, and this machine\'s zone is used', async () => {
    vi.useFakeTimers()
    const { call } = fakeCall(PRESENT)
    const stuck = async (method: string, path: string): Promise<unknown> => (
      path.startsWith('/api/health/status') ? new Promise(() => {}) : call(method, path))
    const review = runDayReview({ date: DATE, sections: 'tasks,calendar' }, stuck as never, { timeoutMs: 80, now: NOW })
    await vi.advanceTimersByTimeAsync(81)
    const out = await review as any
    const machine = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(out.tz).toBe(machine)
    expect(out.unavailable).toEqual([{
      section: 'timezone',
      // The lookup gets half the budget, so the sections waiting on it still have time.
      reason: `the phone's time zone could not be read (did not answer within 40ms): this machine's zone (${machine}) was used`,
    }])
    // Both sections still answered: calendar never waited for the zone.
    expect(Object.keys(out.sections).sort()).toEqual(['calendar', 'tasks'])
  })

  it('a night with a recording gap tells the agent not to state its wake time', async () => {
    const gap = { side: 'after', start: `${NEXT}T03:00:00-04:00`, end: `${NEXT}T04:10:00-04:00`, min: 70, unrecordedMin: 70, otherSleepMin: 170 }
    const { call } = fakeCall({ ...PRESENT, '/api/health/sleep': { nights: [night(DATE), night(NEXT, { wake: `${NEXT}T03:00:00-04:00`, unrecordedGaps: [gap] })] } })
    const out = await runDayReview({ date: DATE, sections: 'sleep' }, call as never, { now: NOW }) as any
    expect(out.sections.sleep).toMatchObject({ wakeDate: NEXT, unrecordedGaps: [gap] })
    expect(out.sections.sleep.note).toMatch(/do not state its wake time or bedtime as fact/)
  })

  it('with every source missing, returns no sections and one reason per section', async () => {
    const { call } = fakeCall({
      '/api/tasks': new Error('Request failed (500): disk'),
      '/api/time/summary': { days: [] },
      '/api/time/apps': { enabled: false, totalMs: 0 },
      '/api/time/screentime': { enabled: false },
      // Calendar plugin not installed and Rhythm absent both answer 404.
      '/api/health/sleep': { connected: false, nights: [] },
      '/api/health/daily': { connected: false, days: [] },
    })
    const out = await runDayReview({ date: DATE }, call as never, { now: NOW }) as any
    expect(out.sections).toEqual({})
    const reasons = Object.fromEntries(out.unavailable.map((u: { section: string; reason: string }) => [u.section, u.reason]))
    expect(Object.keys(reasons).sort()).toEqual([...DAY_REVIEW_SECTIONS].sort())
    expect(reasons.tasks).toMatch(/500/)
    expect(reasons.time).toBe('no time was recorded that day')
    expect(reasons.apps).toMatch(/sampling is off/)
    expect(reasons.screentime).toMatch(/Screen Time import is off/)
    expect(reasons.calendar).toBe('not installed or turned off')
    expect(reasons.focus).toBe('not installed or turned off')
    expect(reasons.sleep).toBe('Apple Health is not connected')
    expect(reasons.activity).toBe('Apple Health is not connected')
  })

  it('a connected store with no night or no day says so, not "not connected"', async () => {
    const { call } = fakeCall({ ...PRESENT, '/api/health/sleep': { nights: [{ date: DATE, status: 'missing' }] }, '/api/health/daily': { days: [] } })
    const out = await runDayReview({ date: DATE, sections: 'sleep,activity' }, call as never, { now: NOW }) as any
    expect(out.unavailable).toEqual([
      { section: 'sleep', reason: 'no night was recorded for this wake date' },
      { section: 'activity', reason: 'nothing has synced from Apple Health for this day' },
    ])
  })

  it('a phone that stopped syncing reads as not connected, with the last sync, not as missing', async () => {
    // The sleep and daily reads only say `connected: false` when no store exists:
    // health_status is the one that knows nothing has synced for 3 days.
    const stale = { connected: false, tz: 'America/New_York', lastUploadAt: '2026-09-17T12:00:00.000Z' }
    const { call } = fakeCall({
      ...PRESENT, '/api/health/status': stale,
      '/api/health/sleep': { nights: [{ date: DATE, status: 'missing' }, { date: NEXT, status: 'missing' }] }, '/api/health/daily': { days: [] },
    })
    const out = await runDayReview({ date: DATE, sections: 'sleep,activity' }, call as never, { now: NOW }) as any
    expect(out.unavailable).toEqual([
      { section: 'sleep', reason: 'Apple Health is not connected: nothing has synced since 2026-09-17' },
      { section: 'activity', reason: 'Apple Health is not connected: nothing has synced since 2026-09-17' },
    ])
    // A day that did sync before the phone stopped is still reported.
    const before = fakeCall({ ...PRESENT, '/api/health/status': stale })
    const kept = await runDayReview({ date: DATE, sections: 'activity' }, before.call as never, { now: NOW }) as any
    expect(kept.unavailable).toEqual([])
    expect(kept.sections.activity).toMatchObject({ activity: { steps: 8000 } })
    // Activity alone (no zone needed) still asks health_status, once.
    expect(before.seen.filter((r) => r.startsWith('GET /api/health/status'))).toHaveLength(1)
    // A store whose phone never synced.
    const never = fakeCall({ ...PRESENT, '/api/health/status': { connected: false, lastUploadAt: null }, '/api/health/daily': { days: [] } })
    const none = await runDayReview({ date: DATE, sections: 'activity' }, never.call as never, { now: NOW }) as any
    expect(none.unavailable).toEqual([{ section: 'activity', reason: 'Apple Health is not connected: the phone has never synced' }])
  })

  it('a source that never answers is listed as unavailable at its deadline; the rest still arrive', async () => {
    const { call } = fakeCall(PRESENT)
    const hanging = async (method: string, path: string): Promise<unknown> => (
      path.startsWith('/api/plugins/calendar') ? new Promise(() => {}) : call(method, path))
    const t0 = Date.now()
    const out = await runDayReview({ date: DATE }, hanging as never, { timeoutMs: 50, now: NOW }) as any
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(out.unavailable).toEqual([{ section: 'calendar', reason: 'did not answer within 50ms' }])
    expect(Object.keys(out.sections)).toHaveLength(DAY_REVIEW_SECTIONS.length - 1)
    expect(DAY_REVIEW_TIMEOUT_MS).toBe(10_000)
  })

  it('refuses an unknown section instead of silently skipping it', async () => {
    await expect(runDayReview({ sections: 'sleep,mood' }, fakeCall(PRESENT).call as never)).rejects.toThrow(/unknown section/)
  })

  it('defaults to yesterday before noon and to today after, in the given zone', () => {
    expect(defaultReviewDate(new Date(2026, 8, 21, 9, 0))).toBe('2026-09-20')
    expect(defaultReviewDate(new Date(2026, 8, 21, 13, 0))).toBe('2026-09-21')
    expect(defaultReviewDate(new Date(Date.parse('2026-09-21T09:00:00-04:00')), 'America/New_York')).toBe('2026-09-20')
  })
})

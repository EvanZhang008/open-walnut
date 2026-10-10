/**
 * The day timeline merge, PURE: sourced segments in, one serial timeline per day
 * out. No I/O, no clock (the caller passes `nowMs`).
 *
 * The rule a reader must be able to repeat: for every minute, the ACTIVITY
 * segment with the highest source priority wins (walnut 100 > Mac apps 90 >
 * calls 85 > sleep 70 > workouts 60 > calendar 50; a plugin's ≤ 80, default 40); ties go to
 * measured over planned over inferred, then to the later-starting, shorter
 * segment (the more specific one). PLACE segments never compete: they annotate.
 *
 * Then the minutes are made readable:
 *   - screen time (walnut + app) joins into one block across gaps up to
 *     SCREEN_GAP_MS, with its top tasks and apps inside; a short non-screen piece
 *     inside such a block is absorbed (a calendar meeting the user sat through on
 *     Zoom is listed in `during`, not as a 30-second sliver);
 *   - other pieces of the same source, kind and label join across 5 minutes;
 *   - a hole of GAP_MIN_MS or more becomes a `gap` block (unknown, with the place
 *     the user was at, when Places knew it).
 */

import { localIso } from '../../health/day-key.js'
import { coveredMs, mergeSpans, type Span } from '../calls.js'
import { isWorkday, workMsOf, WEEKDAY_NAMES, type WorkHours } from '../work-hours.js'
import {
  assignCalls, EMPTY_MEETING_CONTEXT, isIgnoredMeeting, meetingAttendance, settleDoubleBooked,
  type Attendance, type AttendanceBasis, type MeetingAttendance, type MeetingContext,
} from './meetings.js'
import type { SourcedSegment, TimelineConfidence } from './types.js'

export const SCREEN_KINDS: ReadonlySet<string> = new Set(['walnut', 'app'])
const PLANNED_KINDS: ReadonlySet<string> = new Set(['meeting', 'plan'])
export const SCREEN_GAP_MS = 10 * 60_000
export const SAME_JOIN_MS = 5 * 60_000
export const GAP_MIN_MS = 15 * 60_000
/** A planned block shorter than this is not checked against what happened. */
const PLAN_MIN_MS = 10 * 60_000
const MIN = 60_000
const minutes = (ms: number): number => Math.round(ms / MIN)

const CONFIDENCE_RANK: Record<TimelineConfidence, number> = { measured: 3, planned: 2, inferred: 1 }

export interface DayBounds { date: string; startMs: number; endMs: number }

interface Piece { startMs: number; endMs: number; seg: SourcedSegment }

/** Prefer: priority, confidence, later start, shorter. */
function better(a: SourcedSegment, b: SourcedSegment): boolean {
  if (a.priority !== b.priority) return a.priority > b.priority
  const ca = CONFIDENCE_RANK[a.confidence] ?? 0
  const cb = CONFIDENCE_RANK[b.confidence] ?? 0
  if (ca !== cb) return ca > cb
  if (a.startMs !== b.startMs) return a.startMs > b.startMs
  return a.endMs - a.startMs < b.endMs - b.startMs
}

function sameItem(a: SourcedSegment, b: SourcedSegment): boolean {
  return a.source === b.source && a.kind === b.kind && a.label === b.label
    && (a.detail?.taskId ?? null) === (b.detail?.taskId ?? null)
}

/** Clip to [startMs, endMs), drop empties. */
function clip(segs: readonly SourcedSegment[], startMs: number, endMs: number): SourcedSegment[] {
  const out: SourcedSegment[] = []
  for (const s of segs) {
    const a = Math.max(s.startMs, startMs)
    const b = Math.min(s.endMs, endMs)
    if (b > a) out.push({ ...s, startMs: a, endMs: b })
  }
  return out
}

/** One winner per elementary interval, adjacent pieces of one item joined. */
export function resolveActivity(segs: readonly SourcedSegment[]): Piece[] {
  const sorted = [...segs].sort((a, b) => a.startMs - b.startMs)
  const points = [...new Set(sorted.flatMap((s) => [s.startMs, s.endMs]))].sort((a, b) => a - b)
  const pieces: Piece[] = []
  let active: SourcedSegment[] = []
  let next = 0
  for (let i = 0; i < points.length - 1; i++) {
    const t = points[i]!
    const u = points[i + 1]!
    active = active.filter((s) => s.endMs > t)
    while (next < sorted.length && sorted[next]!.startMs <= t) {
      if (sorted[next]!.endMs > t) active.push(sorted[next]!)
      next++
    }
    if (active.length === 0) continue
    let best = active[0]!
    for (const s of active) if (better(s, best)) best = s
    const last = pieces[pieces.length - 1]
    if (last && last.endMs === t && (last.seg === best || sameItem(last.seg, best))) last.endMs = u
    else pieces.push({ startMs: t, endMs: u, seg: best })
  }
  return pieces
}

export interface TimelineBlock {
  start: string
  end: string
  min: number
  kind: string
  label: string
  source: string
  confidence: TimelineConfidence
  /** Where the user was for most of it (Places), when known. */
  place?: string
  /** Screen blocks: the minutes actually tracked inside, and what they were. */
  trackedMin?: number
  top?: Array<{ kind: string; label: string; min: number; taskId?: string }>
  /** Calendar entries this block sat inside (a meeting the user was on screen for). */
  during?: string[]
  detail?: Record<string, string | number | boolean | null>
  flags?: string[]
}

interface ScreenBlock { startMs: number; endMs: number; pieces: Piece[] }

function screenBlocks(pieces: readonly Piece[]): ScreenBlock[] {
  const out: ScreenBlock[] = []
  for (const p of pieces) {
    if (!SCREEN_KINDS.has(p.seg.kind)) continue
    const last = out[out.length - 1]
    if (last && p.startMs - last.endMs <= SCREEN_GAP_MS) { last.endMs = Math.max(last.endMs, p.endMs); last.pieces.push(p) } else out.push({ startMs: p.startMs, endMs: p.endMs, pieces: [p] })
  }
  return out
}

/** Parts of [a, b) outside every block span. */
function outside(a: number, b: number, spans: readonly ScreenBlock[]): Array<[number, number]> {
  let parts: Array<[number, number]> = [[a, b]]
  for (const s of spans) {
    if (s.endMs <= a || s.startMs >= b) continue
    const nextParts: Array<[number, number]> = []
    for (const [x, y] of parts) {
      if (s.endMs <= x || s.startMs >= y) { nextParts.push([x, y]); continue }
      if (s.startMs > x) nextParts.push([x, s.startMs])
      if (s.endMs < y) nextParts.push([s.endMs, y])
    }
    parts = nextParts
  }
  return parts
}

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
}

function placeFor(startMs: number, endMs: number, places: readonly SourcedSegment[]): string | undefined {
  let best: SourcedSegment | undefined
  let bestMs = 0
  for (const p of places) {
    if (p.kind === 'travel') continue
    const o = overlap(startMs, endMs, p.startMs, p.endMs)
    if (o > bestMs) { best = p; bestMs = o }
  }
  return best && bestMs >= (endMs - startMs) / 2 ? best.label : undefined
}

const STOPWORDS = new Set([
  'with', 'from', 'that', 'this', 'into', 'for', 'and', 'the', 'via', 'not', 'all', 'new', 'get', 'set', 'out', 'off',
  'per', 'our', 'you', 'your', 'are', 'was', 'has', 'its', 'one', 'two', 'now', 'day', 'task', 'work', 'todo',
  'booked', 'block', 'meeting', 'review', 'sync', 'weekly', 'daily', 'tbd',
])

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu

/**
 * The words a title is matched on: Latin words of 3+ letters, short all-caps names
 * ("CIS", "Q4"), and every two-character piece of a CJK run (CJK has no spaces).
 * 2026-10-10: a block "<star>CIS Design 1 <CJK>: ..." never matched the task "Feedback on
 * CIS Design 1" because only words of 4+ letters counted and CJK counted as one word.
 */
export function titleTokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of text.split(/[^\p{L}\p{N}]+/u)) {
    if (!raw) continue
    for (const run of raw.match(CJK) ?? []) for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2))
    for (const word of raw.replace(CJK, ' ').split(' ')) {
      if (!word) continue
      const lower = word.toLowerCase()
      const acronym = word.length >= 2 && word === word.toUpperCase() && /\p{L}/u.test(word)
      if ((lower.length >= 3 || acronym) && !STOPWORDS.has(lower)) out.add(lower)
    }
  }
  return out
}
const tokens = titleTokens

const MEETING_APP = /zoom|chime|teams|webex|facetime|meet\.google|meetings\./i

export interface PlanCheck {
  title: string
  kind: string
  start: string
  end: string
  min: number
  /** Measured screen minutes inside the block. */
  screenMin: number
  topTasks: Array<{ taskId: string; title: string; min: number }>
  topApps: Array<{ app: string; min: number }>
  /** The task the block names (by id, or by shared title words), with its minutes. */
  matched?: { taskId: string; title: string; minInBlock: number; minThatDay: number; by: 'id' | 'title' }
  verdict: 'kept' | 'partly' | 'other_work' | 'meeting_on_screen' | 'not_on_screen'
  /** Meetings: attended or not, from the call (meetings.ts), and why. */
  attendance?: Attendance
  attendanceBasis?: AttendanceBasis
  /** Call minutes in the meeting, its overrun past the calendar end included. */
  callMin?: number
  /** The call ran this long past the calendar end. */
  overrunMin?: number
  /** Attended: minutes in the meeting, other work included (the call, or the whole meeting on the user's word). */
  attendedMin?: number
  /** Counted meeting minutes: the call minus other work while on it. */
  meetingMin?: number
  /** Other work while on the call. */
  otherWorkMin?: number
  /** The calendar occurrence, for time_meeting_attendance_set. */
  eventId?: string
}

function planChecks(
  day: DayBounds, planned: readonly SourcedSegment[], pieces: readonly Piece[], tz: string, calls: readonly Span[], ctx: MeetingContext,
): { checks: PlanCheck[]; meetingSpans: Array<[number, number]>; attendedSpans: Array<[number, number]> } {
  const meetings: Array<{ check: PlanCheck; attendance: MeetingAttendance; inCall: Array<[number, number]>; eventId?: string }> = []
  const dayTaskMs = new Map<string, number>()
  for (const p of pieces) {
    const id = p.seg.detail?.taskId
    if (p.seg.kind === 'walnut' && typeof id === 'string') dayTaskMs.set(id, (dayTaskMs.get(id) ?? 0) + (p.endMs - p.startMs))
  }
  const out: PlanCheck[] = []
  // One call is one meeting's, whole, its run past the calendar end included.
  const checked = planned.filter((p) => p.kind === 'meeting' && p.endMs - p.startMs >= PLAN_MIN_MS)
  const owned = new Map(assignCalls(checked, ctx.sessions ?? calls).map((spans, i) => [checked[i]!, spans] as const))
  for (const ev of planned) {
    if (ev.endMs - ev.startMs < PLAN_MIN_MS) continue
    const own = owned.get(ev) ?? []
    const until = Math.max(ev.endMs, ...own.map(([, b]) => b))
    const tasks = new Map<string, { title: string; ms: number }>()
    const apps = new Map<string, number>()
    let screenMs = 0
    for (const p of pieces) {
      if (!SCREEN_KINDS.has(p.seg.kind)) continue
      const o = overlap(ev.startMs, ev.endMs, p.startMs, p.endMs)
      if (o <= 0) continue
      screenMs += o
      const id = p.seg.detail?.taskId
      if (p.seg.kind === 'walnut') {
        const key = typeof id === 'string' ? id : ''
        const t = tasks.get(key) ?? { title: p.seg.label, ms: 0 }
        t.ms += o
        tasks.set(key, t)
      } else apps.set(p.seg.label, (apps.get(p.seg.label) ?? 0) + o)
    }
    const blockMs = ev.endMs - ev.startMs
    const title = ev.label
    // Match the block to a task: a task id written in the title wins; else, of the tasks
    // sharing enough title words, the one with the most time in the block (2026-10-10: a
    // task sharing three words but 4 minutes beat the one sharing two with 62).
    let matched: PlanCheck['matched']
    const idInTitle = /\b([a-z0-9]{8}-[a-z0-9]{4})\b/.exec(title)?.[1]
    const evWords = tokens(title)
    let best: { rank: number; ms: number } | undefined
    for (const [taskId, t] of tasks) {
      if (!taskId) continue
      const by: 'id' | 'title' = idInTitle && taskId === idInTitle ? 'id' : 'title'
      const shared = [...tokens(t.title)].filter((w) => evWords.has(w)).length
      if (by === 'title' && !(shared > 0 && shared >= Math.min(2, evWords.size))) continue
      const rank = by === 'id' ? 1 : 0
      if (!best || rank > best.rank || (rank === best.rank && t.ms > best.ms)) {
        best = { rank, ms: t.ms }
        matched = { taskId, title: t.title, minInBlock: minutes(t.ms), minThatDay: minutes(dayTaskMs.get(taskId) ?? t.ms), by }
      }
    }
    const meetingApps = [...apps.entries()].filter(([app]) => MEETING_APP.test(app)).reduce((s, [, ms]) => s + ms, 0)
    let attend: MeetingAttendance | undefined
    if (ev.kind === 'meeting') {
      // Other work = any screen piece that is not the call app itself.
      const otherWork: Span[] = []
      for (const p of pieces) {
        if (!SCREEN_KINDS.has(p.seg.kind) || (p.seg.kind === 'app' && MEETING_APP.test(p.seg.label))) continue
        const a = Math.max(ev.startMs, p.startMs)
        const b = Math.min(until, p.endMs)
        if (b > a) otherWork.push([a, b])
      }
      const d = ev.detail ?? {}
      attend = meetingAttendance({
        startMs: ev.startMs, endMs: ev.endMs, title,
        ...(typeof d.eventId === 'string' ? { eventId: d.eventId } : {}),
        ...(typeof d.seriesId === 'string' ? { seriesId: d.seriesId } : {}),
        ...(d.recurring === true ? { recurring: true } : {}),
        otherWork, calls: own,
      }, { ...ctx, calls })
    }
    const matchedMs = matched ? matched.minInBlock * MIN : 0
    const verdict: PlanCheck['verdict'] = ev.kind === 'meeting'
      ? (meetingApps >= blockMs * 0.3 ? 'meeting_on_screen' : screenMs >= blockMs * 0.5 ? 'other_work' : 'not_on_screen')
      : matchedMs >= blockMs * 0.5 ? 'kept'
        : matchedMs > 0 ? 'partly'
          : screenMs >= blockMs * 0.3 ? 'other_work' : 'not_on_screen'
    const check: PlanCheck = {
      title, kind: ev.kind,
      start: localIso(Math.max(ev.startMs, day.startMs), tz), end: localIso(Math.min(ev.endMs, day.endMs), tz),
      min: minutes(blockMs), screenMin: minutes(screenMs),
      topTasks: [...tasks.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 3)
        .map(([taskId, t]) => ({ taskId, title: t.title, min: minutes(t.ms) })),
      topApps: [...apps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([app, ms]) => ({ app, min: minutes(ms) })),
      ...(matched ? { matched } : {}),
      verdict,
    }
    out.push(check)
    if (attend) {
      meetings.push({
        check, attendance: attend, inCall: own,
        ...(typeof ev.detail?.eventId === 'string' ? { eventId: ev.detail.eventId } : {}),
      })
    }
  }
  // One call, two meetings at once: which one is the user's to say.
  settleDoubleBooked(meetings)
  for (const m of meetings) {
    const a = m.attendance
    Object.assign(m.check, {
      attendance: a.attendance, attendanceBasis: a.basis,
      callMin: minutes(a.callMs),
      ...(a.overrunMs >= MIN ? { overrunMin: minutes(a.overrunMs) } : {}),
      ...(a.attendance === 'attended' ? { attendedMin: minutes(a.spans.reduce((s, [x, y]) => s + (y - x), 0)) } : {}),
      meetingMin: minutes(a.meetingMs),
      ...(a.otherWorkMs >= MIN ? { otherWorkMin: minutes(a.otherWorkMs) } : {}),
      ...(m.eventId ? { eventId: m.eventId } : {}),
    })
  }
  return {
    checks: out,
    meetingSpans: mergeSpans(meetings.flatMap((m) => m.attendance.counted)),
    attendedSpans: mergeSpans(meetings.flatMap((m) => m.attendance.spans)),
  }
}

/** Starts and ends this close still make the same entry (a copy saved a minute off). */
const TWIN_SLACK_MS = 5 * 60_000

/**
 * Calendar entries at the same time (within TWIN_SLACK_MS at both ends) where one
 * title holds the other are one entry: a room booking, or the same meeting in two
 * calendars (2026-10-06: one at 13:29, its copy at 13:30, read as a double booking).
 */
function dedupePlanned(planned: SourcedSegment[]): SourcedSegment[] {
  const out: SourcedSegment[] = []
  for (const ev of planned.sort((a, b) => a.startMs - b.startMs || a.label.length - b.label.length)) {
    const twin = out.find((o) => Math.abs(o.startMs - ev.startMs) <= TWIN_SLACK_MS && Math.abs(o.endMs - ev.endMs) <= TWIN_SLACK_MS
      && (o.label.toLowerCase().includes(ev.label.toLowerCase()) || ev.label.toLowerCase().includes(o.label.toLowerCase())))
    if (!twin) out.push(ev)
  }
  return out
}

export interface DayTimeline {
  date: string
  weekday: string
  workday: boolean
  /** True for today: the day is cut at now. */
  partial?: true
  blocks: TimelineBlock[]
  places: TimelineBlock[]
  plan: PlanCheck[]
  summary: Record<string, unknown>
}

export interface MergeOptions {
  tz: string
  workHours: WorkHours
  nowMs: number
  /** Call history, coverage and the user's answers for meeting attendance. */
  meetings?: MeetingContext
}

function toBlock(startMs: number, endMs: number, seg: SourcedSegment, tz: string, places: readonly SourcedSegment[]): TimelineBlock {
  const place = seg.lane === 'activity' ? placeFor(startMs, endMs, places) : undefined
  return {
    start: localIso(startMs, tz), end: localIso(endMs, tz), min: minutes(endMs - startMs),
    kind: seg.kind, label: seg.label, source: seg.source, confidence: seg.confidence,
    ...(place ? { place } : {}),
    ...(seg.detail && Object.keys(seg.detail).length ? { detail: seg.detail } : {}),
    ...(seg.flags?.length ? { flags: seg.flags } : {}),
  }
}

/** Merge one day. `segments` may extend past the day: they are clipped here. */
export function mergeDay(day: DayBounds, segments: readonly SourcedSegment[], opts: MergeOptions): DayTimeline {
  const end = Math.min(day.endMs, Math.max(day.startMs, opts.nowMs))
  const activity = clip(segments.filter((s) => s.lane === 'activity'), day.startMs, end)
  const places = clip(segments.filter((s) => s.lane === 'place'), day.startMs, end)
  const ctx = opts.meetings ?? EMPTY_MEETING_CONTEXT
  const allPlanned = dedupePlanned(activity.filter((s) => PLANNED_KINDS.has(s.kind)))
  // Meetings the user asked to leave out (time.meetings.ignore) are not checked.
  const planned = allPlanned.filter((s) => s.kind !== 'meeting' || !isIgnoredMeeting(s.label, ctx.ignore))
  // A call from any source (core reads power assertions; a plugin may add its own).
  const calls = mergeSpans(activity.filter((s) => s.kind === 'call').map((s) => [s.startMs, s.endMs] as [number, number]))
  const pieces = resolveActivity(activity)
  const screens = screenBlocks(pieces)
  const blocks: Array<TimelineBlock & { _s: number; _e: number }> = []

  for (const sb of screens) {
    const byItem = new Map<string, { kind: string; label: string; ms: number; taskId?: string }>()
    let tracked = 0
    let walnutMs = 0
    for (const p of sb.pieces) {
      const ms = p.endMs - p.startMs
      tracked += ms
      if (p.seg.kind === 'walnut') walnutMs += ms
      const taskId = typeof p.seg.detail?.taskId === 'string' ? p.seg.detail.taskId : undefined
      const key = `${p.seg.kind}\u0000${taskId ?? p.seg.label}`
      const it = byItem.get(key) ?? { kind: p.seg.kind, label: p.seg.label, ms: 0, ...(taskId ? { taskId } : {}) }
      it.ms += ms
      byItem.set(key, it)
    }
    const top = [...byItem.values()].sort((a, b) => b.ms - a.ms).slice(0, 5)
    const during = planned
      .filter((ev) => overlap(sb.startMs, sb.endMs, ev.startMs, ev.endMs) >= Math.min(5 * MIN, (ev.endMs - ev.startMs) / 2))
      .map((ev) => ev.label)
    const place = placeFor(sb.startMs, sb.endMs, places)
    const onCallMs = coveredMs(sb.startMs, sb.endMs, calls)
    blocks.push({
      _s: sb.startMs, _e: sb.endMs,
      start: localIso(sb.startMs, opts.tz), end: localIso(sb.endMs, opts.tz), min: minutes(sb.endMs - sb.startMs),
      kind: 'screen',
      label: top.slice(0, 2).map((t) => `${t.label} ${minutes(t.ms)}m`).join(', '),
      source: walnutMs === tracked ? 'walnut' : walnutMs === 0 ? 'mac-apps' : 'walnut+mac-apps',
      confidence: 'measured',
      ...(place ? { place } : {}),
      trackedMin: minutes(tracked),
      top: top.map((t) => ({ kind: t.kind, label: t.label, min: minutes(t.ms), ...(t.taskId ? { taskId: t.taskId } : {}) })),
      ...(during.length ? { during: [...new Set(during)] } : {}),
      ...(onCallMs >= MIN ? { callMin: minutes(onCallMs) } : {}),
    })
  }

  // Non-screen pieces, outside every screen block, joined per item.
  const others: Piece[] = []
  for (const p of pieces) {
    if (SCREEN_KINDS.has(p.seg.kind)) continue
    for (const [a, b] of outside(p.startMs, p.endMs, screens)) {
      const last = others[others.length - 1]
      if (last && sameItem(last.seg, p.seg) && a - last.endMs <= SAME_JOIN_MS) last.endMs = b
      else others.push({ startMs: a, endMs: b, seg: p.seg })
    }
  }
  for (const p of others) {
    if (p.endMs - p.startMs < MIN) continue
    blocks.push({ ...toBlock(p.startMs, p.endMs, p.seg, opts.tz, places), _s: p.startMs, _e: p.endMs })
  }
  blocks.sort((a, b) => a._s - b._s)

  // Holes long enough to ask about.
  const withGaps: Array<TimelineBlock & { _s: number; _e: number }> = []
  let cursor = day.startMs
  const pushGap = (a: number, b: number): void => {
    if (b - a < GAP_MIN_MS) return
    const place = placeFor(a, b, places)
    const travel = places.find((p) => p.kind === 'travel' && overlap(a, b, p.startMs, p.endMs) >= (b - a) / 2)
    withGaps.push({
      _s: a, _e: b, start: localIso(a, opts.tz), end: localIso(b, opts.tz), min: minutes(b - a),
      kind: 'gap', label: travel ? `travel? ${travel.label}` : place ? `away from the Mac (at ${place})` : 'nothing recorded',
      source: 'timeline', confidence: 'inferred', ...(place ? { place } : {}),
    })
  }
  for (const b of blocks) {
    pushGap(cursor, b._s)
    withGaps.push(b)
    cursor = Math.max(cursor, b._e)
  }
  pushGap(cursor, end)

  // Summary: minutes per kind, whole day and work hours.
  const workday = isWorkday(day.date, opts.workHours)
  const sum = (pred: (p: Piece) => boolean, work = false): number => minutes(pieces.filter(pred)
    .reduce((s, p) => s + (work ? workMsOf(p.startMs, p.endMs, opts.workHours) : p.endMs - p.startMs), 0))
  const shown = (kind: string, work = false): number => minutes(others.filter((p) => p.seg.kind === kind)
    .reduce((s, p) => s + (work ? workMsOf(p.startMs, p.endMs, opts.workHours) : p.endMs - p.startMs), 0))
  const gapMs = (work: boolean): number => withGaps.filter((b) => b.kind === 'gap')
    .reduce((s, b) => s + (work ? workMsOf(b._s, b._e, opts.workHours) : b._e - b._s), 0)
  const byPlace: Record<string, number> = {}
  for (const p of places) {
    const key = p.kind === 'travel' ? 'travel (inferred)' : p.label
    byPlace[key] = (byPlace[key] ?? 0) + minutes(p.endMs - p.startMs)
  }
  const kindsSeen = [...new Set(others.map((p) => p.seg.kind))].filter((k) => !PLANNED_KINDS.has(k))
  const view = (work: boolean): Record<string, number> => ({
    screenMin: sum((p) => SCREEN_KINDS.has(p.seg.kind), work),
    walnutMin: sum((p) => p.seg.kind === 'walnut', work),
    appMin: sum((p) => p.seg.kind === 'app', work),
    plannedNotOnScreenMin: minutes(others.filter((p) => PLANNED_KINDS.has(p.seg.kind))
      .reduce((s, p) => s + (work ? workMsOf(p.startMs, p.endMs, opts.workHours) : p.endMs - p.startMs), 0)),
    // A call outside every screen block: the user on a call with the Mac idle.
    ...Object.fromEntries(kindsSeen.map((k) => [k === 'call' ? 'callOffScreenMin' : `${k}Min`, shown(k, work)])),
    gapMin: minutes(gapMs(work)),
  })

  const { checks: plan, meetingSpans: countedSpans, attendedSpans } = planChecks(day, planned, pieces, opts.tz, calls, ctx)
  const meetingChecks = plan.filter((p) => p.attendance !== undefined)
  const meetingSpans = mergeSpans(allPlanned.filter((s) => s.kind === 'meeting').map((s) => [s.startMs, s.endMs] as [number, number]))
  // A meeting's overrun is its call, not an ad-hoc one.
  const explained = mergeSpans([...meetingSpans, ...attendedSpans])
  const needsConfirmation = meetingChecks.filter((p) => p.attendance === 'needs_confirmation')
    .map((p) => ({ title: p.title, start: p.start, end: p.end, basis: p.attendanceBasis, ...(p.eventId ? { eventId: p.eventId } : {}) }))

  return {
    date: day.date,
    weekday: WEEKDAY_NAMES[new Date(day.startMs + 12 * 3_600_000).getDay()]!,
    workday,
    ...(end < day.endMs ? { partial: true as const } : {}),
    blocks: withGaps.map(({ _s, _e, ...b }) => b),
    places: places.map((p) => toBlock(p.startMs, p.endMs, p, opts.tz, [])),
    plan,
    summary: {
      wholeDay: view(false),
      ...(workday ? { workHours: view(true) } : {}),
      ...(Object.keys(byPlace).length ? { byPlaceMin: byPlace } : {}),
      ...(calls.length ? {
        callMin: minutes(calls.reduce((s, [a, b]) => s + (b - a), 0)),
        // Call time no planned meeting explains: an ad-hoc call.
        adHocCallMin: minutes(calls.reduce((s, [a, b]) => s + (b - a) - coveredMs(a, b, explained), 0)),
      } : {}),
      ...(meetingChecks.length ? {
        // Each second once, even when two attended meetings overlap. attendedMeetingMin is the
        // time in them; meetingMin the part with nothing else on screen.
        attendedMeetingMin: minutes(attendedSpans.reduce((s, [a, b]) => s + (b - a), 0)),
        meetingMin: minutes(countedSpans.reduce((s, [a, b]) => s + (b - a), 0)),
        meetings: Object.fromEntries((['attended', 'not_attended', 'needs_confirmation', 'unknown'] as const)
          .map((a) => [a, meetingChecks.filter((p) => p.attendance === a).length])),
      } : {}),
      ...(needsConfirmation.length ? { needsConfirmation } : {}),
      ...(planned.length < allPlanned.length ? { ignoredMeetings: allPlanned.length - planned.length } : {}),
    },
  }
}

/**
 * Was the user in a meeting? A calendar entry says a meeting was planned; a call
 * app holding a call on this Mac (calls.ts) says one ran. This module joins them
 * into an attendance per meeting, PURE, plus the async context it needs.
 *
 * The user's rule for a meeting (all of theirs run on a call):
 *   - a call overlaps it: attended. Meeting time = the call's minutes inside the
 *     meeting minus the seconds the user was doing something else on screen
 *     (Walnut input, another app frontmost; the call app itself is the meeting);
 *   - no call, and it is a recurring meeting never on a call in the lookback
 *     window: not attended;
 *   - no call, and the screen shows other work (anything but the call app) for
 *     at least half of it: not attended, the time belongs to that work;
 *   - no call and nothing recorded (the Mac idle, asleep or away, or only the
 *     call app in front): needs confirmation; with some other work but under
 *     half, needs confirmation too (basis some_other_work). Never counted and
 *     never guessed: the time review asks, and the user's answer
 *     (time_meeting_attendance_set) is kept on this Mac.
 * One call is one meeting (assignCalls): the call the user joined for a meeting
 * stays that meeting's past the calendar end, until it ends (2026-10-07: a
 * 15:15-16:00 meeting's call ran to 16:44, and the 44 minutes read as an ad-hoc
 * call; 2026-10-05: one 97-minute call under a 60-minute slot).
 * "No call" is only an answer inside call coverage (the stretch this Mac was
 * watching); outside it the attendance is unknown. One call under two meetings
 * at once is the user's to say too (settleDoubleBooked).
 */

import { coveredMs, mergeSpans, uncovered, type Span } from '../calls.js'

/** A call that overlaps a meeting by at least this much is the meeting. */
export const ATTEND_MIN_MS = 2 * 60_000
/** A call that started this long before the meeting and ended early in it ran over from before. */
const SPILL_LEAD_MS = 2 * 60_000
const SPILL_INTO_MS = 15 * 60_000
/** "No call" needs this share of the meeting inside call coverage. */
const COVERED_SHARE = 0.8
/** Screen time over this share of a meeting with no call is other work. */
const OTHER_WORK_SHARE = 0.5
/** Under this share the screen recorded nothing to speak of. */
const NOTHING_SHARE = 0.15
/** A series counts as never on a call only after this many watched occurrences. */
export const NEVER_MIN_OCCURRENCES = 2

export type Attendance = 'attended' | 'not_attended' | 'needs_confirmation' | 'unknown'
export type AttendanceBasis =
  | 'user' | 'call' | 'recurring_never_on_call' | 'other_work' | 'some_other_work' | 'nothing_recorded' | 'no_call_data' | 'double_booked'

export interface MeetingContext {
  /** Call intervals (merged across apps) around the range. */
  calls: ReadonlyArray<Span>
  /** One span per call, never joined to the next (callSessions); absent = `calls`. */
  sessions?: ReadonlyArray<Span>
  /** Where this Mac was watching for calls. */
  coverage: ReadonlyArray<Span>
  /** Series (seriesId) seen at least NEVER_MIN_OCCURRENCES times in coverage and never on a call. */
  neverOnCall: ReadonlySet<string>
  /** The user's own answers, by event occurrence id. */
  answers: ReadonlyMap<string, boolean>
  /** Lower-case title words or phrases the user asked to leave out. */
  ignore: readonly string[]
}

export const EMPTY_MEETING_CONTEXT: MeetingContext = { calls: [], coverage: [], neverOnCall: new Set(), answers: new Map(), ignore: [] }

export function isIgnoredMeeting(title: string, ignore: readonly string[]): boolean {
  const t = title.toLowerCase()
  return ignore.some((p) => p && t.includes(p))
}

/** The calls that belong to [a, b): overlapping it, minus a call that only ran over into its start. */
export function callsIn(a: number, b: number, calls: ReadonlyArray<Span>): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const [s, e] of calls) {
    if (e <= a || s >= b) continue
    const spill = s < a - SPILL_LEAD_MS && e - a < Math.min(SPILL_INTO_MS, (b - a) * 0.3)
    if (!spill) out.push([Math.max(a, s), Math.min(b, e)])
  }
  return out
}

/**
 * Which meeting each call belongs to, whole. A call (one session: callSessions)
 * belongs to the meeting it started in, or started up to SPILL_LEAD_MS before,
 * from that meeting's start to the call's end, past the calendar end included. A
 * call that started outside every meeting belongs to the meetings it runs into
 * beyond a spill (callsIn). A call that starts while two meetings run goes to
 * the one that has no call yet (the user left the first for the second); when
 * that does not settle it, to both, and settleDoubleBooked asks. Returns the
 * spans per meeting, in input order.
 */
export function assignCalls(meetings: ReadonlyArray<{ startMs: number; endMs: number }>, sessions: ReadonlyArray<Span>): Array<Array<[number, number]>> {
  const out = meetings.map(() => [] as Array<[number, number]>)
  for (const [s, e] of [...sessions].sort((x, y) => x[0] - y[0])) {
    let owners = meetings.flatMap((m, i) => (m.startMs - SPILL_LEAD_MS <= s && s < m.endMs ? [i] : []))
    if (owners.length > 1) {
      const fresh = owners.filter((i) => out[i]!.length === 0)
      if (fresh.length === 1) owners = fresh
    }
    if (owners.length === 0) owners = meetings.flatMap((m, i) => (callsIn(m.startMs, m.endMs, [[s, e]]).length ? [i] : []))
    for (const i of owners) {
      const a = Math.max(s, meetings[i]!.startMs)
      if (e > a) out[i]!.push([a, e])
    }
  }
  return out.map((spans) => mergeSpans(spans))
}

export interface MeetingFacts {
  startMs: number
  endMs: number
  title: string
  eventId?: string
  seriesId?: string
  recurring?: boolean
  /** Spans inside the meeting (and its call's overrun) the user was doing something else on screen (not the call app). */
  otherWork: ReadonlyArray<Span>
  /** This meeting's calls (assignCalls); absent = the calls inside it (callsIn). */
  calls?: ReadonlyArray<Span>
}

export interface MeetingAttendance {
  attendance: Attendance
  basis: AttendanceBasis
  /** Call time in the meeting (ms), its overrun past the calendar end included. */
  callMs: number
  /** The part of callMs after the calendar end. */
  overrunMs: number
  /** Counted meeting time: call minus other work while on it; 0 unless attended. */
  meetingMs: number
  /** Other work while on the call (ms). */
  otherWorkMs: number
  /**
   * The time in the meeting, other work included: the call, or the whole meeting
   * when the user said they attended and no call was heard. Kept for a double
   * booking (the user was in one of the two). Empty when not attended.
   */
  spans: Array<[number, number]>
  /** `spans` minus other work, so a day can count each second once. */
  counted: Array<[number, number]>
}

export function meetingAttendance(m: MeetingFacts, ctx: MeetingContext): MeetingAttendance {
  const len = m.endMs - m.startMs
  const inCall = mergeSpans(m.calls ?? callsIn(m.startMs, m.endMs, ctx.calls))
  const callMs = inCall.reduce((s, [a, b]) => s + (b - a), 0)
  const overrunMs = inCall.reduce((s, [a, b]) => s + Math.max(0, b - Math.max(a, m.endMs)), 0)
  const otherWork = mergeSpans(m.otherWork)
  const otherWorkMs = inCall.reduce((s, [a, b]) => s + coveredMs(a, b, otherWork), 0)
  const otherWorkInMeetingMs = coveredMs(m.startMs, m.endMs, otherWork)
  const minus = (spans: ReadonlyArray<Span>): Array<[number, number]> => spans.flatMap(([a, b]) => uncovered(a, b, otherWork))
  const sum = (spans: ReadonlyArray<Span>): number => spans.reduce((s, [a, b]) => s + (b - a), 0)
  const answer = m.eventId ? ctx.answers.get(m.eventId) : undefined
  if (answer !== undefined) {
    // The user's word. "Attended" with no call counts the meeting minus other work.
    const spans: Array<[number, number]> = answer ? (callMs > 0 ? inCall : [[m.startMs, m.endMs]]) : []
    const counted = minus(spans)
    return { attendance: answer ? 'attended' : 'not_attended', basis: 'user', callMs, overrunMs, meetingMs: sum(counted), otherWorkMs, spans, counted }
  }
  if (callMs >= Math.min(ATTEND_MIN_MS, len)) {
    const counted = minus(inCall)
    return { attendance: 'attended', basis: 'call', callMs, overrunMs, meetingMs: sum(counted), otherWorkMs, spans: inCall, counted }
  }
  const watched = coveredMs(m.startMs, m.endMs, ctx.coverage)
  const none = { callMs, overrunMs, meetingMs: 0, otherWorkMs, spans: [] as Array<[number, number]>, counted: [] as Array<[number, number]> }
  if (watched < len * COVERED_SHARE) return { attendance: 'unknown', basis: 'no_call_data', ...none }
  if (m.recurring && m.seriesId && ctx.neverOnCall.has(m.seriesId)) return { attendance: 'not_attended', basis: 'recurring_never_on_call', ...none }
  // The call app alone in front is no other work: with no call heard, that is the user's to say.
  if (otherWorkInMeetingMs >= len * OTHER_WORK_SHARE) return { attendance: 'not_attended', basis: 'other_work', ...none }
  // Some other work, under half: not enough to say either way.
  if (otherWorkInMeetingMs >= len * NOTHING_SHARE) return { attendance: 'needs_confirmation', basis: 'some_other_work', ...none }
  return { attendance: 'needs_confirmation', basis: 'nothing_recorded', ...none }
}

/**
 * Two meetings at the same time and one call: which one it was is a guess. When
 * the user said one of them was attended, the call was that one and the other is
 * not attended; else both go back to the user (needs confirmation, basis
 * `double_booked`). The call stays meeting time for the day either way (the user
 * was in one of them), so `spans` and `counted` keep it while `meetingMs` is 0. A meeting
 * the user marked not attended frees the call for the other. Mutates `list`.
 */
export function settleDoubleBooked<T extends { attendance: MeetingAttendance; inCall: ReadonlyArray<Span> }>(list: T[]): T[] {
  const shared = (a: T, b: T): boolean => {
    const ms = a.inCall.reduce((s, [x, y]) => s + coveredMs(x, y, b.inCall), 0)
    const smaller = Math.min(sumMs(a.inCall), sumMs(b.inCall))
    return ms > 0 && ms >= 0.5 * smaller
  }
  const onCall = list.filter((m) => m.attendance.basis === 'call')
  const answeredYes = list.filter((m) => m.attendance.basis === 'user' && m.attendance.attendance === 'attended')
  const taken = new Set(onCall.filter((m) => answeredYes.some((y) => shared(m, y))))
  const open = onCall.filter((m) => !taken.has(m))
  const doubled = new Set<T>()
  for (let i = 0; i < open.length; i++) {
    for (let j = i + 1; j < open.length; j++) {
      if (shared(open[i]!, open[j]!)) { doubled.add(open[i]!); doubled.add(open[j]!) }
    }
  }
  for (const m of taken) m.attendance = { ...m.attendance, attendance: 'not_attended', basis: 'double_booked', meetingMs: 0, spans: [], counted: [] }
  for (const m of doubled) m.attendance = { ...m.attendance, attendance: 'needs_confirmation', basis: 'double_booked', meetingMs: 0 }
  return list
}

const sumMs = (spans: ReadonlyArray<Span>): number => spans.reduce((s, [a, b]) => s + (b - a), 0)

export interface SeriesOccurrence { seriesId: string; startMs: number; endMs: number }

/**
 * Series never on a call: every occurrence inside coverage had no call, and there
 * were at least NEVER_MIN_OCCURRENCES of them. An occurrence the user answered
 * "attended" counts as on a call.
 */
export function seriesNeverOnCall(
  occurrences: readonly SeriesOccurrence[], calls: ReadonlyArray<Span>, coverage: ReadonlyArray<Span>,
  attendedSeries: ReadonlySet<string> = new Set(),
): Set<string> {
  const stats = new Map<string, { watched: number; onCall: number }>()
  for (const o of occurrences) {
    const len = o.endMs - o.startMs
    if (len <= 0 || coveredMs(o.startMs, o.endMs, coverage) < len * COVERED_SHARE) continue
    const st = stats.get(o.seriesId) ?? { watched: 0, onCall: 0 }
    st.watched++
    const callMs = callsIn(o.startMs, o.endMs, calls).reduce((s, [a, b]) => s + (b - a), 0)
    if (callMs >= Math.min(ATTEND_MIN_MS, len)) st.onCall++
    stats.set(o.seriesId, st)
  }
  const out = new Set<string>()
  for (const [id, st] of stats) if (st.watched >= NEVER_MIN_OCCURRENCES && st.onCall === 0 && !attendedSeries.has(id)) out.add(id)
  return out
}

/** The series an occurrence id belongs to: macOS calendar ids carry `#<occurrence>` after the series. */
export function seriesIdOf(eventId: string): string {
  const i = eventId.indexOf('#')
  return i > 0 ? eventId.slice(0, i) : eventId
}

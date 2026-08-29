/**
 * The Overview's scope arithmetic — PURE, so the rules are asserted without a browser
 * (tests/web/time-scope.test.ts).
 *
 * A scope is ONE selected day, or the seven days ending on it. Both readings fold the
 * same `/api/time/summary` window the shell already fetched, so switching scope costs
 * no request and the day nav can never point at a day the summary does not carry.
 *
 * The two lanes travel together through every helper here and are never added: the
 * Overview shows your time and agent runtime side by side, because agents run in
 * parallel and one combined number reads as a working day nobody worked.
 */

import type { DayTime, TaskDayTime, TimeSummary } from './api'
import { dayLabel, dayStartMs, shiftDate } from './time-timeline'

/** Days on the trend chart, and the length of the week scope. */
export const TREND_DAYS = 7
/**
 * The window the shell fetches. Deeper than the trend on purpose: the day nav walks
 * days the summary already carries, so a 7-day fetch would leave it with one step of
 * history before both arrows are dead.
 */
export const WINDOW_DAYS = 14

export type ScopeMode = 'day' | 'week'

export interface Scope {
  mode: ScopeMode
  /** The selected day; in week mode, the LAST day of the seven. */
  date: string
}

export interface LaneTotals {
  humanMs: number
  agentMs: number
}

export interface DayLanes extends LaneTotals {
  date: string
}

/** The calendar days a scope covers, ascending. */
export function scopeDates(scope: Scope): string[] {
  if (scope.mode === 'day') return [scope.date]
  const out: string[] = []
  for (let i = TREND_DAYS - 1; i >= 0; i -= 1) out.push(shiftDate(scope.date, -i))
  return out
}

/**
 * The fetched days a scope covers. Intersected with the window rather than clamped,
 * so a week scope near the oldest fetched day answers with the days that exist
 * instead of inventing empty ones the summary never spoke for.
 */
export function daysInScope(summary: TimeSummary | null, scope: Scope): DayTime[] {
  const wanted = new Set(scopeDates(scope))
  return (summary?.days ?? []).filter((day) => wanted.has(day.date))
}

/** The day nav's own label: one day, or the range the week covers. */
export function scopeLabel(scope: Scope): string {
  if (scope.mode === 'day') return dayLabel(scope.date)
  return `${shortDayLabel(shiftDate(scope.date, -(TREND_DAYS - 1)))} to ${shortDayLabel(scope.date)}`
}

/** The phrase a stat card ends with, in the reader's terms rather than a date range. */
export function scopeHint(scope: Scope, today: string): string {
  if (scope.mode === 'week') return `${TREND_DAYS} days to ${shortDayLabel(scope.date)}`
  return scope.date === today ? 'today' : dayLabel(scope.date)
}

/** "Aug 23". */
export function shortDayLabel(date: string): string {
  const ms = dayStartMs(date)
  if (!Number.isFinite(ms)) return date
  return new Date(ms).toLocaleDateString('en', { month: 'short', day: 'numeric' })
}

/**
 * Both lanes per day, ascending, under the caller's filters. A day the filters empty
 * stays in the list at zero: it is a real day you did none of that work on, and
 * dropping it would both break the trend's calendar and inflate the average.
 */
export function dayLanes(
  days: readonly DayTime[],
  keep: (taskId: string) => boolean,
  humanMsOf: (task: TaskDayTime) => number,
): DayLanes[] {
  return days.map((day) => {
    let humanMs = 0
    let agentMs = 0
    for (const task of day.tasks) {
      if (!keep(task.taskId)) continue
      humanMs += Math.max(0, humanMsOf(task) || 0)
      agentMs += Math.max(0, task.agentMs || 0)
    }
    return { date: day.date, humanMs, agentMs }
  })
}

/**
 * Per-day average over the whole window. Divided by CALENDAR days, never by days
 * that happen to carry data: an average that skips your days off answers "how much
 * per day?" with a number you have never actually sustained.
 */
export function averageLanes(lanes: readonly DayLanes[]): LaneTotals {
  if (lanes.length === 0) return { humanMs: 0, agentMs: 0 }
  let humanMs = 0
  let agentMs = 0
  for (const lane of lanes) {
    humanMs += lane.humanMs
    agentMs += lane.agentMs
  }
  return { humanMs: humanMs / lanes.length, agentMs: agentMs / lanes.length }
}

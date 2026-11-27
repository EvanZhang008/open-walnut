/**
 * How Rhythm's numbers read in the App. PURE.
 */
import { clockTime } from '../server/clock'
import type { RhythmPublicState } from './store'

const MIN = 60_000

/** "0 min", "45 min", "1h 03m". */
export function minutesText(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MIN))
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** "24:59" for a countdown, "1:04:05" past an hour. */
export function countdownText(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0')
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${mm}:${String(s).padStart(2, '0')}`
}


export function focusPhaseText(phase: RhythmPublicState['focus']['phase'], breakKind?: 'short' | 'long' | 'stand'): string {
  if (phase === 'focus') return 'Focus'
  if (phase === 'break') return breakKind === 'long' ? 'Long break' : 'Break'
  if (phase === 'break_due') return 'Break'
  return 'Off'
}

/** "Started 10:05, ends 10:30" for the run in progress, "Last run 10:05 to 10:35" when off. */
export function runText(focus: RhythmPublicState['focus']): string {
  if ((focus.phase === 'focus' || focus.phase === 'break') && focus.endsAt !== null) {
    const started = focus.runStartedAt ?? focus.startedAt
    const what = focus.phase === 'focus' ? 'ends' : 'break ends'
    return started !== null ? `Started ${clockTime(started)}, ${what} ${clockTime(focus.endsAt)}` : `${what} ${clockTime(focus.endsAt)}`
  }
  if (focus.lastRun) return `Last run ${clockTime(focus.lastRun.startedAt)} to ${clockTime(focus.lastRun.endedAt)}`
  return 'No run yet'
}

/** The dial's value under "This run" / "Last run": just the two times. */
export function runSpanText(focus: RhythmPublicState['focus']): string {
  if ((focus.phase === 'focus' || focus.phase === 'break') && focus.endsAt !== null) {
    const started = focus.runStartedAt ?? focus.startedAt
    return started !== null ? `${clockTime(started)} to ${clockTime(focus.endsAt)}` : `Until ${clockTime(focus.endsAt)}`
  }
  if (focus.lastRun) return `${clockTime(focus.lastRun.startedAt)} to ${clockTime(focus.lastRun.endedAt)}`
  return 'None yet'
}

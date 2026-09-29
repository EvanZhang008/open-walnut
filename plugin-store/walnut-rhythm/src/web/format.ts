/**
 * How Rhythm's numbers read in the App. PURE.
 */
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

export function clockText(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** One line for "when is the next stand-up reminder". */
export function nextReminderText(state: RhythmPublicState): string {
  const { reminder, sitting } = state
  switch (reminder.phase) {
    case 'away': return 'Not at the keyboard'
    case 'paused':
      if (reminder.pausedBy === 'quiet_hours') return 'Paused: quiet hours'
      if (reminder.pausedBy === 'focus') return 'Paused: focus block'
      return 'Paused: quiet mode'
    case 'deferred': return 'Due, waiting for the agent turn to finish'
    case 'due': return 'Due now'
    case 'snoozed':
    case 'counting': {
      if (reminder.dueAt === null || sitting.lastActiveAt === null) return 'Counting'
      const left = Math.max(0, reminder.dueAt - sitting.lastActiveAt)
      const prefix = reminder.phase === 'snoozed' ? 'Snoozed, back in' : 'In'
      return `${prefix} ${minutesText(left)} at the keyboard`
    }
  }
}

export function focusPhaseText(phase: RhythmPublicState['focus']['phase'], breakKind?: 'short' | 'long' | 'stand'): string {
  if (phase === 'focus') return 'Focus'
  if (phase === 'break') return breakKind === 'long' ? 'Long break' : breakKind === 'stand' ? 'Stand-up break' : 'Break'
  if (phase === 'break_due') return 'Block done'
  return 'Idle'
}

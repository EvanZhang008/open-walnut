/**
 * One day's scorecard, stored as `days/<YYYY-MM-DD>.json` in the plugin's data
 * directory. PURE reducers; the runtime owns reading and writing the file.
 *
 * `breaksTaken` counts every time the person actually moved: Done (on a reminder or on
 * its own), a focus break started, or walking away (for the away threshold) while a reminder or a
 * finished block was still waiting for an answer. That last one matters: the reminder
 * worked even though nobody clicked it.
 */

export interface FocusBlockEntry {
  /** End of the block, epoch ms. */
  at: number
  minutes: number
  taskId?: string
  title?: string
}

export interface DayLog {
  date: string
  focusBlocks: FocusBlockEntry[]
  focusMinutes: number
  stoppedBlocks: number
  breaksTaken: number
  focusBreaks: number
  remindersFired: number
  remindersDone: number
  remindersSnoozed: number
  /** Reminders answered by walking away rather than by a click. */
  movedWithoutClick: number
  longestStreakMs: number
}

/** A day holds at most this many block entries; the counters keep counting past it. */
export const MAX_BLOCK_ENTRIES = 100

export function emptyDay(date: string): DayLog {
  return {
    date,
    focusBlocks: [],
    focusMinutes: 0,
    stoppedBlocks: 0,
    breaksTaken: 0,
    focusBreaks: 0,
    remindersFired: 0,
    remindersDone: 0,
    remindersSnoozed: 0,
    movedWithoutClick: 0,
    longestStreakMs: 0,
  }
}

export function parseDay(raw: unknown, date: string): DayLog {
  const base = emptyDay(date)
  if (!raw || typeof raw !== 'object') return base
  const value = raw as Record<string, unknown>
  const count = (key: keyof DayLog): number => {
    const n = value[key]
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0
  }
  const blocks = Array.isArray(value.focusBlocks)
    ? value.focusBlocks.filter((b): b is FocusBlockEntry => !!b && typeof b === 'object'
      && typeof (b as FocusBlockEntry).at === 'number' && typeof (b as FocusBlockEntry).minutes === 'number')
    : []
  return {
    ...base,
    focusBlocks: blocks.slice(-MAX_BLOCK_ENTRIES),
    focusMinutes: count('focusMinutes'),
    stoppedBlocks: count('stoppedBlocks'),
    breaksTaken: count('breaksTaken'),
    focusBreaks: count('focusBreaks'),
    remindersFired: count('remindersFired'),
    remindersDone: count('remindersDone'),
    remindersSnoozed: count('remindersSnoozed'),
    movedWithoutClick: count('movedWithoutClick'),
    longestStreakMs: count('longestStreakMs'),
  }
}

export type DayChange =
  | { type: 'block'; entry: FocusBlockEntry }
  | { type: 'stopped' }
  | { type: 'break' }
  | { type: 'focus-break' }
  | { type: 'reminder-fired' }
  | { type: 'reminder-done' }
  | { type: 'reminder-snoozed' }
  | { type: 'moved-without-click' }
  | { type: 'streak'; ms: number }

export function applyDay(day: DayLog, change: DayChange): DayLog {
  switch (change.type) {
    case 'block':
      return {
        ...day,
        focusBlocks: [...day.focusBlocks, change.entry].slice(-MAX_BLOCK_ENTRIES),
        focusMinutes: day.focusMinutes + change.entry.minutes,
      }
    case 'stopped': return { ...day, stoppedBlocks: day.stoppedBlocks + 1 }
    case 'break': return { ...day, breaksTaken: day.breaksTaken + 1 }
    case 'focus-break': return { ...day, focusBreaks: day.focusBreaks + 1, breaksTaken: day.breaksTaken + 1 }
    case 'reminder-fired': return { ...day, remindersFired: day.remindersFired + 1 }
    case 'reminder-done': return { ...day, remindersDone: day.remindersDone + 1, breaksTaken: day.breaksTaken + 1 }
    case 'reminder-snoozed': return { ...day, remindersSnoozed: day.remindersSnoozed + 1 }
    case 'moved-without-click': return { ...day, movedWithoutClick: day.movedWithoutClick + 1, breaksTaken: day.breaksTaken + 1 }
    case 'streak': return change.ms > day.longestStreakMs ? { ...day, longestStreakMs: change.ms } : day
  }
}

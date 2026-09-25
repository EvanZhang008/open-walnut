/**
 * Focus blocks (a pomodoro tied to a task) and the one quiet hold Rhythm owns. PURE.
 *
 *   idle ──start──▶ focus ──time up──▶ break_due ──Start break──▶ break ──time up──▶ idle
 *                     │                   │  └──Skip break / expiry──▶ idle
 *                     └──stop──▶ idle     └──Another block──▶ focus
 *
 * `break_due` is the moment the block ended and the person has not answered yet. It
 * waits for a click rather than starting the break on its own, so "Start break" means
 * what it says; if nobody answers it lapses after BREAK_DUE_EXPIRY_MS. Every Nth
 * completed block is followed by the long break, and the cycle count starts over
 * after the long break or after a long idle spell.
 */

export type FocusPhase = 'idle' | 'focus' | 'break_due' | 'break'
export type BreakKind = 'short' | 'long'

export interface FocusState {
  phase: FocusPhase
  taskId?: string
  title?: string
  /** This block's focus length, kept for "Another block". */
  minutes: number
  /** The current phase's window, epoch ms. Both 0 while idle. */
  startedAt: number
  endsAt: number
  /** Blocks completed since the last long break. */
  completedInCycle: number
  breakKind?: BreakKind
  /** When the latest block (or break) finished, epoch ms. 0 = never. */
  lastEndedAt: number
}

export interface FocusDurations {
  focusMinutes: number
  breakMinutes: number
  longBreakMinutes: number
  longBreakEvery: number
}

export interface CompletedBlock {
  startedAt: number
  endedAt: number
  minutes: number
  taskId?: string
  title?: string
}

export type FocusEvent =
  | { type: 'focus-completed'; block: CompletedBlock; breakKind: BreakKind; lateMs: number }
  | { type: 'break-ended'; breakKind: BreakKind; lateMs: number }
  | { type: 'break-due-lapsed' }

export const IDLE_FOCUS: FocusState = { phase: 'idle', minutes: 0, startedAt: 0, endsAt: 0, completedInCycle: 0, lastEndedAt: 0 }

/** Unanswered "block done" prompt lapses to idle after this. */
export const BREAK_DUE_EXPIRY_MS = 30 * 60_000
/** Idle this long and the next block starts a fresh cycle. */
export const CYCLE_RESET_MS = 2 * 60 * 60_000

const MIN = 60_000

export function isFocusRunning(state: FocusState): boolean {
  return state.phase === 'focus'
}

/** Any phase that owns the person's next break (the stand-up reminder stays out of it). */
export function ownsBreak(state: FocusState): boolean {
  return state.phase !== 'idle'
}

export function startFocus(
  state: FocusState,
  input: { now: number; minutes: number; taskId?: string; title?: string },
): FocusState {
  if (state.phase === 'focus') throw new Error('A focus block is already running. Stop it first with focus_stop.')
  const freshCycle = state.phase === 'idle' && state.lastEndedAt > 0 && input.now - state.lastEndedAt > CYCLE_RESET_MS
  return {
    phase: 'focus',
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.title ? { title: input.title } : {}),
    minutes: input.minutes,
    startedAt: input.now,
    endsAt: input.now + input.minutes * MIN,
    completedInCycle: freshCycle ? 0 : state.completedInCycle,
    lastEndedAt: state.lastEndedAt,
  }
}

/** Stop whatever is running. The cycle ends too: stopping means "done for now". */
export function stopFocus(state: FocusState, now: number): { state: FocusState; stoppedMinutes: number | null } {
  const stoppedMinutes = state.phase === 'focus' ? Math.max(0, Math.floor((now - state.startedAt) / MIN)) : null
  return { state: { ...IDLE_FOCUS, lastEndedAt: state.phase === 'idle' ? state.lastEndedAt : now }, stoppedMinutes }
}

export function breakLengthMs(kind: BreakKind, d: FocusDurations): number {
  return (kind === 'long' ? d.longBreakMinutes : d.breakMinutes) * MIN
}

/**
 * Start (or restart) the break now. From `break_due` it is the break the block
 * earned; from `idle` it is a plain short break someone asked for.
 */
export function startBreak(state: FocusState, now: number, d: FocusDurations): FocusState {
  if (state.phase === 'focus') throw new Error('A focus block is running. Stop it first, or wait for it to end.')
  const kind: BreakKind = state.phase === 'idle' ? 'short' : state.breakKind ?? 'short'
  return { ...state, phase: 'break', breakKind: kind, startedAt: now, endsAt: now + breakLengthMs(kind, d) }
}

/** Skip the break: back to idle, keeping the cycle count so the long break still comes. */
export function skipBreak(state: FocusState, now: number): FocusState {
  if (state.phase !== 'break_due' && state.phase !== 'break') return state
  return { ...IDLE_FOCUS, completedInCycle: state.completedInCycle, lastEndedAt: now }
}

/**
 * Move the cycle forward to `now`, one phase at a time, so a server that was down
 * through a whole block and its break still lands in the right place.
 */
export function advanceFocus(state: FocusState, now: number, d: FocusDurations): { state: FocusState; events: FocusEvent[] } {
  let current = state
  const events: FocusEvent[] = []
  for (let guard = 0; guard < 4 && current.phase !== 'idle' && current.endsAt > 0 && current.endsAt <= now; guard++) {
    const endedAt = current.endsAt
    if (current.phase === 'focus') {
      const completed = current.completedInCycle + 1
      const long = d.longBreakEvery > 0 && completed % d.longBreakEvery === 0
      const breakKind: BreakKind = long ? 'long' : 'short'
      events.push({
        type: 'focus-completed',
        block: {
          startedAt: current.startedAt,
          endedAt,
          minutes: current.minutes,
          ...(current.taskId ? { taskId: current.taskId } : {}),
          ...(current.title ? { title: current.title } : {}),
        },
        breakKind,
        lateMs: now - endedAt,
      })
      current = {
        ...current,
        phase: 'break_due',
        breakKind,
        completedInCycle: long ? 0 : completed,
        startedAt: endedAt,
        endsAt: endedAt + BREAK_DUE_EXPIRY_MS,
        lastEndedAt: endedAt,
      }
    } else if (current.phase === 'break_due') {
      events.push({ type: 'break-due-lapsed' })
      current = { ...IDLE_FOCUS, completedInCycle: current.completedInCycle, lastEndedAt: current.lastEndedAt }
    } else {
      events.push({ type: 'break-ended', breakKind: current.breakKind ?? 'short', lateMs: now - endedAt })
      current = {
        ...IDLE_FOCUS,
        completedInCycle: current.completedInCycle,
        minutes: current.minutes,
        ...(current.taskId ? { taskId: current.taskId } : {}),
        ...(current.title ? { title: current.title } : {}),
        lastEndedAt: endedAt,
      }
    }
  }
  return { state: current, events }
}

/** Parse what state.json held; anything malformed is idle. */
export function focusOnBoot(raw: unknown): FocusState {
  if (!raw || typeof raw !== 'object') return { ...IDLE_FOCUS }
  const value = raw as Partial<FocusState>
  const phase: FocusPhase = value.phase === 'focus' || value.phase === 'break_due' || value.phase === 'break' ? value.phase : 'idle'
  const num = (n: unknown, def = 0): number => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : def)
  const state: FocusState = {
    phase,
    ...(typeof value.taskId === 'string' && value.taskId ? { taskId: value.taskId } : {}),
    ...(typeof value.title === 'string' && value.title ? { title: value.title } : {}),
    minutes: num(value.minutes),
    startedAt: num(value.startedAt),
    endsAt: num(value.endsAt),
    completedInCycle: Math.floor(num(value.completedInCycle)),
    ...(value.breakKind === 'long' || value.breakKind === 'short' ? { breakKind: value.breakKind } : {}),
    lastEndedAt: num(value.lastEndedAt),
  }
  if (state.phase !== 'idle' && state.endsAt === 0) return { ...IDLE_FOCUS, lastEndedAt: state.lastEndedAt }
  return state
}

// ── The one quiet hold ──────────────────────────────────────────────────────

export interface HoldSpec {
  reason: string
  /** Epoch ms; absent = until cleared. */
  until?: number
}

/**
 * Walnut keeps ONE quiet hold per plugin, and Rhythm has two reasons to hold it: a
 * running focus block (ends at the block's end) and a macOS Focus (ends when macOS
 * says so). The hold is their union: both reasons named, and an end time only when
 * every part of it has one.
 */
export function desiredHold(input: { focus: FocusState; focusQuietsWalnut: boolean; macosFocusName: string | null }): HoldSpec | null {
  const parts: HoldSpec[] = []
  if (input.focusQuietsWalnut && input.focus.phase === 'focus') parts.push({ reason: 'Focus block', until: input.focus.endsAt })
  if (input.macosFocusName) parts.push({ reason: `macOS Focus: ${input.macosFocusName}` })
  if (parts.length === 0) return null
  const reason = parts.map((part) => part.reason).join(', ')
  const ends = parts.every((part) => part.until !== undefined)
  return ends ? { reason, until: Math.max(...parts.map((part) => part.until!)) } : { reason }
}

export function sameHold(a: HoldSpec | null, b: HoldSpec | null): boolean {
  if (a === null || b === null) return a === b
  return a.reason === b.reason && a.until === b.until
}

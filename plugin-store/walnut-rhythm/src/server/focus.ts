/**
 * The focus run (a pomodoro, optionally tied to a task) and the one quiet hold Rhythm
 * owns. PURE.
 *
 *   off ──Start──▶ focus ──time up──▶ break ──time up──▶ off (asks once: start the next one?)
 *    │               │ ▲                │ └──End break──▶ off
 *    │               │ └───Focus now────┘
 *    │               ├──Rest now──▶ break
 *    │               └──Stop──▶ off
 *    └──Rest──▶ break
 *
 * Extend adds time to the block or the break running now.
 *
 * Rhythm is off until the person presses Start, and only a Start (`startFocus`, or
 * `startRest` for a rest) leaves off: no clock, restart, attention or reload ever
 * does. A run is the block the person started and the break that follows it; when the break runs out, Rhythm asks once
 * whether to start the next one and stays off if nobody does. Every Nth completed block
 * is followed by the long break, and the cycle count starts over after the long break
 * or after a long idle spell.
 *
 * `break_due` (an older version waited for a click between the block and its break)
 * and the old stand-up break (`stand`) are still read from a stored state, so an
 * upgrade mid-run lands in the right place.
 */

export type FocusPhase = 'idle' | 'focus' | 'break_due' | 'break'
export type BreakKind = 'short' | 'long' | 'stand'

export interface FocusState {
  phase: FocusPhase
  taskId?: string
  title?: string
  /** This block's focus length, kept for "Another block". */
  minutes: number
  /** The short break this block's person picked at Start, in minutes. 0 = the configured one. */
  breakMinutes: number
  /** The Spotify playlist Start played on the Mac for this block, kept for "Another block". */
  spotifyUri?: string
  /** The current phase's window, epoch ms. Both 0 while off. */
  startedAt: number
  endsAt: number
  /** When the person pressed Start for the run in progress (its block), epoch ms. 0 while off. */
  runStartedAt: number
  /** Blocks completed since the last long break. */
  completedInCycle: number
  breakKind?: BreakKind
  /** When the latest phase (block or break) finished, epoch ms. 0 = never. */
  lastEndedAt: number
  /** The last finished run, for "Last run 10:05 to 10:35". Both 0 = none yet. */
  lastRunStartedAt: number
  lastRunEndedAt: number
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
  /** The short break picked with it (0 = the configured one), so "Another block" keeps it. */
  breakMinutes: number
  spotifyUri?: string
  taskId?: string
  title?: string
}

export type FocusEvent =
  | { type: 'focus-completed'; block: CompletedBlock; breakKind: BreakKind; breakEndsAt: number; lateMs: number }
  | { type: 'break-ended'; breakKind: BreakKind; lateMs: number }

export const IDLE_FOCUS: FocusState = {
  phase: 'idle', minutes: 0, breakMinutes: 0, startedAt: 0, endsAt: 0, runStartedAt: 0, completedInCycle: 0,
  lastEndedAt: 0, lastRunStartedAt: 0, lastRunEndedAt: 0,
}

/** Idle this long and the next block starts a fresh cycle. */
export const CYCLE_RESET_MS = 2 * 60 * 60_000

const MIN = 60_000

export function isFocusRunning(state: FocusState): boolean {
  return state.phase === 'focus'
}

/** Back to off, remembering the run that just ended (if one did). */
function off(state: FocusState, endedAt: number): FocusState {
  const ran = state.phase !== 'idle'
  return {
    ...IDLE_FOCUS,
    completedInCycle: state.completedInCycle,
    minutes: state.minutes,
    breakMinutes: state.breakMinutes,
    ...(state.taskId ? { taskId: state.taskId } : {}),
    ...(state.title ? { title: state.title } : {}),
    ...(state.spotifyUri ? { spotifyUri: state.spotifyUri } : {}),
    lastEndedAt: ran ? endedAt : state.lastEndedAt,
    lastRunStartedAt: ran ? state.runStartedAt || state.startedAt : state.lastRunStartedAt,
    lastRunEndedAt: ran ? endedAt : state.lastRunEndedAt,
  }
}

export function startFocus(
  state: FocusState,
  input: { now: number; minutes: number; breakMinutes?: number; spotifyUri?: string; taskId?: string; title?: string },
): FocusState {
  if (state.phase === 'focus') throw new Error('A focus block is already running. Stop it first with focus_stop.')
  // "Another block" during a break: the run being cut off is the last run now.
  if (state.phase !== 'idle') state = off(state, input.now)
  const freshCycle = state.phase === 'idle' && state.lastEndedAt > 0 && input.now - state.lastEndedAt > CYCLE_RESET_MS
  return {
    phase: 'focus',
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.title ? { title: input.title } : {}),
    minutes: input.minutes,
    breakMinutes: input.breakMinutes ?? 0,
    ...(input.spotifyUri ? { spotifyUri: input.spotifyUri } : {}),
    startedAt: input.now,
    endsAt: input.now + input.minutes * MIN,
    runStartedAt: input.now,
    completedInCycle: freshCycle ? 0 : state.completedInCycle,
    lastEndedAt: state.lastEndedAt,
    lastRunStartedAt: state.lastRunStartedAt,
    lastRunEndedAt: state.lastRunEndedAt,
  }
}

/** Stop whatever is running. The cycle ends too: stopping means "done for now". */
export function stopFocus(state: FocusState, now: number): { state: FocusState; stoppedMinutes: number | null } {
  const stoppedMinutes = state.phase === 'focus' ? Math.max(0, Math.floor((now - state.startedAt) / MIN)) : null
  if (state.phase === 'idle') return { state, stoppedMinutes }
  return { state: { ...off(state, now), completedInCycle: 0 }, stoppedMinutes }
}

/**
 * A break the person chose: Rest now during a block (the block ends here, short of its
 * time, and does not count toward the long break), or Rest from off. Either way it runs
 * `minutes`, then Rhythm asks once about the next block, as after any break.
 */
export function startRest(state: FocusState, input: { now: number; minutes: number }): FocusState {
  if (state.phase === 'break' || state.phase === 'break_due') throw new Error('A break is already running. Add time to it with focus_extend, or end it with break_skip.')
  const fromBlock = state.phase === 'focus'
  const freshCycle = !fromBlock && state.lastEndedAt > 0 && input.now - state.lastEndedAt > CYCLE_RESET_MS
  return {
    ...state,
    phase: 'break',
    breakKind: 'short',
    startedAt: input.now,
    endsAt: input.now + input.minutes * MIN,
    runStartedAt: fromBlock ? state.runStartedAt || state.startedAt : input.now,
    completedInCycle: freshCycle ? 0 : state.completedInCycle,
    lastEndedAt: fromBlock ? input.now : state.lastEndedAt,
  }
}

/** Extend's step, and what one Extend may add. */
export const EXTEND_DEFAULT_MINUTES = 5
export const EXTEND_RANGE = { min: 1, max: 60 }

/** Longest a block or a break may run after Extend, counted from its start. */
export const MAX_PHASE_MINUTES = 240

/** More time on the block or break running now (Extend, More break). The run keeps its place. */
export function extendPhase(state: FocusState, input: { now: number; minutes: number }): FocusState {
  if (state.phase !== 'focus' && state.phase !== 'break') throw new Error('Nothing is running to extend. Start a focus block or a rest first.')
  const endsAt = Math.max(state.endsAt, input.now) + input.minutes * MIN
  if (endsAt - state.startedAt > MAX_PHASE_MINUTES * MIN) throw new Error(`A ${state.phase === 'focus' ? 'block' : 'break'} runs at most ${MAX_PHASE_MINUTES} minutes.`)
  // `minutes` stays the person's pick, so the next block runs it again; the log counts the time it ran.
  return { ...state, endsAt }
}

/** The long break is always the configured one; a short break is the block's own pick, else the configured one. */
export function breakLengthMs(kind: BreakKind, d: FocusDurations, picked = 0): number {
  return (kind === 'long' ? d.longBreakMinutes : picked > 0 ? picked : d.breakMinutes) * MIN
}

/** End the break now (End break): off, keeping the cycle count so the long break still comes. */
export function skipBreak(state: FocusState, now: number): FocusState {
  if (state.phase !== 'break_due' && state.phase !== 'break') return state
  return off(state, now)
}

/**
 * Move the run forward to `now`, one phase at a time, so a server that was down
 * through a whole block and its break still lands in the right place. It only ever
 * moves toward off: nothing here starts a block.
 */
export function advanceFocus(state: FocusState, now: number, d: FocusDurations): { state: FocusState; events: FocusEvent[] } {
  let current = state
  const events: FocusEvent[] = []
  if (current.phase === 'break_due') {
    // A stored state from the version that waited for a click: the break began at the block's end.
    const kind: BreakKind = current.breakKind === 'long' ? 'long' : 'short'
    current = { ...current, phase: 'break', breakKind: kind, endsAt: current.startedAt + breakLengthMs(kind, d, current.breakMinutes), runStartedAt: legacyRunStart(current) }
  }
  for (let guard = 0; guard < 3 && current.phase !== 'idle' && current.endsAt > 0 && current.endsAt <= now; guard++) {
    const endedAt = current.endsAt
    if (current.phase === 'focus') {
      const completed = current.completedInCycle + 1
      const long = d.longBreakEvery > 0 && completed % d.longBreakEvery === 0
      const breakKind: BreakKind = long ? 'long' : 'short'
      const breakEndsAt = endedAt + breakLengthMs(breakKind, d, current.breakMinutes)
      events.push({
        type: 'focus-completed',
        block: {
          startedAt: current.startedAt,
          endedAt,
          // An extended block logs the time it ran.
          minutes: Math.max(current.minutes, Math.round((endedAt - current.startedAt) / MIN)),
          breakMinutes: current.breakMinutes,
          ...(current.spotifyUri ? { spotifyUri: current.spotifyUri } : {}),
          ...(current.taskId ? { taskId: current.taskId } : {}),
          ...(current.title ? { title: current.title } : {}),
        },
        breakKind,
        breakEndsAt,
        lateMs: now - endedAt,
      })
      current = {
        ...current,
        phase: 'break',
        breakKind,
        completedInCycle: long ? 0 : completed,
        startedAt: endedAt,
        endsAt: breakEndsAt,
        runStartedAt: current.runStartedAt || current.startedAt,
        lastEndedAt: endedAt,
      }
    } else {
      events.push({ type: 'break-ended', breakKind: current.breakKind ?? 'short', lateMs: now - endedAt })
      current = off(current, endedAt)
    }
  }
  return { state: current, events }
}

/** An older version kept no run start: the block began its length before the break did. */
function legacyRunStart(state: FocusState): number {
  if (state.runStartedAt > 0) return state.runStartedAt
  return state.minutes > 0 ? Math.max(0, state.startedAt - state.minutes * MIN) : state.startedAt
}

/** Parse what state.json held; anything malformed is off. */
export function focusOnBoot(raw: unknown): FocusState {
  if (!raw || typeof raw !== 'object') return { ...IDLE_FOCUS }
  const value = raw as Partial<FocusState>
  const phase: FocusPhase = value.phase === 'focus' || value.phase === 'break_due' || value.phase === 'break' ? value.phase : 'idle'
  const num = (n: unknown, def = 0): number => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : def)
  const state: FocusState = {
    phase,
    ...(typeof value.taskId === 'string' && value.taskId ? { taskId: value.taskId } : {}),
    ...(typeof value.title === 'string' && value.title ? { title: value.title } : {}),
    ...(typeof value.spotifyUri === 'string' && /^spotify:[a-z]+:[A-Za-z0-9]+$/.test(value.spotifyUri) ? { spotifyUri: value.spotifyUri } : {}),
    minutes: num(value.minutes),
    breakMinutes: Math.floor(num(value.breakMinutes)),
    startedAt: num(value.startedAt),
    endsAt: num(value.endsAt),
    runStartedAt: num(value.runStartedAt),
    completedInCycle: Math.floor(num(value.completedInCycle)),
    ...(value.breakKind === 'long' || value.breakKind === 'short' || value.breakKind === 'stand' ? { breakKind: value.breakKind } : {}),
    lastEndedAt: num(value.lastEndedAt),
    lastRunStartedAt: num(value.lastRunStartedAt),
    lastRunEndedAt: num(value.lastRunEndedAt),
  }
  if (state.phase === 'idle') return { ...state, startedAt: 0, endsAt: 0, runStartedAt: 0 }
  // An older version's stand-up break was no run of a block: it ends here, quietly.
  if (state.breakKind === 'stand') return { ...state, phase: 'idle', startedAt: 0, endsAt: 0, runStartedAt: 0, completedInCycle: state.completedInCycle }
  if (state.phase === 'break' && state.runStartedAt === 0 && state.startedAt > 0) state.runStartedAt = legacyRunStart(state)
  if (state.endsAt === 0 && state.phase !== 'break_due') return { ...IDLE_FOCUS, lastEndedAt: state.lastEndedAt }
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

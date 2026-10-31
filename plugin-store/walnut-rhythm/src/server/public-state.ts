/**
 * What the App, the `status` op and the `state` event see. Built from the runtime
 * without changing it, so reading the status can never start or move anything.
 *
 * The web entry reads this type with `import type`, which the build erases, so the
 * browser bundle never pulls in server code.
 */
import type { QuietHold } from '@open-walnut/plugin-api/server'
import type { RhythmConfig } from './config'
import type { DayLog } from './day-log'
import type { BreakKind, FocusPhase, HoldSpec } from './focus'
import type { MirrorView, ShortcutsView } from './macos-bridge'
import type { RhythmRuntime } from './runtime'

export interface RhythmPublicState {
  version: 1
  now: number
  replica: boolean
  config: RhythmConfig
  focus: {
    /** `idle` is off: nothing runs and nothing counts until the person presses Start. */
    phase: FocusPhase
    taskId?: string
    title?: string
    minutes: number
    /** The current phase's window (the block, or its break). */
    startedAt: number | null
    endsAt: number | null
    remainingMs: number
    /** When the person pressed Start for the run in progress. */
    runStartedAt: number | null
    completedInCycle: number
    longBreakEvery: number
    breakKind?: BreakKind
    /** The last finished run (Start to the end of its break, or to Stop). */
    lastRun: { startedAt: number; endedAt: number } | null
  }
  quiet: {
    active: boolean
    holds: QuietHold[]
    ours: HoldSpec | null
  }
  macos: {
    available: boolean
    mirror: MirrorView & { enabled: boolean }
    shortcuts: ShortcutsView & { enabled: boolean }
  }
  today: DayLog
}

export function buildPublicState(runtime: RhythmRuntime, now: number): RhythmPublicState {
  const { config, focus } = runtime
  const running = focus.phase !== 'idle' && focus.endsAt > 0
  return {
    version: 1,
    now,
    replica: false,
    config,
    focus: {
      phase: focus.phase,
      ...(focus.taskId ? { taskId: focus.taskId } : {}),
      ...(focus.title ? { title: focus.title } : {}),
      minutes: focus.minutes,
      startedAt: running ? focus.startedAt : null,
      endsAt: running ? focus.endsAt : null,
      remainingMs: running ? Math.max(0, focus.endsAt - now) : 0,
      runStartedAt: running ? focus.runStartedAt || focus.startedAt : null,
      completedInCycle: focus.completedInCycle,
      longBreakEvery: config.longBreakEvery,
      ...(focus.breakKind && focus.phase !== 'idle' && focus.phase !== 'focus' ? { breakKind: focus.breakKind } : {}),
      lastRun: focus.lastRunStartedAt > 0 && focus.lastRunEndedAt >= focus.lastRunStartedAt
        ? { startedAt: focus.lastRunStartedAt, endedAt: focus.lastRunEndedAt }
        : null,
    },
    quiet: {
      active: runtime.quietState.active,
      holds: runtime.quietState.holds,
      ours: runtime.ownHold(),
    },
    macos: {
      available: runtime.macos.available,
      mirror: { ...runtime.macos.mirror, enabled: config.mirrorMacosFocus },
      shortcuts: { ...runtime.macos.shortcuts, enabled: config.macosFocusShortcuts },
    },
    today: runtime.day,
  }
}

/** The state JSON without the fields that move on their own, for "did anything change". */
export function stateFingerprint(state: RhythmPublicState): string {
  const { now: _now, focus, ...rest } = state
  const { remainingMs: _remaining, ...focusRest } = focus
  return JSON.stringify({ ...rest, focus: focusRest, minuteLeft: Math.ceil(focus.remainingMs / 60_000) })
}

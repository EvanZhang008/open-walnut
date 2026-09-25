/**
 * What the App, the `status` op and the `state` event see. Built from the runtime
 * without changing it, so reading the status can never fire or defer a reminder.
 *
 * The web entry reads this type with `import type`, which the build erases, so the
 * browser bundle never pulls in server code.
 */
import type { RhythmConfig } from './config'
import type { DayLog } from './day-log'
import type { BreakKind, FocusPhase, HoldSpec } from './focus'
import type { QuietHold } from './host'
import type { MirrorView, ShortcutsView } from './macos-bridge'
import { isPresent } from './presence'
import type { RhythmRuntime } from './runtime'
import type { ReminderView } from './scheduler'

export interface RhythmPublicState {
  version: 1
  now: number
  replica: boolean
  config: RhythmConfig
  sitting: {
    present: boolean
    sittingMs: number
    streakStartedAt: number | null
    lastActiveAt: number | null
    /** When each signal last delivered attention, epoch ms. */
    signals: { walnut: number | null; mac: number | null }
  }
  reminder: ReminderView & {
    turnsInFlight: number
    quietHours: { value: string; valid: boolean; inside: boolean }
  }
  focus: {
    phase: FocusPhase
    taskId?: string
    title?: string
    minutes: number
    startedAt: number | null
    endsAt: number | null
    remainingMs: number
    completedInCycle: number
    longBreakEvery: number
    breakKind?: BreakKind
  }
  quiet: {
    available: boolean
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
  const { config, presence, focus } = runtime
  const view = runtime.evaluate(now).view
  const present = isPresent(presence, now, runtime.awayMs)
  const running = focus.phase !== 'idle' && focus.endsAt > 0
  return {
    version: 1,
    now,
    replica: false,
    config,
    sitting: {
      present,
      sittingMs: view.sittingMs,
      streakStartedAt: presence.streakStartedAt || null,
      lastActiveAt: presence.lastActiveAt || null,
      signals: { walnut: runtime.signals.walnut || null, mac: runtime.signals.mac || null },
    },
    reminder: {
      ...view,
      turnsInFlight: runtime.turnsInFlight(now),
      quietHours: { value: config.quietHours, valid: runtime.quietHoursValid, inside: runtime.inQuietHours(now) },
    },
    focus: {
      phase: focus.phase,
      ...(focus.taskId ? { taskId: focus.taskId } : {}),
      ...(focus.title ? { title: focus.title } : {}),
      minutes: focus.minutes,
      startedAt: running ? focus.startedAt : null,
      endsAt: running ? focus.endsAt : null,
      remainingMs: running ? Math.max(0, focus.endsAt - now) : 0,
      completedInCycle: focus.completedInCycle,
      longBreakEvery: config.longBreakEvery,
      ...(focus.breakKind && focus.phase !== 'idle' && focus.phase !== 'focus' ? { breakKind: focus.breakKind } : {}),
    },
    quiet: {
      available: runtime.quietAvailable,
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

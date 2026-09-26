/**
 * What each op does, over the runtime. Every mutating action runs inside the runtime's
 * `serial` queue and ends with one `step`, so the quiet hold, the reminder and the
 * `state` event are all settled before the op answers.
 *
 * Refusals are thrown as plain sentences; the host turns a throw into
 * `{ ok: false, message }` for every caller (a session, the App, a notice button).
 */
import { clampMinutes } from './config'
import { startBreak, startFocus, stopFocus, skipBreak, advanceFocus } from './focus'
import { KEY_BREAK_OVER, KEY_FOCUS_DONE, KEY_STAND_UP } from './notices'
import { restartStreak } from './presence'
import { buildPublicState, type RhythmPublicState } from './public-state'
import type { RhythmRuntime } from './runtime'
import { snoozeReminder, syncStreak } from './scheduler'

export interface ActionResult {
  message: string
  state: RhythmPublicState
}

const MAX_FOCUS_MINUTES = 180

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

async function finish(runtime: RhythmRuntime, message: string): Promise<ActionResult> {
  await runtime.step()
  return { message, state: buildPublicState(runtime, runtime.now()) }
}

/** Settle the cycle up to now first, so an action never acts on a phase that already ended. */
async function settle(runtime: RhythmRuntime): Promise<void> {
  const advanced = advanceFocus(runtime.focus, runtime.now(), runtime.durations())
  if (advanced.events.length > 0) await runtime.step()
}

export function focusStart(runtime: RhythmRuntime, args: Record<string, unknown>): Promise<ActionResult> {
  return runtime.serial(async () => {
    await settle(runtime)
    const taskId = str(args.taskId)
    let title: string | undefined
    if (taskId) {
      const task = await runtime.walnut.tasks.get(taskId)
      if (!task) throw new Error(`Task ${taskId} was not found.`)
      title = task.title
    }
    const minutes = clampMinutes(args.minutes, runtime.config.focusMinutes, 1, MAX_FOCUS_MINUTES)
    const now = runtime.now()
    runtime.focus = startFocus(runtime.focus, { now, minutes, ...(taskId ? { taskId } : {}), ...(title ? { title } : {}) })
    runtime.markDirty()
    await runtime.dismiss(KEY_FOCUS_DONE)
    await runtime.dismiss(KEY_BREAK_OVER)
    if (runtime.config.macosFocusShortcuts) runtime.macos.setDoNotDisturb(true, runtime.now)
    return finish(runtime, `Focus block started: ${minutes} min${title ? ` on ${title}` : ''}.`)
  })
}

export function focusStop(runtime: RhythmRuntime): Promise<ActionResult> {
  return runtime.serial(async () => {
    await settle(runtime)
    const was = runtime.focus.phase
    const stopped = stopFocus(runtime.focus, runtime.now())
    runtime.focus = stopped.state
    runtime.markDirty()
    if (stopped.stoppedMinutes !== null) runtime.recordDay({ type: 'stopped' })
    if (was === 'focus' && runtime.config.macosFocusShortcuts) {
      runtime.macos.setDoNotDisturb(false, runtime.now)
      runtime.macos.assumeDoNotDisturbOff(runtime.now())
    }
    await runtime.dismiss(KEY_FOCUS_DONE)
    await runtime.dismiss(KEY_BREAK_OVER)
    const message = was === 'idle'
      ? 'Nothing was running.'
      : was === 'focus' ? `Focus block stopped after ${stopped.stoppedMinutes ?? 0} min.` : 'Stopped.'
    return finish(runtime, message)
  })
}

/** "I stood up": the sitting streak starts over now. */
export function breakDone(runtime: RhythmRuntime): Promise<ActionResult> {
  return runtime.serial(async () => {
    const answered = runtime.reminder.outstanding
    runtime.presence = restartStreak(runtime.presence, runtime.now())
    runtime.reminder = syncStreak({ ...runtime.reminder, outstanding: false }, runtime.presence)
    runtime.markDirty()
    runtime.recordDay({ type: answered ? 'reminder-done' : 'break' })
    await runtime.dismiss(KEY_STAND_UP)
    return finish(runtime, 'Break logged. The sitting count starts over.')
  })
}

export function breakSnooze(runtime: RhythmRuntime, args: Record<string, unknown>): Promise<ActionResult> {
  return runtime.serial(async () => {
    const minutes = clampMinutes(args.minutes, runtime.config.snoozeMinutes, 1, 240)
    const now = runtime.now()
    runtime.reminder = snoozeReminder(syncStreak(runtime.reminder, runtime.presence), now, minutes)
    runtime.markDirty()
    runtime.recordDay({ type: 'reminder-snoozed' })
    await runtime.dismiss(KEY_STAND_UP)
    return finish(runtime, `Stand-up reminder snoozed for ${minutes} min.`)
  })
}

export function breakStart(runtime: RhythmRuntime): Promise<ActionResult> {
  return runtime.serial(async () => {
    await settle(runtime)
    const was = runtime.focus.phase
    const now = runtime.now()
    runtime.focus = startBreak(runtime.focus, now, runtime.durations())
    // Taking the break means standing up: the sitting count starts over too.
    runtime.presence = restartStreak(runtime.presence, now)
    runtime.markDirty()
    if (was === 'break_due') runtime.recordDay({ type: 'focus-break' })
    else if (was === 'idle') runtime.recordDay({ type: 'break' })
    await runtime.dismiss(KEY_FOCUS_DONE)
    await runtime.dismiss(KEY_BREAK_OVER)
    const minutes = Math.round((runtime.focus.endsAt - now) / 60_000)
    return finish(runtime, `Break started: ${minutes} min.`)
  })
}

export function breakSkip(runtime: RhythmRuntime): Promise<ActionResult> {
  return runtime.serial(async () => {
    await settle(runtime)
    const was = runtime.focus.phase
    runtime.focus = skipBreak(runtime.focus, runtime.now())
    runtime.markDirty()
    await runtime.dismiss(KEY_FOCUS_DONE)
    await runtime.dismiss(KEY_BREAK_OVER)
    return finish(runtime, was === 'break_due' || was === 'break' ? 'Break skipped.' : 'No break was waiting.')
  })
}

export function status(runtime: RhythmRuntime, args: Record<string, unknown>): Promise<RhythmPublicState> {
  return runtime.serial(async () => {
    const now = runtime.now()
    // `shortcuts list` runs only when someone asks (the App's Check again and its first
    // open) or when the shortcuts are actually in use; a plain status read starts nothing.
    if (args.refresh === true) {
      await runtime.macos.checkShortcuts(now, true)
      // Check again after granting Full Disk Access must not wait out the 10 minute backoff.
      await runtime.macos.pollMirror(now, runtime.config.mirrorMacosFocus, true)
      await runtime.syncHold()
    } else if (runtime.config.macosFocusShortcuts) await runtime.macos.checkShortcuts(now)
    return buildPublicState(runtime, runtime.now())
  })
}

export async function privacyOpen(runtime: RhythmRuntime): Promise<{ message: string }> {
  await runtime.macos.openPrivacySettings()
  return { message: 'System Settings is open at Full Disk Access. Turn on the Walnut server there, then click Check again.' }
}

export async function shortcutsInstall(runtime: RhythmRuntime): Promise<{ message: string; steps: unknown[]; state: RhythmPublicState }> {
  // Deliberately outside `serial`: signing talks to Apple and can take many seconds.
  const result = await runtime.macos.install(runtime.now)
  const opened = result.steps.filter((step) => step.ok).length
  const failed = result.steps.filter((step) => !step.ok)
  const message = result.alreadyInstalled
    ? 'Both Rhythm shortcuts are already in Shortcuts.'
    : failed.length === 0
      ? `Shortcuts opened ${opened} Add Shortcut ${opened === 1 ? 'dialog' : 'dialogs'}. Click Add Shortcut in each.`
      : `${failed.map((step) => `${step.name}: ${step.step} failed (${step.error ?? 'unknown error'})`).join('; ')}`
  if (!result.alreadyInstalled && opened === 0) throw new Error(message)
  return { message, steps: result.steps, state: await status(runtime, {}) }
}

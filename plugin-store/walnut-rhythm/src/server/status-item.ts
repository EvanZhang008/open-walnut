/**
 * Rhythm's ring in the console rail, as plain data. PURE: the public state in, the
 * status item out (or null to hide it).
 *
 *   focus block      blue, drains          Stop block
 *   block done       green, check          Start break · Skip break · Another block
 *   break            green, drains         End break (a stand-up break or a block's break)
 *   reminder fired   orange, standing man  Start break · Snooze
 *   counting         grey, fills up        Stand up now · Start focus block
 *   snoozed          grey, drains          Stand up now · Snooze again
 *   waiting on turn  grey, standing man    Stand up now · Snooze
 *   Walnut quiet     grey, pause           Stand up now
 *   away / quiet hours / replica: hidden
 *
 * "Start break" answers a reminder that is on screen by starting the stand-up break
 * (`break_start`): the ring turns green and counts it down, and the sitting count starts
 * when it ends. The same op reads "Stand up now" when nothing has asked yet. The host
 * ticks the ring from `timer`, so nothing here runs per minute.
 */
import type { StatusItemAction, StatusItemState } from '@open-walnut/plugin-api/server'
import { formatSitting } from './clock'
import type { RhythmPublicState } from './public-state'

export const STATUS_ITEM_ID = 'rhythm'
const APP = 'main'
const MIN = 60_000

function nextBlockArgs(focus: RhythmPublicState['focus']): Record<string, unknown> {
  return {
    ...(focus.taskId ? { taskId: focus.taskId } : {}),
    ...(focus.minutes > 0 ? { minutes: focus.minutes } : {}),
  }
}

function sittingLine(ms: number): string {
  return ms < MIN ? 'You just sat down.' : `${formatSitting(ms)} at the keyboard.`
}

export function rhythmStatusItem(state: RhythmPublicState): StatusItemState | null {
  if (state.replica) return null
  const { focus, reminder, config } = state
  const snooze: StatusItemAction = { label: `Snooze ${config.snoozeMinutes} min`, op: 'break_snooze', args: { minutes: config.snoozeMinutes } }
  const standNow: StatusItemAction = { label: 'Stand up now', op: 'break_start', primary: true }

  if (focus.phase === 'focus' && focus.startedAt !== null && focus.endsAt !== null && focus.endsAt > focus.startedAt) {
    const quiet = config.focusQuietsWalnut ? 'Walnut is quiet until it ends.' : 'One thing until it ends.'
    return {
      title: 'Focus · {remaining} left',
      detail: focus.title ? `${focus.title}. ${quiet}` : quiet,
      tone: 'accent',
      timer: { startedAt: focus.startedAt, endsAt: focus.endsAt, mode: 'drain' },
      actions: [{ label: 'Stop block', op: 'focus_stop' }],
      app: APP,
    }
  }
  if (focus.phase === 'break_due') {
    const breakMinutes = focus.breakKind === 'long' ? config.longBreakMinutes : config.breakMinutes
    const what = focus.title ? ` on ${focus.title}` : ''
    return {
      title: 'Focus block done',
      detail: `${focus.minutes} min${what}. Time for a ${breakMinutes} min ${focus.breakKind === 'long' ? 'long break' : 'break'}.`,
      tone: 'success',
      glyph: 'check',
      actions: [
        { label: 'Start break', op: 'break_start', primary: true },
        { label: 'Skip break', op: 'break_skip' },
        { label: 'Another block', op: 'focus_start', args: nextBlockArgs(focus) },
      ],
      app: APP,
    }
  }
  if (focus.phase === 'break' && focus.startedAt !== null && focus.endsAt !== null && focus.endsAt > focus.startedAt) {
    return {
      title: 'Break · {remaining} left',
      detail: focus.breakKind === 'stand'
        ? 'Walk, stretch, look away from the screen. The sitting count starts when it ends.'
        : 'Stand, stretch, look away from the screen.',
      tone: 'success',
      timer: { startedAt: focus.startedAt, endsAt: focus.endsAt, mode: 'drain' },
      actions: [{ label: 'End break', op: 'break_skip' }],
      app: APP,
    }
  }

  // No block running: the stand-up reminder owns the ring.
  if (reminder.outstanding) {
    return {
      title: 'Time to stand up',
      detail: `${sittingLine(state.sitting.sittingMs)} Start break counts down ${config.standBreakMinutes} min.`,
      tone: 'warning',
      glyph: 'stand',
      actions: [{ label: 'Start break', op: 'break_start', primary: true }, snooze],
      app: APP,
    }
  }
  // Nights stay dark: the ring would only count down to a reminder that never comes.
  if (reminder.phase === 'away' || reminder.quietHours.inside) return null

  if (reminder.phase === 'paused') {
    return {
      title: 'Stand-up reminder paused',
      detail: 'Walnut is in quiet mode. Rhythm reminds you when it ends.',
      tone: 'neutral',
      glyph: 'pause',
      actions: [standNow],
      app: APP,
    }
  }
  if (reminder.phase === 'deferred') {
    return {
      title: 'Stand up after this turn',
      detail: `An agent is working. Rhythm waits for it to finish, at most ${config.deferForNaturalPauseMinutes} min.`,
      tone: 'neutral',
      glyph: 'stand',
      actions: [standNow, snooze],
      app: APP,
    }
  }

  const now = state.now
  if (reminder.phase === 'snoozed' && reminder.snoozedUntil !== null && reminder.snoozedUntil > now) {
    const endsAt = reminder.snoozedUntil
    return {
      title: 'Reminder in {remaining}',
      detail: 'Snoozed. Rhythm asks again when this runs out.',
      tone: 'neutral',
      timer: { startedAt: Math.min(now, endsAt - config.snoozeMinutes * MIN), endsAt, mode: 'drain' },
      actions: [standNow, { ...snooze, label: `Snooze ${config.snoozeMinutes} more` }],
      app: APP,
    }
  }

  const dueAt = reminder.dueAt
  if (dueAt === null) return null
  const detail = sittingLine(state.sitting.sittingMs)
  const startFocus: StatusItemAction = { label: 'Start focus block', op: 'focus_start' }
  if (dueAt <= now) {
    // Due by the clock, but the last attention came before it: one more keystroke fires it.
    return { title: 'Stand up soon', detail, tone: 'neutral', glyph: 'stand', actions: [standNow, startFocus], app: APP }
  }
  const intervalMs = config.reminderEveryMinutes * MIN
  return {
    title: 'Stand up in {remaining}',
    detail,
    tone: 'neutral',
    timer: { startedAt: Math.min(now, dueAt - intervalMs), endsAt: dueAt, mode: 'fill' },
    actions: [standNow, startFocus],
    app: APP,
  }
}

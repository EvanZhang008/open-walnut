/**
 * The three reminders Rhythm raises, as plain data. PURE.
 *
 * Each has a fixed dedupKey, so the feed holds at most one of each: the runtime
 * dismisses a key before raising it again and whenever it stops being true (the person
 * walked away, a new block started). Action `op`s are LOCAL op names; the host prefixes
 * them, so a button can only ever run one of this plugin's own ops.
 *
 * Button words say what happens next, never "Done": "Start break" starts the timer the
 * person stands up for (the rail's ring counts it down), the same as the rail's popover.
 */
import type { PluginNoticeAction, PluginNotifyInput } from '@open-walnut/plugin-api/server'
import { formatSitting } from './clock'
import type { BreakKind, CompletedBlock, FocusState } from './focus'

export const KEY_STAND_UP = 'stand-up'
export const KEY_FOCUS_DONE = 'focus-done'
export const KEY_BREAK_OVER = 'break-over'

export function standUpNotice(sittingMs: number, snoozeMinutes: number, breakMinutes: number): PluginNotifyInput {
  return {
    kind: 'reminder',
    title: `Stand up: ${formatSitting(sittingMs)} at the keyboard`,
    body: `Start break counts down ${breakMinutes} min in the sidebar. Walk, stretch, look away from the screen.`,
    dedupKey: KEY_STAND_UP,
    severity: 'info',
    actions: [
      { label: 'Start break', op: 'break_start' },
      { label: `Snooze ${snoozeMinutes} min`, op: 'break_snooze', args: { minutes: snoozeMinutes } },
    ],
  }
}

/** The stand-up break ran out. No buttons: the sitting count has already started. */
export function standBreakOverNotice(): PluginNotifyInput {
  return {
    kind: 'reminder',
    title: 'Break over',
    body: 'Welcome back. The sitting count starts again now.',
    dedupKey: KEY_BREAK_OVER,
    severity: 'info',
  }
}

function nextBlockArgs(focus: { taskId?: string; minutes: number }): Record<string, unknown> {
  return {
    ...(focus.taskId ? { taskId: focus.taskId } : {}),
    ...(focus.minutes > 0 ? { minutes: focus.minutes } : {}),
  }
}

export function focusDoneNotice(block: CompletedBlock, breakKind: BreakKind, breakMinutes: number): PluginNotifyInput {
  const what = block.title ? ` on ${block.title}` : ''
  const breakText = breakKind === 'long' ? `a ${breakMinutes} min long break` : `a ${breakMinutes} min break`
  const actions: PluginNoticeAction[] = [
    { label: 'Start break', op: 'break_start' },
    { label: 'Skip break', op: 'break_skip' },
    { label: 'Another block', op: 'focus_start', args: nextBlockArgs(block) },
  ]
  return {
    kind: 'reminder',
    title: 'Focus block done, stand up',
    body: `${block.minutes} min${what}. Time for ${breakText}.`,
    dedupKey: KEY_FOCUS_DONE,
    severity: 'success',
    ...(block.taskId ? { taskId: block.taskId } : {}),
    actions,
  }
}

export function breakOverNotice(focus: Pick<FocusState, 'taskId' | 'title' | 'minutes'>): PluginNotifyInput {
  const what = focus.title ? ` on ${focus.title}` : ''
  return {
    kind: 'reminder',
    title: 'Break over',
    body: `Ready for the next block${what}?`,
    dedupKey: KEY_BREAK_OVER,
    severity: 'info',
    ...(focus.taskId ? { taskId: focus.taskId } : {}),
    actions: [
      { label: 'Start next block', op: 'focus_start', args: nextBlockArgs(focus) },
      { label: 'Done for today', op: 'focus_stop' },
    ],
  }
}

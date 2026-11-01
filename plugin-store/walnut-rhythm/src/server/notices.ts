/**
 * The two reminders Rhythm raises, as plain data. PURE.
 *
 * Each has a fixed dedupKey, so the feed holds at most one of each: the runtime
 * dismisses a key before raising it again and whenever it stops being true (the break
 * ended, a new block started). Action `op`s are LOCAL op names; the host prefixes them,
 * so a button can only ever run one of this plugin's own ops.
 *
 * Rhythm speaks only inside a run the person started: once when the block ends (the
 * break has begun) and once when the break ends (start the next one?). `KEY_STAND_UP`
 * is the stand-up reminder an older version raised on its own; it is only ever
 * dismissed now.
 */
import type { PluginNoticeAction, PluginNotifyInput } from '@open-walnut/plugin-api/server'
import { clockTime } from './clock'
import type { BreakKind, CompletedBlock, FocusState } from './focus'

export const KEY_STAND_UP = 'stand-up'
export const KEY_FOCUS_DONE = 'focus-done'
export const KEY_BREAK_OVER = 'break-over'

/** The next block as this one was started: same task, same length, same break. */
function nextBlockArgs(focus: { taskId?: string; minutes: number; breakMinutes: number; spotifyUri?: string }): Record<string, unknown> {
  return {
    ...(focus.spotifyUri ? { spotify: focus.spotifyUri } : {}),
    ...(focus.taskId ? { taskId: focus.taskId } : {}),
    ...(focus.minutes > 0 ? { minutes: focus.minutes } : {}),
    ...(focus.breakMinutes > 0 ? { breakMinutes: focus.breakMinutes } : {}),
  }
}

export function focusDoneNotice(block: CompletedBlock, breakKind: BreakKind, breakMinutes: number, breakEndsAt: number): PluginNotifyInput {
  const what = block.title ? ` on ${block.title}` : ''
  const breakText = breakKind === 'long' ? 'long break' : 'break'
  const actions: PluginNoticeAction[] = [
    { label: 'End break', op: 'break_skip' },
    { label: 'Another block', op: 'focus_start', args: nextBlockArgs(block) },
  ]
  return {
    kind: 'reminder',
    title: `Focus block done, ${breakMinutes} min ${breakText}`,
    body: `${block.minutes} min${what}. Stand up and move; the break ends at ${clockTime(breakEndsAt)}.`,
    dedupKey: KEY_FOCUS_DONE,
    severity: 'success',
    ...(block.taskId ? { taskId: block.taskId } : {}),
    actions,
  }
}

/** The one question after a break: start the next block? Not answering leaves Rhythm off. */
export function breakOverNotice(focus: Pick<FocusState, 'taskId' | 'title' | 'minutes' | 'breakMinutes' | 'spotifyUri'>): PluginNotifyInput {
  const what = focus.title ? ` on ${focus.title}` : ''
  return {
    kind: 'reminder',
    title: 'Break over. Start the next block?',
    body: `Rhythm stays off until you start one${what ? `. Next: ${focus.minutes} min${what}` : ''}.`,
    dedupKey: KEY_BREAK_OVER,
    severity: 'info',
    ...(focus.taskId ? { taskId: focus.taskId } : {}),
    actions: [
      { label: 'Start next block', op: 'focus_start', args: nextBlockArgs(focus) },
      { label: 'Not now', op: 'focus_stop' },
    ],
  }
}

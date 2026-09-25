/**
 * The three reminders Rhythm raises, as plain data. PURE.
 *
 * Each has a fixed dedupKey, so the feed holds at most one of each: the runtime
 * dismisses a key before raising it again and whenever it stops being true (the person
 * walked away, a new block started). Action `op`s are LOCAL op names; the host prefixes
 * them, so a button can only ever run one of this plugin's own ops.
 */
import type { NoticeAction, RhythmNotice } from './host'
import { formatSitting } from './clock'
import type { BreakKind, CompletedBlock, FocusState } from './focus'

export const KEY_STAND_UP = 'stand-up'
export const KEY_FOCUS_DONE = 'focus-done'
export const KEY_BREAK_OVER = 'break-over'

export function standUpNotice(sittingMs: number, snoozeMinutes: number): RhythmNotice {
  return {
    kind: 'reminder',
    title: 'Time to stand up',
    body: `You have been at the keyboard for ${formatSitting(sittingMs)}. Walk for a couple of minutes.`,
    dedupKey: KEY_STAND_UP,
    severity: 'info',
    actions: [
      { label: 'Done', op: 'break_done' },
      { label: `Snooze ${snoozeMinutes} min`, op: 'break_snooze', args: { minutes: snoozeMinutes } },
    ],
  }
}

function nextBlockArgs(focus: { taskId?: string; minutes: number }): Record<string, unknown> {
  return {
    ...(focus.taskId ? { taskId: focus.taskId } : {}),
    ...(focus.minutes > 0 ? { minutes: focus.minutes } : {}),
  }
}

export function focusDoneNotice(block: CompletedBlock, breakKind: BreakKind, breakMinutes: number): RhythmNotice {
  const what = block.title ? ` on ${block.title}` : ''
  const breakText = breakKind === 'long' ? `a ${breakMinutes} min long break` : `a ${breakMinutes} min break`
  const actions: NoticeAction[] = [
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

export function breakOverNotice(focus: Pick<FocusState, 'taskId' | 'title' | 'minutes'>): RhythmNotice {
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
      { label: 'Stop', op: 'focus_stop' },
    ],
  }
}

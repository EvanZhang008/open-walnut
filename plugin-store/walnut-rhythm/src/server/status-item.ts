/**
 * Rhythm's ring in the console rail, as plain data. PURE: the public state in, the
 * status item out (or null to hide it).
 *
 *   off          grey, pause, no timer   Start focus block
 *   focus block  blue, drains            Stop block
 *   break        green, drains           End break
 *   replica: hidden
 *
 * Off is the state until the person presses Start, and after every run: the ring then
 * says so and offers one Start, never a countdown, because nothing is counting. Each
 * running state names when the run started and when it ends. The host ticks the ring
 * from `timer`, so nothing here runs per minute.
 */
import type { StatusItemState } from '@open-walnut/plugin-api/server'
import { clockTime } from './clock'
import type { RhythmPublicState } from './public-state'

export const STATUS_ITEM_ID = 'rhythm'
const APP = 'main'

export function rhythmStatusItem(state: RhythmPublicState): StatusItemState | null {
  if (state.replica) return null
  const { focus, config } = state
  const started = focus.runStartedAt !== null ? clockTime(focus.runStartedAt) : null

  if (focus.phase === 'focus' && focus.startedAt !== null && focus.endsAt !== null && focus.endsAt > focus.startedAt) {
    const quiet = config.focusQuietsWalnut ? ' Walnut is quiet until it ends.' : ''
    const what = focus.title ? `${focus.title}. ` : ''
    return {
      title: 'Focus · {remaining} left',
      detail: `${what}Started ${started ?? clockTime(focus.startedAt)}, ends ${clockTime(focus.endsAt)}.${quiet}`,
      tone: 'accent',
      timer: { startedAt: focus.startedAt, endsAt: focus.endsAt, mode: 'drain' },
      actions: [{ label: 'Stop block', op: 'focus_stop' }],
      app: APP,
    }
  }
  if (focus.phase === 'break' && focus.startedAt !== null && focus.endsAt !== null && focus.endsAt > focus.startedAt) {
    const block = started ? `Block ${started} to ${clockTime(focus.startedAt)}. ` : ''
    return {
      title: `${focus.breakKind === 'long' ? 'Long break' : 'Break'} · {remaining} left`,
      detail: `${block}Break ends ${clockTime(focus.endsAt)}, then Rhythm asks before the next block.`,
      tone: 'success',
      timer: { startedAt: focus.startedAt, endsAt: focus.endsAt, mode: 'drain' },
      actions: [{ label: 'End break', op: 'break_skip' }],
      app: APP,
    }
  }

  const last = focus.lastRun
  return {
    title: 'Rhythm is off',
    detail: last
      ? `Last run ${clockTime(last.startedAt)} to ${clockTime(last.endedAt)}. Nothing runs until you start a block.`
      : 'Nothing runs or counts until you start a block.',
    tone: 'neutral',
    glyph: 'pause',
    // A plain block of the configured length; the break-over notice is the one that continues a task.
    actions: [{ label: `Start focus block (${config.focusMinutes} min)`, op: 'focus_start', primary: true }],
    app: APP,
  }
}

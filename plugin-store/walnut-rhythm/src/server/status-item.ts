/**
 * Rhythm's ring in the console rail, as plain data. PURE: the public state in, the
 * status item out (or null to hide it).
 *
 *   off          grey, pause, no timer   Start focus block, Rest
 *   focus block  blue, drains            Rest now, +5 min, Stop block
 *   break        green, drains           Focus now, +5 min, End break
 *   replica: hidden
 *
 * Off is the state until the person presses Start, and after every run: the ring then
 * says so and offers one Start, never a countdown, because nothing is counting. Each
 * running state names when the run started and when it ends. The host ticks the ring
 * from `timer`, so nothing here runs per minute.
 */
import type { StatusItemState } from '@open-walnut/plugin-api/server'
import { clockTime } from './clock'
import { EXTEND_DEFAULT_MINUTES } from './focus'
import { nextBlockArgs } from './notices'
import type { RhythmPublicState } from './public-state'

export const STATUS_ITEM_ID = 'rhythm'
const APP = 'main'

export function rhythmStatusItem(state: RhythmPublicState): StatusItemState | null {
  if (state.replica) return null
  const { focus, config } = state
  const started = focus.runStartedAt !== null ? clockTime(focus.runStartedAt) : null

  if (focus.phase === 'focus' && focus.startedAt !== null && focus.endsAt !== null && focus.endsAt > focus.startedAt) {
    const quiet = config.focusQuietsWalnut ? ' Walnut is quiet until it ends.' : ''
    const what = `${focus.goal ? `Goal: ${focus.goal}. ` : ''}${focus.title ? `${focus.title}. ` : ''}`
    return {
      title: 'Focus · {remaining} left',
      detail: `${what}Started ${started ?? clockTime(focus.startedAt)}, ends ${clockTime(focus.endsAt)}.${quiet}`,
      tone: 'accent',
      timer: { startedAt: focus.startedAt, endsAt: focus.endsAt, mode: 'drain' },
      actions: [
        { label: 'Rest now', op: 'focus_rest' },
        { label: `+${EXTEND_DEFAULT_MINUTES} min`, op: 'focus_extend' },
        { label: 'Stop block', op: 'focus_stop' },
      ],
      app: APP,
    }
  }
  if (focus.phase === 'break' && focus.startedAt !== null && focus.endsAt !== null && focus.endsAt > focus.startedAt) {
    // A rest started from off had no block before it.
    const afterBlock = focus.runStartedAt !== null && focus.runStartedAt < focus.startedAt
    const block = started && afterBlock ? `Block ${started} to ${clockTime(focus.startedAt)}. ` : ''
    return {
      title: `${focus.breakKind === 'long' ? 'Long break' : 'Break'} · {remaining} left`,
      detail: `${block}Break ends ${clockTime(focus.endsAt)}, then Rhythm asks before the next block.`,
      tone: 'success',
      timer: { startedAt: focus.startedAt, endsAt: focus.endsAt, mode: 'drain' },
      actions: [
        { label: 'Focus now', op: 'focus_start', args: nextBlockArgs(focus), primary: true },
        { label: `+${EXTEND_DEFAULT_MINUTES} min break`, op: 'focus_extend' },
        { label: 'End break', op: 'break_skip' },
      ],
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
    actions: [
      { label: `Start focus block (${config.focusMinutes} min)`, op: 'focus_start', primary: true },
      { label: `Rest (${config.breakMinutes} min)`, op: 'focus_rest' },
    ],
    app: APP,
  }
}

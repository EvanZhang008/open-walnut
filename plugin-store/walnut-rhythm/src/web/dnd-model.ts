/**
 * What the running block's Do Not Disturb row says, and which button it offers. PURE,
 * so node tests read it without the JSX runtime.
 */
import { clockTime } from '../server/clock'
import { NO_END } from '../server/dnd-words'
import type { RhythmPublicState } from '../server/public-state'

export interface DndRowView {
  /** The one line, in plain words. */
  text: string
  tone?: 'warn' | 'error'
  /** The button: turn on, turn off, or none while macOS is busy. */
  action: 'on' | 'off' | null
  busy: boolean
}

/**
 * The row for the block running now; null when there is nothing to show (not a Mac, no
 * block). In any phase, a Do Not Disturb of Rhythm's that did not turn off is shown, with
 * a way to try again, so the Mac is never left silenced without a word.
 */
export function dndRowView(state: Pick<RhythmPublicState, 'dnd' | 'focus' | 'macos'>): DndRowView | null {
  if (!state.dnd.available) return null
  if (state.dnd.record?.stillOn) return { text: state.dnd.record.error ?? 'Mac Do Not Disturb may still be on.', tone: 'error', action: 'off', busy: false }
  if (state.focus.phase !== 'focus' || state.focus.startedAt === null) return null
  const record = state.dnd.record && state.dnd.record.block === state.focus.startedAt ? state.dnd.record : null
  const shortcuts = state.macos.shortcuts
  const notAdded = shortcuts.installed !== null && shortcuts.missing.length > 0
  if (!record || record.status === 'off') {
    return notAdded
      ? { text: 'Mac Do Not Disturb is off. Turning it on needs the two Rhythm shortcuts (Open Rhythm, then Add shortcuts).', action: null, busy: false }
      : { text: 'Mac Do Not Disturb is off for this block.', action: 'on', busy: false }
  }
  switch (record.status) {
    case 'turning-on': return { text: 'Turning Mac Do Not Disturb on…', action: null, busy: true }
    case 'turning-off': return { text: 'Turning Mac Do Not Disturb off…', action: null, busy: true }
    case 'on': return record.error
      ? { text: `Mac Do Not Disturb is on until ${clockTime(record.until)}. ${record.error}`, tone: 'warn', action: 'off', busy: false }
      : { text: `Mac Do Not Disturb is on until ${clockTime(record.until)}; macOS turns it off then.`, action: 'off', busy: false }
    case 'left-alone': return { text: `${record.focusName ?? 'A Focus'} was already on, so Rhythm left it as it is.`, action: 'on', busy: false }
    case 'failed': return { text: `Mac Do Not Disturb did not turn on. ${record.error ?? ''}`.trim(), tone: 'error', action: notAdded ? null : 'on', busy: false }
  }
}

/** The App's setup line for the setting. */
export function dndSetupText(state: Pick<RhythmPublicState, 'config' | 'macos'> & Partial<Pick<RhythmPublicState, 'dnd'>>): { text: string; tone?: 'warn' | 'error'; step: 'add' | 'access' | null } {
  const { shortcuts, mirror } = state.macos
  const on = state.config.macosFocusShortcuts
  // The last block found a copy of the shortcut that sets no end time; deleting it makes it "missing" below.
  if (state.dnd?.record?.noEnd && shortcuts.missing.length === 0) return { text: NO_END, tone: 'warn', step: null }
  if (!shortcuts.checked) return { text: on ? 'Checking your Shortcuts…' : 'Off. Each focus block can turn Mac Do Not Disturb on until it ends.', step: null }
  if (shortcuts.installed === null) return { text: shortcuts.error ?? 'Could not list your Shortcuts.', tone: 'error', step: null }
  if (shortcuts.missing.length > 0) {
    if (shortcuts.watching) return { text: `Adding them to Shortcuts (${shortcuts.missing.length} to go). If the Shortcuts app asks, click Add Shortcut.`, step: 'add' }
    return {
      text: on
        ? 'One time: add the two Rhythm shortcuts. Click Add shortcuts; if the Shortcuts app asks, click Add Shortcut for each.'
        : 'Off. Turning it on asks you to add two Rhythm shortcuts, one time.',
      tone: on ? 'warn' : undefined,
      step: 'add',
    }
  }
  if (on && mirror.phase === 'unavailable' && mirror.needsAccess) {
    return { text: 'One more one-time step, so Rhythm can see a Focus you turned on yourself and leave it alone: click Open Privacy settings, turn on Walnut in the Full Disk Access list (click + to add it if it is not there), then click Check again.', tone: 'warn', step: 'access' }
  }
  return on
    ? { text: 'On. Each focus block turns Mac Do Not Disturb on until it ends; a Focus you turned on yourself is left alone.', step: null }
    : { text: 'Off. The shortcuts are added; turn this on to use them.', step: null }
}

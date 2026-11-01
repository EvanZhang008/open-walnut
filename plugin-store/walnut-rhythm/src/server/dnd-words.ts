/**
 * The shortcut names and the words both the server and the App use for Do Not Disturb.
 * PURE, with no Node import, so the browser bundle can take it.
 */

export const SHORTCUT_ON = 'Walnut Do Not Disturb Until'
export const SHORTCUT_OFF = 'Walnut Focus Off'
/** What an older Rhythm installed: on until turned off. Never run now. */
export const LEGACY_SHORTCUT_ON = 'Walnut Focus On'

/** A shortcut of that name turned Do Not Disturb on without the block's end time. */
export const NO_END = `The "${SHORTCUT_ON}" shortcut in your Shortcuts app sets no end time, so Do Not Disturb goes off only while Walnut runs. Replace it: in Shortcuts, delete "${SHORTCUT_ON}", then click Add shortcuts in Rhythm.`

/**
 * The shortcut names and the words both the server and the App use for Do Not Disturb.
 * PURE, with no Node import, so the browser bundle can take it.
 */

/**
 * A new name, made only by this Rhythm's installer, so a copy that sets no end time can never
 * be the one that runs (2026-11-01: an earlier build's "Walnut Do Not Disturb Until" kept
 * Do Not Disturb on with no end, and Add shortcuts never replaced it, since only missing names
 * are added; "Walnut Do Not Disturb Until End" handed its output back, which macOS asks the
 * person about). Change the name again whenever the shortcut's actions change.
 */
export const SHORTCUT_ON = 'Walnut Do Not Disturb Until Block Ends'
export const SHORTCUT_OFF = 'Walnut Focus Off'
/** What an older Rhythm installed: on until turned off. Never run now. */
export const LEGACY_SHORTCUT_ON = 'Walnut Focus On'
/** Every "on" shortcut an older Rhythm made. None is run now; the App says they can go. */
export const LEGACY_SHORTCUT_NAMES: readonly string[] = [LEGACY_SHORTCUT_ON, 'Walnut Do Not Disturb Until', 'Walnut Do Not Disturb Until End']

/** The App's line about older shortcuts still in Shortcuts. PURE. */
export function legacyText(names: readonly string[]): string {
  const quoted = names.map((name) => `"${name}"`)
  const list = quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}` : quoted[0]
  return quoted.length > 1
    ? `The older ${list} shortcuts are no longer used; you can delete them in Shortcuts.`
    : `The older ${list} shortcut is no longer used; you can delete it in Shortcuts.`
}

/** A shortcut of that name turned Do Not Disturb on without the block's end time. */
export const NO_END = `The "${SHORTCUT_ON}" shortcut in your Shortcuts app sets no end time, so Do Not Disturb goes off only while Walnut runs. Replace it: in Shortcuts, delete "${SHORTCUT_ON}", then click Add shortcuts in Rhythm.`

/**
 * The sounds the person starred: they sit at the top of every music list, on every
 * device. PURE. Each is the list's own key for a choice (`track:<file name>` or
 * `spotify:<uri>`), kept in state.json by the runtime and sent in the public state.
 * A starred file that left the folder stays starred, so it is on top again if it
 * comes back; nothing else reads a key that matches no sound.
 */

/** How many stars Rhythm keeps; starring one more drops the oldest. */
export const MAX_STARRED = 50

const TRACK_KEY = /^track:[^\u0000-\u001f]{1,300}$/
const SPOTIFY_KEY = /^spotify:spotify:(playlist|album|artist|show|track):[A-Za-z0-9]{8,40}$/

export function isStarKey(key: unknown): key is string {
  return typeof key === 'string' && (TRACK_KEY.test(key) || SPOTIFY_KEY.test(key))
}

/** What state.json held → the starred keys, oldest first, without repeats. */
export function parseStarred(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.filter(isStarKey))].slice(-MAX_STARRED)
}

/** Star (`on`) or unstar one key. A new star goes last; the oldest goes past MAX_STARRED. */
export function setStarred(list: string[], key: string, on: boolean): string[] {
  const rest = list.filter((one) => one !== key)
  return on ? [...rest, key].slice(-MAX_STARRED) : rest
}

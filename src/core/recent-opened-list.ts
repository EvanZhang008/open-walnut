/**
 * The list behind the Home panel's Recent tab (web/src/utils/recent-opened.ts): the tasks the
 * person created, opened or wrote in, one entry per task at its newest human touch.
 * Newest first, capped. Shared by the web client and the ui-prefs route, which stores this key as the UNION of what each window
 * sends (UNION_PREF_KEYS), never one window's list replacing another's: two devices opening
 * tasks at the same moment both keep their opens.
 */

export const RECENT_OPENED_KEY = 'walnut-todo-recent-opened'
/** How many opens the list keeps (about 3 KB, well under a ui-prefs value's 8 KB). */
export const RECENT_OPENED_MAX = 50

export interface RecentOpen {
  /** The task id. */
  id: string
  /** When the person last created, opened or wrote in it (ISO). */
  at: string
  /** Verified at the trusted input or person-source boundary. Older clients ignore it. */
  human?: true
}

function normalize(entries: readonly RecentOpen[]): RecentOpen[] {
  const newest = new Map<string, RecentOpen>()
  for (const e of entries) {
    const seen = newest.get(e.id)
    if (seen?.human === true && e.human !== true) continue
    if (!seen || (e.human === true && seen.human !== true) || Date.parse(e.at) > Date.parse(seen.at)) newest.set(e.id, { id: e.id, at: e.at, ...(e.human === true ? { human: true } : {}) })
  }
  const values = [...newest.values()]
  // Once verified rows exist, an old browser's unverified list cannot fill the cap.
  const verified = values.some((e) => e.human === true) ? values.filter((e) => e.human === true) : values
  return verified
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id))
    .slice(0, RECENT_OPENED_MAX)
}

/** Entries from any stored value: bad rows dropped, one per task, newest first, capped. */
export function parseRecentOpened(raw: string | null): RecentOpen[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value)) return []
    return normalize(value.filter((e): e is RecentOpen =>
      !!e && typeof e === 'object' && typeof (e as RecentOpen).id === 'string' && !!(e as RecentOpen).id
      && typeof (e as RecentOpen).at === 'string' && !isNaN(Date.parse((e as RecentOpen).at))))
  } catch { return [] }
}

/** Two lists as one: each task at its newest open, newest first, capped. */
export function mergeRecentOpened(a: readonly RecentOpen[], b: readonly RecentOpen[]): RecentOpen[] {
  return normalize([...a, ...b])
}

/** Two stored values as one (the same rule on the raw strings). */
export function mergeRecentOpenedRaw(a: string | null, b: string | null): string {
  return JSON.stringify(mergeRecentOpened(parseRecentOpened(a), parseRecentOpened(b)))
}

/** The list with `id` opened at `at` (moved to the top when already there). */
export function withOpened(list: readonly RecentOpen[], id: string, at: string): RecentOpen[] {
  return normalize([{ id, at, human: true }, ...list])
}

/**
 * ui-prefs keys every writer adds to: a write is merged with the stored value instead of
 * replacing it, whichever is newer (the boot merge, the mirror's flush and the server's PUT).
 */
export const UNION_PREF_KEYS: Readonly<Record<string, (a: string, b: string) => string>> = {
  [RECENT_OPENED_KEY]: mergeRecentOpenedRaw,
}

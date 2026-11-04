/**
 * Builds that did not stay serving where they replaced a daemon, kept across server
 * restarts. 2026-11-04 review: the backoff lived in memory, so every deploy (a server
 * restart) let the next connect stop the healthy daemon for the same failing build again.
 *
 * Wall clock (Date.now), never a monotonic one: a backoff must run out in real time,
 * across a Mac's sleep and across restarts, and a monotonic clock stops in sleep and
 * starts again at every process start.
 *
 * One small JSON file in WALNUT_HOME/local/ (daemon-update-store.ts: machine-local, never
 * synced), keyed by this machine and where the daemon runs (`local:<dir>`, `ssh:<host>`,
 * `net:<host>`). A test run keeps none unless it names the file (WALNUT_BUILD_BACKOFF_FILE).
 */
import { KeyedUpdateStore, updateStoresSettled } from './daemon-update-store.js'

/** How long a build that did not stay serving is left alone where it failed (a newer build ends it sooner). */
export const BUILD_BACKOFF_MS = 24 * 60 * 60_000

export interface BuildBackoffEntry {
  expected: string
  at: number
  reason: string
  /** SSH: how the build that ran before was started again after this one failed (its files are back in place). */
  previous?: { runtime: string; bunPath: string | null }
}

const valid = (e: unknown): e is BuildBackoffEntry => !!e && typeof e === 'object'
  && typeof (e as BuildBackoffEntry).expected === 'string' && Number.isFinite((e as BuildBackoffEntry).at)

const store = new KeyedUpdateStore<BuildBackoffEntry>('daemon-build-backoff.json', 'WALNUT_BUILD_BACKOFF_FILE', BUILD_BACKOFF_MS, valid)

/** The entry kept for `key`, or null (none, unreadable, or no file in a test run). */
export async function readBuildBackoff(key: string): Promise<BuildBackoffEntry | null> {
  const entry = await store.read(key)
  if (!entry) return null
  const p = entry.previous
  const previous = p && typeof p.runtime === 'string' && (p.bunPath === null || typeof p.bunPath === 'string') ? { runtime: p.runtime, bunPath: p.bunPath } : undefined
  return { expected: entry.expected, at: entry.at, reason: String(entry.reason ?? ''), ...(previous ? { previous } : {}) }
}

/** Keep (or with null, forget) the entry for `key`. Best effort: a backoff that cannot be kept is in memory only. */
export function writeBuildBackoff(key: string, entry: BuildBackoffEntry | null): Promise<void> {
  return store.write(key, entry)
}

/** The writes asked for so far are on disk (tests, and a caller that must read its own write). */
export function buildBackoffSettled(): Promise<void> {
  return updateStoresSettled()
}

/**
 * `entry` holds `expected` back now: the same build, within BUILD_BACKOFF_MS of its failure
 * (wall clock; a clock set back counts the same distance, so a backoff never lasts much longer).
 */
export function buildBackedOff(entry: BuildBackoffEntry | null | undefined, expected: string, now = Date.now()): boolean {
  return !!entry && entry.expected === expected && store.fresh(entry, now)
}

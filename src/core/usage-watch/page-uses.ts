/**
 * A page's real use: its visits, and the errors thrown on it, by the hour (store.ts page_uses).
 *
 * 2026-11-25: every `page:` watch target read 0 uses and passed. Real use counted only a page's
 * errors, named by chunk or request (normalize.ts pageErrorKind), as its "uses": page:home, opened 29
 * times that day (Settings › Page use), was 0 uses with no error, and a page target was exempt from
 * the least use a verdict needs. Now:
 *   - a visit Page use counts (core/page-visits.ts, the places in core/page-places.ts) is a use of
 *     its place, by the hour;
 *   - an error thrown on a page, or a request its browser refused, counts on the place its address
 *     names (the log line's path), never a request that went wrong on its way;
 *   - before this file kept a place's hours, its visits are known by the day (Page use's own days).
 * A replica (the companion) keeps no store: its visits stay its own (record.ts flushUsage drops them).
 * The verdict (watches.ts judgeWatch) never passes a target with no use.
 */
import { CORE_PAGE_KEYS, PAGE_PARTS, VISIT_KEY_RE, pageKeyForPath, visitKeyOfTarget } from '../page-places.js'
import { firstPageUseHour, readPageUseKeys, readPageUses } from './store.js'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
/** More places between two flushes (a minute) than the app has: the rest is dropped, never stored. */
const MAX_PLACES_PER_FLUSH = 200

let pending = new Map<string, { hour: number; key: string; visits: number; errors: number }>()

/** One visit or one error of a place (`page:home`, `part:session-panel`), into this hour's row. */
export function notePageUse(key: string, what: 'visit' | 'error', now: number): void {
  if (!VISIT_KEY_RE.test(key)) return
  const hour = Math.floor(now / HOUR_MS) * HOUR_MS
  const id = `${hour}\t${key}`
  let row = pending.get(id)
  if (!row) {
    if (pending.size >= MAX_PLACES_PER_FLUSH) return
    row = { hour, key, visits: 0, errors: 0 }
    pending.set(id, row)
  }
  if (what === 'visit') row.visits += 1
  else row.errors += 1
}

/** The place a page's log line came from (its `url`, the page's path), or null. */
export function placeOfPagePath(pathname: unknown): string | null {
  return typeof pathname === 'string' && pathname.startsWith('/') ? pageKeyForPath(pathname.split(/[?#]/)[0] ?? '') : null
}

/** What gathered since the last flush (record.ts flushUsage), taken. */
export function takePageUses(): Array<{ hour: number; key: string; visits: number; errors: number }> {
  const rows = [...pending.values()]
  pending = new Map()
  return rows
}

export function _resetPageUsesForTesting(): void {
  pending = new Map()
  seen = null
}

/** A page of the app's own, a part, a Settings pane or an app: a place by its key alone. */
export function isPlaceKey(key: string): boolean {
  return CORE_PAGE_KEYS.includes(key) || PAGE_PARTS.some((p) => p.key === key) || /^(settings|app):/.test(key)
}

const SEEN_EVERY_MS = 60_000
let seen: { at: number; keys: Set<string> } | null = null

/** The places real use kept a row of in its four weeks, read again at most once a minute. */
function seenPlaces(now = Date.now()): Set<string> {
  if (!seen || now - seen.at > SEEN_EVERY_MS) seen = { at: now, keys: new Set(readPageUseKeys(now - 28 * DAY_MS)) }
  return seen.keys
}

/**
 * Whether a key is a place whose visits are counted: one by its key alone (isPlaceKey), or one a visit
 * was counted for (a plugin's page): real use kept a row of it, or Page use has its days. The same
 * answer when a watch is set, judged, rung and reported. A `page:` target naming anything else (a
 * component, an error's words) is an older target, judged by the page errors its words name, as before.
 */
export function isCountedPlace(key: string, days?: Record<string, number>): boolean {
  return isPlaceKey(key) || days !== undefined || seenPlaces().has(key)
}

/** The days a span touches, `YYYY-MM-DD` (UTC). */
function daysOf(from: number, to: number): string[] {
  const out: string[] = []
  for (let d = Math.floor(from / DAY_MS) * DAY_MS; d < to; d += DAY_MS) out.push(new Date(d).toISOString().slice(0, 10))
  return out
}

export interface PlaceUse {
  visits: number
  errors: number
  /** Of `visits`, those known only by the day (before page rows were kept by the hour). */
  byDay: number
}

/**
 * A place's visits and own errors over [since, until). As for every target (watches.ts mergedFor),
 * the window starts at its first whole hour. Hours before the first page row was kept read Page use's
 * days instead (`days`, its per-day counts), each day the window touches before the day page rows began.
 */
export function placeUseOf(key: string, since: number, until: number, days?: Record<string, number>): PlaceUse {
  const next = Math.ceil(since / HOUR_MS) * HOUR_MS
  const from = next + HOUR_MS <= until ? next : Math.floor(since / HOUR_MS) * HOUR_MS
  const out: PlaceUse = { visits: 0, errors: 0, byDay: 0 }
  for (const r of readPageUses(from, key)) {
    if (r.hour >= until) continue
    out.visits += r.visits
    out.errors += r.errors
  }
  if (days) {
    const first = firstPageUseHour()
    // The day page rows began holds hourly rows: days are read only up to its start, never both.
    const cut = first === null ? until : Math.min(until, Math.floor(first / DAY_MS) * DAY_MS)
    // Whole days: the day the watch was set counts whole, visits before it included.
    if (cut > since) for (const day of daysOf(since, cut)) out.byDay += days[day] ?? 0
    out.visits += out.byDay
  }
  return out
}

/**
 * Why a `page:` target names nothing real use counts, or null. `known`: the places counted so far
 * (Page use's keys, this file's rows). A Settings pane or an app is taken by its form alone: one just
 * shipped was never opened yet.
 */
export function pageTargetProblem(target: string, known: ReadonlySet<string>): string | null {
  const key = visitKeyOfTarget(target)
  const forms = 'page:<page> (page:home, page:org), page:<part> (page:session-panel, page:task-detail), page:settings:<pane id> or page:app:<app id>'
  if (!key) return `"${target.slice(0, 80)}" names no page: use ${forms}`
  if (isCountedPlace(key) || known.has(key)) return null
  const pages = [...new Set([...CORE_PAGE_KEYS, ...[...known].filter((k) => k.startsWith('page:'))])].sort()
  return `"${target.slice(0, 80)}" is no page Walnut counts visits of, so its watch could never see a use. Name ${forms}; pages: ${pages.join(', ')}`
}

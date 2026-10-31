/**
 * Local page-use counts: which web pages and Settings panes the user opens, and when.
 *
 * Why (2026-10-31, the user): Settings had grown panes nobody opened in a year, and
 * pruning them was guesswork. Every page and Settings pane now records a visit here, so
 * the next pruning reads facts ("Page use" in Settings > Diagnostics).
 *
 * Rules, all on purpose:
 * - Machine-local and private: `WALNUT_HOME/local/page-visits.json` (`/local/` is out of
 *   the data-repo sync), never sent anywhere. Counts and dates only, no content.
 * - Tiny and bounded: at most MAX_KEYS keys, each `<kind>:<id>` of at most 80 safe
 *   characters; per key a total, the first and last visit, and a per-day count kept for
 *   KEEP_DAYS days. A key over the cap evicts the least recently used one.
 * - Cheap: visits gather in memory and reach the disk at most every FLUSH_MS.
 * - A test run (header `x-walnut-test-run`, an automated browser) never records: the
 *   route drops those before they get here.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../constants.js'
import { log } from '../logging/index.js'

export const MAX_KEYS = 400
export const KEEP_DAYS = 120
export const FLUSH_MS = 30_000
/** `page:org`, `settings:sessions`, `app:walnut-notes~main`. */
export const VISIT_KEY_RE = /^(page|settings|app):[A-Za-z0-9._~-]{1,72}$/

export interface VisitEntry {
  count: number
  firstAt: string
  lastAt: string
  /** YYYY-MM-DD (UTC) -> visits that day, the last KEEP_DAYS days only. */
  days: Record<string, number>
}

export interface VisitStore {
  version: 1
  since: string
  keys: Record<string, VisitEntry>
}

let fileOverride: string | null = null
const visitsFile = () => fileOverride ?? path.join(WALNUT_HOME, 'local', 'page-visits.json')

let store: VisitStore | null = null
let loading: Promise<VisitStore> | null = null
let dirty = false
let timer: ReturnType<typeof setTimeout> | null = null

function emptyStore(now: Date): VisitStore {
  return { version: 1, since: now.toISOString(), keys: {} }
}

/** A stored file read back leniently: anything malformed is dropped, never thrown. */
export function sanitizeStore(raw: unknown, now: Date = new Date()): VisitStore {
  const out = emptyStore(now)
  if (!raw || typeof raw !== 'object') return out
  const r = raw as Record<string, unknown>
  if (typeof r.since === 'string' && !Number.isNaN(Date.parse(r.since))) out.since = r.since
  const keys = r.keys && typeof r.keys === 'object' ? r.keys as Record<string, unknown> : {}
  for (const [key, value] of Object.entries(keys)) {
    if (!VISIT_KEY_RE.test(key) || !value || typeof value !== 'object') continue
    const v = value as Record<string, unknown>
    const count = typeof v.count === 'number' && Number.isFinite(v.count) && v.count > 0 ? Math.floor(v.count) : 0
    if (!count || typeof v.lastAt !== 'string' || typeof v.firstAt !== 'string') continue
    const days: Record<string, number> = {}
    if (v.days && typeof v.days === 'object') {
      for (const [d, n] of Object.entries(v.days as Record<string, unknown>)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(d) && typeof n === 'number' && n > 0) days[d] = Math.floor(n)
      }
    }
    out.keys[key] = { count, firstAt: v.firstAt, lastAt: v.lastAt, days }
  }
  return prune(out, now)
}

/** Drop days older than KEEP_DAYS and evict the least recently used keys past MAX_KEYS. */
export function prune(s: VisitStore, now: Date = new Date()): VisitStore {
  const cutoff = new Date(now.getTime() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10)
  for (const entry of Object.values(s.keys)) {
    for (const d of Object.keys(entry.days)) if (d < cutoff) delete entry.days[d]
  }
  const names = Object.keys(s.keys)
  if (names.length > MAX_KEYS) {
    names.sort((a, b) => s.keys[a].lastAt.localeCompare(s.keys[b].lastAt))
    for (const k of names.slice(0, names.length - MAX_KEYS)) delete s.keys[k]
  }
  return s
}

/** Count one visit of each key into `s` (pure: the route and the tests share it). */
export function applyVisits(s: VisitStore, keys: readonly string[], now: Date = new Date()): number {
  const at = now.toISOString()
  const day = at.slice(0, 10)
  let counted = 0
  for (const key of keys) {
    if (typeof key !== 'string' || !VISIT_KEY_RE.test(key)) continue
    const entry = s.keys[key] ?? (s.keys[key] = { count: 0, firstAt: at, lastAt: at, days: {} })
    entry.count += 1
    entry.lastAt = at
    entry.days[day] = (entry.days[day] ?? 0) + 1
    counted += 1
  }
  if (counted) prune(s, now)
  return counted
}

async function load(): Promise<VisitStore> {
  if (store) return store
  loading ??= (async () => {
    let raw: unknown = null
    try { raw = JSON.parse(await fsp.readFile(visitsFile(), 'utf8')) } catch { /* none yet, or unreadable: start fresh */ }
    store = sanitizeStore(raw)
    return store
  })().finally(() => { loading = null })
  return loading
}

let writing: Promise<void> = Promise.resolve()

/** One write at a time, so a Clear never loses to an older write still in flight. */
function flush(): Promise<void> {
  timer = null
  writing = writing.then(writeNow, writeNow)
  return writing
}

async function writeNow(): Promise<void> {
  if (!dirty || !store) return
  dirty = false
  const file = visitsFile()
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    await fsp.writeFile(tmp, JSON.stringify(store), 'utf8')
    await fsp.rename(tmp, file)
  } catch (err) {
    // Kept in memory: the next visit (or shutdown) writes it again.
    dirty = true
    log.web.warn('page-visits: write failed', { error: err instanceof Error ? err.message : String(err) })
  }
}

/** Record visits; returns how many keys counted. The disk sees them within FLUSH_MS. */
export async function recordVisits(keys: readonly string[], now: Date = new Date()): Promise<number> {
  const s = await load()
  const counted = applyVisits(s, keys, now)
  if (counted) {
    dirty = true
    if (!timer) {
      timer = setTimeout(() => { void flush() }, FLUSH_MS)
      timer.unref?.()
    }
  }
  return counted
}

export async function readVisits(): Promise<VisitStore> {
  return structuredClone(await load())
}

/** Clear every count (the pane's Reset), on disk at once. */
export async function resetVisits(now: Date = new Date()): Promise<void> {
  store = emptyStore(now)
  dirty = true
  if (timer) { clearTimeout(timer); timer = null }
  await flush()
}

/** Write what is pending now (server shutdown, tests). */
export async function flushVisitsNow(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null }
  await flush()
}

export function setPageVisitsFileForTesting(file: string | null): void {
  fileOverride = file
  store = null
  loading = null
  dirty = false
  if (timer) { clearTimeout(timer); timer = null }
}

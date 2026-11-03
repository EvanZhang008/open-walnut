/**
 * The fleet view's memory of each host (Settings › Remote Hosts › Overview): the
 * last `host.vitals` answer and placement view each host gave, when Walnut last
 * read it, and why its last read failed. 2026-11-03, the user: the Overview sat on
 * "Reading each host..." for half a minute on every open; "just show cache and
 * fetch when user click". So the page opens on what Walnut read last
 * (fleet-refresh.ts builds the cards from this plus the live link state) and reads
 * the hosts again only when the person asks.
 *
 * Kept in WALNUT_HOME/local/fleet-cache.json: local to this Walnut (`/local/` is
 * out of the data-repo sync), read once per process at the first fleet read, then
 * served from memory. Writes are async, coalesced (WRITE_DELAY_MS after the last
 * change, one at a time) and atomic (writeJsonFile: a temp file, then rename). It is
 * a cache: a file that does not parse, or an entry that does not look like ours, is
 * dropped, and the next read fills it again.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import { writeJsonFile } from '../../utils/fs.js'
import type { HostVitals } from '../../providers/host-vitals-core.js'
import type { FleetInputs } from './fleet-model.js'

export type FleetLoad = NonNullable<FleetInputs['load']>

export interface FleetCacheEntry {
  /** When the readings below were last read (the last read that worked); null before one. */
  readAt: number | null
  /** The host's last host.vitals answer (the 30 day window) and when it came. */
  vitals: { value: HostVitals; at: number } | null
  /** The last read got no fresh answer (the host is away, or did not answer): `vitals` is older. */
  stale: boolean
  /** Placement's last view of the host. */
  load: FleetLoad | null
  /** Why the last read failed and when; null once one worked. */
  error: string | null
  errorAt: number | null
}

export interface FleetSpend { at: number; from: string; byHost: Record<string, number> }

interface CacheFile { version: 1; hosts: Record<string, FleetCacheEntry>; spend: FleetSpend | null }

const WRITE_DELAY_MS = 500
const MAX_HOSTS = 64
const MAX_ERROR_CHARS = 300

let fileOverride: string | null = null
const cacheFile = () => fileOverride ?? path.join(WALNUT_HOME, 'local', 'fleet-cache.json')

let memory: CacheFile | null = null
/** The file was read into memory; every change waits for that (see `pending`). */
let loaded = false
let loading: Promise<void> | null = null
/**
 * Changes recorded before the file was read wait here: applied to a blank entry, a change
 * that names one field (a session prompt's fleet read records only placement's load) would
 * stand for the whole host and erase the readings only the file holds (2026-11-03 review).
 */
let pending: Array<(m: CacheFile) => void> = []
let dirty = false
let timer: ReturnType<typeof setTimeout> | null = null
let writing: Promise<void> = Promise.resolve()
/** Bumped by a test reset: a write from before it never lands in the next test's file. */
let generation = 0

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function sanitizeEntry(raw: unknown): FleetCacheEntry | null {
  if (!isObj(raw)) return null
  const v = raw.vitals
  const vitals = isObj(v) && isNum(v.at) && isObj(v.value) && isObj(v.value.stats) && isObj(v.value.history)
    ? { value: v.value as unknown as HostVitals, at: v.at } : null
  const l = raw.load
  const load = isObj(l) && typeof l.known === 'boolean' && Array.isArray(l.reasons) ? l as unknown as FleetLoad : null
  const readAt = isNum(raw.readAt) ? raw.readAt : null
  const error = typeof raw.error === 'string' ? raw.error.slice(0, MAX_ERROR_CHARS) : null
  if (readAt === null && !vitals && !error) return null
  return { readAt, vitals, stale: raw.stale === true, load, error, errorAt: error && isNum(raw.errorAt) ? raw.errorAt : null }
}

/** A stored file read back leniently: anything malformed is dropped, never thrown. */
export function sanitizeFleetCache(raw: unknown): CacheFile {
  const out: CacheFile = { version: 1, hosts: {}, spend: null }
  if (!isObj(raw) || raw.version !== 1) return out
  if (isObj(raw.hosts)) {
    for (const [host, entry] of Object.entries(raw.hosts).slice(0, MAX_HOSTS)) {
      const clean = sanitizeEntry(entry)
      if (clean && host.length <= 128) out.hosts[host] = clean
    }
  }
  const s = raw.spend
  if (isObj(s) && isNum(s.at) && typeof s.from === 'string' && isObj(s.byHost)) {
    const byHost: Record<string, number> = {}
    for (const [k, n] of Object.entries(s.byHost)) if (isNum(n)) byHost[k] = n
    out.spend = { at: s.at, from: s.from, byHost }
  }
  return out
}

/** The cache, read from disk the first time (memoized: concurrent first reads share one). */
export async function loadFleetCache(): Promise<void> {
  if (loaded) return
  const gen = generation
  loading ??= (async () => {
    let raw: unknown = null
    try {
      raw = JSON.parse(await fsp.readFile(cacheFile(), 'utf8'))
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') log.web.warn('fleet cache: unreadable, starting empty', { error: err instanceof Error ? err.message : String(err) })
    }
    if (gen !== generation) return
    memory = sanitizeFleetCache(raw)
    loaded = true
    // What was recorded while the file was being read, applied to the file's own entries in order.
    const queued = pending.splice(0)
    for (const change of queued) change(memory)
    if (queued.length) scheduleWrite()
  })().finally(() => { loading = null })
  await loading
}

export function fleetCacheEntry(host: string): FleetCacheEntry | null {
  return memory?.hosts[host] ?? null
}

export function cachedSpend(): FleetSpend | null {
  return memory?.spend ?? null
}

/** Apply a change to the cache: now when the file was read, else once it is. */
function change(fn: (m: CacheFile) => void): void {
  if (loaded && memory) { fn(memory); scheduleWrite(); return }
  pending.push(fn)
  void loadFleetCache()
}

function entry(m: CacheFile, host: string): FleetCacheEntry {
  return (m.hosts[host] ??= { readAt: null, vitals: null, stale: false, load: null, error: null, errorAt: null })
}

/** The host answered host.vitals: the reading is fresh, any failure before it is over. */
export function recordFleetVitals(host: string, value: HostVitals, at: number): void {
  const { ok: _ok, ...rest } = value as HostVitals & { ok?: unknown }
  change((m) => { Object.assign(entry(m, host), { vitals: { value: rest as HostVitals, at }, stale: false, readAt: at, error: null, errorAt: null }) })
}

/**
 * A read that worked without a vitals answer: the host is away (its reading stays,
 * stale) or its daemon cannot answer one (an older daemon: nothing to keep).
 */
export function recordFleetNoVitals(host: string, at: number, opts: { away: boolean }): void {
  change((m) => {
    const e = entry(m, host)
    Object.assign(e, { readAt: at, stale: opts.away ? !!e.vitals : false, error: null, errorAt: null })
    if (!opts.away) e.vitals = null
  })
}

/** The read failed: what it read before stays (now stale), with why. */
export function recordFleetFailure(host: string, error: string, at: number): void {
  change((m) => {
    const e = entry(m, host)
    Object.assign(e, { stale: !!e.vitals, error: error.split('\n')[0].slice(0, MAX_ERROR_CHARS), errorAt: at })
  })
}

export function recordFleetLoad(host: string, load: FleetLoad): void {
  change((m) => { entry(m, host).load = load })
}

/** A full read of the fleet: drop the hosts it no longer lists (removed from Settings). */
export function pruneFleetCache(keep: readonly string[]): void {
  change((m) => { for (const host of Object.keys(m.hosts)) if (!keep.includes(host)) delete m.hosts[host] })
}

export function recordFleetSpend(spend: FleetSpend): void {
  change((m) => { m.spend = spend })
}

function scheduleWrite(): void {
  dirty = true
  if (timer) return
  timer = setTimeout(() => { timer = null; void flush() }, WRITE_DELAY_MS)
  timer.unref?.()
}

function flush(): Promise<void> {
  const gen = generation
  writing = writing.then(() => writeNow(gen), () => writeNow(gen))
  return writing
}

async function writeNow(gen: number): Promise<void> {
  // Changes reach memory only after the file was read, so a write never loses what only it held.
  if (!dirty || !loaded || !memory || gen !== generation) return
  dirty = false
  try {
    await writeJsonFile(cacheFile(), memory)
  } catch (err) {
    // Kept in memory: the next change writes it again.
    dirty = true
    log.web.warn('fleet cache: write failed', { error: err instanceof Error ? err.message : String(err) })
  }
}

/** Write what is pending now (tests; a shutdown may call it too). */
export async function flushFleetCacheNow(): Promise<void> {
  await loadFleetCache()
  if (timer) { clearTimeout(timer); timer = null }
  await flush()
}

/**
 * Test seam: forget the memory (the next read comes from disk, as after a restart),
 * drop pending writes, and optionally point the cache at another file.
 */
export function __resetFleetCacheForTesting(opts: { file?: string | null } = {}): void {
  generation++
  if (opts.file !== undefined) fileOverride = opts.file
  memory = null
  loaded = false
  loading = null
  pending = []
  dirty = false
  if (timer) { clearTimeout(timer); timer = null }
}

/**
 * Quiet mode: Walnut-level do not disturb.
 *
 * A focus timer (a plugin), the human's own toggle, or anything else can HOLD
 * quiet. Several holds may coexist, keyed by `source` (`user`, `plugin:<id>`), and
 * Walnut is quiet while any of them is live. The web stops toasting, chiming and
 * raising browser notifications, and push stops, but the feed keeps collecting
 * and the badge keeps counting. Quiet silences interruptions; it never loses them.
 *
 * `allowPermissions` defaults to TRUE on every hold, and the computed flag is the
 * AND of the live holds. A permission prompt is not an interruption like the
 * others: an agent is BLOCKED on it, so silencing it stalls work for the length
 * of the focus block without anyone noticing. A hold that really means "nothing
 * at all" says so explicitly.
 *
 * Expiry is lazy on every read plus ONE timer armed for the earliest `until`, so
 * `quiet:changed` fires at the moment a hold ends without anything polling. The
 * state persists to <WALNUT_HOME>/quiet.json so a restart in the middle of a focus
 * block stays quiet until its `until`. The file is machine-local (git-sync ignores
 * it): an echo of another box's older holds would re-arm quiet here.
 */
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { readJsonFile, writeJsonFile } from '../../utils/fs.js'
import { bus, EventNames } from '../event-bus.js'
import { log } from '../../logging/index.js'
import type { QuietHold, QuietState } from '../event-types.js'

export type { QuietHold, QuietState }

export interface SetQuietInput {
  source: string
  /** Epoch ms. Absent = until cleared. A time already past clears the hold. */
  until?: number
  reason?: string
  /** Default true (see the module comment for why). */
  allowPermissions?: boolean
  /**
   * Which generation of the source set this hold (a plugin's api instance). Only
   * gates `clearQuiet(source, { owner })`: a replaced plugin generation disposing
   * late must not clear the hold its successor just set. Never persisted.
   */
  owner?: string
}

interface StoredHold extends QuietHold {
  allowPermissions: boolean
  owner?: string
}

const MAX_SOURCE_CHARS = 128
const MAX_REASON_CHARS = 200
/** Below this an `until` is seconds, not milliseconds: refuse instead of expiring it at once. */
const MIN_EPOCH_MS = 1e11
/** setTimeout overflows past 2^31-1 ms; a longer hold re-arms at most daily. */
const MAX_TIMER_MS = 24 * 60 * 60 * 1000

const INACTIVE: QuietState = { active: false, allowPermissions: true, holds: [] }

const holds = new Map<string, StoredHold>()
let loadPromise: Promise<void> | null = null
let expiryTimer: ReturnType<typeof setTimeout> | null = null
let lastPublishedKey = JSON.stringify(INACTIVE)
let writeChain: Promise<void> = Promise.resolve()

function quietFile(): string {
  return path.join(WALNUT_HOME, 'quiet.json')
}

function normalizeHold(raw: unknown): StoredHold | null {
  if (!raw || typeof raw !== 'object') return null
  const h = raw as Record<string, unknown>
  if (typeof h.source !== 'string' || !h.source) return null
  if (typeof h.since !== 'number' || !Number.isFinite(h.since)) return null
  const until = typeof h.until === 'number' && Number.isFinite(h.until) ? h.until : undefined
  const reason = typeof h.reason === 'string' && h.reason ? h.reason.slice(0, MAX_REASON_CHARS) : undefined
  return {
    source: h.source.slice(0, MAX_SOURCE_CHARS),
    since: h.since,
    allowPermissions: h.allowPermissions !== false,
    ...(until !== undefined ? { until } : {}),
    ...(reason ? { reason } : {}),
  }
}

function isLive(h: StoredHold, now: number): boolean {
  return h.until === undefined || h.until > now
}

function snapshot(now = Date.now()): QuietState {
  const live = [...holds.values()].filter(h => isLive(h, now)).sort((a, b) => a.since - b.since)
  if (live.length === 0) return { ...INACTIVE, holds: [] }
  return {
    active: true,
    allowPermissions: live.every(h => h.allowPermissions),
    holds: live.map(h => ({
      source: h.source,
      since: h.since,
      ...(h.until !== undefined ? { until: h.until } : {}),
      ...(h.reason ? { reason: h.reason } : {}),
    })),
  }
}

/** Drop holds whose `until` passed. True when anything was removed. */
function pruneExpired(now: number): boolean {
  let removed = false
  for (const [source, h] of holds) {
    if (!isLive(h, now)) { holds.delete(source); removed = true }
  }
  return removed
}

function persist(): Promise<void> {
  const body = {
    version: 1,
    // `owner` is a process-lifetime token, meaningless after a restart.
    holds: [...holds.values()].map(({ owner: _owner, ...rest }) => rest),
  }
  writeChain = writeChain
    .then(() => writeJsonFile(quietFile(), body))
    .catch((err) => {
      log.notif.warn('quiet: failed to persist state', { error: err instanceof Error ? err.message : String(err) })
    })
  return writeChain
}

function publishIfChanged(): void {
  const state = snapshot()
  const key = JSON.stringify(state)
  if (key === lastPublishedKey) return
  lastPublishedKey = key
  bus.emit(EventNames.QUIET_CHANGED, state, ['web-ui'], { source: 'quiet' })
}

function armTimer(): void {
  if (expiryTimer) { clearTimeout(expiryTimer); expiryTimer = null }
  let next = Infinity
  for (const h of holds.values()) if (h.until !== undefined && h.until < next) next = h.until
  if (next === Infinity) return
  const delay = Math.min(Math.max(0, next - Date.now()) + 25, MAX_TIMER_MS)
  expiryTimer = setTimeout(() => {
    expiryTimer = null
    if (pruneExpired(Date.now())) void persist()
    publishIfChanged()
    armTimer()
  }, delay)
  expiryTimer.unref?.()
}

function ensureLoaded(): Promise<void> {
  loadPromise ??= (async () => {
    try {
      const raw = await readJsonFile<{ holds?: unknown } | null>(quietFile(), null)
      for (const one of Array.isArray(raw?.holds) ? raw.holds : []) {
        const h = normalizeHold(one)
        if (h && !holds.has(h.source)) holds.set(h.source, h)
      }
    } catch (err) {
      log.notif.warn('quiet: unreadable state file, starting loud', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    if (pruneExpired(Date.now())) void persist()
    armTimer()
    publishIfChanged()
  })()
  return loadPromise
}

/** Load the persisted state and arm the expiry timer. Idempotent (server boot). */
export async function initQuiet(): Promise<void> {
  await ensureLoaded()
}

/** The current quiet state, expired holds dropped. */
export async function getQuiet(): Promise<QuietState> {
  await ensureLoaded()
  if (pruneExpired(Date.now())) {
    void persist()
    publishIfChanged()
    armTimer()
  }
  return snapshot()
}

/**
 * Synchronous read for hot paths. Correct once loaded (server boot loads it);
 * before that it answers "not quiet" and starts the load.
 */
export function peekQuiet(): QuietState {
  if (!loadPromise) void ensureLoaded()
  return snapshot()
}

/** Set (or replace) `source`'s hold. Returns the resulting state. */
export async function setQuiet(input: SetQuietInput): Promise<QuietState> {
  const source = typeof input.source === 'string' ? input.source.trim() : ''
  if (!source || source.length > MAX_SOURCE_CHARS) {
    throw new Error(`quiet source must be 1-${MAX_SOURCE_CHARS} characters`)
  }
  if (input.until !== undefined && (!Number.isFinite(input.until) || input.until < MIN_EPOCH_MS)) {
    throw new Error('quiet `until` must be an epoch time in milliseconds')
  }
  await ensureLoaded()
  const now = Date.now()
  if (input.until !== undefined && input.until <= now) return clearQuiet(source)
  const existing = holds.get(source)
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, MAX_REASON_CHARS) : ''
  holds.set(source, {
    source,
    // Replacing a live hold keeps when quiet began; a lapsed one starts over.
    since: existing && isLive(existing, now) ? existing.since : now,
    allowPermissions: input.allowPermissions !== false,
    ...(input.until !== undefined ? { until: input.until } : {}),
    ...(reason ? { reason } : {}),
    ...(input.owner ? { owner: input.owner } : {}),
  })
  await persist()
  armTimer()
  publishIfChanged()
  return snapshot()
}

/**
 * Remove `source`'s hold. With `owner`, only a hold that generation set (or one
 * loaded from disk, which no live generation owns) is removed.
 */
export async function clearQuiet(source: string, opts: { owner?: string } = {}): Promise<QuietState> {
  await ensureLoaded()
  const existing = holds.get(source)
  if (!existing) return snapshot()
  if (opts.owner && existing.owner && existing.owner !== opts.owner) return snapshot()
  holds.delete(source)
  await persist()
  armTimer()
  publishIfChanged()
  return snapshot()
}

/** Would quiet silence this interruption? Permission asks pass while allowed. */
export function quietSuppresses(state: QuietState, opts: { permission?: boolean } = {}): boolean {
  if (!state.active) return false
  return !(opts.permission && state.allowPermissions)
}

/** Subscribe to state changes in-process. Returns an unsubscribe. */
export function onQuietChanged(name: string, handler: (state: QuietState) => void | Promise<void>): () => void {
  bus.subscribe(name, (event) => handler(event.data as QuietState), {
    global: true,
    interest: [EventNames.QUIET_CHANGED],
  })
  return () => bus.unsubscribe(name)
}

const skipLogged = new Set<string>()

/**
 * Log that `channel` skipped work because of quiet, ONCE per set of holds rather
 * than once per event: a focus block can swallow dozens of pushes, and the line
 * that matters is "push is off because of these holds".
 */
export function logQuietSkipOnce(channel: string, state: QuietState): void {
  const key = `${channel}|${state.holds.map(h => `${h.source}@${h.since}`).join(',')}`
  if (skipLogged.has(key)) return
  if (skipLogged.size > 200) skipLogged.clear()
  skipLogged.add(key)
  log.notif.info('quiet: suppressing', {
    channel,
    holds: state.holds.map(h => ({ source: h.source, until: h.until, reason: h.reason })),
    allowPermissions: state.allowPermissions,
  })
}

/** Server teardown + tests: forget the in-memory state and stop the timer. */
export function stopQuiet(): void {
  if (expiryTimer) { clearTimeout(expiryTimer); expiryTimer = null }
  holds.clear()
  loadPromise = null
  lastPublishedKey = JSON.stringify(INACTIVE)
  skipLogged.clear()
}

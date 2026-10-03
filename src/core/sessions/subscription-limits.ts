/**
 * Claude subscription limits per host: the newest reading of each usage window
 * (5-hour, weekly, per-model weekly, extra usage) a host's Claude Code reported,
 * with when it was seen and which session reported it.
 *
 * Fed by ClaudeCodeSession's `rate_limit_event` case (local and remote sessions
 * both pass through the server's stream handler); read by GET
 * /api/subscription-limits and pushed as the `host:subscription-limits` WS
 * event, one frame per host. The parsing and folding rules live in
 * subscription-limits-model.ts.
 *
 * Persisted to WALNUT_HOME/cache/subscription-limits.json (a cache, never synced:
 * git-sync ignores cache/) so a restart keeps the last reading. Every disk touch
 * is async and coalesced; nothing here blocks the event loop.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import { bus, EventNames } from '../event-bus.js'
import { store as readinessStore } from '../hosts/host-readiness-store.js'
import {
  applyRateLimitInfo, parseRateLimitEvent, reviveHostLimitState, signInKind,
  type HostLimitState, type SignInKind,
} from './subscription-limits-model.js'

export const LOCAL_HOST_KEY = '__local__'
/** Bursts of events (several sessions on one host) share one write. */
const PERSIST_DEBOUNCE_MS = 500

export interface HostSignIn {
  kind: SignInKind
  /** The readiness check's words ("a Claude account", "Bedrock"). Never a credential. */
  detail?: string
  /** When that check ran (server ms): a reading newer than it outranks it. */
  checkedAt?: number
}

/** What GET and the WS push carry for one host. No top-level sessionId: it is about a host. */
export interface HostLimitFrame extends HostLimitState {
  signIn?: HostSignIn
  /** Server clock at send time, so a client on another device can correct for skew. */
  serverNow: number
}

type StoreShape = Record<string, HostLimitState>
type SignInResolver = (host: string) => Promise<HostSignIn | undefined>

let cache: StoreShape | null = null
let loadPromise: Promise<StoreShape> | null = null
let writeChain: Promise<void> = Promise.resolve()
let persistTimer: ReturnType<typeof setTimeout> | null = null
let resolveSignIn: SignInResolver = defaultSignIn

export function subscriptionLimitsFile(): string {
  return path.join(WALNUT_HOME, 'cache', 'subscription-limits.json')
}

export function limitHostKey(host: string | null | undefined): string {
  return host && host.trim() ? host.trim() : LOCAL_HOST_KEY
}

async function load(): Promise<StoreShape> {
  if (cache) return cache
  if (!loadPromise) {
    loadPromise = (async () => {
      const next: StoreShape = {}
      try {
        const parsed = JSON.parse(await fsp.readFile(subscriptionLimitsFile(), 'utf-8')) as { hosts?: Record<string, unknown> }
        for (const [host, raw] of Object.entries(parsed?.hosts ?? {})) {
          const state = reviveHostLimitState(host, raw)
          if (state) next[host] = state
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          log.session.warn('subscription limits: unreadable cache, starting empty', { error: err instanceof Error ? err.message : String(err) })
        }
      }
      cache = next
      return cache
    })()
  }
  return loadPromise
}

function writeNow(): Promise<void> {
  const snapshot = JSON.stringify({ version: 1, hosts: cache ?? {} }, null, 2)
  const file = subscriptionLimitsFile()
  writeChain = writeChain.then(async () => {
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true })
      // Same-dir temp + rename: a reader never sees half a file.
      const tmp = `${file}.${process.pid}.tmp`
      await fsp.writeFile(tmp, snapshot, 'utf-8')
      await fsp.rename(tmp, file)
    } catch (err) {
      log.session.warn('subscription limits: persist failed', { error: err instanceof Error ? err.message : String(err) })
    }
  })
  return writeChain
}

function schedulePersist(): void {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    void writeNow()
  }, PERSIST_DEBOUNCE_MS)
  persistTimer.unref?.()
}

async function defaultSignIn(host: string): Promise<HostSignIn | undefined> {
  if (host === LOCAL_HOST_KEY) {
    // Dynamic: local-readiness pulls in the probe machinery; it is loaded by then.
    const { getLocalClaude } = await import('../hosts/local-readiness.js')
    const local = getLocalClaude()
    if (!local) return undefined
    return { kind: signInKind(local.claude.auth, local.claude.authDetail), ...(local.claude.authDetail ? { detail: local.claude.authDetail } : {}), checkedAt: local.checkedAt }
  }
  const r = readinessStore.get(host)
  if (!r) return undefined
  return { kind: signInKind(r.claude.auth, r.claude.authDetail), ...(r.claude.authDetail ? { detail: r.claude.authDetail } : {}), checkedAt: r.checkedAt }
}

async function frameOf(state: HostLimitState): Promise<HostLimitFrame> {
  let signIn: HostSignIn | undefined
  try { signIn = await resolveSignIn(state.host) } catch { signIn = undefined }
  return { ...state, ...(signIn ? { signIn } : {}), serverNow: Date.now() }
}

/**
 * One `rate_limit_event` line from a session's stream. Returns whether it was a
 * readable one; the fold, the push and the write happen asynchronously.
 */
export function noteRateLimitEvent(
  host: string | null | undefined,
  sessionId: string | null | undefined,
  event: unknown,
  seenAt: number = Date.now(),
): boolean {
  const info = parseRateLimitEvent(event)
  const key = limitHostKey(host)
  if (!info) {
    log.session.debug('subscription limits: unreadable rate_limit_event ignored', { host: key, sessionId: sessionId ?? undefined })
    return false
  }
  void load().then(async (store) => {
    const prev = store[key]
    const next = applyRateLimitInfo(prev, key, info, seenAt, sessionId ?? undefined)
    store[key] = next
    schedulePersist()
    const fields = {
      host: key, sessionId: sessionId ?? undefined, status: info.status, rateLimitType: info.rateLimitType,
      utilization: info.utilization, resetsAt: info.resetsAt, windows: info.windows.map((w) => `${w.type}:${Math.round(w.utilization * 100)}%`).join(','),
      isUsingOverage: info.isUsingOverage, overageStatus: info.overageStatus,
    }
    // A status edge is worth reading in the log; the routine refresh is not.
    if (prev?.current?.status !== info.status || prev?.current?.type !== info.rateLimitType) log.session.info('subscription limit status', fields)
    else log.session.debug('subscription limit reading', fields)
    const frame = await frameOf(next)
    // A newer event folded while the sign-in was read pushes its own frame.
    if (store[key] === next) bus.emit(EventNames.HOST_SUBSCRIPTION_LIMITS, frame, ['web-ui'])
  }).catch((err) => {
    log.session.warn('subscription limits: event not recorded', { host: key, error: err instanceof Error ? err.message : String(err) })
  })
  return true
}

/** Every host's frame (or one host's), local first. */
export async function readSubscriptionLimits(host?: string): Promise<HostLimitFrame[]> {
  const store = await load()
  const states = host ? (store[limitHostKey(host)] ? [store[limitHostKey(host)]] : []) : Object.values(store)
  states.sort((a, b) => (a.host === LOCAL_HOST_KEY ? -1 : b.host === LOCAL_HOST_KEY ? 1 : a.host.localeCompare(b.host)))
  return Promise.all(states.map(frameOf))
}

// ── Test seams ──

export function _setSignInResolverForTest(fn: SignInResolver | null): void {
  resolveSignIn = fn ?? defaultSignIn
}

/** Run the pending write now and wait for every write so far. */
export async function _flushSubscriptionLimitsForTest(): Promise<void> {
  if (loadPromise) await loadPromise
  // Let a fold whose load just resolved run first.
  await new Promise((r) => setTimeout(r, 0))
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
    await writeNow()
  }
  await writeChain
}

/** Forget the in-memory copy (the next read loads the file again). */
export function _resetSubscriptionLimitsForTest(): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = null
  cache = null
  loadPromise = null
  writeChain = Promise.resolve()
  resolveSignIn = defaultSignIn
}

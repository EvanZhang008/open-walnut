/**
 * One bridge read per session at a time, shared by every caller that wants it.
 *
 * Why (replica, 2026-09-26 16:25 to 16:35Z): the phone asked for one session's
 * fresh transcript up to 284 times a minute, 130 of them inside one second, and
 * each request did its own `read-history` over the daemon bridge: a 512KB tail
 * read on the Mac, a 512KB frame up the uplink, a parse on the replica. Response
 * times climbed from 0.1s to 5s inside each burst because every request queued
 * behind the ones before it on the same socket. The burst had one answer; it
 * was computed a hundred times.
 *
 * Rules:
 *   - at most ONE read runs per session, and at most one more waits behind it.
 *     A caller joins the running read when nothing changed since it started,
 *     otherwise the waiting one (which starts after the change, so it is fresh);
 *   - a finished read is reused for READ_HISTORY_CACHE_MS, but only while the
 *     session's content generation is unchanged. The generation moves on every
 *     non-delta jsonl line the bridge forwards, so a refetch after `turn-end`
 *     never gets the answer-less tail it read a second earlier;
 *   - at most READ_HISTORY_PER_HOST reads run against one host at a time, so a
 *     storm over many sessions cannot monopolise one daemon's socket either.
 * A failed read is shared by its joiners but never cached.
 */

export const READ_HISTORY_CACHE_MS = 4_000
export const READ_HISTORY_PER_HOST = 2
const MAX_TRACKED_SESSIONS = 2_000

interface Running<T> { gen: number; promise: Promise<T> }
interface Cached { gen: number; at: number; value: unknown }
interface SessionState {
  running?: Running<unknown>
  waiting?: Promise<unknown>
}

const generation = new Map<string, number>()
const sessions = new Map<string, SessionState>()
const cache = new Map<string, Cached>()
const hostActive = new Map<string, number>()
const hostQueue = new Map<string, Array<() => void>>()

const stats = { requests: 0, reads: 0, cacheHits: 0, joined: 0, peakHostActive: 0 }

function bounded<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value as K
    map.delete(oldest)
  }
}

/** The session's content changed (a new transcript line reached this box). */
export function noteSessionContentChanged(sessionId: string): void {
  const next = (generation.get(sessionId) ?? 0) + 1
  generation.delete(sessionId)
  generation.set(sessionId, next)
  bounded(generation, MAX_TRACKED_SESSIONS)
}

function genOf(sessionId: string): number {
  return generation.get(sessionId) ?? 0
}

/**
 * Run `run` holding one of the host's READ_HISTORY_PER_HOST permits.
 *
 * A released permit is HANDED to the next waiter, never returned to the pool
 * first. The waiter resumes a microtask later, and a count that dropped in
 * between let a newcomer take the free slot and the waiter take it again: three
 * reads on one host.
 */
async function withHostPermit<T>(host: string, run: () => Promise<T>): Promise<T> {
  const active = hostActive.get(host) ?? 0
  if (active >= READ_HISTORY_PER_HOST) {
    // The permit arrives already counted (releaseHostPermit keeps the count).
    await new Promise<void>((resolve) => {
      const q = hostQueue.get(host) ?? []
      q.push(resolve)
      hostQueue.set(host, q)
    })
  } else {
    hostActive.set(host, active + 1)
    stats.peakHostActive = Math.max(stats.peakHostActive, active + 1)
  }
  try {
    return await run()
  } finally {
    releaseHostPermit(host)
  }
}

function releaseHostPermit(host: string): void {
  const q = hostQueue.get(host)
  const nextWaiter = q?.shift()
  if (q && q.length === 0) hostQueue.delete(host)
  if (nextWaiter) {
    nextWaiter()
    return
  }
  const left = (hostActive.get(host) ?? 1) - 1
  if (left <= 0) hostActive.delete(host)
  else hostActive.set(host, left)
}

function freshCached(key: string, sessionId: string): Cached | null {
  const hit = cache.get(key)
  if (!hit) return null
  if (hit.gen !== genOf(sessionId) || Date.now() - hit.at > READ_HISTORY_CACHE_MS) {
    cache.delete(key)
    return null
  }
  return hit
}

function startRead<T>(host: string, key: string, sessionId: string, state: SessionState, read: () => Promise<T>): Promise<T> {
  const gen = genOf(sessionId)
  stats.reads++
  const promise = withHostPermit(host, read)
  const running: Running<T> = { gen, promise }
  state.running = running as Running<unknown>
  // Settle bookkeeping runs in the SAME reaction as the cache write: a chained
  // `.finally` lands a tick later, and a caller arriving in that gap would join
  // the finished read even after its cache entry had expired.
  const settle = (): void => {
    if (state.running === running) state.running = undefined
    if (!state.running && !state.waiting) sessions.delete(key)
  }
  void promise.then((value) => {
    cache.delete(key)
    cache.set(key, { gen, at: Date.now(), value })
    bounded(cache, MAX_TRACKED_SESSIONS)
    settle()
  }, () => { settle() /* failures are shared with joiners, never cached */ })
  return promise
}

/**
 * Run `read` for a session, or reuse a read that answers the same question.
 * `read` must not depend on the caller (same RPC, same parameters). `key` names
 * the question when one session has several (a relayed transcript page per
 * cursor); the session's content generation still decides freshness.
 */
export function coalescedSessionRead<T>(host: string, sessionId: string, read: () => Promise<T>, key: string = sessionId): Promise<T> {
  stats.requests++
  const hit = freshCached(key, sessionId)
  if (hit) { stats.cacheHits++; return Promise.resolve(hit.value as T) }

  let state = sessions.get(key)
  if (!state) { state = {}; sessions.set(key, state) }
  const gen = genOf(sessionId)
  if (state.running && state.running.gen === gen) { stats.joined++; return state.running.promise as Promise<T> }
  if (!state.running) return startRead(host, key, sessionId, state, read)
  if (state.waiting) { stats.joined++; return state.waiting as Promise<T> }

  // A read is running but it predates a change: queue ONE read behind it.
  const s = state
  const behind = s.running!.promise.catch(() => undefined)
  const waiting = behind.then(() => {
    s.waiting = undefined
    const again = freshCached(key, sessionId)
    if (again) return again.value as T
    return startRead(host, key, sessionId, s, read)
  })
  s.waiting = waiting
  return waiting
}

/** Counters for tests and the storm repro. */
export function bridgeReadHistoryStats(): Readonly<typeof stats> {
  return { ...stats }
}

export function _resetBridgeReadHistoryForTesting(): void {
  generation.clear()
  sessions.clear()
  cache.clear()
  hostActive.clear()
  hostQueue.clear()
  stats.requests = 0
  stats.reads = 0
  stats.cacheHits = 0
  stats.joined = 0
  stats.peakHostActive = 0
}

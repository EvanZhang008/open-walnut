/**
 * Request-path deadline for reads that need a remote host's daemon (session
 * history, Changes, Files, the folder picker, the slash palette, images, file
 * content): house rule, every route touching a daemon answers within a
 * deadline, degraded if it must, and never pins a browser connection. Every
 * pool state has its bound:
 *  - dialing (a connect or reconnect already running): degraded AT ONCE. This
 *    request would only wait on a dial it did not start.
 *  - cold (idle, or a reconnect waiting out its backoff): this request starts or
 *    expedites the dial, and waits for it at most HOST_READ_DIAL_CAP_MS. The
 *    dial goes on in the background; the next request finds it running.
 *  - fails-fast (a failure the pool already knows): the read runs (the pool
 *    answers at once) and its failure is the degraded answer, in the host's name.
 *  - connected: the read is judged by PROGRESS, never by wall time. Each
 *    HOST_READ_QUIET_MS window that brings bytes for THIS read is a read
 *    arriving: the bytes that reached its own daemon commands (read-progress.ts;
 *    a main-socket command counts what the link brings ahead of its reply). A
 *    read that has sent no command yet counts the host's bytes. A window that
 *    brings nothing asks the link ONE probe (a ping, DaemonConnection
 *    .probeLiveness, whose deadline grows with the link's measured round trip).
 *    Silent: this read answers degraded now. For the cloud box the link is
 *    closed so the pool reconnects at once ("Reconnecting to Cloud"); any other
 *    host keeps its link ("Dev box is not answering"), and for
 *    HOST_SILENT_MEMO_MS the next reads ask the link at once instead of after
 *    their own quiet window. Alive but sending nothing (a daemon still
 *    working): the read keeps its slot until HOST_READ_IDLE_MS with no bytes. A
 *    read still streaming answers by HOST_READ_STREAM_CAP_MS and goes on in
 *    the background; boundSharedHostRead hands its result to the next request
 *    for the same thing.
 *
 * Measured behind a host that accepts TCP and never answers: history 44.5s,
 * Changes 60.4s. Behind a companion that was connected and then stopped
 * forwarding: Files 30s then 500, history 60s then 502, Changes over 130s, the
 * slash palette 30s, while the pool needed 58.5s (three missed 15s pings) to
 * notice. A total deadline instead of a progress one cut a 24MB read at 1MB/s
 * at 20s, every time: HEAD finished it in 88s.
 *
 * The degraded answer is ONE shape everywhere: HostReconnectingError, a 503 with
 * code `host_reconnecting`, its sentence naming the host by its label
 * (host-display-name.ts). Routes serve their cache on it, or say it. A failure
 * that is the request's own (a 4xx: unknown session, bad path) is never turned
 * into it.
 *
 * Local sessions never come here (their daemon is this machine's).
 */

import { SessionControlError } from '../sessions/session-controls.js'
import { log } from '../../logging/index.js'
import { hostDisplayNameFor } from './host-display-name.js'
import { ReadProgress, currentReadProgress, runWithReadProgress } from './read-progress.js'
import { linkFailureKind } from '../../providers/link-failure.js'

/** How long a request waits on a dial it started itself. */
export const HOST_READ_DIAL_CAP_MS = 5_000
/** A read on a connected host is checked for progress once per window this long. */
export const HOST_READ_QUIET_MS = 3_000
/**
 * The liveness probe's deadline on a quick link: no pong and no byte from the
 * daemon in this long = silent. A link whose measured round trip is longer gets
 * twice that and half a second more, up to 20s (DaemonConnection.probeDeadlineMs).
 */
export const HOST_LIVENESS_PROBE_MS = 3_000
/** Connected and answering pings, but no bytes for the read in this long: answered degraded. */
export const HOST_READ_IDLE_MS = 20_000
/**
 * The idle bound in round trips of the link, when that is longer: a read's
 * commands each wait one before their first byte (gate review, 2026-10-03: a
 * 256KB read on a 7s round trip answered "did not answer in time" at 20s while
 * its reply was on the way).
 */
export const HOST_READ_IDLE_ROUND_TRIPS = 4
/** Bytes still arriving: the request answers by this anyway, and the read goes on in the background. */
export const HOST_READ_STREAM_CAP_MS = 60_000
/** What one window must bring to count as the read's bytes arriving (a pong or a keepalive is a few bytes). */
export const HOST_READ_PROGRESS_BYTES = 2_048
/** After a probe's silent verdict, the next reads on that host ask the link at once for this long, unless a byte arrives. */
export const HOST_SILENT_MEMO_MS = 15_000
/** How long a read's result waits for the request it was cut from (boundSharedHostRead). */
export const HOST_READ_RESULT_TTL_MS = 30_000

/** The error code the routes answer with (503), in both the web and the v1 shape. */
export const HOST_RECONNECTING = 'host_reconnecting'

/** The host is not answering now: the read did not run, or did not finish in time. */
export class HostReconnectingError extends SessionControlError {
  constructor(public host: string, label: string, message = `Reconnecting to ${label}`) {
    super(message, 503, { code: HOST_RECONNECTING, host })
    this.name = 'HostReconnectingError'
  }
}

/**
 * The read is arriving, on a link that answers, and goes on without this
 * request: the next request for the same thing joins it (boundSharedHostRead).
 * A client keeps what it shows and asks again at once; it is not an outage.
 */
export class HostStillLoadingError extends HostReconnectingError {
  constructor(host: string, public from: string) {
    super(host, from, `Still loading from ${from}. Try again in a moment.`)
    this.name = 'HostStillLoadingError'
  }
}

type WouldWait = 'connected' | 'fails-fast' | 'dialing' | 'cold'

export interface BoundDeps {
  wouldWait: (host: string) => WouldWait
  label: (host: string) => Promise<string>
  /** Why the pool cannot reach the host, in its own words (the cached failure). */
  reason: (host: string) => Promise<string | undefined>
  /** Is the connected link still answering? (DaemonConnection.probeLiveness) */
  probe: (host: string, deadlineMs: number) => Promise<boolean>
  /** Bytes heard so far from the host's daemon, all sockets (-1 unknown). The progress clock. */
  heard: (host: string) => number
  /** A probe found the link silent moments ago and nothing arrived since. */
  silent: (host: string) => boolean
  /** The connected link's measured round trip in ms (0 unknown). The idle bound scales with it. */
  roundTrip: (host: string) => number
  /** Cold: how long this request waits on the dial it started. */
  capMs: number
  quietMs: number
  probeMs: number
  /** Connected and answering, no bytes: how long the read may wait. */
  idleMs: number
  /** Connected and streaming: when the request answers anyway (the read goes on). */
  streamCapMs: number
  progressBytes: number
}

type Pool = typeof import('../../providers/daemon-connection.js')

let poolModule: Promise<Pool | null> | null = null

/**
 * The pool module, imported ONCE, on first use (lazily: a static import here
 * would be a cycle). Every request shares that import: importing per request
 * cost every read an await, and a test runner that mocks the module handed
 * concurrent first imports two different modules (one read saw the double's
 * "connected", three saw the real pool's "cold" a second later).
 */
function loadPool(): Promise<Pool | null> {
  poolModule ??= import('../../providers/daemon-connection.js').catch(() => null)
  return poolModule
}

/**
 * The pool's readers. A stand-in pool without one (a module double that only
 * hands out connections) reads as connected and answering, which is what the
 * read did before this file existed.
 */
async function poolHook<K extends 'daemonConnectWouldWait' | 'probeDaemonLiveness' | 'getDaemonConnectState' | 'daemonHeardBytes' | 'daemonLinkSilent' | 'daemonRoundTripMs'>(name: K): Promise<Pool[K] | undefined> {
  try {
    const fn = (await loadPool())?.[name]
    return typeof fn === 'function' ? fn : undefined
  } catch {
    return undefined
  }
}

async function defaultWouldWait(): Promise<(host: string) => WouldWait> {
  return (await poolHook('daemonConnectWouldWait')) ?? (() => 'connected')
}

async function defaultProbe(host: string, deadlineMs: number): Promise<boolean> {
  const probe = await poolHook('probeDaemonLiveness')
  return probe ? probe(host, deadlineMs) : true
}

async function defaultHeard(): Promise<(host: string) => number> {
  const heard = await poolHook('daemonHeardBytes')
  return heard ? (host) => heard(host) : () => -1
}

async function defaultSilent(): Promise<(host: string) => boolean> {
  const silent = await poolHook('daemonLinkSilent')
  return silent ? (host) => silent(host, HOST_SILENT_MEMO_MS) : () => false
}

async function defaultRoundTrip(): Promise<(host: string) => number> {
  const rtt = await poolHook('daemonRoundTripMs')
  return rtt ? (host) => rtt(host) : () => 0
}

async function defaultReason(host: string): Promise<string | undefined> {
  try {
    const state = (await poolHook('getDaemonConnectState'))?.(host)
    return state?.error ?? state?.lastError
  } catch {
    return undefined
  }
}

/** A remote host alias (not the local machine). */
export function isRemoteHost(host: string | null | undefined): host is string {
  return typeof host === 'string' && host !== '' && host !== '__local__'
}

/**
 * Is `host`'s connected link answering? ONE probe, now: for a caller about to
 * start long work on the link (an ssh forward, a code-server install) that a
 * read deadline would cut short. False when nothing is connected.
 */
export async function hostLinkAnswers(host: string | null | undefined, deadlineMs = HOST_LIVENESS_PROBE_MS): Promise<boolean> {
  if (!isRemoteHost(host)) return true
  return defaultProbe(host, deadlineMs).catch(() => true)
}

/**
 * The progress clock for one read: the bytes that reached its own commands,
 * or the host's while it has sent none (a pool double that sends nothing, or a
 * read still before its first command).
 */
function perRead(progress: ReadProgress | undefined, hostHeard: (host: string) => number): (host: string) => number {
  if (!progress) return hostHeard
  return (host) => {
    const own = progress.bytes()
    return own >= 0 ? own : hostHeard(host)
  }
}

type Within<T> = { done: true; value: T } | { done: false }

/** `work` if it settles within `ms` (a rejection rethrows), else not done. */
async function within<T>(work: Promise<T>, ms: number): Promise<Within<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<Within<T>>((resolve) => { timer = setTimeout(() => resolve({ done: false }), ms) })
  try {
    return await Promise.race([work.then((value): Within<T> => ({ done: true, value })), late])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * `work`, failed with `message` once the host sends nothing for `idleMs` (fewer
 * than HOST_READ_PROGRESS_BYTES from it, on any of its sockets, in each window
 * of that span), or at `ceilingMs` in all. For a read that goes on after the
 * request that started it was answered (a history the next request picks up):
 * a slow link that is delivering is never cut, a silent one still is. A pool
 * that cannot say what it heard makes `idleMs` a total deadline, as before.
 */
export async function boundByProgress<T>(
  host: string,
  work: Promise<T>,
  opts: { idleMs: number; ceilingMs: number; message: string; windowMs?: number; heard?: (host: string) => number },
): Promise<T> {
  const heard = opts.heard ?? perRead(currentReadProgress(), await defaultHeard())
  const windowMs = Math.min(opts.windowMs ?? HOST_READ_QUIET_MS, opts.idleMs)
  const startedAt = Date.now()
  let lastProgressAt = startedAt
  let mark = heard(host)
  for (;;) {
    const step = await within(work, windowMs)
    if (step.done) return step.value
    const now = heard(host)
    if (now >= 0 && mark >= 0 && now - mark >= HOST_READ_PROGRESS_BYTES) { mark = now; lastProgressAt = Date.now() }
    else if (now < 0 || mark < 0 || now < mark) mark = now
    const at = Date.now()
    if (at - lastProgressAt >= opts.idleMs || at - startedAt >= opts.ceilingMs) {
      abandon(work)
      throw new Error(opts.message)
    }
  }
}

/** The read goes on without this request; its outcome reaches the pool, not the caller. */
function abandon(work: Promise<unknown>): void {
  work.catch(() => { /* the pool caches the failure; the next request sees it */ })
}

/**
 * Run `read`, which needs `host`'s daemon, within the rules above. Throws
 * HostReconnectingError when the host is not answering now.
 */
export async function boundHostRead<T>(
  host: string | null | undefined,
  read: () => Promise<T>,
  deps: Partial<BoundDeps> = {},
): Promise<T> {
  return boundHostReadIn(host, read, withTestBounds(deps), new ReadProgress(currentReadProgress()))
}

type Bounds = Pick<BoundDeps, 'capMs' | 'quietMs' | 'probeMs' | 'idleMs' | 'streamCapMs'>
let testBounds: Partial<Bounds> | null = null

/** Test seam: shorter bounds for a route test that cannot wait out the real ones (null: the real ones). */
export function setHostReadBoundsForTest(bounds: Partial<Bounds> | null): void {
  testBounds = bounds
}

function withTestBounds(deps: Partial<BoundDeps>): Partial<BoundDeps> {
  return testBounds ? { ...testBounds, ...deps } : deps
}

/** boundHostRead, with the bytes of the read's commands counted in `progress`. */
async function boundHostReadIn<T>(
  host: string | null | undefined,
  read: () => Promise<T>,
  deps: Partial<BoundDeps>,
  progress: ReadProgress,
): Promise<T> {
  if (!isRemoteHost(host)) return read()
  const wouldWait = deps.wouldWait ?? await defaultWouldWait()
  const label = () => (deps.label ?? hostDisplayNameFor)(host)
  const before = wouldWait(host)
  if (before === 'dialing') throw new HostReconnectingError(host, await label())
  // A probe found this link silent moments ago and nothing has arrived since:
  // this read asks the link at once rather than after its own quiet window. It
  // never answers from the verdict alone: a link that came back since (gate
  // review, 2026-10-02: the old verdict was repeated 46ms after the link was
  // back) has nothing to send until a read asks it something.
  const askAtOnce = before === 'connected' && (deps.silent ?? await defaultSilent())(host)

  const work = runWithReadProgress(progress, read)
  // Settled: the context it leaves behind (timers, a dial it set off) counts nothing more.
  work.then(() => progress.close(), () => progress.close())
  try {
    if (before === 'connected') return await connectedRead(host, work, deps, label, wouldWait, progress, askAtOnce)
    const first = await within(work, deps.capMs ?? HOST_READ_DIAL_CAP_MS)
    if (first.done) return first.value
    abandon(work)
    log.web.info('host read answered degraded: the host is still connecting', { host })
    throw new HostReconnectingError(host, await label())
  } catch (err) {
    throw await degraded(err, host, before, wouldWait, label, deps)
  }
}

/** Connected: progress windows, a probe for a window that brought nothing, the idle and stream bounds. */
async function connectedRead<T>(
  host: string,
  work: Promise<T>,
  deps: Partial<BoundDeps>,
  label: () => Promise<string>,
  wouldWait: (host: string) => WouldWait,
  progress: ReadProgress,
  askAtOnce: boolean,
): Promise<T> {
  const startedAt = Date.now()
  const heard = perRead(progress, deps.heard ?? await defaultHeard())
  const probe = deps.probe ?? defaultProbe
  const windowMs = deps.quietMs ?? HOST_READ_QUIET_MS
  // A link with a long round trip takes that long per command before any byte
  // comes back: the idle bound is a few of them, never less than its own.
  const roundTrip = (deps.roundTrip ?? await defaultRoundTrip())(host)
  const idleMs = Math.max(deps.idleMs ?? HOST_READ_IDLE_MS, HOST_READ_IDLE_ROUND_TRIPS * (Number.isFinite(roundTrip) && roundTrip > 0 ? roundTrip : 0))
  const streamCapMs = deps.streamCapMs ?? HOST_READ_STREAM_CAP_MS
  const minBytes = deps.progressBytes ?? HOST_READ_PROGRESS_BYTES
  let mark = heard(host)
  let lastProgressAt = startedAt
  /** Did bytes for the read arrive since the last look? */
  const progressed = (): boolean => {
    const now = heard(host)
    if (now < 0 || mark < 0 || now < mark) { mark = now; return false }
    if (now - mark < minBytes) return false
    mark = now
    lastProgressAt = Date.now()
    return true
  }
  /** One probe, raced with the read. Silent: the degraded answer, said as what the pool did. */
  const askTheLink = async (): Promise<{ value: T } | null> => {
    const verdict = await Promise.race([
      work.then((value) => ({ value })),
      probe(host, deps.probeMs ?? HOST_LIVENESS_PROBE_MS).catch(() => true).then((alive) => ({ alive })),
    ])
    if ('value' in verdict) return verdict
    if (!verdict.alive) {
      abandon(work)
      // The cloud box's silent link is closed and re-dialled: that IS
      // reconnecting. Any other host's link stays as it was, and saying
      // "Reconnecting" there described something that was not happening.
      const name = await label()
      const kept = wouldWait(host) === 'connected'
      log.web.warn('host read answered degraded: the host stopped answering', {
        host, waitedMs: Date.now() - startedAt, linkKept: kept,
      })
      throw kept ? new HostReconnectingError(host, name, `${name} is not answering`) : new HostReconnectingError(host, name)
    }
    progressed()
    return null
  }
  if (askAtOnce) {
    const answered = await askTheLink()
    if (answered) return answered.value
  }
  for (;;) {
    const step = await within(work, windowMs)
    if (step.done) return step.value
    if (!progressed()) {
      const answered = await askTheLink()
      if (answered) return answered.value
    }
    const now = Date.now()
    if (now - lastProgressAt >= idleMs) {
      abandon(work)
      const name = await label()
      log.web.info('host read answered degraded: the host answers, but sent nothing for the read', { host, idleMs })
      throw new HostReconnectingError(host, name, `${name} did not answer in time`)
    }
    if (now - startedAt >= streamCapMs) {
      abandon(work)
      const name = await label()
      log.web.info('host read answered degraded: still arriving, the read goes on', { host, streamCapMs })
      throw new HostStillLoadingError(host, name)
    }
  }
}

interface SharedRead {
  work: Promise<unknown>
  /** The read's own commands, so every request that joins it judges it by them. */
  progress: ReadProgress
  /** Runs the read, once; until a request passes the bound it has not run. */
  start: () => void
  started: boolean
  /** A request was answered degraded while the read went on: keep its result. */
  cut: boolean
  /** Requests holding this entry now. */
  holders: number
}
const sharedReads = new Map<string, SharedRead>()
const cutResults = new Map<string, { value: unknown; at: number }>()
/** Kept results at most (a big file or history each): the oldest goes first. */
export const HOST_READ_KEPT_MAX = 16

/**
 * Keep a cut read's result for the next request, within bounds: expired ones
 * go now (a result nobody came back for was held until the process ended), and
 * past HOST_READ_KEPT_MAX the oldest goes.
 */
function keepCutResult(fullKey: string, value: unknown): void {
  const now = Date.now()
  for (const [k, kept] of cutResults) if (now - kept.at >= HOST_READ_RESULT_TTL_MS) cutResults.delete(k)
  cutResults.delete(fullKey)
  cutResults.set(fullKey, { value, at: now })
  while (cutResults.size > HOST_READ_KEPT_MAX) cutResults.delete(cutResults.keys().next().value as string)
  // Nobody may come back: the last one held still goes when its time is up.
  const sweep = setTimeout(() => {
    const kept = cutResults.get(fullKey)
    if (kept && Date.now() - kept.at >= HOST_READ_RESULT_TTL_MS) cutResults.delete(fullKey)
  }, HOST_READ_RESULT_TTL_MS + 50)
  sweep.unref?.()
}

/** Test seam: how many results are kept now. */
export function keptHostReadCount(): number {
  return cutResults.size
}

/**
 * The entry for `fullKey`, made when there is none. It is taken when the
 * request ARRIVES, not when its bound lets the read start (that is a few awaits
 * later), so requests that arrive together hold one entry and one read.
 */
function sharedEntry(fullKey: string, read: () => Promise<unknown>): SharedRead {
  const existing = sharedReads.get(fullKey)
  if (existing) return existing
  let begin: () => void = () => {}
  const progress = new ReadProgress(currentReadProgress())
  const work = new Promise<unknown>((resolve, reject) => {
    begin = () => {
      try { runWithReadProgress(progress, read).then(resolve, reject) } catch (err) { reject(err) }
    }
  })
  const entry: SharedRead = { work, progress, started: false, cut: false, holders: 0, start: () => {} }
  entry.start = () => {
    if (entry.started) return
    entry.started = true
    begin()
  }
  sharedReads.set(fullKey, entry)
  work.then((value) => {
    if (entry.cut) keepCutResult(fullKey, value)
  }, () => { /* the pool caches the failure; the next request sees it */ }).finally(() => {
    if (sharedReads.get(fullKey) === entry) sharedReads.delete(fullKey)
  })
  return entry
}

/**
 * boundHostRead for a read many requests may ask for at once (a file the
 * viewer opens, then opens again): ONE read per key runs, every request for
 * it joins that read, and a read that outlived the request it was started for
 * keeps its result for the next request with the same key, once, for
 * HOST_READ_RESULT_TTL_MS. So a retry after a degraded answer gets the bytes
 * the first request was already receiving instead of starting over (which on
 * a slow link never finished: each retry began from zero behind the last).
 * `key` must name everything that shapes the result.
 */
export function boundSharedHostRead<T>(
  host: string | null | undefined,
  key: string,
  read: () => Promise<T>,
  deps: Partial<BoundDeps> = {},
): Promise<T> {
  if (!isRemoteHost(host)) return read()
  const fullKey = `${host}\u0000${key}`
  const kept = cutResults.get(fullKey)
  if (kept) {
    cutResults.delete(fullKey)
    if (Date.now() - kept.at < HOST_READ_RESULT_TTL_MS) return Promise.resolve(kept.value as T)
  }
  const entry = sharedEntry(fullKey, read)
  entry.holders++
  const join = (): Promise<T> => {
    entry.start()
    return entry.work as Promise<T>
  }
  return boundHostReadIn(host, join, withTestBounds(deps), entry.progress).then((value) => {
    // A request got the result itself: nothing is left to hand over.
    entry.cut = false
    cutResults.delete(fullKey)
    return value
  }, (err) => {
    if (err instanceof HostReconnectingError && entry.started) entry.cut = true
    throw err
  }).finally(() => {
    entry.holders--
    // Every request for it was answered before any let it run: it never will.
    if (!entry.started && entry.holders === 0 && sharedReads.get(fullKey) === entry) sharedReads.delete(fullKey)
  })
}

/** The thing behind `key` changed (a save): a kept or running read of it is out of date. */
export function forgetSharedHostRead(host: string, key: string): void {
  const fullKey = `${host}\u0000${key}`
  cutResults.delete(fullKey)
  const running = sharedReads.get(fullKey)
  if (running) { running.cut = false; sharedReads.delete(fullKey) }
}

/** Test seam: forget every shared read and kept result. */
export function resetSharedHostReadsForTest(): void {
  sharedReads.clear()
  cutResults.clear()
}

/**
 * A failed read, as the caller answers it. The request's own failures stay as
 * they are; a failure because the host is not reachable becomes the degraded
 * answer. Told apart by the error's kind first: a link failure (no connection
 * could be had, or it went away under the read; providers/link-failure.ts) is
 * the host not being reachable, whatever the pool did after it (gate review,
 * 2026-10-05: a dial that failed fast left the pool waiting to retry, or
 * already reconnected, and the raw dial error reached the Files tree as a 500
 * it never retried). Otherwise by the pool, after the failure: it no longer has
 * a link it had, or it now knows a failure or runs a dial. A read that failed
 * before touching the pool (cold before and after) keeps its own error.
 */
/** The pool's own command deadline (DaemonConnection.send), as it words it. */
function isCommandTimeout(err: unknown): boolean {
  return /^daemon command timeout: /.test(err instanceof Error ? err.message : String(err))
}

async function degraded(
  err: unknown,
  host: string,
  before: WouldWait,
  wouldWait: (host: string) => WouldWait,
  label: () => Promise<string>,
  deps: Partial<BoundDeps>,
): Promise<unknown> {
  if (err instanceof HostReconnectingError) return err
  if (err instanceof SessionControlError && err.statusCode < 500) return err
  const after = wouldWait(host)
  // One command the pool gave up on while the link stayed up (its reply queued
  // behind other bytes on a thin link): the host's own words, never the
  // pool's "daemon command timeout: fs.ls (30000ms) [traceId=...]".
  if (before === 'connected' && after === 'connected' && isCommandTimeout(err)) {
    const name = await label()
    log.web.info('host read answered degraded: a command timed out on a connected link', {
      host, error: err instanceof Error ? err.message : String(err),
    })
    return new HostReconnectingError(host, name, `${name} did not answer in time`)
  }
  const link = linkFailureKind(err)
  const unreachable = link !== null
    || (before === 'connected' ? after !== 'connected' : after === 'fails-fast' || after === 'dialing')
  if (!unreachable) return err
  const name = await label()
  log.web.info('host read answered degraded: the host is not reachable', {
    host, before, after, link, error: err instanceof Error ? err.message : String(err),
  })
  // Dialling again, back already, or (after a link failure) waiting out the
  // loop's backoff: the pool is on it, and the client's next poll gets the read.
  if (after === 'dialing' || after === 'connected' || (link && after === 'cold')) return new HostReconnectingError(host, name)
  // The pool waits out a dial that failed moments ago. The answer is a plain
  // sentence; the dial's own words (an errno, a URL, an ssh line) go to the log only.
  const why = await (deps.reason ?? defaultReason)(host)
  if (why) log.web.info('host read answered degraded: the last dial failed', { host, why })
  return new HostReconnectingError(host, name, `Can't reach ${name} right now.`)
}

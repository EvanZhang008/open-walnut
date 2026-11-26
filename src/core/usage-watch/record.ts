/**
 * The real-use recorder: every gateway tool call, every request from a browser or phone, every
 * page error and every cut Claude Code reported, counted in memory and written once a minute.
 * A call costs a map update; nothing here blocks a request or throws into its caller.
 *
 * Two outputs:
 *  - hourly aggregates per name in the store (usage-watch.sqlite), for the Real Use page and
 *    the watches' checks;
 *  - minute counters for Walnut Health's alarms (usage-alarms.ts), through the metrics registry.
 */
import { count } from '../observability/metrics.js'
import { reportGauge } from '../health-monitor/gauges.js'
import { addCall, emptyAgg, type Agg, type OutcomeClass, type UsageKind } from './agg.js'
import { addClientFailures, addEvents, addHours, addPageUses, addSlept, addToolErrors, clientFailureKnown, markAlive, pruneStore, readHours, readToolErrors, type ToolErrorRow, type UsageEvent } from './store.js'
import { NO_ANSWER_CODES } from '../../lib/no-answer-report.js'
import { ASLEEP_CODE, TemplateMatcher, pageKindIsPagesOwn, type PageErrorKind } from './normalize.js'
import type { ToolClient } from '../../lib/tool-answer-size.js'
import { MOUNT_OP, labelValue } from './counters.js'
import { _resetPageUsesForTesting, notePageUse, takePageUses } from './page-uses.js'
export { MOUNT_OP } from './counters.js'
import { sleepIntervals, sleptBetween } from '../../lib/sleep-ledger.js'

const HOUR_MS = 3_600_000
const FLUSH_MS = 60_000
/** At most this many names of one kind per hour; the rest count under `other`. */
export const MAX_NAMES_PER_HOUR = 600
const MAX_EVENTS_PER_FLUSH = 200
/** A read slower than this is slow (long polls and streams never count). */
export const SLOW_READ_MS = 5_000

export { USAGE_COUNTERS } from './counters.js'

/**
 * How much of a call's `ms` (wall clock, as its callers measure it) this machine slept (the sleep
 * ledger), with a second's margin for a sleep that ended as the call's awake time began.
 */
const SLEPT_MARGIN_MS = 1_000
function sleptOf(now: number, ms: number): number {
  return ms > 0 ? Math.min(ms, sleptBetween(now - ms - SLEPT_MARGIN_MS, now)) : 0
}

/** The routes a page failure is matched against (only templates this server answered). */
export const answeredTemplates = new TemplateMatcher()

let pending = new Map<string, { hour: number; kind: UsageKind; name: string; agg: Agg }>()
let events: UsageEvent[] = []
let toolErrors: ToolErrorRow[] = []
let timer: ReturnType<typeof setInterval> | null = null
/** Only the server that started the recorder counts (a replica or a CLI process never does). */
let active = false
let lastPrune = 0
let lastBadArgs = 0
const BAD_ARGS_EVERY_MS = 5 * 60_000
/** Ops an armed watch names, refreshed each flush (a watched tool's errors ring on fewer). */
let watchedOps = new Set<string>()

/** Sets the ops armed watches name (runtime.ts, each minute). */
export function setWatchedOps(ops: Iterable<string>): void {
  watchedOps = new Set(ops)
}
/**
 * When each route last answered with a server error, read slowly or could not reach its host, so a
 * page failure of the same cause is not alarmed twice: it rings on the route's own alarm.
 */
const routeTroubleAt = new Map<string, number>()
/** Whether `route` read slowly, failed or could not reach its host in the clock hour of `at`. */
const routeTroubledInHourOf = (route: string, at: number): boolean => {
  const t = routeTroubleAt.get(route)
  return t !== undefined && Math.floor(t / HOUR_MS) === Math.floor(at / HOUR_MS)
}

/**
 * A page request that timed out is held this long: when several different requests time out within
 * it, the page, the server or the way between them stalled, which counts once as a stall. One timing
 * out alone never rings: a route that held the page until it gave up rings as its own slow read (the
 * page's deadline aborts its fetch, and recordHttp counts the hang-up), and one the server answered in
 * time or never saw is neither the route's nor the page's (2026-11-24: a notes list the server
 * answered in 24 ms that the page waited 15 s for, and servers requests on a server being replaced
 * for a deploy, rang the watches of tasks that changed neither). What a lone timeout no longer shows
 * rings elsewhere: a server that read the request late (a stalled event loop) on Walnut Health's
 * event-loop alarm, a host it could not reach on its host link, a server down on its server alarms.
 */
const OUTAGE_WINDOW_MS = 60_000
const OUTAGE_KINDS = 3
/** Right after this server started, a page's timed-out requests are the restart's. */
const START_GRACE_MS = 2 * 60_000
const MAX_HELD = 2_000
/** Timeouts of several requests together count once under this kind: a stall that recurs still rings. */
export const STALL_KIND = 'page requests timed out together'
let startedAt = 0
/** Up to when this process kept the machine's sleep (flushUsage). */
let sleptSeenTo = 0
/** In arrival order; a judged entry is context only (a failure that never rings, or one already counted). */
let held: { at: number; kind: string; route?: string; judged: boolean }[] = []
let lastStallAt = -Infinity

function hourOf(t: number): number {
  return Math.floor(t / HOUR_MS) * HOUR_MS
}

function bucket(kind: UsageKind, name: string, now: number): Agg {
  const hour = hourOf(now)
  let key = `${hour}\t${kind}\t${name}`
  let row = pending.get(key)
  if (!row) {
    if (pending.size >= MAX_NAMES_PER_HOUR * 3) { name = 'other'; key = `${hour}\t${kind}\tother`; row = pending.get(key) }
    if (!row) { row = { hour, kind, name, agg: emptyAgg() }; pending.set(key, row) }
  }
  return row.agg
}

function event(e: UsageEvent): void {
  if (events.length < MAX_EVENTS_PER_FLUSH) events.push(e)
}

export interface OpCall {
  op: string
  client: ToolClient
  cls: OutcomeClass
  code?: string
  /** The answer's size in its client's unit (answerSize). */
  size: number
  overLimit: boolean
  /** Saved to a file by Walnut's MCP server (answerSize). */
  spilled?: boolean
  /**
   * The answer was not held to an agent's surface (ops/answer.ts): a program read it (a check
   * script, a plugin job, a CLI loop, a person's terminal), or the caller asked for it whole
   * (`_full`). Its size is no agent's read: counted as a call, in no size number and never over a limit.
   */
  whole?: boolean
  ms: number
  now?: number
}

/** One gateway tool call. */
export function recordOpCall(call: OpCall): void {
  if (!active) return
  const now = call.now ?? Date.now()
  // A timeout that was mostly this machine's sleep: Walnut was away (ASLEEP_CODE), not the tool's
  // fault; its time is the part awake. A thrown error is the tool's fault, slept or not.
  const slept = call.cls === 'timeout' ? sleptOf(now, call.ms) : 0
  const c: OpCall = slept > 0 && slept * 2 >= call.ms ? { ...call, cls: 'unreachable', code: ASLEEP_CODE, ms: call.ms - slept } : call
  const agg = bucket('op', c.op, now)
  const overLimit = c.overLimit && !c.whole
  addCall(agg, { cls: c.cls, ...(c.code ? { code: c.code } : {}), ...(c.whole && c.cls === 'ok' ? {} : { chars: c.size }), ms: c.ms })
  if (overLimit) agg.overLimit++
  if (c.spilled) agg.spilled++
  const labels = { op: labelValue(c.op) }
  if (c.cls === 'error' || c.cls === 'timeout') {
    // A session's Walnut tools that did not start ring at the first, on their own alarm (usage.mount).
    count(c.op === MOUNT_OP ? 'usage.op.mount_failed' : 'usage.op.errors', 1, labels)
    if (watchedOps.has(c.op)) count('usage.op.watched_errors', 1, labels)
  }
  if (c.cls === 'bad_args') count('usage.op.bad_args', 1, labels)
  if (overLimit) count('usage.op.over_limit', 1, labels)
  if (c.cls !== 'ok' || overLimit) {
    event({ at: now, kind: 'op', name: c.op, problem: c.cls !== 'ok' ? c.cls : 'over_limit', ...(c.code ? { code: c.code } : {}), chars: c.size, ms: c.ms })
  }
}

/**
 * A session's Walnut tool call that failed as its agent read it, on any host: the server's
 * refusals, the client's own (Walnut unreachable, the tool gone after a disconnect) and Claude
 * Code's (its input refused). Its session, task, host, op and error code; never its words.
 */
export function recordToolError(row: Omit<ToolErrorRow, 'at'> & { at?: number }, via: ToolErrorVia = 'hook', clientId?: string): boolean {
  const at = row.at ?? Date.now()
  // A client's report sent again (its first answer was slow, put back, and landed all the same):
  // each failure has its own id, counted once (lib/no-answer-report.ts).
  if (via === 'client' && clientId && sameClientIdTold(row.sid, clientId)) return false
  if (NO_ANSWER_CODES.has(row.code) && sameNoAnswerSeen({ ...row, at }, via)) return false
  // Kept before the recorder starts too (2026-11-24 audit: a server's first seconds after a restart
  // are when the calls that failed during it are told, and they were dropped here). A process that
  // never starts it (a replica, a CLI) keeps at most one flush's rows and writes none.
  if (toolErrors.length < MAX_EVENTS_PER_FLUSH) toolErrors.push({ ...row, at })
  if (active) count('usage.tool_errors', 1, { code: labelValue(row.code) })
  return true
}

/** Who said a call failed: the session hook reading its result, or the client that made it (a no-answer report). */
export type ToolErrorVia = 'hook' | 'client'

/**
 * A no-answer failure the other source already told (the hook read it live and the client reports it
 * later, or the other way round): told once. Matched by session, op and code within a short window,
 * each entry once, so two real retries stay two. A report of a failure the hook recorded before this
 * server started is matched against the store (one read, only for such a report).
 */
const NO_ANSWER_MATCH_MS = 2 * 60_000
const NO_ANSWER_KEEP_MS = 30 * 60_000
let noAnswerSeen: Array<{ key: string; at: number; via: ToolErrorVia; matched: boolean; old?: true; seenAt: number }> = []

/** Client failure ids told here, by session, as long as a client still tells a failure (a day). */
const CLIENT_IDS_KEEP_MS = 24 * 3_600_000
const CLIENT_IDS_MAX = 20_000
let clientIdsTold = new Map<string, number>()

/** Ids told since the last flush, written with its rows (store.ts client_failures): a restart keeps them. */
let clientIdsToWrite: Array<{ sid: string; id: string; at: number }> = []

function sameClientIdTold(sid: string, id: string): boolean {
  const key = `${sid}\t${id}`
  if (clientIdsTold.has(key)) return true
  const now = Date.now()
  // Told to the server before this one started: its store says so.
  if (clientFailureKnown(sid, id)) { clientIdsTold.set(key, now); return true }
  clientIdsToWrite.push({ sid, id, at: now })
  if (clientIdsTold.size >= CLIENT_IDS_MAX) {
    for (const [k, t] of clientIdsTold) if (now - t > CLIENT_IDS_KEEP_MS || clientIdsTold.size >= CLIENT_IDS_MAX) clientIdsTold.delete(k); else break
  }
  clientIdsTold.set(key, now)
  return false
}

function sameNoAnswerSeen(row: ToolErrorRow, via: ToolErrorVia): boolean {
  const key = `${row.sid}\t${row.op}\t${row.code}`
  // Kept by when each was told here, never by the row's own time: a report hours late must not clear
  // what waits for its match (2026-11-24 review).
  const now = Date.now()
  noAnswerSeen = noAnswerSeen.filter((e) => now - e.seenAt <= NO_ANSWER_KEEP_MS).slice(-1_000)
  const near = (e: { key: string; at: number }) => e.key === key && Math.abs(row.at - e.at) <= NO_ANSWER_MATCH_MS
  const other = noAnswerSeen.find((e) => near(e) && e.via !== via && !e.matched)
  if (other) { other.matched = true; noAnswerSeen.push({ key, at: row.at, via, matched: true, seenAt: now }); return true }
  if (via === 'client' && startedAt && row.at - NO_ANSWER_MATCH_MS < startedAt) {
    const before = readToolErrors({ since: row.at - NO_ANSWER_MATCH_MS, session: row.sid })
      .filter((r) => r.at < startedAt && r.sid === row.sid && r.op === row.op && r.code === row.code && Math.abs(r.at - row.at) <= NO_ANSWER_MATCH_MS).length
    const claimed = noAnswerSeen.filter((e) => near(e) && e.old).length
    if (before > claimed) { noAnswerSeen.push({ key, at: row.at, via, matched: true, old: true, seenAt: now }); return true }
  }
  noAnswerSeen.push({ key, at: row.at, via, matched: false, seenAt: now })
  return false
}


/**
 * What a Claude Code session's start said of its Walnut MCP mount (claude-code-session.ts
 * reconcileMcpMountStatus): one call of MOUNT_OP per process that asked for one. Connected, or still
 * starting, worked. Failed (it did not start, or closed before it answered) is Walnut's own fault and
 * rings at the first (usage.mount): the session runs with none of its Walnut tools. A server a machine
 * policy or the user's settings refused (blocked, disabled) is a refusal by design. One that did not
 * work is also kept by session (tool-errors.ts). 2026-11-24 and 25: Main and a Main AI chat started
 * without them at every resume, their mount naming a deploy's removed stage, and nothing counted it.
 */
export function recordMountVerdict(v: { sid?: string; taskId?: string; host: string; status: string; ms: number; now?: number }): void {
  const ok = v.status === 'connected' || v.status === 'pending'
  const cls: OutcomeClass = ok ? 'ok' : v.status === 'blocked' || v.status === 'disabled' ? 'refused' : 'error'
  const code = ok ? undefined : `mount_${v.status.replace(/[^a-z]+/gi, '_').toLowerCase().slice(0, 40)}`
  const now = v.now ?? Date.now()
  recordOpCall({ op: MOUNT_OP, client: 'mcp', cls, ...(code ? { code } : {}), size: 0, overLimit: false, ms: Math.max(0, v.ms), now })
  if (code && v.sid) recordToolError({ at: now, sid: v.sid, ...(v.taskId ? { taskId: v.taskId } : {}), host: v.host, op: MOUNT_OP, client: 'mcp', code })
}

/** Claude Code said it saved an answer of this op to a file instead of passing it on. */
export function recordConfirmedCut(op: string, size: number, client: ToolClient, now = Date.now()): void {
  if (!active) return
  const agg = bucket('op', op, now)
  agg.cut++
  if (size > agg.charsMax) agg.charsMax = size
  count('usage.op.cut', 1, { op: labelValue(op) })
  event({ at: now, kind: 'op', name: op, problem: 'cut', chars: size, code: `cut_${client}` })
}

export interface HttpRequest {
  method: string
  template: string
  status: number
  ms: number
  /** A read that waits on purpose or a stream: its time is no latency. */
  waits: boolean
  /**
   * The client left before any answer was sent (a page's deadline aborts its fetch, a closed tab):
   * its time is how long the client waited, the least the answer would have taken. A client leaving
   * an answer already under way (a player seeking in a video, a cancelled download) is not one.
   */
  hungUp?: boolean
  /** A 503 saying the host it reads through is not reachable now (web/middleware/host-unreachable-answer.ts). */
  hostUnreachable?: boolean
  now?: number
}

/** One request from a browser, the phone or another client (never an op's own call). */
export function recordHttp(r: HttpRequest): void {
  if (!active) return
  const now = r.now ?? Date.now()
  const name = `${r.method} ${r.template}`
  answeredTemplates.add(r.method, r.template)
  const agg = bucket('http', name, now)
  // A 503 saying its host is not reachable now is unreachable, as an op call's is (normalize.ts
  // failureClass), never this route's own error: the outage rings once, on its own alarm (Walnut
  // Health's host link), not on every route that read through it (2026-11-23: deploys cut the
  // clouddev link, and the history route's "Reconnecting" answers rang as its server errors).
  // Any other 503 (a store busy, a state unavailable) is still the route's.
  const hostAway = r.status === 503 && r.hostUnreachable === true
  // This machine's sleep inside the request (ASLEEP_CODE): a gateway answer (502/503/504) that was
  // mostly sleep is Walnut away, and a read is slow only by its time awake. A 500 stays the route's.
  const gatewayAnswer = r.status === 502 || r.status === 503 || r.status === 504
  const slept = gatewayAnswer || (r.method === 'GET' && r.ms > SLOW_READ_MS) ? sleptOf(now, r.ms) : 0
  const awakeMs = r.ms - slept
  const asleep = gatewayAnswer && !hostAway && slept > 0 && slept * 2 >= r.ms
  const unreachable = hostAway || asleep
  const serverError = r.status >= 500 && r.status !== 501 && !unreachable
  const cls: OutcomeClass = unreachable ? 'unreachable' : serverError ? 'error' : r.status >= 400 ? 'refused' : 'ok'
  const code = asleep ? ASLEEP_CODE : `http_${r.status}`
  // A client that left before any answer waited that long: a read held past the slow line is the
  // route holding it (2026-11-24: such hang-ups were counted as waits of 0 ms, so a route that held
  // its page until the page gave up read as fast). A shorter one, or a write's, stays a wait: it
  // says nothing of the route, and a write that waits on purpose (a long poll by POST) would skew
  // its p95.
  const waited = r.waits || (r.hungUp === true && !(r.method === 'GET' && awakeMs > SLOW_READ_MS))
  addCall(agg, { cls, ...(r.status >= 400 ? { code } : {}), chars: 0, ms: waited ? 0 : awakeMs })
  const labels = { route: labelValue(name) }
  if (unreachable) {
    routeTroubleAt.set(name, now)
    event({ at: now, kind: 'http', name, problem: 'unreachable', code, ms: r.ms })
  }
  if (serverError) {
    agg.serverErrors++
    count('usage.http.server_errors', 1, labels)
    routeTroubleAt.set(name, now)
    event({ at: now, kind: 'http', name, problem: 'server_error', code: `http_${r.status}`, ms: r.ms })
  }
  if (!waited && r.method === 'GET' && awakeMs > SLOW_READ_MS) {
    agg.slow++
    routeTroubleAt.set(name, now)
    count('usage.http.slow', 1, labels)
    event({ at: now, kind: 'http', name, problem: 'slow', ms: r.ms })
  }
}

/** One visit of a place Page use counts (core/page-visits.ts): a use of a `page:` target (page-uses.ts). */
export function recordPageVisit(key: string, now = Date.now()): void {
  if (active) notePageUse(key, 'visit', now)
}

/**
 * One error a page reported, as its kind; `place` is the page it came from (page-uses.ts
 * placeOfPagePath), where an error of the page's own counts too.
 */
export function recordPageError(k: PageErrorKind, now = Date.now(), place: string | null = null): void {
  if (!active) return
  if (place && pageKindIsPagesOwn(k.kind)) notePageUse(place, 'error', now)
  const agg = bucket('page', k.kind, now)
  addCall(agg, { cls: 'error', chars: 0, ms: 0 })
  // The same cause rang on its route this hour (server errors, slow reads): counted here, alarmed there.
  const sameCause = k.route ? routeTroubledInHourOf(k.route, now) : false
  // A request the page's connection queue gave up on (rejected) was never sent, and one that
  // failed never reached the server (a network error: it was down, restarting or asleep, or the
  // network was): their cause rings on its own (slow reads, server errors, Walnut Health's server
  // alarms) or is not Walnut's. Shown in the table, never rung (2026-11-22: a restart made 19 at
  // once, and a sleeping Mac's page nine at one instant). A timed-out one is the same alone; it waits
  // a minute only to see whether it was part of a stall (settlePageFailures). A thrown error, or a
  // request the browser refused, rings.
  const hold = (judged: boolean) => { if (held.length < MAX_HELD) held.push({ at: now, kind: k.kind, ...(k.route ? { route: k.route } : {}), judged }) }
  if (!k.request || k.how === 'refused') { if (!sameCause) count('usage.page.errors', 1, { kind: labelValue(k.kind) }) }
  else if (k.how === 'rejected') { /* a hung route fills the queue: never context for its own timeouts */ }
  // Right after this server started, what the page lost is the restart's: not even context for a stall.
  else if (now - startedAt < START_GRACE_MS) { /* the restart's */ }
  // Context for the window only: what failed with it, and timeouts their route already rang for.
  else if (k.how !== 'timed out' || sameCause) hold(true)
  else hold(false)
  event({ at: now, kind: 'page', name: k.kind, problem: k.request ? 'request_failed' : 'error' })
}

/** Settles the held page timeouts whose window has passed: several kinds together count once as a stall. */
export function settlePageFailures(now = Date.now()): void {
  for (let i = 0; i < held.length; i++) {
    const f = held[i]!
    if (f.judged || now - f.at < OUTAGE_WINDOW_MS) continue
    f.judged = true
    // Its route read slowly or failed in its hour (its answer lands after the page gave up): the route's.
    if (f.route && routeTroubledInHourOf(f.route, f.at)) continue
    if (kindsNear(i) >= OUTAGE_KINDS && f.at - lastStallAt > OUTAGE_WINDOW_MS) {
      lastStallAt = f.at
      count('usage.page.errors', 1, { kind: STALL_KIND })
    }
  }
  held = held.filter((f) => now - f.at < 2 * OUTAGE_WINDOW_MS)
}

/** Different kinds within the window of held[i] (arrival order), counted up to OUTAGE_KINDS. */
function kindsNear(i: number): number {
  const at = held[i]!.at
  const kinds = new Set<string>([held[i]!.kind])
  for (let j = i - 1; j >= 0 && at - held[j]!.at <= OUTAGE_WINDOW_MS && kinds.size < OUTAGE_KINDS; j--) kinds.add(held[j]!.kind)
  for (let j = i + 1; j < held.length && held[j]!.at - at <= OUTAGE_WINDOW_MS && kinds.size < OUTAGE_KINDS; j++) kinds.add(held[j]!.kind)
  return kinds.size
}

/**
 * Where a replica's rows go instead of its own file: the cloud companion hands the requests its own
 * routes answered to the Mac, which counts them (companion-uses.ts). Its events and tool errors stay
 * behind: the hours are what a watch and the report read.
 */
let rowSink: ((rows: Array<{ hour: number; kind: UsageKind; name: string; agg: Agg }>) => void) | null = null

/** Writes what this process counted since the last flush (also on shutdown). */
export function flushUsage(now = Date.now()): void {
  settlePageFailures(now)
  const rows = [...pending.values()]
  pending = new Map()
  const evs = events
  events = []
  const errs = toolErrors
  toolErrors = []
  const pageRows = takePageUses()
  if (rowSink) {
    rowSink(rows)
    // A replica keeps no store: its told ids stay in memory only.
    clientIdsToWrite = []
    for (const [route, at] of routeTroubleAt) if (now - at > HOUR_MS) routeTroubleAt.delete(route)
    return
  }
  addHours(rows)
  addPageUses(pageRows)
  addEvents(evs)
  addToolErrors(errs)
  const ids = clientIdsToWrite
  clientIdsToWrite = []
  addClientFailures(ids)
  markAlive(now)
  // The sleep this process saw since its last flush, kept by the hour (store.ts addSlept).
  const sleptFrom = sleptSeenTo || startedAt || now
  if (now > sleptFrom) addSlept(sleepIntervals(sleptFrom, now))
  sleptSeenTo = now
  if (now - lastPrune > HOUR_MS) { lastPrune = now; pruneStore(now) }
  for (const [route, at] of routeTroubleAt) if (now - at > HOUR_MS) routeTroubleAt.delete(route)
  // The gauge's alarm reads it every 5 minutes: a day of hour rows is read no more often.
  if (now - lastBadArgs >= BAD_ARGS_EVERY_MS) { lastBadArgs = now; reportBadArgShares(now) }
}

/** Bad-argument share per op over the last 24 hours, for ops with 10 or more: a gauge the bad-args alarm reads. */
const badArgGauges = new Set<string>()
function reportBadArgShares(now: number): void {
  const since = hourOf(now) - 23 * HOUR_MS
  const per = new Map<string, { calls: number; bad: number }>()
  for (const r of readHours(since, { kind: 'op' })) {
    const p = per.get(r.name) ?? { calls: 0, bad: 0 }
    p.calls += r.agg.calls
    p.bad += r.agg.badArgs
    per.set(r.name, p)
  }
  const now24 = new Set<string>()
  for (const [op, p] of per) {
    if (p.bad < 10 || !p.calls) continue
    const key = `usage.op.bad_args_pct{op=${labelValue(op)}}`
    reportGauge(key, Math.round((p.bad / p.calls) * 1000) / 10)
    now24.add(key)
  }
  for (const key of badArgGauges) if (!now24.has(key)) reportGauge(key, null)
  badArgGauges.clear()
  for (const k of now24) badArgGauges.add(k)
}

export function startUsageRecorder(opts: { sink?: typeof rowSink } = {}): void {
  rowSink = opts.sink ?? null
  if (!active) startedAt = Date.now()
  active = true
  if (timer) return
  timer = setInterval(() => { try { flushUsage() } catch { /* the store logs its own failure */ } }, FLUSH_MS)
  timer.unref?.()
}

export function stopUsageRecorder(): void {
  if (timer) clearInterval(timer)
  timer = null
  active = false
  try { flushUsage() } catch { /* shutting down */ }
  held = []
}

export function _resetUsageRecorderForTesting(on = true, started = 0, sink: typeof rowSink = null): void {
  active = on
  rowSink = sink
  startedAt = started
  sleptSeenTo = 0
  held = []
  lastStallAt = -Infinity
  pending = new Map()
  _resetPageUsesForTesting()
  events = []
  toolErrors = []
  noAnswerSeen = []
  clientIdsTold = new Map()
  clientIdsToWrite = []
  routeTroubleAt.clear()
  badArgGauges.clear()
  lastPrune = 0
  lastBadArgs = 0
}

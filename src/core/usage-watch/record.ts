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
import { addEvents, addHours, addToolErrors, markAlive, pruneStore, readHours, type ToolErrorRow, type UsageEvent } from './store.js'
import { TemplateMatcher, type PageErrorKind } from './normalize.js'
import type { ToolClient } from '../../lib/tool-answer-size.js'
import { labelValue } from './counters.js'

const HOUR_MS = 3_600_000
const FLUSH_MS = 60_000
/** At most this many names of one kind per hour; the rest count under `other`. */
const MAX_NAMES_PER_HOUR = 600
const MAX_EVENTS_PER_FLUSH = 200
/** A read slower than this is slow (long polls and streams never count). */
export const SLOW_READ_MS = 5_000

export { USAGE_COUNTERS } from './counters.js'

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
 * When each route last answered with a server error or read slowly, so a page failure of the same
 * cause is not alarmed twice: it rings on the route's own alarm (watches.ts judges the same per hour).
 */
const routeTroubleAt = new Map<string, number>()

/**
 * A page request that timed out is held this long before it may ring: when several different
 * requests time out within it, the server or the network stalled, which rings on its own; one
 * route timing out alone is that route's (2026-11-22: the threads route, also a slow read).
 */
const OUTAGE_WINDOW_MS = 60_000
const OUTAGE_KINDS = 3
/** Right after this server started, a page's timed-out requests are the restart's. */
const START_GRACE_MS = 2 * 60_000
const MAX_HELD = 2_000
/** Timeouts of several requests together count once under this kind: a stall that recurs still rings. */
export const STALL_KIND = 'page requests timed out together'
let startedAt = 0
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
export function recordOpCall(c: OpCall): void {
  if (!active) return
  const now = c.now ?? Date.now()
  const agg = bucket('op', c.op, now)
  const overLimit = c.overLimit && !c.whole
  addCall(agg, { cls: c.cls, ...(c.code ? { code: c.code } : {}), ...(c.whole && c.cls === 'ok' ? {} : { chars: c.size }), ms: c.ms })
  if (overLimit) agg.overLimit++
  if (c.spilled) agg.spilled++
  const labels = { op: labelValue(c.op) }
  if (c.cls === 'error' || c.cls === 'timeout') {
    count('usage.op.errors', 1, labels)
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
export function recordToolError(row: Omit<ToolErrorRow, 'at'> & { at?: number }): void {
  if (!active) return
  if (toolErrors.length < MAX_EVENTS_PER_FLUSH) toolErrors.push({ ...row, at: row.at ?? Date.now() })
  count('usage.tool_errors', 1, { code: labelValue(row.code) })
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
  const unreachable = r.status === 503 && r.hostUnreachable === true
  const serverError = r.status >= 500 && r.status !== 501 && !unreachable
  const cls: OutcomeClass = unreachable ? 'unreachable' : serverError ? 'error' : r.status >= 400 ? 'refused' : 'ok'
  addCall(agg, { cls, ...(r.status >= 400 ? { code: `http_${r.status}` } : {}), chars: 0, ms: r.waits ? 0 : r.ms })
  const labels = { route: labelValue(name) }
  if (unreachable) event({ at: now, kind: 'http', name, problem: 'unreachable', code: `http_${r.status}`, ms: r.ms })
  if (serverError) {
    agg.serverErrors++
    count('usage.http.server_errors', 1, labels)
    routeTroubleAt.set(name, now)
    event({ at: now, kind: 'http', name, problem: 'server_error', code: `http_${r.status}`, ms: r.ms })
  }
  if (!r.waits && r.method === 'GET' && r.ms > SLOW_READ_MS) {
    agg.slow++
    routeTroubleAt.set(name, now)
    count('usage.http.slow', 1, labels)
    event({ at: now, kind: 'http', name, problem: 'slow', ms: r.ms })
  }
}

/** One error a page reported, as its kind. */
export function recordPageError(k: PageErrorKind, now = Date.now()): void {
  if (!active) return
  const agg = bucket('page', k.kind, now)
  addCall(agg, { cls: 'error', chars: 0, ms: 0 })
  // The same cause rang on its route this hour (server errors, slow reads): counted here, alarmed there.
  const sameCause = k.route ? now - (routeTroubleAt.get(k.route) ?? 0) < HOUR_MS : false
  // A request the page's connection queue gave up on (rejected) was never sent, and one that
  // failed never reached the server (a network error: it was down, restarting or asleep, or the
  // network was): their cause rings on its own (slow reads, server errors, Walnut Health's server
  // alarms) or is not Walnut's. Shown in the table, never rung (2026-11-22: a restart made 19 at
  // once, and a sleeping Mac's page nine at one instant). A timed-out one can be its route's: it
  // waits a minute (settlePageFailures). A thrown error, or a request the browser refused, rings.
  const hold = (judged: boolean) => { if (held.length < MAX_HELD) held.push({ at: now, kind: k.kind, ...(k.route ? { route: k.route } : {}), judged }) }
  if (!k.request || k.how === 'refused') { if (!sameCause) count('usage.page.errors', 1, { kind: labelValue(k.kind) }) }
  else if (k.how === 'rejected') { /* a hung route fills the queue: never context for its own timeouts */ }
  // Context for the window only: what failed with it, what came right after a restart.
  else if (k.how !== 'timed out' || sameCause || now - startedAt < START_GRACE_MS) hold(true)
  else hold(false)
  event({ at: now, kind: 'page', name: k.kind, problem: k.request ? 'request_failed' : 'error' })
}

/** Rings the held page timeouts whose window has passed: alone by their route, together once as a stall. */
export function settlePageFailures(now = Date.now()): void {
  for (let i = 0; i < held.length; i++) {
    const f = held[i]!
    if (f.judged || now - f.at < OUTAGE_WINDOW_MS) continue
    f.judged = true
    // Its route read slowly or failed around it (its answer lands after the page gave up): the route's.
    if (f.route && Math.abs(f.at - (routeTroubleAt.get(f.route) ?? -Infinity)) < HOUR_MS) continue
    if (kindsNear(i) < OUTAGE_KINDS) count('usage.page.errors', 1, { kind: labelValue(f.kind) })
    else if (f.at - lastStallAt > OUTAGE_WINDOW_MS) {
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

/** Writes what this process counted since the last flush (also on shutdown). */
export function flushUsage(now = Date.now()): void {
  settlePageFailures(now)
  const rows = [...pending.values()]
  pending = new Map()
  const evs = events
  events = []
  const errs = toolErrors
  toolErrors = []
  addHours(rows)
  addEvents(evs)
  addToolErrors(errs)
  markAlive(now)
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

export function startUsageRecorder(): void {
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

export function _resetUsageRecorderForTesting(on = true, started = 0): void {
  active = on
  startedAt = started
  held = []
  lastStallAt = -Infinity
  pending = new Map()
  events = []
  toolErrors = []
  routeTroubleAt.clear()
  badArgGauges.clear()
  lastPrune = 0
  lastBadArgs = 0
}

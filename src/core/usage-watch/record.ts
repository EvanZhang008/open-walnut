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
import { addEvents, addHours, markAlive, pruneStore, readHours, type UsageEvent } from './store.js'
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
/** Server errors by route this hour, so a page failure of the same cause is not alarmed twice. */
const routeErrorsAt = new Map<string, number>()

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
  ms: number
  now?: number
}

/** One gateway tool call. */
export function recordOpCall(c: OpCall): void {
  if (!active) return
  const now = c.now ?? Date.now()
  const agg = bucket('op', c.op, now)
  addCall(agg, { cls: c.cls, ...(c.code ? { code: c.code } : {}), chars: c.size, ms: c.ms })
  if (c.overLimit) agg.overLimit++
  if (c.spilled) agg.spilled++
  const labels = { op: labelValue(c.op) }
  if (c.cls === 'error' || c.cls === 'timeout') {
    count('usage.op.errors', 1, labels)
    if (watchedOps.has(c.op)) count('usage.op.watched_errors', 1, labels)
  }
  if (c.cls === 'bad_args') count('usage.op.bad_args', 1, labels)
  if (c.overLimit) count('usage.op.over_limit', 1, labels)
  if (c.cls !== 'ok' || c.overLimit) {
    event({ at: now, kind: 'op', name: c.op, problem: c.cls !== 'ok' ? c.cls : 'over_limit', ...(c.code ? { code: c.code } : {}), chars: c.size, ms: c.ms })
  }
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
  now?: number
}

/** One request from a browser, the phone or another client (never an op's own call). */
export function recordHttp(r: HttpRequest): void {
  if (!active) return
  const now = r.now ?? Date.now()
  const name = `${r.method} ${r.template}`
  answeredTemplates.add(r.method, r.template)
  const agg = bucket('http', name, now)
  const serverError = r.status >= 500 && r.status !== 501
  const cls: OutcomeClass = serverError ? 'error' : r.status >= 400 ? 'refused' : 'ok'
  addCall(agg, { cls, ...(r.status >= 400 ? { code: `http_${r.status}` } : {}), chars: 0, ms: r.waits ? 0 : r.ms })
  const labels = { route: labelValue(name) }
  if (serverError) {
    agg.serverErrors++
    count('usage.http.server_errors', 1, labels)
    routeErrorsAt.set(name, now)
    event({ at: now, kind: 'http', name, problem: 'server_error', code: `http_${r.status}`, ms: r.ms })
  }
  if (!r.waits && r.method === 'GET' && r.ms > SLOW_READ_MS) {
    agg.slow++
    count('usage.http.slow', 1, labels)
    event({ at: now, kind: 'http', name, problem: 'slow', ms: r.ms })
  }
}

/** One error a page reported, as its kind. */
export function recordPageError(k: PageErrorKind, now = Date.now()): void {
  if (!active) return
  const agg = bucket('page', k.kind, now)
  addCall(agg, { cls: 'error', chars: 0, ms: 0 })
  // The same cause rang on its route this hour (server errors): counted here, alarmed there.
  const sameCause = k.route ? now - (routeErrorsAt.get(k.route) ?? 0) < HOUR_MS : false
  // A request the page's connection queue gave up on was never sent: a restart or a held route
  // fills the queue, and that cause rings on its own (slow reads, server errors, Walnut Health's
  // server alarms). Shown in the table, never rung (2026-11-22: a deploy's restart made 19 at once).
  const unsent = / rejected in the page$/.test(k.kind)
  if (!sameCause && !unsent) count('usage.page.errors', 1, { kind: labelValue(k.kind) })
  event({ at: now, kind: 'page', name: k.kind, problem: k.request ? 'request_failed' : 'error' })
}

/** Writes what this process counted since the last flush (also on shutdown). */
export function flushUsage(now = Date.now()): void {
  const rows = [...pending.values()]
  pending = new Map()
  const evs = events
  events = []
  addHours(rows)
  addEvents(evs)
  markAlive(now)
  if (now - lastPrune > HOUR_MS) { lastPrune = now; pruneStore(now) }
  for (const [route, at] of routeErrorsAt) if (now - at > HOUR_MS) routeErrorsAt.delete(route)
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
}

export function _resetUsageRecorderForTesting(on = true): void {
  active = on
  pending = new Map()
  events = []
  routeErrorsAt.clear()
  badArgGauges.clear()
  lastPrune = 0
  lastBadArgs = 0
}

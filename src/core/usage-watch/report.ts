/**
 * What the Real Use page and `usage_watch {"action":"report"}` read: per tool, request and page
 * error kind, its totals over the range, its size and time percentiles, its error codes and a
 * line per day. Read from the hourly rows only (no content is in them).
 */
import { emptyAgg, mergeAgg, msPercentile, ownFaults, sizePercentile, type Agg, type UsageKind } from './agg.js'
import { readAlive, readEvents, readHours, type UsageEvent } from './store.js'
import { recordedShare, targetCovers } from './watches.js'

const HOUR_MS = 3_600_000
export type ReportRange = '24h' | '48h' | '7d'
/** Each range's hours and the step its series is drawn in (2026-11-24: sessions asked for 48h). */
export const RANGE_HOURS: Record<ReportRange, { hours: number; step: number }> = { '24h': { hours: 24, step: 4 }, '48h': { hours: 48, step: 8 }, '7d': { hours: 168, step: 24 } }
/** The range a caller named, else 7 days. */
export const readRange = (v: unknown): ReportRange => (typeof v === 'string' && Object.hasOwn(RANGE_HOURS, v) ? v as ReportRange : '7d')

export interface ReportRow {
  kind: UsageKind
  name: string
  calls: number
  fails: number
  refused: number
  badArgs: number
  errors: number
  timeouts: number
  unreachable: number
  cut: number
  overLimit: number
  spilled: number
  over10k: number
  sizeP50: number | null
  sizeP95: number | null
  largest: number
  slow: number
  serverErrors: number
  msP95: number | null
  codes: Record<string, number>
  /** One point per day (7 days) or per 4 hours (24 hours): uses, and the failures that matter for the kind. */
  series: Array<{ at: number; uses: number; bad: number }>
}

export interface UsageReport {
  range: ReportRange
  from: number
  to: number
  /** Share of minutes in the range this server recorded. */
  recorded: number
  /** The first hour anything was recorded, or null. */
  firstHour: number | null
  rows: ReportRow[]
}

function badOf(kind: UsageKind, a: Agg): number {
  // Walnut's own faults and cut answers; the caller's side is not a problem of the tool's (agg.ts).
  if (kind === 'op') return ownFaults(a) + a.cut
  if (kind === 'http') return a.slow + a.serverErrors
  return a.calls
}

/** The report over the last 24 hours, 48 hours or 7 days, optionally one target's rows only. */
export function usageReport(range: ReportRange, opts: { now?: number; target?: string } = {}): UsageReport {
  const now = opts.now ?? Date.now()
  const span = RANGE_HOURS[range].hours * HOUR_MS
  const step = RANGE_HOURS[range].step * HOUR_MS
  const to = Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_MS
  const from = to - span
  const steps = span / step
  const per = new Map<string, { kind: UsageKind; name: string; agg: Agg; series: Array<{ at: number; uses: number; bad: number }> }>()
  let first: number | null = null
  for (const r of readHours(from)) {
    if (opts.target && !targetCovers(opts.target, r.kind, r.name)) continue
    if (first === null || r.hour < first) first = r.hour
    const key = `${r.kind}\t${r.name}`
    let p = per.get(key)
    if (!p) {
      p = { kind: r.kind, name: r.name, agg: emptyAgg(), series: Array.from({ length: steps }, (_, i) => ({ at: from + i * step, uses: 0, bad: 0 })) }
      per.set(key, p)
    }
    p.agg = mergeAgg(p.agg, r.agg)
    const i = Math.min(steps - 1, Math.max(0, Math.floor((r.hour - from) / step)))
    p.series[i]!.uses += r.agg.calls
    p.series[i]!.bad += badOf(r.kind, r.agg)
  }
  const rows: ReportRow[] = [...per.values()].map(({ kind, name, agg: a, series }) => ({
    kind, name, calls: a.calls, fails: a.fails, refused: a.refused, badArgs: a.badArgs, errors: a.errors, timeouts: a.timeouts,
    unreachable: a.unreachable, cut: a.cut, overLimit: a.overLimit, spilled: a.spilled, over10k: a.over10k,
    sizeP50: kind === 'op' ? sizePercentile(a, 50) : null, sizeP95: kind === 'op' ? sizePercentile(a, 95) : null, largest: a.charsMax,
    slow: a.slow, serverErrors: a.serverErrors, msP95: kind === 'http' ? msPercentile(a, 95) : null, codes: a.codes, series,
  }))
  // Recorded since this server first recorded in the range: a fresh install is not "mostly missing".
  // The first hour counts from its first recorded minute (its minutes, back from its end), not
  // from the top of the hour: a server started at :56 has not missed the 56 minutes before it.
  const alive = readAlive(from)
  const firstAlive = alive.size ? Math.min(...alive.keys()) : null
  const since = firstAlive === null ? now
    : Math.max(from, Math.min(firstAlive + 3_600_000, now) - (alive.get(firstAlive) ?? 0) * 60_000)
  const recorded = since >= now ? 1 : Math.round(recordedShare(since, Math.min(to, now)) * 1000) / 1000
  return { range, from, to, recorded, firstHour: first, rows }
}

/** The latest problem calls of one target (no content: name, problem, code, size, time). */
export function targetEvents(target: string, limit = 20): UsageEvent[] {
  const kind: UsageKind = target.startsWith('op:') ? 'op' : target.startsWith('route:') ? 'http' : 'page'
  return readEvents({ kind, limit: 500 }).filter((e) => targetCovers(target, e.kind, e.name)).slice(0, limit)
}

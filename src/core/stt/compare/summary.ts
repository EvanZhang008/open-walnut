/**
 * The comparison summary: engines are compared only over the takes every
 * shown engine has a score on ("on the same N recordings"), so an engine run on three
 * easy takes never looks better than one run on fifty. Rates are estimated
 * errors against the judge's reference, not a ground truth. The lowest rate is
 * marked only when it is lower than the next by at least BEST_MARGIN points.
 * The trend is the other rule: per day, each engine over every take it scored
 * that day, so the in-use engine has a point each day the nightly run scored it.
 */
import type { CompareTake } from './types.js'

/** Half a percentage point. */
export const BEST_MARGIN = 0.005

export interface EngineRates {
  mixed: number | null
  cjk: number | null
  latin: number | null
  terms: number | null
}

export interface EngineSummary extends EngineRates {
  id: string
  /** Median engine time over the shared takes, ms. */
  medianMs: number | null
  takes: number
  /** Takes with a score for this engine, shared or not. */
  scoredTakes: number
  /** The models its results over the shared takes were made with (more than one: the rate mixes them). */
  models: string[]
  /** Shared takes whose result recorded no model (older results): the rate is not all one known model. */
  unrecorded: number
}

export interface DaySummary { day: string; takes: number; engines: Record<string, EngineRates>; best?: string }

/** One engine on one day, over every take it scored that day (shared or not). */
export interface TrendPoint extends EngineRates {
  takes: number
  /** Median engine time that day, ms. */
  medianMs: number | null
}

/** Only the engines that scored a take that day. */
export interface TrendDay { day: string; engines: Record<string, TrendPoint> }

export interface CompareSummary {
  takes: number
  judged: number
  sharedTakes: number
  engines: EngineSummary[]
  best?: string
  /** The shared takes by day, newest first (the side-by-side rule). */
  byDay: DaySummary[]
  /** Every scored take by day, oldest first (each engine alone). */
  trend: TrendDay[]
}

const rate = (edits: number, n: number) => (n > 0 ? edits / n : null)

function rates(takes: CompareTake[], id: string): EngineRates {
  let edits = 0, n = 0, cjkEdits = 0, cjkN = 0, latEdits = 0, latN = 0, hit = 0, need = 0
  for (const take of takes) {
    const s = take.scores?.[id]
    if (!s) continue
    edits += s.edits; n += s.n; cjkEdits += s.cjkEdits; cjkN += s.cjkN; latEdits += s.latEdits; latN += s.latN
    hit += s.termsHit; need += s.termsNeed
  }
  return { mixed: rate(edits, n), cjk: rate(cjkEdits, cjkN), latin: rate(latEdits, latN), terms: need > 0 ? hit / need : null }
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** The engine whose mixed rate is lowest by at least BEST_MARGIN, if one is. */
export function bestOf(rows: Array<{ id: string; mixed: number | null }>): string | undefined {
  const ranked = rows.filter((r) => r.mixed !== null).sort((a, b) => a.mixed! - b.mixed!)
  if (ranked.length < 2) return undefined
  return ranked[1]!.mixed! - ranked[0]!.mixed! >= BEST_MARGIN ? ranked[0]!.id : undefined
}

/** The local calendar day of an ISO time. */
export function localDay(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'unknown'
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The takes by local day, in the order first seen. */
function groupByDay(takes: CompareTake[]): Map<string, CompareTake[]> {
  const days = new Map<string, CompareTake[]>()
  for (const take of takes) {
    const day = localDay(take.at)
    days.set(day, [...(days.get(day) ?? []), take])
  }
  return days
}

const msOf = (takes: CompareTake[], id: string) =>
  median(takes.map((t) => t.results[id]?.ms).filter((ms): ms is number => typeof ms === 'number'))

/** Per day, oldest first: each shown engine over the takes it scored that day; a take with no day is left out. */
export function trendOf(takes: CompareTake[], shown: string[]): TrendDay[] {
  const days = groupByDay(takes.filter((t) => shown.some((id) => t.scores?.[id])))
  days.delete('unknown')
  return [...days.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, list]) => {
    const engines: Record<string, TrendPoint> = {}
    for (const id of shown) {
      const own = list.filter((t) => t.scores?.[id])
      if (own.length) engines[id] = { ...rates(own, id), takes: own.length, medianMs: msOf(own, id) }
    }
    return { day, engines }
  })
}

/** Every engine with a score on some take, in the order first seen. */
export function scoredEngines(takes: CompareTake[]): string[] {
  return [...new Set(takes.flatMap((t) => Object.keys(t.scores ?? {})))]
}

/** `engines`: the engines shown, in order (default: every engine with a score; an empty list shows none). */
export function summarize(takes: CompareTake[], engines?: string[]): CompareSummary {
  const shown = engines ?? scoredEngines(takes)
  const shared = takes.filter((t) => shown.length > 0 && shown.every((id) => t.scores?.[id]))
  const rows: EngineSummary[] = shown.map((id) => ({
    id,
    ...rates(shared, id),
    medianMs: msOf(shared, id),
    takes: shared.length,
    scoredTakes: takes.filter((t) => t.scores?.[id]).length,
    models: [...new Set(shared.map((t) => t.results[id]?.model).filter((m): m is string => !!m))],
    unrecorded: shared.filter((t) => !t.results[id]?.model).length,
  }))
  const byDay: DaySummary[] = [...groupByDay(shared).entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([day, list]) => {
    const perEngine = Object.fromEntries(shown.map((id) => [id, rates(list, id)]))
    const best = bestOf(shown.map((id) => ({ id, mixed: perEngine[id]!.mixed })))
    return { day, takes: list.length, engines: perEngine, ...(best ? { best } : {}) }
  })
  const best = bestOf(rows)
  return {
    takes: takes.length,
    judged: takes.filter((t) => t.reference).length,
    sharedTakes: shared.length,
    engines: rows,
    ...(best ? { best } : {}),
    byDay,
    trend: trendOf(takes, shown),
  }
}

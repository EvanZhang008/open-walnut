/**
 * Alarm evaluation, CloudWatch's way: fold the minute rows of a metric into
 * periods, compare each period with the threshold, and read ALARM when at least
 * M of the latest N periods cross it. Pure: rows in, state out.
 *
 * Periods end at the start of the current minute (that minute is still being
 * written), so a period never reads a partial minute.
 */

import type { AlarmDef, AlarmState, Comparison, MinuteRow, SeriesKind, Statistic } from './types.js'

export const MINUTE_MS = 60_000

/** Minute rows by their start, built once per tick. */
export type RowIndex = Map<number, MinuteRow>

export function indexRows(rows: readonly MinuteRow[]): RowIndex {
  const m: RowIndex = new Map()
  for (const r of rows) m.set(r.t, r)
  return m
}

/** `name{a=1,b=2}` → its parts. */
export function parseSeriesKey(key: string): { name: string; labels: Record<string, string> } {
  const i = key.indexOf('{')
  if (i < 0 || !key.endsWith('}')) return { name: key, labels: {} }
  const labels: Record<string, string> = {}
  for (const part of key.slice(i + 1, -1).split(',')) {
    const eq = part.indexOf('=')
    if (eq > 0) labels[part.slice(0, eq)] = part.slice(eq + 1)
  }
  return { name: key.slice(0, i), labels }
}

/** The canonical key (labels sorted), as metrics.ts writes it. */
export function seriesKeyOf(name: string, labels?: Record<string, string>): string {
  const ks = labels ? Object.keys(labels).sort() : []
  return ks.length ? `${name}{${ks.map((k) => `${k}=${labels![k]}`).join(',')}}` : name
}

/**
 * Does `key` match `pattern` (whose label values may be `*`)? Returns the
 * starred labels' values, or null.
 */
export function matchSeries(pattern: string, key: string): Record<string, string> | null {
  const p = parseSeriesKey(pattern)
  const k = parseSeriesKey(key)
  if (p.name !== k.name) return null
  const pk = Object.keys(p.labels)
  if (pk.length !== Object.keys(k.labels).length) return null
  const star: Record<string, string> = {}
  for (const l of pk) {
    const want = p.labels[l]
    const got = k.labels[l]
    if (got === undefined) return null
    if (want === '*') star[l] = got
    else if (want !== got) return null
  }
  return star
}

/** Put the starred labels' values into a pattern. */
export function fillPattern(pattern: string, values: Record<string, string>): string {
  const p = parseSeriesKey(pattern)
  const labels: Record<string, string> = {}
  for (const [k, v] of Object.entries(p.labels)) labels[k] = v === '*' ? (values[k] ?? '*') : v
  return seriesKeyOf(p.name, labels)
}

export function compare(value: number, cmp: Comparison, threshold: number): boolean {
  switch (cmp) {
    case '>': return value > threshold
    case '>=': return value >= threshold
    case '<': return value < threshold
    case '<=': return value <= threshold
  }
}

function fold(values: number[], stat: Statistic): number {
  switch (stat) {
    case 'sum': return values.reduce((a, b) => a + b, 0)
    case 'max': return Math.max(...values)
    case 'min': return Math.min(...values)
    case 'avg': return values.reduce((a, b) => a + b, 0) / values.length
    case 'last': return values[values.length - 1]
  }
}

/**
 * The value of each of the latest `n` periods, oldest first; null = no data.
 * A counter reads 0 for a minute whose row exists without its key; no row at
 * all (the server was down) is no data for both kinds.
 */
export function periodValues(
  index: RowIndex, key: string, kind: SeriesKind, stat: Statistic,
  periodMin: number, n: number, nowMs: number,
): Array<number | null> {
  const end = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS
  const out: Array<number | null> = []
  for (let i = n - 1; i >= 0; i--) {
    const pEnd = end - i * periodMin * MINUTE_MS
    const vals: number[] = []
    for (let t = pEnd - periodMin * MINUTE_MS; t < pEnd; t += MINUTE_MS) {
      const row = index.get(t)
      if (!row) continue
      const v = row.v[key]
      if (typeof v === 'number') vals.push(v)
      else if (kind === 'counter') vals.push(0)
    }
    out.push(vals.length ? fold(vals, stat) : null)
  }
  return out
}

export interface Evaluation {
  state: AlarmState
  /** The latest period with data. */
  value: number | null
  breaching: number
  periods: Array<number | null>
}

/** Evaluate one alarm instance on one series key. */
export function evaluateAlarm(def: AlarmDef, index: RowIndex, key: string, nowMs: number, alsoKey?: string): Evaluation {
  const periods = periodValues(index, key, def.kind, def.stat, def.periodMin, def.evaluationPeriods, nowMs)
  const alsoPeriods = def.also
    ? periodValues(index, alsoKey ?? def.also.metric, 'gauge', def.also.stat, def.periodMin, def.evaluationPeriods, nowMs)
    : null
  let breaching = 0
  let withData = 0
  periods.forEach((v, i) => {
    if (v === null) {
      if (def.missing === 'breaching') breaching++
      return
    }
    withData++
    let hit = compare(v, def.comparison, def.threshold)
    if (hit && def.also && alsoPeriods) {
      const a = alsoPeriods[i]
      hit = a !== null && compare(a, def.also.comparison, def.also.threshold)
    }
    if (hit) breaching++
  })
  const value = [...periods].reverse().find((v) => v !== null) ?? null
  if (breaching >= def.datapointsToAlarm) return { state: 'ALARM', value, breaching, periods }
  if (withData === 0 && def.missing === 'missing') return { state: 'INSUFFICIENT_DATA', value, breaching, periods }
  return { state: 'OK', value, breaching, periods }
}

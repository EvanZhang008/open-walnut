/**
 * Run every registered timeline source for a range, in parallel and each under
 * its own deadline, then merge per day (merge.ts). A source that throws or is
 * late is reported in `sources[]` with the reason and leaves its minutes out; it
 * never fails the answer. A plugin source's segments are validated and capped
 * here, so a broken plugin cannot flood the merge or put raw data in an answer.
 */

import { dayBoundsMs } from '../blocks.js'
import { shiftDateKey } from '../rollup.js'
import { workHoursLabel, workHoursToConfig, type WorkHours } from '../work-hours.js'
import { mergeDay, type DayTimeline } from './merge.js'
import { listTimelineSources, type RegisteredSource } from './registry.js'
import type { SourcedSegment, TimelineRange, TimelineSegmentInput } from './types.js'

export const TIMELINE_MAX_DAYS = 7
const SOURCE_TIMEOUT_MS = 8_000
const MAX_SEGMENTS_PER_SOURCE = 50_000
const MAX_LABEL = 120
const MAX_FLAGS = 4
const MAX_DETAIL_KEYS = 8

export const TIMELINE_PRECEDENCE =
  'For each minute the activity with the highest source priority wins: Walnut attention 100 > Mac apps 90 > sleep 70 > '
  + 'workouts 60 > calendar 50 (a plugin source 40 by default, never above 80); places say where, they never compete.'

export interface SourceReport {
  id: string
  label: string
  owner: string
  lane: string
  priority: number
  available: boolean
  note?: string
  segments: number
  ms: number
}

const toMs = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? ms : null
}

function clean(src: RegisteredSource, seg: TimelineSegmentInput, range: TimelineRange): SourcedSegment | null {
  const startMs = toMs(seg?.start)
  const endMs = toMs(seg?.end)
  if (startMs === null || endMs === null || endMs <= startMs) return null
  if (endMs <= range.startMs || startMs >= range.endMs) return null
  if (typeof seg.kind !== 'string' || !seg.kind.trim()) return null
  const confidence = seg.confidence === 'planned' || seg.confidence === 'inferred' ? seg.confidence : 'measured'
  const lane = seg.lane === 'place' || seg.lane === 'activity' ? seg.lane : src.spec.lane
  const detail: Record<string, string | number | boolean | null> = {}
  if (seg.detail && typeof seg.detail === 'object') {
    for (const [k, v] of Object.entries(seg.detail).slice(0, MAX_DETAIL_KEYS)) {
      if (v === null || typeof v === 'boolean' || typeof v === 'number') detail[k] = v
      else if (typeof v === 'string') detail[k] = v.slice(0, MAX_LABEL)
    }
  }
  const flags = Array.isArray(seg.flags) ? seg.flags.filter((f) => typeof f === 'string').slice(0, MAX_FLAGS).map((f) => f.slice(0, 200)) : []
  return {
    startMs, endMs,
    kind: seg.kind.trim().slice(0, 24),
    label: (typeof seg.label === 'string' && seg.label.trim() ? seg.label.trim() : seg.kind).slice(0, MAX_LABEL),
    confidence, lane, source: src.spec.id, priority: src.priority,
    ...(Object.keys(detail).length ? { detail } : {}),
    ...(flags.length ? { flags } : {}),
  }
}

async function runSource(src: RegisteredSource, range: TimelineRange, timeoutMs: number): Promise<{ report: SourceReport; segments: SourcedSegment[] }> {
  const started = Date.now()
  const base = { id: src.spec.id, label: src.spec.label, owner: src.owner, lane: src.spec.lane, priority: src.priority }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`did not answer within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs)
    })
    const result = await Promise.race([src.spec.segments(range), late])
    const raw = Array.isArray(result?.segments) ? result.segments : []
    const segments: SourcedSegment[] = []
    for (const seg of raw.slice(0, MAX_SEGMENTS_PER_SOURCE)) {
      const c = clean(src, seg, range)
      if (c) segments.push(c)
    }
    const coverage = result?.coverage
    const available = coverage ? coverage.available !== false : true
    const notes = [
      ...(coverage?.note ? [String(coverage.note).slice(0, 300)] : []),
      ...(raw.length > MAX_SEGMENTS_PER_SOURCE ? [`only the first ${MAX_SEGMENTS_PER_SOURCE} segments were read`] : []),
    ]
    return {
      report: { ...base, available, ...(notes.length ? { note: notes.join('. ') } : {}), segments: segments.length, ms: Date.now() - started },
      segments,
    }
  } catch (err) {
    return {
      report: { ...base, available: false, note: `failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`, segments: 0, ms: Date.now() - started },
      segments: [],
    }
  } finally {
    clearTimeout(timer)
  }
}

export interface TimelineAnswer {
  from: string
  to: string
  tz: string
  workHours: Record<string, unknown>
  precedence: string
  sources: SourceReport[]
  days: DayTimeline[]
}

export async function buildTimeline(
  from: string,
  to: string,
  opts: { workHours: WorkHours; workHoursSource: string; tz: string; nowMs?: number; sourceTimeoutMs?: number },
): Promise<TimelineAnswer> {
  const dates: string[] = []
  for (let d = from; d <= to && dates.length < TIMELINE_MAX_DAYS; d = shiftDateKey(d, 1)) dates.push(d)
  const bounds = dates.map((date) => ({ date, ...dayBoundsMs(date)! }))
  const range: TimelineRange = { from, to: dates[dates.length - 1]!, startMs: bounds[0]!.startMs, endMs: bounds[bounds.length - 1]!.endMs, tz: opts.tz }
  const runs = await Promise.all(listTimelineSources().map((src) => runSource(src, range, opts.sourceTimeoutMs ?? SOURCE_TIMEOUT_MS)))
  const all = runs.flatMap((r) => r.segments)
  const nowMs = opts.nowMs ?? Date.now()
  return {
    from, to: range.to, tz: opts.tz,
    workHours: { ...workHoursToConfig(opts.workHours), label: workHoursLabel(opts.workHours), source: opts.workHoursSource },
    precedence: TIMELINE_PRECEDENCE,
    sources: runs.map((r) => r.report),
    days: bounds.map((b) => mergeDay(b, all, { tz: opts.tz, workHours: opts.workHours, nowMs })),
  }
}

/**
 * Walnut Health looks into its own errors (2026-11-17, the user: "some error, need to self
 * resolve, worst case with an agent auto investigate; if no risk just fix, if there is an
 * issue, then show as a potential error notification").
 *
 * The existing health monitor does the work; this file only feeds it. Every minute it counts,
 * per category of Walnut Health's errors (audience.ts), the open ones that keep happening (3
 * times or more, or open for 30 minutes), and reports the count as the gauge
 * `health.errors{category=<slug>}`. The built-in alarm `health.errors` (alarms.ts) reads it:
 * one alarm instance per category, so one category is one investigation however many errors
 * it holds, and the engine's own rules apply (one fix task per instance, its daily cap, the
 * delay before a new one, `health_monitor.fix_tasks` record/start/off). The fix task's brief
 * lists the category's errors (`healthErrorEvidence`) and says what the agent may do alone (a
 * safe step that can be undone) and what goes to the person as a possible problem
 * (brief.ts `healthErrorsRules`).
 */
import { audienceOf } from './audience.js'
import { categoryFromRecoveryKey } from './humanize.js'
import type { NotificationRecord } from './store.js'
import { reportGauge } from '../health-monitor/gauges.js'
import { log } from '../../logging/index.js'

export const HEALTH_ERRORS_METRIC = 'health.errors'
/** The built-in alarm that reads it (alarms.ts). */
export const HEALTH_ERRORS_ALARM = 'health.errors'
/** An open error counts as one that keeps happening from this many occurrences... */
export const KEEPS_HAPPENING_TIMES = 3
/** ...or once it has been open this long. */
export const KEEPS_HAPPENING_MS = 30 * 60_000
/** ...and only while it was seen this recently. */
export const RECENT_MS = 60 * 60_000
const TICK_MS = 60_000
const MAX_EVIDENCE_ROWS = 8

export interface HealthErrorEvidenceRow {
  dedupKey: string
  title: string
  times: number
  firstSeen: number
  lastSeen: number
  detail?: string
}

export interface HealthErrorCategory {
  category: string
  slug: string
  rows: HealthErrorEvidenceRow[]
}

/** A category name as a label value: `Data & Sync` -> `data-sync`. */
export function categorySlug(category: string): string {
  return category.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'other'
}

/** The open Walnut Health errors that keep happening, by category. */
export function keepHappeningByCategory(records: readonly NotificationRecord[], now: number): HealthErrorCategory[] {
  const out = new Map<string, HealthErrorCategory>()
  for (const r of records) {
    // One already handed to a repair session ("Fix with agent") has its investigation.
    if (r.resolved || r.fix || audienceOf(r) !== 'health') continue
    const times = r.occurrences ?? r.count ?? 1
    const lastSeen = r.lastTimestamp ?? r.timestamp
    // Still happening: seen in the last hour. A card left open days after its one occurrence is not.
    if (now - lastSeen > RECENT_MS) continue
    if (times < KEEPS_HAPPENING_TIMES && now - r.timestamp < KEEPS_HAPPENING_MS) continue
    const category = r.category ?? categoryFromRecoveryKey(r.recoveryKey) ?? 'Other'
    const slug = categorySlug(category)
    const group = out.get(slug) ?? { category, slug, rows: [] }
    group.rows.push({
      dedupKey: r.dedupKey, title: r.title, times, firstSeen: r.timestamp, lastSeen: r.lastTimestamp ?? r.timestamp,
      ...(r.detail ?? r.body ? { detail: (r.detail ?? r.body ?? '').slice(0, 400) } : {}),
    })
    out.set(slug, group)
  }
  for (const g of out.values()) g.rows.sort((a, b) => b.lastSeen - a.lastSeen)
  return [...out.values()]
}

let latest = new Map<string, HealthErrorCategory>()
let ended = new Set<string>()

/** The brief's evidence for one category: its errors as the last count saw them. */
export function healthErrorEvidence(slug: string | undefined): string[] {
  const g = slug ? latest.get(slug) : undefined
  if (!g) return []
  const iso = (ms: number) => new Date(ms).toISOString()
  return [
    `## The errors (Settings > Walnut Health > Background errors > ${g.category})`,
    ...g.rows.slice(0, MAX_EVIDENCE_ROWS).map((r) =>
      `- ${r.title} (\`${r.dedupKey}\`): ${r.times} times, first ${iso(r.firstSeen)}, last ${iso(r.lastSeen)}${r.detail ? `. Detail: ${r.detail.replace(/\s+/g, ' ')}` : ''}`),
    ...(g.rows.length > MAX_EVIDENCE_ROWS ? [`- and ${g.rows.length - MAX_EVIDENCE_ROWS} more in the same category`] : []),
  ]
}

/** Count now and report one gauge per category (0 for a category that stopped). */
export async function reportHealthErrorGauges(now = Date.now()): Promise<HealthErrorCategory[]> {
  const { listNotifications } = await import('./store.js')
  const { feed } = await listNotifications()
  const groups = keepHappeningByCategory(feed, now)
  const next = new Map(groups.map((g) => [g.slug, g] as const))
  // A category that stopped reads 0 once (its alarm sees it end), then no data.
  for (const slug of latest.keys()) if (!next.has(slug)) reportGauge(`${HEALTH_ERRORS_METRIC}{category=${slug}}`, 0)
  for (const slug of ended) if (!next.has(slug) && !latest.has(slug)) reportGauge(`${HEALTH_ERRORS_METRIC}{category=${slug}}`, null)
  ended = new Set([...latest.keys()].filter((slug) => !next.has(slug)))
  for (const g of groups) reportGauge(`${HEALTH_ERRORS_METRIC}{category=${g.slug}}`, g.rows.length)
  latest = next
  return groups
}

let timer: ReturnType<typeof setInterval> | null = null

/** Start the minute count (server boot, the primary only). Idempotent. */
export function startHealthErrorWatch(): void {
  if (timer) return
  const tick = () => {
    void reportHealthErrorGauges().catch((err) => {
      log.obs.warn('health errors: count failed', { error: err instanceof Error ? err.message : String(err) })
    })
  }
  tick()
  timer = setInterval(tick, TICK_MS)
  timer.unref?.()
}

export function stopHealthErrorWatch(): void {
  if (timer) { clearInterval(timer); timer = null }
  latest = new Map()
  ended = new Set()
}

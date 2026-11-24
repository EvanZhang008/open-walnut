/**
 * The cloud companion's real use, counted on the Mac.
 *
 * A phone talks to the companion. The companion forwards most /api/v1 calls to the Mac, which
 * counts them as its own requests (web/v1-forward/target.ts runs them through its Express), and
 * answers the rest itself (web/v1-forward/policy.ts COMPANION_ROUTES: streams, sends, identity,
 * bytes, the paged reads of a session's transcript and history). Real use ran only on the Mac, so
 * those were never counted (2026-11-24: GET /api/v1/sessions/:id/transcript, how the phone reads a
 * chat, had no row in a week, and no watch could name it).
 *
 * The box: its recorder runs with this module as its sink instead of its own file. It counts only
 * the requests one of its own routes answered: a forwarded call has no route there and is the
 * Mac's to count (usage-watch/request-record.ts skips a request with no route). Every minute the
 * hour rows (route names and counts, no content) go over the primary relay, `server.usage.rows`,
 * at most MAX_ROWS_PER_CALL a call. A batch keeps its id until the Mac answers it, so a resend
 * after a lost answer is counted once. An older Mac answers needs-upgrade and the rows wait, at
 * most KEEP_HOURS and MAX_WAITING rows; a refusal (a 4xx) drops the batch.
 *
 * The Mac: applyCompanionUses checks each row (an /api route's name, an hour of the last week,
 * numbers only) and adds it to the hours under the route's own name, as its own requests are.
 */
import { randomUUID } from 'node:crypto'
import { log } from '../../logging/index.js'
import { emptyAgg, mergeAgg, type Agg, type UsageKind } from './agg.js'

export const MAX_ROWS_PER_CALL = 500
const MAX_WAITING = 2_000
const HOUR_MS = 3_600_000
const KEEP_HOURS = 48
const RELAY_TIMEOUT_MS = 15_000

export interface UseRow { hour: number; kind: UsageKind; name: string; agg: Agg }

// ── The box's half ──

/** Rows not yet sent, by hour and name (deltas: a later count of the same hour adds to it). */
const waiting = new Map<string, UseRow>()
/** The batch on the wire, or the one whose answer was lost: sent again as it is, under its id. */
let inflight: { id: string; rows: UseRow[] } | null = null
let flushing = false

/** The recorder's minute of rows (record.ts flushUsage), kept until the Mac takes them. */
export function noteCompanionRows(rows: readonly UseRow[], now = Date.now()): void {
  for (const r of rows) {
    if (r.kind !== 'http' || r.agg.calls <= 0) continue
    const key = `${r.hour}\t${r.name}`
    const was = waiting.get(key)
    waiting.set(key, was ? { ...was, agg: mergeAgg(was.agg, r.agg) } : { ...r, agg: { ...r.agg } })
  }
  const oldest = now - KEEP_HOURS * HOUR_MS
  for (const [key, r] of waiting) if (r.hour < oldest) waiting.delete(key)
  // Over the bound, the oldest hours go first (a Mac away for days).
  if (waiting.size > MAX_WAITING) {
    const keys = [...waiting.entries()].sort((a, b) => a[1].hour - b[1].hour).slice(0, waiting.size - MAX_WAITING).map(([k]) => k)
    for (const k of keys) waiting.delete(k)
  }
}

/** Sends the waiting rows. Returns how many the Mac took. Single-flight; never throws. */
export async function flushCompanionUses(why: string, now = Date.now()): Promise<number> {
  if (flushing) return 0
  flushing = true
  try {
    if (inflight && inflight.rows.every((r) => r.hour < now - KEEP_HOURS * HOUR_MS)) inflight = null
    if (!inflight) {
      const rows = [...waiting.values()].sort((a, b) => a.hour - b.hour).slice(0, MAX_ROWS_PER_CALL)
      if (!rows.length) return 0
      for (const r of rows) waiting.delete(`${r.hour}\t${r.name}`)
      inflight = { id: `cu-${randomUUID()}`, rows }
    }
    const batch = inflight
    const { callPrimaryControl } = await import('../../web/routes/v1-control-relay.js')
    const r = await callPrimaryControl('server.usage.rows', '__server__', { batch: batch.id, rows: batch.rows }, RELAY_TIMEOUT_MS)
    if (r.ok) { inflight = null; return batch.rows.length }
    if (r.failure.kind === 'error' && r.failure.status < 500) {
      log.web.warn('companion real use: the Mac refused a batch of rows, dropped', { rows: batch.rows.length, error: r.failure.message })
      inflight = null
    } else if (why !== 'sweep') {
      log.web.info('companion real use: the Mac did not take the rows yet', { why, kind: r.failure.kind, rows: batch.rows.length })
    }
    return 0
  } catch (err) {
    log.web.warn('companion real use: sending to the Mac failed', { why, error: err instanceof Error ? err.message : String(err) })
    return 0
  } finally {
    flushing = false
  }
}

/**
 * The box's recorder with this module as its sink, a send each minute and when the bridge to the
 * Mac connects. Cloud companion only (server.ts, beside the cards' outbox). Returns the stop.
 */
export function startCompanionUses(): { stop: () => void } {
  void import('./record.js').then(({ startUsageRecorder }) => {
    startUsageRecorder({ sink: (rows) => { noteCompanionRows(rows); void flushCompanionUses('sweep') } })
  }).catch((err) => log.web.warn('companion real use: not started', { error: err instanceof Error ? err.message : String(err) }))
  let unhook: (() => void) | null = null
  let stopped = false
  void import('../../web/ws/bridge-registry.js').then(({ addPrimaryBridgeConnectedHandler }) => {
    if (!stopped) unhook = addPrimaryBridgeConnectedHandler(() => { void flushCompanionUses('bridge-connected') })
  }).catch(() => { /* the minute's send still goes */ })
  return {
    stop: () => {
      stopped = true
      unhook?.()
      void import('./record.js').then(({ stopUsageRecorder }) => stopUsageRecorder()).catch(() => {})
    },
  }
}

/** Rows waiting and on the wire, for tests and the box's own reads. */
export function companionUsesWaiting(): { waiting: number; inflight: number } {
  return { waiting: waiting.size, inflight: inflight?.rows.length ?? 0 }
}

export function _resetCompanionUsesForTesting(): void {
  waiting.clear()
  inflight = null
  flushing = false
}

// ── The Mac's half ──

/** A route name as the recorder writes one (normalize.ts publicTemplate), under /api. */
const ROUTE_NAME_RE = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \/api\/[A-Za-z0-9_\-/:.*]{1,160}$/
const COUNTS = Object.keys(emptyAgg()).filter((k) => typeof (emptyAgg() as unknown as Record<string, unknown>)[k] === 'number') as Array<keyof Agg>
const MAPS = ['hist', 'msHist', 'codes'] as const
const MAP_KEY_RE: Record<(typeof MAPS)[number], RegExp> = { hist: /^-?\d{1,4}$/, msHist: /^-?\d{1,4}$/, codes: /^[a-z][a-z0-9_]{0,47}$/ }
const MAX_COUNT = 1e12
/** Batches already added, so a resend after a lost answer is added once. */
const appliedBatches: string[] = []
const MAX_APPLIED = 500

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_COUNT ? v : null)

/** A row as the box sent it, or null when any part of it is not one the recorder writes. */
function checkedRow(v: unknown, now: number): UseRow | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  if (r.kind !== 'http' || typeof r.name !== 'string' || !ROUTE_NAME_RE.test(r.name)) return null
  const hour = r.hour
  if (typeof hour !== 'number' || !Number.isInteger(hour) || hour % HOUR_MS !== 0 || hour < now - 8 * 24 * HOUR_MS || hour > now + HOUR_MS) return null
  if (!r.agg || typeof r.agg !== 'object') return null
  const a = r.agg as Record<string, unknown>
  const agg = emptyAgg()
  for (const k of COUNTS) {
    if (a[k] === undefined) continue
    const n = count(a[k])
    if (n === null) return null
    ;(agg as unknown as Record<string, number>)[k] = n
  }
  for (const m of MAPS) {
    const src = a[m]
    if (src === undefined) continue
    if (!src || typeof src !== 'object' || Object.keys(src).length > 200) return null
    for (const [k, val] of Object.entries(src as Record<string, unknown>)) {
      const n = count(val)
      if (!MAP_KEY_RE[m].test(k) || n === null) return null
      agg[m][k] = n
    }
  }
  return agg.calls > 0 ? { hour, kind: 'http', name: r.name, agg } : null
}

/**
 * The companion's rows, added to this Mac's hours (session-controls.ts `server.usage.rows`).
 * A row that is not one the recorder writes is refused and counted, never stored.
 */
export async function applyCompanionUses(params: { batch?: unknown; rows?: unknown }, now = Date.now()): Promise<{ added: number; refused: number; duplicate?: true }> {
  const batch = typeof params.batch === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(params.batch) ? params.batch : null
  if (!batch || !Array.isArray(params.rows) || params.rows.length > MAX_ROWS_PER_CALL) throw new CompanionUsesError(`batch is an id and rows an array of at most ${MAX_ROWS_PER_CALL}`)
  if (appliedBatches.includes(batch)) return { added: 0, refused: 0, duplicate: true }
  const rows: UseRow[] = []
  let refused = 0
  for (const v of params.rows) { const r = checkedRow(v, now); if (r) rows.push(r); else refused++ }
  const { addHours } = await import('./store.js')
  addHours(rows)
  appliedBatches.push(batch)
  if (appliedBatches.length > MAX_APPLIED) appliedBatches.splice(0, appliedBatches.length - MAX_APPLIED)
  if (refused) log.web.warn('companion real use: rows refused', { batch, refused, added: rows.length })
  return { added: rows.length, refused }
}

export class CompanionUsesError extends Error {}

export function _resetAppliedBatchesForTesting(): void {
  appliedBatches.length = 0
}

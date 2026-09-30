/**
 * One health sync call, applied in ONE SQLite transaction on the primary.
 *
 * The answer is 200 only after the transaction committed, so a 200 means the
 * phone may forget what it sent. Everything else is decided up front:
 *   413 too_large       over the per-call caps (sanitize.ts): split and resend
 *   409 store_mismatch  the phone names a store that was deleted: reset anchors
 *   200 paused          stored nothing new (deletions still apply)
 *
 * Rules (each pinned by a test):
 *   - raw rows are insert-or-ignore by HealthKit UUID, so a resent batch is a no-op;
 *   - a deleted UUID removes its row;
 *   - buckets are replaced by (metric, start, interval);
 *   - resync is mark and sweep: `begin` marks every row of the type at or after
 *     windowStart with generation G, a re-sent row clears its mark, and `end`
 *     deletes the rows still marked G. No `end`, no sweep.
 *
 * Logs carry COUNTS only. A value, a source name or a timestamp never reaches a
 * log line from here.
 */

import { bus, EventNames } from '../event-bus.js'
import type { HealthIngestedEvent } from '../event-types.js'
import { log } from '../../logging/index.js'
import { HEALTH_METRICS, isHealthCategory, metricSpec, type HealthCategory } from './catalog.js'
import {
  bumpMaterializedRev, deleteMeta, getHealthDb, getMeta, getMetaJson, setMeta, setMetaJson,
} from './db.js'
import { localDate, nightDate, sampleLastInstant, sampleNightDate } from './day-key.js'
import { markDirty, persistDirty } from './materialize.js'
import { sanitizeHealthSync, type CleanBatch, type CleanResync } from './sanitize.js'
import { isAppleDeviceSource } from './source-order.js'
import { armMissingCheck, checkSleepReady } from './sleep-ready.js'

export interface HealthSyncBody {
  accepted: number
  inserted: number
  deleted: number
  storeId: string
  paused: boolean
  rejected?: number
  unsupported?: true
  categoryDisabled?: true
  resync?: { phase: 'begin' | 'end'; generation: number | null; marked?: number; swept?: number; stale?: true }
}

export type HealthSyncOutcome =
  | { status: 200; body: HealthSyncBody }
  | { status: 409; body: { error: { code: 'store_mismatch'; message: string }; storeId: string } }
  | { status: 413; body: { error: { code: 'too_large'; message: string }; maxItems: number; maxBytes: number } }

export function enabledCategories(): Set<HealthCategory> {
  const saved = getMetaJson<unknown>('categories')
  if (!Array.isArray(saved)) return new Set(Object.values(HEALTH_METRICS).map((s) => s.category))
  return new Set(saved.filter(isHealthCategory))
}

interface Touched { nights: Set<string>; days: Set<string> }

function touchSample(t: Touched, type: string, start: number, end: number, tz: string): void {
  t.days.add(localDate(sampleLastInstant(start, end), tz))
  if (metricSpec(type)?.night) t.nights.add(sampleNightDate(start, end, tz))
}

function resyncKey(batch: CleanBatch): string {
  return `resync:${batch.kind}:${batch.type}`
}

function applyResyncBegin(batch: CleanBatch, resync: CleanResync, now: number): HealthSyncBody['resync'] {
  const db = getHealthDb()
  const table = batch.kind === 'raw' ? 'samples' : 'buckets'
  const column = batch.kind === 'raw' ? 'type' : 'metric'
  const generation = resync.generation ?? now
  const windowStart = resync.windowStart ?? 0
  const open = getMetaJson<{ generation: number }>(resyncKey(batch))
  // A new begin supersedes an unfinished one: its marks must not linger unsweepable.
  if (open) db.prepare(`UPDATE ${table} SET gen = NULL WHERE ${column} = ? AND gen = ?`).run(batch.type, open.generation)
  const marked = db.prepare(`UPDATE ${table} SET gen = ? WHERE ${column} = ? AND start_ms >= ?`)
    .run(generation, batch.type, windowStart).changes
  setMetaJson(resyncKey(batch), { generation, windowStart, startedAt: now })
  return { phase: 'begin', generation, marked }
}

function applyResyncEnd(batch: CleanBatch, resync: CleanResync, touched: Touched): HealthSyncBody['resync'] {
  const db = getHealthDb()
  const open = getMetaJson<{ generation: number }>(resyncKey(batch))
  const generation = resync.generation ?? open?.generation ?? null
  if (!open || generation !== open.generation) return { phase: 'end', generation, swept: 0, stale: true }
  if (batch.kind === 'raw') {
    const rows = db.prepare('SELECT type, start_ms, end_ms, tz FROM samples WHERE type = ? AND gen = ?')
      .all(batch.type, generation) as Array<{ type: string; start_ms: number; end_ms: number; tz: string }>
    for (const r of rows) touchSample(touched, r.type, r.start_ms, r.end_ms, r.tz)
    db.prepare('DELETE FROM samples WHERE type = ? AND gen = ?').run(batch.type, generation)
    deleteMeta(resyncKey(batch))
    return { phase: 'end', generation, swept: rows.length }
  }
  const rows = db.prepare('SELECT local_date, night_date FROM buckets WHERE metric = ? AND gen = ?')
    .all(batch.type, generation) as Array<{ local_date: string; night_date: string }>
  for (const r of rows) {
    touched.days.add(r.local_date)
    if (metricSpec(batch.type)?.night) touched.nights.add(r.night_date)
  }
  db.prepare('DELETE FROM buckets WHERE metric = ? AND gen = ?').run(batch.type, generation)
  deleteMeta(resyncKey(batch))
  return { phase: 'end', generation, swept: rows.length }
}

function applyDeletes(uuids: readonly string[], touched: Touched): number {
  const db = getHealthDb()
  const find = db.prepare('SELECT type, start_ms, end_ms, tz FROM samples WHERE uuid = ?')
  const del = db.prepare('DELETE FROM samples WHERE uuid = ?')
  let removed = 0
  for (const uuid of uuids) {
    const row = find.get(uuid) as { type: string; start_ms: number; end_ms: number; tz: string } | undefined
    if (!row) continue
    del.run(uuid)
    touchSample(touched, row.type, row.start_ms, row.end_ms, row.tz)
    removed++
  }
  return removed
}

/** Insert new raw rows; returns how many were new. Re-sent rows only clear their resync mark. */
function applySamples(batch: CleanBatch, touched: Touched, now: number): number {
  const db = getHealthDb()
  const insert = db.prepare(`INSERT OR IGNORE INTO samples
    (uuid, type, start_ms, end_ms, value, code, source_bundle, source_name, device, tz, local_date, night_date, user_entered, meta)
    VALUES (@uuid, @type, @start, @end, @value, @code, @bundle, @name, @device, @tz, @localDate, @nightDate, @userEntered, @meta)`)
  const unmark = db.prepare('UPDATE samples SET gen = NULL WHERE uuid = ? AND gen IS NOT NULL')
  const sources = new Map<string, { name: string; firstSampleMs: number; apple: boolean }>()
  let inserted = 0
  for (const s of batch.samples) {
    const at = sampleLastInstant(s.start, s.end)
    const res = insert.run({
      uuid: s.uuid, type: batch.type, start: s.start, end: s.end, value: s.value ?? null, code: s.code ?? null,
      bundle: s.source.bundleId, name: s.source.name, device: s.device ?? null, tz: s.tz,
      localDate: localDate(at, s.tz), nightDate: sampleNightDate(s.start, s.end, s.tz), userEntered: s.meta?.userEntered ? 1 : 0,
      meta: s.meta ? JSON.stringify(s.meta) : null,
    })
    if (res.changes === 1) {
      inserted++
      touchSample(touched, batch.type, s.start, s.end, s.tz)
    } else unmark.run(s.uuid)
    const src = sources.get(s.source.bundleId)
    const apple = isAppleDeviceSource(s.source.bundleId, s.device)
    if (!src) sources.set(s.source.bundleId, { name: s.source.name, firstSampleMs: s.start, apple })
    else {
      src.firstSampleMs = Math.min(src.firstSampleMs, s.start)
      src.apple ||= apple
    }
  }
  const read = db.prepare('SELECT first_sample_ms FROM sources WHERE bundle = ?')
  const upsert = db.prepare(`INSERT INTO sources (bundle, name, first_sample_ms, first_seen_ms, last_seen_ms, apple)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(bundle) DO UPDATE SET name = excluded.name,
    first_sample_ms = MIN(first_sample_ms, excluded.first_sample_ms), last_seen_ms = excluded.last_seen_ms,
    apple = MAX(apple, excluded.apple)`)
  let rankChanged = false
  for (const [bundle, src] of sources) {
    const before = read.get(bundle) as { first_sample_ms: number } | undefined
    // The earlier first sample is the tie-break between sources first seen together
    // (source-order.ts); a brand-new source goes to the top, which moves no other
    // pair, and every night it touches is dirty anyway.
    if (before && src.firstSampleMs < before.first_sample_ms) rankChanged = true
    upsert.run(bundle, src.name || bundle, src.firstSampleMs, now, now, src.apple ? 1 : 0)
  }
  // An existing source moved in the default order: every sleep night may merge differently.
  if (rankChanged && batch.type === 'sleep') bumpMaterializedRev()
  return inserted
}

function applyBuckets(batch: CleanBatch, touched: Touched): number {
  const db = getHealthDb()
  const upsert = db.prepare(`INSERT OR REPLACE INTO buckets
    (metric, start_ms, interval_sec, sum, avg, min, max, count, tz, local_date, night_date, gen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
  const night = metricSpec(batch.type)?.night === true
  for (const b of batch.buckets) {
    const day = localDate(b.start, batch.tz)
    const nightKey = nightDate(b.start + (b.intervalSec * 1000) / 2, batch.tz)
    upsert.run(batch.type, b.start, b.intervalSec, b.sum ?? null, b.avg ?? null, b.min ?? null, b.max ?? null,
      b.count ?? null, batch.tz, day, nightKey)
    touched.days.add(day)
    if (night) touched.nights.add(nightKey)
  }
  return batch.buckets.length
}

function recordUploadMeta(batch: CleanBatch, now: number): void {
  setMeta('lastUploadAt', String(now))
  if (batch.tz) setMeta('lastTz', batch.tz)
  if (batch.preferredUnits) setMetaJson('preferredUnits', batch.preferredUnits)
  if (batch.device?.installId) {
    const devices = getMetaJson<Record<string, unknown>>('devices') ?? {}
    devices[batch.device.installId] = { model: batch.device.model ?? null, os: batch.device.os ?? null, lastSeenAt: now }
    setMetaJson('devices', devices)
  }
  const earliest = Math.min(...batch.samples.map((s) => s.start), ...batch.buckets.map((b) => b.start))
  const from = Number(getMeta('backfillFrom') ?? Infinity)
  if (Number.isFinite(earliest) && earliest < from) setMeta('backfillFrom', String(earliest))
}

export function ingestHealthSync(rawBody: unknown, opts: { now?: number; extraRejected?: number } = {}): HealthSyncOutcome {
  const now = opts.now ?? Date.now()
  const clean = sanitizeHealthSync(rawBody, now)
  if (!clean.ok) {
    return { status: 413, body: { error: { code: 'too_large', message: clean.message }, maxItems: clean.maxItems, maxBytes: clean.maxBytes } }
  }
  const { batch } = clean
  const rejected = clean.rejected + (opts.extraRejected ?? 0)
  const db = getHealthDb()
  const storeId = getMeta('storeId') as string
  if (batch.storeId && batch.storeId !== storeId) {
    return {
      status: 409,
      body: { error: { code: 'store_mismatch', message: 'This health store was reset: clear the upload anchors and resync from scratch' }, storeId },
    }
  }
  const paused = getMeta('paused') === '1'
  const spec = metricSpec(batch.type)
  const categoryOff = !!spec && !enabledCategories().has(spec.category)
  const storeItems = !paused && !categoryOff && !clean.unsupported
  const touched: Touched = { nights: new Set(), days: new Set() }
  const body: HealthSyncBody = { accepted: 0, inserted: 0, deleted: 0, storeId, paused }

  db.transaction(() => {
    if (storeItems && batch.resync?.phase === 'begin') body.resync = applyResyncBegin(batch, batch.resync, now)
    if (storeItems) {
      if (batch.kind === 'raw') {
        body.inserted = applySamples(batch, touched, now)
        body.accepted = batch.samples.length
      } else {
        body.accepted = applyBuckets(batch, touched)
        body.inserted = body.accepted
      }
    }
    // Deletions apply even while paused: removing data is always what the user wants.
    body.deleted = applyDeletes(batch.deleted, touched)
    if (storeItems && batch.resync?.phase === 'end') body.resync = applyResyncEnd(batch, batch.resync, touched)
    if (storeItems) recordUploadMeta(batch, now)
    // Same transaction as the rows: a restart before the drain still knows these are stale.
    persistDirty(touched.nights, touched.days)
  })()

  if (rejected > 0) body.rejected = rejected
  if (clean.unsupported) body.unsupported = true
  if (categoryOff) body.categoryDisabled = true
  log.web.info('health sync applied', {
    kind: batch.kind, type: batch.type, accepted: body.accepted, inserted: body.inserted,
    deleted: body.deleted, rejected, paused, dates: touched.days.size,
    ...(body.resync ? { resync: body.resync.phase, swept: body.resync.swept ?? 0 } : {}),
  })

  if (touched.nights.size || touched.days.size) {
    markDirty(touched.nights, touched.days)
    const event: HealthIngestedEvent = { types: [batch.type], dates: [...touched.days].sort() }
    bus.emit(EventNames.HEALTH_INGESTED, event, [], { source: 'health' })
  }
  if (storeItems) {
    try {
      armMissingCheck(now)
      checkSleepReady(now)
    } catch (err) {
      log.web.warn('health sleep-ready check failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { status: 200, body }
}

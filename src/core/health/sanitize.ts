/**
 * POST /api/v1/health/sync body → a narrowed, validated batch.
 *
 * Runs on BOTH boxes: the replica narrows before relaying (known fields only,
 * bounded strings, so one frame can never close the shared bridge socket), and
 * the primary runs it again on what arrives. It is idempotent on its own output
 * (instants come out as epoch ms, which it also accepts).
 *
 * Junk never errors: an item that fails validation is dropped and counted in
 * `rejected`, because retrying an item that can never be accepted helps nobody.
 * The only refusal is 413 for a call over the caps, which tells the phone to
 * split the batch (it keeps the data).
 */

import {
  BUCKET_INTERVALS, HEALTH_MAX_ITEMS_PER_SYNC, HEALTH_MAX_SYNC_BYTES, SPAN_VALUE_TYPES, metricSpec,
} from './catalog.js'
import { isValidTz } from './day-key.js'

export interface HealthSource { bundleId: string; name: string }

export interface SampleMeta {
  userEntered?: true
  activity?: string
  energyKcal?: number
  distanceM?: number
  kind?: 'momentary' | 'daily'
  labels?: string[]
  associations?: string[]
}

export interface CleanSample {
  uuid: string
  start: number
  end: number
  value?: number
  code?: number
  source: HealthSource
  device?: string
  tz: string
  meta?: SampleMeta
}

export interface CleanBucket {
  start: number
  intervalSec: number
  sum?: number
  avg?: number
  min?: number
  max?: number
  count?: number
}

export interface PreferredUnits {
  temperature?: 'degC' | 'degF'
  distance?: 'km' | 'mi'
  energy?: 'kcal' | 'kJ'
}

export interface CleanResync { phase: 'begin' | 'end'; windowStart?: number; generation?: number }

export interface CleanBatch {
  storeId?: string
  device?: { installId?: string; model?: string; os?: string }
  tz: string
  kind: 'raw' | 'buckets'
  /** The type (raw) or metric (buckets) every item in this call belongs to. */
  type: string
  samples: CleanSample[]
  deleted: string[]
  buckets: CleanBucket[]
  resync?: CleanResync
  preferredUnits?: PreferredUnits
}

export type SanitizeOutcome =
  | { ok: true; batch: CleanBatch; rejected: number; unsupported?: true }
  | { ok: false; status: 413; code: 'too_large'; message: string; maxItems: number; maxBytes: number }

const UUID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
/** Oldest instant the store accepts (HealthKit shipped in 2014; older is a broken clock). */
const MIN_INSTANT = Date.UTC(2010, 0, 1)
/** How far in the future a sample may end (clock skew between phone and Mac). */
const FUTURE_SLACK_MS = 36 * 3600_000
/** Longest single sample (a long workout or an in-bed span). */
const MAX_SPAN_MS = 2 * 86_400_000

function str(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Epoch ms from an ISO-8601 string or an epoch-ms number, inside the plausible window. */
export function parseInstant(value: unknown, now: number): number | undefined {
  let ms: number | undefined
  if (typeof value === 'number') ms = Number.isFinite(value) ? Math.round(value) : undefined
  else if (typeof value === 'string' && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const parsed = Date.parse(value)
    ms = Number.isFinite(parsed) ? parsed : undefined
  }
  if (ms === undefined || ms < MIN_INSTANT || ms > now + FUTURE_SLACK_MS) return undefined
  return ms
}

function inRange(value: number, spec: { min?: number; max?: number }): boolean {
  return (spec.min === undefined || value >= spec.min) && (spec.max === undefined || value <= spec.max)
}

function shortList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.map((v) => str(v, 32)).filter((v): v is string => !!v).slice(0, 10)
  return out.length ? out : undefined
}

function cleanMeta(raw: unknown): SampleMeta | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const m = raw as Record<string, unknown>
  const out: SampleMeta = {}
  if (m.userEntered === true || m.wasUserEntered === true) out.userEntered = true
  const activity = str(m.activity, 64)
  if (activity) out.activity = activity
  const energy = num(m.energyKcal)
  if (energy !== undefined && energy >= 0 && energy <= 20_000) out.energyKcal = energy
  const distance = num(m.distanceM)
  if (distance !== undefined && distance >= 0 && distance <= 1_000_000) out.distanceM = distance
  if (m.kind === 'momentary' || m.kind === 'daily') out.kind = m.kind
  const labels = shortList(m.labels)
  if (labels) out.labels = labels
  const associations = shortList(m.associations)
  if (associations) out.associations = associations
  return Object.keys(out).length ? out : undefined
}

function cleanSample(raw: unknown, type: string, batchTz: string, now: number): CleanSample | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const s = raw as Record<string, unknown>
  const spec = metricSpec(type)
  if (!spec?.raw) return null
  const uuid = typeof s.uuid === 'string' && UUID_RE.test(s.uuid) ? s.uuid : undefined
  const start = parseInstant(s.start, now)
  const end = parseInstant(s.end, now)
  if (!uuid || start === undefined || end === undefined || end < start || end - start > MAX_SPAN_MS) return null
  const tz = isValidTz(s.tz) ? s.tz : batchTz
  if (!tz) return null
  const src = (s.source && typeof s.source === 'object' ? s.source : {}) as Record<string, unknown>
  const source: HealthSource = { bundleId: str(src.bundleId, 200) ?? 'unknown', name: str(src.name, 100) ?? '' }
  const out: CleanSample = { uuid, start, end, source, tz }
  if (type === 'sleep') {
    const code = s.code
    if (typeof code !== 'number' || !Number.isInteger(code) || code < 0 || code > 5) return null
    out.code = code
  } else {
    let value = num(s.value)
    if (value === undefined && SPAN_VALUE_TYPES.has(type)) value = (end - start) / 60_000
    if (value === undefined || !inRange(value, spec)) return null
    out.value = value
  }
  const device = str(s.device, 100)
  if (device) out.device = device
  const meta = cleanMeta(s.meta)
  if (meta) out.meta = meta
  return out
}

function cleanBucket(raw: unknown, type: string, now: number): CleanBucket | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const b = raw as Record<string, unknown>
  const spec = metricSpec(type)
  if (!spec?.buckets) return null
  const start = parseInstant(b.start, now)
  const intervalSec = num(b.intervalSec)
  if (start === undefined || intervalSec === undefined || !BUCKET_INTERVALS.has(intervalSec)) return null
  const out: CleanBucket = { start, intervalSec }
  const bounds = spec.agg === 'sum' ? { min: spec.min, max: (spec.max ?? Infinity) } : spec
  for (const key of ['sum', 'avg', 'min', 'max'] as const) {
    const v = num(b[key])
    if (v === undefined) continue
    if (!inRange(v, bounds)) return null
    out[key] = v
  }
  const count = num(b.count)
  if (count !== undefined && Number.isInteger(count) && count >= 0 && count <= 1_000_000) out.count = count
  if (out.sum === undefined && out.avg === undefined) return null
  return out
}

function cleanResync(raw: unknown, now: number): CleanResync | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  if (r.phase !== 'begin' && r.phase !== 'end') return undefined
  const out: CleanResync = { phase: r.phase }
  const windowStart = parseInstant(r.windowStart, now)
  if (windowStart !== undefined) out.windowStart = windowStart
  const gen = num(r.generation)
  if (gen !== undefined && Number.isInteger(gen) && gen > 0 && gen <= Number.MAX_SAFE_INTEGER) out.generation = gen
  return out
}

function cleanUnits(raw: unknown): PreferredUnits | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const u = raw as Record<string, unknown>
  const out: PreferredUnits = {}
  if (u.temperature === 'degC' || u.temperature === 'degF') out.temperature = u.temperature
  if (u.distance === 'km' || u.distance === 'mi') out.distance = u.distance
  if (u.energy === 'kcal' || u.energy === 'kJ') out.energy = u.energy
  return Object.keys(out).length ? out : undefined
}

export function cleanPreferredUnits(raw: unknown): PreferredUnits | undefined {
  return cleanUnits(raw)
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** Serialized size of a request body, for the 192 KB cap. */
export function serializedBytes(body: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(body ?? null), 'utf8')
  } catch {
    return Infinity
  }
}

export function sanitizeHealthSync(body: unknown, now = Date.now()): SanitizeOutcome {
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>
  const samplesIn = arr(b.samples)
  const deletedIn = arr(b.deleted)
  const bucketsIn = arr(b.buckets)
  const items = samplesIn.length + deletedIn.length + bucketsIn.length
  const bytes = serializedBytes(body)
  if (items > HEALTH_MAX_ITEMS_PER_SYNC || bytes > HEALTH_MAX_SYNC_BYTES) {
    return {
      ok: false, status: 413, code: 'too_large',
      message: `A sync call carries at most ${HEALTH_MAX_ITEMS_PER_SYNC} items and ${HEALTH_MAX_SYNC_BYTES} bytes: split the batch and send it again`,
      maxItems: HEALTH_MAX_ITEMS_PER_SYNC, maxBytes: HEALTH_MAX_SYNC_BYTES,
    }
  }
  const kind: 'raw' | 'buckets' = b.kind === 'buckets' || (b.kind !== 'raw' && bucketsIn.length > 0 && samplesIn.length === 0)
    ? 'buckets' : 'raw'
  const type = str(kind === 'buckets' ? (b.metric ?? b.type) : (b.type ?? b.metric), 40) ?? ''
  const tz = isValidTz(b.tz) ? b.tz : ''
  const spec = metricSpec(type)
  const storeId = typeof b.storeId === 'string' && ID_RE.test(b.storeId) ? b.storeId : undefined
  const dev = (b.device && typeof b.device === 'object' ? b.device : {}) as Record<string, unknown>
  const installId = typeof dev.installId === 'string' && ID_RE.test(dev.installId) ? dev.installId : undefined
  const device = { installId, model: str(dev.model, 64), os: str(dev.os, 64) }
  const hasDevice = Object.values(device).some((v) => v !== undefined)

  const deleted = [...new Set(deletedIn.filter((u): u is string => typeof u === 'string' && UUID_RE.test(u)))]
  let rejected = deletedIn.length - deleted.length
  const base: CleanBatch = {
    ...(storeId ? { storeId } : {}),
    ...(hasDevice ? { device: Object.fromEntries(Object.entries(device).filter(([, v]) => v !== undefined)) } : {}),
    tz, kind, type, samples: [], deleted, buckets: [],
  }
  const resync = cleanResync(b.resync, now)
  if (resync) base.resync = resync
  const units = cleanUnits(b.preferredUnits)
  if (units) base.preferredUnits = units

  const supported = kind === 'raw' ? spec?.raw === true : spec?.buckets === true
  if (!supported) {
    // Nothing of an unknown type can be stored. The phone gates on status.supported,
    // and must not advance its anchor for a call answered `unsupported`.
    delete base.resync
    return { ok: true, batch: base, rejected: rejected + samplesIn.length + bucketsIn.length, unsupported: true }
  }
  if (kind === 'raw') {
    const seen = new Set<string>()
    for (const item of samplesIn) {
      const clean = cleanSample(item, type, tz, now)
      if (!clean || seen.has(clean.uuid)) { rejected++; continue }
      seen.add(clean.uuid)
      base.samples.push(clean)
    }
    rejected += bucketsIn.length
  } else {
    if (!tz) rejected += bucketsIn.length
    else {
      const seen = new Set<string>()
      for (const item of bucketsIn) {
        const clean = cleanBucket(item, type, now)
        const key = clean ? `${clean.start}:${clean.intervalSec}` : ''
        if (!clean || seen.has(key)) { rejected++; continue }
        seen.add(key)
        base.buckets.push(clean)
      }
    }
    rejected += samplesIn.length
  }
  return { ok: true, batch: base, rejected }
}

/**
 * The batch as it crosses the bridge: a sample's zone is omitted when it equals the
 * batch zone (the primary's sanitize fills it back in), so narrowing can only ever
 * shrink a batch, never grow it past the frame budget.
 */
export function relayPayload(batch: CleanBatch): Record<string, unknown> {
  return {
    ...batch,
    samples: batch.samples.map(({ tz, ...rest }) => (tz === batch.tz ? rest : { ...rest, tz })),
  }
}

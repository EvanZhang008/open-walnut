/**
 * The primary's side of the companion's copy of the search index
 * (docs/plan/walnut-control-plane.md "The companion's copy of the search
 * index"; the companion's side is search-replica-store.ts).
 *
 * One round, up to three steps over POST /bridge/replica (kind 'search'):
 *   status  the setting (`search.companion_semantic`), this Mac's model and
 *           its digest; the companion answers whether its copy is on and its
 *           own digest. Off, or the digests equal: the round ends there.
 *   sync    the docs' keys and values → the keys the companion lacks. Once
 *           both sides matched, only what changed since (and the keys removed
 *           since); the whole manifest (under 1 MB for 12k docs) only when that
 *           is unknown or did not bring the companion level.
 *   put     those docs with their vectors, about 1 MB per request; the last
 *           one carries the digest, so the companion knows it is complete.
 *
 * A doc's value is its content hash and its vector state, kept in memory and
 * refreshed only for the docs a write touched (the index's change listener):
 * a round with nothing new reads no index row. The whole table is walked once
 * after boot and then hourly, in small slices, because reading a doc's hash
 * reads its body's overflow pages (3 s for 12k docs cold, in one go).
 */

import { CLOUD_MODE, WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import type { SearchIndex } from '../../lib/hybrid-search/index.js'
import type { CloudReplicaReply } from '../cloud-ingest.js'
import { refOfReplicaKey, replicaKey } from '../search/replica-refs.js'
import { DigestMap } from './search-digest.js'
import {
  companionSearchMode, manifestValue, type CompanionSearchMode, type CompanionSearchReason, type WireDoc,
} from './search-replica-wire.js'

const ROUND_MS = 2 * 60_000
const FIRST_ROUND_MS = 60_000
const CONFIG_ROUND_MS = 3_000
const FULL_SCAN_MS = 60 * 60_000
/** Rows per slice of the full walk: a cold slice reads its long bodies' overflow pages (64 rows: 72 ms worst on the real 12k-doc index). */
const SCAN_SLICE = 32
const PUT_BATCH_BYTES = 1024 * 1024
const PUT_TIMEOUT_MS = 60_000
/** A companion that does not know kind 'search' is asked again after this. */
const UNSUPPORTED_REST_MS = 30 * 60_000

export interface SearchReplicaDeps {
  /** This Mac's index, or null when it has none (search off). */
  index: () => SearchIndex | null
  /** Its semantic lane's model; null = keyword only, nothing worth copying. */
  model: () => string | null
  home: string
  mode: () => Promise<CompanionSearchMode>
  post: (payload: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<CloudReplicaReply>
  available: () => Promise<boolean>
  /** Wait between slices of a walk (the event loop's turn). */
  pause?: () => Promise<void>
}

/** What Settings shows about the companion's copy. */
export interface CompanionSearchStatus {
  mode: CompanionSearchMode
  state: 'no-companion' | 'unsupported' | 'mac-keyword-only' | 'off' | 'memory' | 'model' | 'syncing' | 'ready' | 'error'
  reason?: CompanionSearchReason
  totalMb?: number
  needMb?: number
  autoMinMb?: number
  docs?: number
  vectored?: number
  /** Docs still to send in the round in flight. */
  pending?: number
  syncedAt?: number | null
  checkedAt: number
  error?: string
}

let status: CompanionSearchStatus | null = null

export function companionSearchStatus(): CompanionSearchStatus | null {
  return status
}

const map = new DigestMap()
let mapBuiltAt = 0
let allDirty = true
const dirty = new Set<number>()
let unsupportedUntil = 0

/** The index's change listener. */
export function noteSearchDocChange(docId: number | null): void {
  if (docId === null) allDirty = true
  else dirty.add(docId)
}

const defaultPause = () => new Promise<void>((resolve) => setImmediate(resolve))

async function refreshMap(index: SearchIndex, home: string, pause: () => Promise<void>): Promise<void> {
  if (allDirty || Date.now() - mapBuiltAt >= FULL_SCAN_MS) {
    allDirty = false
    dirty.clear()
    const seen = new Set<number>()
    for (let after = 0; ;) {
      const rows = index.replica.states(after, SCAN_SLICE)
      if (rows.length === 0) break
      for (const r of rows) {
        const key = replicaKey(r.kind, r.ref, home)
        if (!key) continue
        map.set(r.id, key, manifestValue(r.hash, r.vec))
        seen.add(r.id)
      }
      after = rows[rows.length - 1]!.id
      await pause()
    }
    for (const e of map.entries()) if (!seen.has(e.id)) map.delete(e.id)
    mapBuiltAt = Date.now()
    return
  }
  if (dirty.size === 0) return
  const ids = [...dirty]
  dirty.clear()
  for (let i = 0; i < ids.length; i += SCAN_SLICE) {
    const slice = ids.slice(i, i + SCAN_SLICE)
    const found = new Set<number>()
    for (const r of index.replica.statesOf(slice)) {
      const key = replicaKey(r.kind, r.ref, home)
      if (!key) continue
      map.set(r.id, key, manifestValue(r.hash, r.vec))
      found.add(r.id)
    }
    for (const id of slice) if (!found.has(id)) map.delete(id)
    await pause()
  }
}

class StepFailed extends Error {
  constructor(readonly outcome: 'failed' | 'unsupported', message: string) { super(message) }
}

async function step(deps: SearchReplicaDeps, payload: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
  const r = await deps.post({ kind: 'search', ...payload }, timeoutMs ? { timeoutMs } : undefined)
  if (r.ok) {
    if (r.reply.ok !== true) throw new StepFailed('failed', typeof r.reply.error === 'string' ? r.reply.error : 'refused')
    return r.reply
  }
  // An older companion: the route answers 400 for an op or kind it does not know.
  if (r.error === 'unknown_op' || r.error === 'unknown_kind') throw new StepFailed('unsupported', r.error)
  throw new StepFailed(r.outcome, r.error ?? (r.status ? `HTTP ${r.status}` : r.outcome))
}

function toWire(doc: ReturnType<SearchIndex['replica']['exportDocs']>[number], key: string, value: string): WireDoc {
  return {
    k: key, h: value, title: doc.title, summary: doc.summary, note: doc.note, meta: doc.meta,
    updatedAt: doc.updatedAt, hash: doc.hash, idents: doc.idents,
    vectors: doc.vectors.map((v) => ({ s: v.seq, b: v.vec.toString('base64') })),
  }
}

function wireBytes(doc: WireDoc): number {
  let n = 200 + doc.title.length + doc.summary.length + doc.note.length + doc.meta.length + doc.k.length
  for (const t of doc.idents) n += t.length + 3
  for (const v of doc.vectors) n += v.b.length + 12
  return n
}

/** What the companion held the last time both digests matched (key → value). */
let confirmed: Map<string, string> | null = null

/** One manifest step and the puts it asks for; the last put carries the digest. */
async function sendManifest(
  deps: SearchReplicaDeps,
  index: SearchIndex,
  snapshot: Map<string, string>,
  digest: string,
  whole: boolean,
  pause: () => Promise<void>,
): Promise<{ need: number; sent: number; removed: number; inSync: boolean }> {
  let payload: Record<string, unknown>
  if (whole || !confirmed) {
    payload = { op: 'sync', entries: [...snapshot].map(([k, h]) => ({ k, h })) }
  } else {
    const was = confirmed
    const entries = [...snapshot].filter(([k, h]) => was.get(k) !== h).map(([k, h]) => ({ k, h }))
    const removes = [...was.keys()].filter((k) => !snapshot.has(k))
    payload = { op: 'sync', partial: true, entries, removes }
  }
  const synced = await step(deps, payload)
  const need = Array.isArray(synced.need) ? (synced.need as unknown[]).filter((k): k is string => typeof k === 'string') : []
  const removed = Number(synced.removed) || 0
  status = { ...status!, pending: need.length }
  let sent = 0
  let inSync = false
  let batch: WireDoc[] = []
  let bytes = 0
  const flush = async (last: boolean): Promise<void> => {
    if (batch.length === 0 && !last) return
    const r = await step(deps, { op: 'put', docs: batch, ...(last ? { digest } : {}) }, PUT_TIMEOUT_MS)
    sent += Number(r.stored) || 0
    if (last) inSync = r.inSync === true
    batch = []
    bytes = 0
    status = { ...status!, pending: Math.max(0, need.length - sent) }
  }
  for (let i = 0; i < need.length; i++) {
    const key = need[i]!
    const at = refOfReplicaKey(key, deps.home)
    const value = snapshot.get(key)
    if (!at || !value) continue
    const [doc] = index.replica.exportDocs([at])
    if (!doc) continue // removed since the manifest: the next round says so
    const wire = toWire(doc, key, value)
    const size = wireBytes(wire)
    if (batch.length > 0 && bytes + size > PUT_BATCH_BYTES) await flush(false)
    batch.push(wire)
    bytes += size
    if (i % 32 === 31) await pause()
  }
  await flush(true)
  return { need: need.length, sent, removed, inSync }
}

export type SearchReplicaRoundResult =
  | { action: 'unavailable' | 'unsupported' | 'keyword-only' | 'off' | 'in-sync' }
  | { action: 'synced'; need: number; sent: number; removed: number; inSync: boolean }
  | { action: 'failed'; error: string }

let running: Promise<SearchReplicaRoundResult> | null = null

/** One round; a round asked for while one runs shares it. Never throws. */
export function syncSearchReplica(deps: SearchReplicaDeps): Promise<SearchReplicaRoundResult> {
  if (running) return running
  running = round(deps).finally(() => { running = null })
  return running
}

async function round(deps: SearchReplicaDeps): Promise<SearchReplicaRoundResult> {
  const pause = deps.pause ?? defaultPause
  const mode = await deps.mode()
  const base = { mode, checkedAt: Date.now() }
  if (Date.now() < unsupportedUntil) return { action: 'unsupported' }
  if (!(await deps.available())) {
    status = { ...base, state: 'no-companion' }
    return { action: 'unavailable' }
  }
  const index = deps.index()
  const model = deps.model()
  if (!index || !model) {
    status = { ...base, state: 'mac-keyword-only' }
    return { action: 'keyword-only' }
  }
  try {
    await refreshMap(index, deps.home, pause)
    const reply = await step(deps, { op: 'status', mode, model, digest: map.digest })
    const info = {
      reason: reply.reason as CompanionSearchReason | undefined,
      totalMb: Number(reply.totalMb) || undefined,
      needMb: Number(reply.needMb) || undefined,
      autoMinMb: Number(reply.autoMinMb) || undefined,
      syncedAt: typeof reply.syncedAt === 'number' ? reply.syncedAt : null,
    }
    if (reply.enabled !== true) {
      const state = info.reason === 'memory' ? 'memory' : info.reason === 'model' ? 'model' : 'off'
      status = { ...base, ...info, state }
      return { action: 'off' }
    }
    const counts = { docs: Number(reply.docs) || 0, vectored: Number(reply.vectored) || 0 }
    const snapshot = new Map(map.entries().map((e) => [e.key, e.value]))
    const manifestDigest = map.digest
    if (reply.inSync === true || reply.digest === manifestDigest) {
      confirmed = snapshot
      status = { ...base, ...info, ...counts, state: 'ready' }
      return { action: 'in-sync' }
    }
    status = { ...base, ...info, ...counts, state: 'syncing' }
    // What changed since both sides last matched; the whole manifest when that
    // is unknown, or when the delta did not bring the companion level.
    let totals = { need: 0, sent: 0, removed: 0 }
    let inSync = false
    for (const whole of confirmed ? [false, true] : [true]) {
      const r = await sendManifest(deps, index, snapshot, manifestDigest, whole, pause)
      totals = { need: totals.need + r.need, sent: totals.sent + r.sent, removed: totals.removed + r.removed }
      inSync = r.inSync
      if (inSync) break
    }
    if (inSync) confirmed = snapshot
    status = {
      ...base, ...info, state: inSync ? 'ready' : 'syncing', docs: snapshot.size, pending: 0,
      ...(inSync ? { syncedAt: Date.now() } : {}),
    }
    log.memory.info('search replica: round', { entries: snapshot.size, ...totals, inSync })
    return { action: 'synced', ...totals, inSync }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    if (err instanceof StepFailed && err.outcome === 'unsupported') {
      unsupportedUntil = Date.now() + UNSUPPORTED_REST_MS
      status = { ...base, state: 'unsupported' }
      log.memory.info('search replica: the companion keeps no search copy yet (older build), asking again in 30 minutes')
      return { action: 'unsupported' }
    }
    status = { ...base, state: 'error', error }
    log.memory.warn('search replica: round failed', { error })
    return { action: 'failed', error }
  }
}

async function defaultDeps(): Promise<SearchReplicaDeps> {
  const [wiring, ingest, { getConfig }] = await Promise.all([
    import('../search/wiring.js'), import('../cloud-ingest.js'), import('../config-manager.js'),
  ])
  return {
    index: () => (wiring.isSearchV2Enabled() ? wiring.getSearchV2Index() : null),
    model: () => wiring.currentEmbedModelId(),
    home: WALNUT_HOME,
    mode: async () => companionSearchMode((await getConfig()).search?.companion_semantic),
    post: ingest.postToCloudReplica,
    available: ingest.cloudReplicaAvailable,
  }
}

/**
 * Primary only: a first round a minute after boot, one every 2 minutes, and
 * one a few seconds after the setting changes.
 */
export function startSearchReplicaSync(given?: SearchReplicaDeps): { stop: () => void } {
  if (CLOUD_MODE) return { stop: () => {} }
  let stopped = false
  let deps: SearchReplicaDeps | null = given ?? null
  let unlisten: (() => void) | null = null
  const run = (): void => {
    if (stopped) return
    void (async () => {
      deps ??= await defaultDeps()
      if (!unlisten && !given) unlisten = (await import('../search/wiring.js')).onSearchIndexDocChange(noteSearchDocChange)
      await syncSearchReplica(deps)
    })().catch((err) => log.memory.warn('search replica: round crashed', { error: err instanceof Error ? err.message : String(err) }))
  }
  const first = setTimeout(run, FIRST_ROUND_MS)
  first.unref?.()
  const every = setInterval(run, ROUND_MS)
  every.unref?.()
  let soon: ReturnType<typeof setTimeout> | null = null
  const name = 'search-replica-config'
  void import('../event-bus.js').then(({ bus }) => {
    if (stopped) return
    bus.subscribe(name, (event) => {
      // A Settings save carries the whole merged config; only a new mode is news here.
      const config = (event.data as { config?: { search?: { companion_semantic?: unknown } } } | undefined)?.config
      if (!config || soon) return
      if (companionSearchMode(config.search?.companion_semantic) === (status?.mode ?? 'auto')) return
      soon = setTimeout(() => { soon = null; run() }, CONFIG_ROUND_MS)
      soon.unref?.()
    }, { global: true, interest: ['config:changed'] })
  })
  return {
    stop: () => {
      stopped = true
      clearTimeout(first)
      clearInterval(every)
      if (soon) clearTimeout(soon)
      unlisten?.()
      void import('../event-bus.js').then(({ bus }) => bus.unsubscribe(name)).catch(() => {})
    },
  }
}

/** Tests only. */
export function _resetSearchReplicaForTesting(): void {
  map.clear()
  mapBuiltAt = 0
  allDirty = true
  dirty.clear()
  unsupportedUntil = 0
  running = null
  status = null
  confirmed = null
}

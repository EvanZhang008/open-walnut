/**
 * The primary's side of the followers' copies of the search index
 * (docs/plan/walnut-control-plane.md "The companion's copy of the search
 * index"; a follower's side is search-replica-store.ts). A follower is any
 * other Walnut server: the cloud companion, or a server on a host
 * (replica-targets.ts lists them and carries each one's requests).
 *
 * One round per follower, up to three steps over its /bridge/replica (kind
 * 'search'):
 *   status  the setting (`search.companion_semantic`), this Mac's model and
 *           its digest; the follower answers whether its copy is on and its
 *           own digest. Off, or the digests equal: the round ends there.
 *   sync    the docs' keys and values → the keys the follower lacks. Once
 *           both sides matched, only what changed since (and the keys removed
 *           since); the whole manifest (under 1 MB for 12k docs) only when that
 *           is unknown or did not bring the follower level.
 *   put     those docs with their vectors, about 1 MB per request; the last
 *           one carries the digest, so the follower knows it is complete.
 *
 * A doc's value is its content hash and its vector state, kept in memory and
 * refreshed only for the docs a write touched (the index's change listener):
 * a round with nothing new reads no index row. The whole table is walked once
 * after boot and then hourly, in small slices, because reading a doc's hash
 * reads its body's overflow pages (3 s for 12k docs cold, in one go). That map
 * is shared; what each follower last matched, its rest after an older build
 * and its status are kept per follower. Followers go one after another, so a
 * first copy (about 126 MB gzipped) is never sent to two at once.
 */

import { WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import type { SearchIndex } from '../../lib/hybrid-search/index.js'
import { isFollower, type FollowerKind } from '../server-role.js'
import type { ReplicaTarget } from './replica-targets.js'
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
/** A follower that does not know kind 'search' is asked again after this. */
const UNSUPPORTED_REST_MS = 30 * 60_000

export interface SearchReplicaDeps {
  /** This Mac's index, or null when it has none (search off). */
  index: () => SearchIndex | null
  /** Its semantic lane's model; null = keyword only, nothing worth copying. */
  model: () => string | null
  home: string
  mode: () => Promise<CompanionSearchMode>
  /** The followers to keep level, in the order Settings lists them. */
  targets: () => ReplicaTarget[]
  /** Wait between slices of a walk (the event loop's turn). */
  pause?: () => Promise<void>
}

/** What Settings shows about one follower's copy. */
export interface FollowerSearchStatus {
  id: string
  kind: FollowerKind
  label: string
  mode: CompanionSearchMode
  state: 'unavailable' | 'unsupported' | 'mac-keyword-only' | 'off' | 'memory' | 'model' | 'syncing' | 'ready' | 'error'
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

interface FollowerState {
  /** What the follower held the last time both digests matched (key → value). */
  confirmed: Map<string, string> | null
  unsupportedUntil: number
  status: FollowerSearchStatus | null
}

const followers = new Map<string, FollowerState>()

function stateOf(id: string): FollowerState {
  let s = followers.get(id)
  if (!s) {
    s = { confirmed: null, unsupportedUntil: 0, status: null }
    followers.set(id, s)
  }
  return s
}

/** Every follower's last round, for Settings; one that left the list is gone. */
export function followerSearchStatuses(targets?: ReplicaTarget[]): FollowerSearchStatus[] {
  const order = targets?.map((t) => t.id) ?? [...followers.keys()]
  const out: FollowerSearchStatus[] = []
  for (const id of order) {
    const st = followers.get(id)?.status
    if (st) out.push(st)
  }
  return out
}

const map = new DigestMap()
let mapBuiltAt = 0
let allDirty = true
const dirty = new Set<number>()

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

async function step(target: ReplicaTarget, payload: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
  const r = await target.post({ kind: 'search', ...payload }, timeoutMs ? { timeoutMs } : undefined)
  if (r.ok) {
    if (r.reply.ok !== true) throw new StepFailed('failed', typeof r.reply.error === 'string' ? r.reply.error : 'refused')
    return r.reply
  }
  // An older follower: the route answers 400 for an op or kind it does not know.
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

/** One manifest step and the puts it asks for; the last put carries the digest. */
async function sendManifest(
  deps: SearchReplicaDeps,
  target: ReplicaTarget,
  fs: FollowerState,
  index: SearchIndex,
  snapshot: Map<string, string>,
  digest: string,
  whole: boolean,
  pause: () => Promise<void>,
): Promise<{ need: number; sent: number; removed: number; inSync: boolean }> {
  let payload: Record<string, unknown>
  if (whole || !fs.confirmed) {
    payload = { op: 'sync', entries: [...snapshot].map(([k, h]) => ({ k, h })) }
  } else {
    const was = fs.confirmed
    const entries = [...snapshot].filter(([k, h]) => was.get(k) !== h).map(([k, h]) => ({ k, h }))
    const removes = [...was.keys()].filter((k) => !snapshot.has(k))
    payload = { op: 'sync', partial: true, entries, removes }
  }
  const synced = await step(target, payload)
  const need = Array.isArray(synced.need) ? (synced.need as unknown[]).filter((k): k is string => typeof k === 'string') : []
  const removed = Number(synced.removed) || 0
  fs.status = { ...fs.status!, pending: need.length }
  let sent = 0
  let inSync = false
  let batch: WireDoc[] = []
  let bytes = 0
  const flush = async (last: boolean): Promise<void> => {
    if (batch.length === 0 && !last) return
    const r = await step(target, { op: 'put', docs: batch, ...(last ? { digest } : {}) }, PUT_TIMEOUT_MS)
    sent += Number(r.stored) || 0
    if (last) inSync = r.inSync === true
    batch = []
    bytes = 0
    fs.status = { ...fs.status!, pending: Math.max(0, need.length - sent) }
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

type RoundOutcome =
  | { action: 'unavailable' | 'unsupported' | 'keyword-only' | 'off' | 'in-sync' }
  | { action: 'synced'; need: number; sent: number; removed: number; inSync: boolean }
  | { action: 'failed'; error: string }

export type SearchReplicaRoundResult = { target: string } & RoundOutcome

let running: Promise<SearchReplicaRoundResult[]> | null = null

/** One round for every follower, one after another; a round asked for while one runs shares it. Never throws. */
export function syncSearchReplica(deps: SearchReplicaDeps): Promise<SearchReplicaRoundResult[]> {
  if (running) return running
  running = roundAll(deps).finally(() => { running = null })
  return running
}

async function roundAll(deps: SearchReplicaDeps): Promise<SearchReplicaRoundResult[]> {
  const targets = deps.targets()
  // A follower that left the list (a host server removed) leaves Settings too.
  for (const id of [...followers.keys()]) if (!targets.some((t) => t.id === id)) followers.delete(id)
  const out: SearchReplicaRoundResult[] = []
  for (const target of targets) {
    try {
      out.push({ target: target.id, ...(await round(deps, target)) })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      out.push({ target: target.id, action: 'failed', error })
    }
  }
  return out
}

async function round(deps: SearchReplicaDeps, target: ReplicaTarget): Promise<RoundOutcome> {
  const pause = deps.pause ?? defaultPause
  const fs = stateOf(target.id)
  const mode = await deps.mode()
  const base = { id: target.id, kind: target.kind, label: target.label, mode, checkedAt: Date.now() }
  if (Date.now() < fs.unsupportedUntil) return { action: 'unsupported' }
  if (!(await target.available())) {
    fs.status = { ...base, state: 'unavailable' }
    return { action: 'unavailable' }
  }
  const index = deps.index()
  const model = deps.model()
  if (!index || !model) {
    fs.status = { ...base, state: 'mac-keyword-only' }
    return { action: 'keyword-only' }
  }
  try {
    // Shared by every follower; after the first one it reads only what changed meanwhile.
    await refreshMap(index, deps.home, pause)
    const reply = await step(target, { op: 'status', mode, model, digest: map.digest })
    const info = {
      reason: reply.reason as CompanionSearchReason | undefined,
      totalMb: Number(reply.totalMb) || undefined,
      needMb: Number(reply.needMb) || undefined,
      autoMinMb: Number(reply.autoMinMb) || undefined,
      syncedAt: typeof reply.syncedAt === 'number' ? reply.syncedAt : null,
    }
    if (reply.enabled !== true) {
      const state = info.reason === 'memory' ? 'memory' : info.reason === 'model' ? 'model' : 'off'
      fs.status = { ...base, ...info, state }
      return { action: 'off' }
    }
    const counts = { docs: Number(reply.docs) || 0, vectored: Number(reply.vectored) || 0 }
    const snapshot = new Map(map.entries().map((e) => [e.key, e.value]))
    const manifestDigest = map.digest
    if (reply.inSync === true || reply.digest === manifestDigest) {
      fs.confirmed = snapshot
      fs.status = { ...base, ...info, ...counts, state: 'ready' }
      return { action: 'in-sync' }
    }
    fs.status = { ...base, ...info, ...counts, state: 'syncing' }
    // What changed since both sides last matched; the whole manifest when that
    // is unknown, or when the delta did not bring the follower level.
    let totals = { need: 0, sent: 0, removed: 0 }
    let inSync = false
    for (const whole of fs.confirmed ? [false, true] : [true]) {
      const r = await sendManifest(deps, target, fs, index, snapshot, manifestDigest, whole, pause)
      totals = { need: totals.need + r.need, sent: totals.sent + r.sent, removed: totals.removed + r.removed }
      inSync = r.inSync
      if (inSync) break
    }
    if (inSync) fs.confirmed = snapshot
    fs.status = {
      ...base, ...info, state: inSync ? 'ready' : 'syncing', docs: snapshot.size, pending: 0,
      ...(inSync ? { syncedAt: Date.now() } : {}),
    }
    log.memory.info('search replica: round', { target: target.id, entries: snapshot.size, ...totals, inSync })
    return { action: 'synced', ...totals, inSync }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    if (err instanceof StepFailed && err.outcome === 'unsupported') {
      fs.unsupportedUntil = Date.now() + UNSUPPORTED_REST_MS
      fs.status = { ...base, state: 'unsupported' }
      log.memory.info('search replica: this follower keeps no search copy yet (older build), asking again in 30 minutes', { target: target.id })
      return { action: 'unsupported' }
    }
    fs.status = { ...base, state: 'error', error }
    log.memory.warn('search replica: round failed', { target: target.id, error })
    return { action: 'failed', error }
  }
}

async function defaultDeps(): Promise<SearchReplicaDeps> {
  const [wiring, targets, { getConfig }] = await Promise.all([
    import('../search/wiring.js'), import('./replica-targets.js'), import('../config-manager.js'),
  ])
  return {
    index: () => (wiring.isSearchV2Enabled() ? wiring.getSearchV2Index() : null),
    model: () => wiring.currentEmbedModelId(),
    home: WALNUT_HOME,
    mode: async () => companionSearchMode((await getConfig()).search?.companion_semantic),
    targets: targets.replicaTargets,
  }
}

/**
 * The leader only: a first round a minute after boot, one every 2 minutes,
 * one a few seconds after the setting changes or a follower joins.
 */
export function startSearchReplicaSync(given?: SearchReplicaDeps): { stop: () => void } {
  if (isFollower()) return { stop: () => {} }
  let stopped = false
  let deps: SearchReplicaDeps | null = given ?? null
  const unlisten: Array<() => void> = []
  let wired = false
  const run = (): void => {
    if (stopped) return
    void (async () => {
      deps ??= await defaultDeps()
      if (!wired && !given) {
        wired = true
        unlisten.push((await import('../search/wiring.js')).onSearchIndexDocChange(noteSearchDocChange))
        unlisten.push((await import('./replica-targets.js')).onReplicaTargetsChanged(soonRound))
      }
      await syncSearchReplica(deps)
    })().catch((err) => log.memory.warn('search replica: round crashed', { error: err instanceof Error ? err.message : String(err) }))
  }
  let soon: ReturnType<typeof setTimeout> | null = null
  function soonRound(): void {
    if (stopped || soon) return
    soon = setTimeout(() => { soon = null; run() }, CONFIG_ROUND_MS)
    soon.unref?.()
  }
  const first = setTimeout(run, FIRST_ROUND_MS)
  first.unref?.()
  const every = setInterval(run, ROUND_MS)
  every.unref?.()
  const name = 'search-replica-config'
  void import('../event-bus.js').then(({ bus }) => {
    if (stopped) return
    bus.subscribe(name, (event) => {
      // A Settings save carries the whole merged config; only a new mode is news here.
      const config = (event.data as { config?: { search?: { companion_semantic?: unknown } } } | undefined)?.config
      if (!config) return
      const next = companionSearchMode(config.search?.companion_semantic)
      const seen = followerSearchStatuses()
      if (seen.length > 0 && seen.every((s) => s.mode === next)) return
      soonRound()
    }, { global: true, interest: ['config:changed'] })
  })
  return {
    stop: () => {
      stopped = true
      clearTimeout(first)
      clearInterval(every)
      if (soon) clearTimeout(soon)
      for (const u of unlisten.splice(0)) u()
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
  followers.clear()
  running = null
}

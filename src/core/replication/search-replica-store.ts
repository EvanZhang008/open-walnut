/**
 * A follower's side of its copy of the leader's search index
 * (docs/plan/walnut-control-plane.md "The companion's copy of the search
 * index"; the leader's side is search-replica.ts, the wire is
 * search-replica-wire.ts, the route web/routes/bridge-replica.ts). A follower
 * is the cloud companion or a server on a host (core/server-role.ts).
 *
 * The leader embeds every passage once; this box takes its docs and vectors
 * as they are and only ever embeds a query, so while the Mac is away the phone
 * still runs semantic search: tasks, sessions, notes, memory and skills.
 *
 * On or off is the primary's setting (`search.companion_semantic`, sent in
 * every status step) and this box's memory (companionSearchDecision). Off, the
 * index is closed and its model stopped; nothing is sent. The copy lives in
 * cache/search-replica.sqlite and survives a restart, so only what changed
 * meanwhile comes again.
 *
 * Each copied doc carries the primary's manifest value as its stamp. A task
 * written on this box while the Mac is away is written into the copy too (by
 * keyword; its unchanged passages keep their vectors), which drops its stamp,
 * so the primary's own version replaces it once the Mac has the write.
 */

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { writeJsonFile } from '../../utils/fs.js'
import { log } from '../../logging/index.js'
import type { SearchIndex } from '../../lib/hybrid-search/index.js'
import { setCompanionSearchReady } from '../search/companion-ready.js'
import { isFollower, leaderAnswers, onLeaderPresence } from '../server-role.js'
import { refOfReplicaKey, replicaKey } from '../search/replica-refs.js'
import { DigestMap } from './search-digest.js'
import {
  AUTO_MIN_TOTAL_MB, MANIFEST_VALUE_RE, MODEL_FOOTPRINT_MB, companionSearchDecision, companionSearchMode, wireDocOf,
  type CompanionSearchMode, type CompanionSearchReason,
} from './search-replica-wire.js'
import type { ReplicaStepResult } from './task-replica-store.js'

const STATE_FILE = () => path.join(WALNUT_HOME, 'cache', 'search-replica.json')
/** From this many docs on, a manifest that would remove more than half of them is refused. */
const MASS_REMOVE_FLOOR = 200
const SCAN_SLICE = 500
/** While the Mac is away, the query worker is kept loaded: re-warmed this often (its idle reap is 10 min). */
const WARM_EVERY_MS = 4 * 60_000
const TICK_MS = 30_000

interface State {
  v: 1
  mode: CompanionSearchMode | null
  /** Last time this copy matched the primary's index (ms epoch). */
  syncedAt: number | null
}

export interface SearchReplicaStoreDeps {
  totalMb: () => number
  /** The Mac does not answer right now (default: the follower's leader presence). */
  macAway: () => Promise<boolean>
  /** This box's embedding model id (default: the wiring's); the copy is on only when it equals the primary's. */
  model?: () => string | null
}

const defaultMacAway = async (): Promise<boolean> => !leaderAnswers()

let deps: SearchReplicaStoreDeps = {
  totalMb: () => Math.round(os.totalmem() / (1024 * 1024)),
  macAway: defaultMacAway,
}

let state: State | null = null
let enabled = false
let reason: CompanionSearchReason = 'off'
const map = new DigestMap()
let mapBuilt = false
let allDirty = true
const dirty = new Set<number>()
let unlisten: (() => void) | null = null
let lastWarmAt = 0
let warmedOnce = false

async function wiring() {
  return import('../search/wiring.js')
}

async function loadState(): Promise<State> {
  if (state) return state
  let s: State = { v: 1, mode: null, syncedAt: null }
  try {
    const raw = JSON.parse(await fsp.readFile(STATE_FILE(), 'utf8')) as Partial<State>
    if (raw && raw.v === 1) {
      s = { v: 1, mode: raw.mode ? companionSearchMode(raw.mode) : null, syncedAt: typeof raw.syncedAt === 'number' ? raw.syncedAt : null }
    }
  } catch { /* none yet: off until the primary says */ }
  state = s
  return s
}

async function saveState(): Promise<void> {
  if (state) await writeJsonFile(STATE_FILE(), state)
}

let chain: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.catch(() => {})
  return run
}

const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

/** The copy's stamps, current: a full pass after open, then only the docs a write touched. */
async function refreshMap(index: SearchIndex): Promise<void> {
  if (allDirty || !mapBuilt) {
    allDirty = false
    dirty.clear()
    map.clear()
    for (let after = 0; ;) {
      const rows = index.replica.tags(after, SCAN_SLICE)
      if (rows.length === 0) break
      for (const r of rows) {
        const key = replicaKey(r.kind, r.ref, WALNUT_HOME)
        if (key) map.set(r.id, key, r.tag)
      }
      after = rows[rows.length - 1]!.id
      await yieldLoop()
    }
    mapBuilt = true
    return
  }
  if (dirty.size === 0) return
  const ids = [...dirty]
  dirty.clear()
  for (let i = 0; i < ids.length; i += SCAN_SLICE) {
    const slice = ids.slice(i, i + SCAN_SLICE)
    const found = new Set<number>()
    for (const r of index.replica.tagsOf(slice)) {
      const key = replicaKey(r.kind, r.ref, WALNUT_HOME)
      if (!key) continue
      map.set(r.id, key, r.tag)
      found.add(r.id)
    }
    for (const id of slice) if (!found.has(id)) map.delete(id)
  }
}

async function openIndex(): Promise<SearchIndex> {
  const w = await wiring()
  if (!unlisten) {
    unlisten = w.onSearchIndexDocChange((id) => {
      if (id === null) allDirty = true
      else dirty.add(id)
    })
  }
  if (!w.searchV2IndexOpen()) { allDirty = true; mapBuilt = false }
  return w.getSearchV2Index()
}

async function closeIndex(): Promise<void> {
  const w = await wiring()
  if (w.searchV2IndexOpen()) {
    await w.closeSearchV2Index()
    log.memory.info('search replica: copy closed, model stopped', { reason })
  }
  map.clear()
  mapBuilt = false
  allDirty = true
}

function publishReady(): void {
  const ready = enabled && mapBuilt && map.size > 0 && state?.syncedAt != null
  setCompanionSearchReady(ready, ready ? state!.syncedAt : null)
}

async function markInSync(): Promise<void> {
  const s = await loadState()
  const first = s.syncedAt === null
  s.syncedAt = Date.now()
  await saveState()
  publishReady()
  if (first) log.memory.info('search replica: the copy matches the primary', { docs: map.size })
  // Fetch and load the model once now, so the first search with the Mac away
  // does not wait for a 600 MB download.
  if (!warmedOnce) {
    warmedOnce = true
    void warm('first sync')
  }
}

async function warm(why: string): Promise<void> {
  lastWarmAt = Date.now()
  try {
    const w = await wiring()
    if (!w.searchV2IndexOpen()) return
    const started = Date.now()
    const ok = await w.getSearchV2Index().warmQueryWorker()
    log.memory.info('search replica: query worker warmed', { why, ok, ms: Date.now() - started })
  } catch (err) {
    log.memory.warn('search replica: warm failed', { why, error: err instanceof Error ? err.message : String(err) })
  }
}

/** The status step: the primary's setting and digest in, this box's decision and digest out. */
export function searchReplicaStatus(body: Record<string, unknown>): Promise<ReplicaStepResult> {
  return serial(async () => {
    if (!isFollower()) return { ok: false, status: 400, error: 'not_a_replica' }
    const s = await loadState()
    const mode = companionSearchMode(body.mode)
    if (s.mode !== mode) { s.mode = mode; await saveState() }
    const totalMb = deps.totalMb()
    const w = await wiring()
    const model = deps.model ? deps.model() : w.currentEmbedModelId()
    let decision = companionSearchDecision(mode, totalMb)
    if (decision.enabled && (typeof body.model !== 'string' || body.model !== model)) {
      decision = { enabled: false, reason: 'model' }
    }
    const was = enabled
    enabled = decision.enabled
    reason = decision.reason
    if (!enabled) {
      await closeIndex()
      publishReady()
      if (was) log.memory.info('search replica: off', { reason, totalMb })
      return { ok: true, enabled: false, reason, totalMb, needMb: MODEL_FOOTPRINT_MB, autoMinMb: AUTO_MIN_TOTAL_MB, model, digest: null, inSync: false, syncedAt: s.syncedAt }
    }
    const index = await openIndex()
    await refreshMap(index)
    const inSync = typeof body.digest === 'string' && body.digest === map.digest
    if (inSync) await markInSync()
    else publishReady()
    if (!was) log.memory.info('search replica: on', { reason, totalMb, docs: map.size })
    return {
      ok: true, enabled: true, reason, totalMb, needMb: MODEL_FOOTPRINT_MB, autoMinMb: AUTO_MIN_TOTAL_MB, model,
      digest: map.digest, inSync, syncedAt: s.syncedAt,
      // From the stamps, not a COUNT over doc_vec (a walk of ~100 MB of pages).
      docs: map.size, vectored: map.countValues((v) => !v.endsWith('n')),
    }
  })
}

/**
 * The manifest step: the keys this copy lacks or holds at another value.
 * Whole (`partial` absent): stamped docs it no longer names go. Partial: only
 * the entries that changed since the last time both sides matched, and the
 * keys removed since (`removes`).
 */
export function searchReplicaSync(body: Record<string, unknown>): Promise<ReplicaStepResult> {
  return serial(async () => {
    if (!isFollower()) return { ok: false, status: 400, error: 'not_a_replica' }
    if (!enabled) return { ok: false, status: 400, error: 'search_copy_off' }
    if (!Array.isArray(body.entries)) return { ok: false, status: 400, error: 'bad_entries' }
    const partial = body.partial === true
    const wanted = new Map<string, string>()
    for (const e of body.entries) {
      const k = (e as { k?: unknown })?.k
      const h = (e as { h?: unknown })?.h
      if (typeof k !== 'string' || !k || typeof h !== 'string' || !MANIFEST_VALUE_RE.test(h)) {
        return { ok: false, status: 400, error: 'bad_entries' }
      }
      wanted.set(k, h)
    }
    const removes = partial && Array.isArray(body.removes)
      ? new Set(body.removes.filter((k): k is string => typeof k === 'string' && k.length > 0))
      : null
    const index = await openIndex()
    await refreshMap(index)
    const need: string[] = []
    for (const [k, h] of wanted) if (map.valueOfKey(k) !== h) need.push(k)
    const remove = partial
      ? map.entries().filter((e) => removes?.has(e.key) && !wanted.has(e.key))
      : map.entries().filter((e) => !wanted.has(e.key))
    // A primary whose index was emptied (a damaged file, a rebuild in its first
    // seconds) must not empty this copy, which may be the only one that works.
    if (map.size >= MASS_REMOVE_FLOOR && remove.length * 2 > map.size) {
      log.memory.warn('search replica: refused a manifest that removes most docs', { entries: wanted.size, local: map.size, removing: remove.length })
      return { ok: false, status: 400, error: 'manifest_removes_most_docs' }
    }
    let removed = 0
    for (const e of remove) {
      const at = refOfReplicaKey(e.key, WALNUT_HOME)
      if (at && index.remove(at.kind, at.ref)) removed++
      if (removed % 200 === 199) await yieldLoop()
    }
    if (removed > 0) void forgetSearchMemo()
    if (need.length > 0 || removed > 0) {
      log.memory.info('search replica: manifest', { entries: wanted.size, partial, need: need.length, removed })
    }
    return { ok: true, need, removed }
  })
}

/** The search memo (core/search.ts) holds answers for 20 s; a changed copy must not be hidden behind it. */
async function forgetSearchMemo(): Promise<void> {
  try {
    const { clearSearchResultCache } = await import('../search.js')
    clearSearchResultCache()
  } catch { /* the memo expires on its own */ }
}

/** The bodies step: docs as the primary has them, vectors included. */
export function searchReplicaPut(body: Record<string, unknown>): Promise<ReplicaStepResult> {
  return serial(async () => {
    if (!isFollower()) return { ok: false, status: 400, error: 'not_a_replica' }
    if (!enabled) return { ok: false, status: 400, error: 'search_copy_off' }
    if (!Array.isArray(body.docs)) return { ok: false, status: 400, error: 'bad_docs' }
    const docs = []
    let skipped = 0
    for (const raw of body.docs) {
      const d = wireDocOf(raw)
      const at = d ? refOfReplicaKey(d.k, WALNUT_HOME) : null
      if (!d || !at) { skipped++; continue }
      docs.push({
        kind: at.kind, ref: at.ref, title: d.title, summary: d.summary, note: d.note, meta: d.meta,
        updatedAt: d.updatedAt, hash: d.hash, idents: d.idents, tag: d.h,
        vectors: d.vectors.map((v) => ({ seq: v.s, vec: Buffer.from(v.b, 'base64') })),
      })
    }
    const index = await openIndex()
    const r = docs.length > 0 ? index.replica.importDocs(docs) : { stored: 0, keptVectors: 0 }
    if (r.stored > 0) void forgetSearchMemo()
    let inSync = false
    if (typeof body.digest === 'string') {
      await refreshMap(index)
      inSync = body.digest === map.digest
      if (inSync) await markInSync()
    }
    return { ok: true, stored: r.stored, keptVectors: r.keptVectors, skipped, inSync }
  })
}

// ── this box's own task writes, while the copy is on ──

/**
 * Only while the Mac is away: while it answers, its own rounds bring every
 * change (this box's writes reach it first), and a local write here would only
 * drop a stamp and cost the next round a whole manifest.
 */
async function syncLocalTasks(ids: string[]): Promise<void> {
  const w = await wiring()
  if (!enabled || !w.searchV2IndexOpen() || !(await deps.macAway())) return
  const [{ listTasks }, { taskToDoc }] = await Promise.all([import('../task-manager.js'), import('../search/serializers.js')])
  const wanted = new Set(ids)
  const byId = new Map((await listTasks()).filter((t) => wanted.has(t.id)).map((t) => [t.id, t]))
  const index = w.getSearchV2Index()
  for (const id of ids) {
    const task = byId.get(id)
    const doc = task ? taskToDoc(task) : null
    if (doc) index.upsert(doc)
    else index.remove('task', id)
  }
  void forgetSearchMemo()
}

/**
 * A follower only: answer the steps, keep the copy current for this box's own
 * task writes, keep the model loaded while the Mac is away (loaded at once when
 * the leader stops answering), and give it back under memory pressure. Returns
 * the stop.
 */
export function startSearchReplicaStore(options: Partial<SearchReplicaStoreDeps> = {}): { stop: () => Promise<void> } {
  if (!isFollower()) return { stop: async () => {} }
  deps = { ...deps, ...options }
  let stopped = false
  const name = 'search-replica-local-tasks'
  const unsubs: Array<() => void> = []
  // A restart opens the copy at once when it was on, so semantic search
  // answers before the primary's next round (if the Mac is away, there is none).
  void (async () => {
    const s = await loadState()
    if (!s.mode || stopped) return
    const decision = companionSearchDecision(s.mode, deps.totalMb())
    if (!decision.enabled) return
    await serial(async () => {
      enabled = true
      reason = decision.reason
      await refreshMap(await openIndex())
      publishReady()
    })
  })().catch((err) => log.memory.warn('search replica: reopen failed', { error: err instanceof Error ? err.message : String(err) }))

  void Promise.all([import('../search/incremental-queue.js'), import('../event-bus.js'), import('./task-replica-store.js'), import('../memory-pressure.js')])
    .then(([{ createIncrementalQueue }, { bus }, { TASK_REPLICA_SOURCE }, mp]) => {
      if (stopped) return
      const queue = createIncrementalQueue({ debounceMs: 2_000, dispatch: syncLocalTasks })
      unsubs.push(() => { void queue.stop() })
      bus.subscribe(name, (event) => {
        if (!enabled || event.source === TASK_REPLICA_SOURCE) return
        const data = event.data as { task?: { id?: unknown } | null; taskIds?: unknown } | undefined
        const ids = typeof data?.task?.id === 'string' ? [data.task.id]
          : Array.isArray(data?.taskIds) ? data.taskIds.filter((v): v is string => typeof v === 'string') : []
        for (const id of ids) queue.enqueue(id, event.name === 'task:deleted' ? 'delete' : 'sync')
      }, { global: true, interest: ['task:created', 'task:updated', 'task:completed', 'task:deleted'] })
      unsubs.push(() => bus.unsubscribe(name))
      unsubs.push(mp.onMemoryPressureChange((shedding, level) => {
        void wiring().then((w) => {
          if (!w.searchV2IndexOpen()) return
          const index = w.getSearchV2Index()
          if (shedding) {
            void index.suspendEmbedder().then(() => log.memory.warn('search replica: model released under memory pressure', { level }))
          } else {
            index.resumeEmbedder()
          }
        })
      }))
    })
    .catch((err) => log.memory.warn('search replica: local writes not wired', { error: err instanceof Error ? err.message : String(err) }))

  // The leader just stopped answering: the next search is this copy's, so load the model now.
  unsubs.push(onLeaderPresence((answers) => {
    if (stopped || answers || !enabled || state?.syncedAt == null) return
    void warm('leader away')
  }))

  const tick = setInterval(() => {
    void (async () => {
      if (stopped || !enabled || state?.syncedAt == null) return
      if (Date.now() - lastWarmAt < WARM_EVERY_MS) return
      if (!(await deps.macAway())) return
      await warm('mac away')
    })().catch(() => {})
  }, TICK_MS)
  tick.unref?.()

  return {
    stop: async () => {
      stopped = true
      clearInterval(tick)
      for (const u of unsubs.splice(0)) u()
      unlisten?.()
      unlisten = null
    },
  }
}

/** Tests only. */
export function _resetSearchReplicaStoreForTesting(overrides: Partial<SearchReplicaStoreDeps> = {}): void {
  state = null
  enabled = false
  reason = 'off'
  map.clear()
  mapBuilt = false
  allDirty = true
  dirty.clear()
  unlisten?.()
  unlisten = null
  lastWarmAt = 0
  warmedOnce = false
  chain = Promise.resolve()
  deps = { totalMb: () => Math.round(os.totalmem() / (1024 * 1024)), macAway: defaultMacAway, ...overrides }
  setCompanionSearchReady(false, null)
}

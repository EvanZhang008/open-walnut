/**
 * The companion's side of its copy of the primary's task store
 * (docs/plan/walnut-control-plane.md "The companion's copy of the tasks"; the
 * primary's side is task-replica.ts, the route is web/routes/bridge-replica.ts).
 *
 * The primary sends a manifest (every task id with the sha256-12 of its row, in
 * store order); this side answers the ids it lacks or holds at another hash,
 * removes the rows the manifest no longer names, and takes the rows it asked
 * for as they are. The result is the primary's rows exactly: every field,
 * every task (no retention window, no slim projection), and its order. The
 * registry (projects, folders, custom tiers) rides beside it as one document.
 *
 * A row this box changed itself is HELD: neither replaced nor removed while
 * its write waits for the primary (a queued op, a delete tombstone, or a write
 * here in the last 30 seconds whose relay may still be in flight). The primary's
 * own row comes back once it has applied the write, and the held count tells
 * the primary to send the manifest again next round.
 *
 * What this box holds is kept in cache/task-replica.json (the hash of each row
 * as the primary sent it, the manifest order, the primary's clock), so a
 * restart does not ask for every row again.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { CLOUD_MODE, WALNUT_HOME } from '../../constants.js'
import { writeJsonFile } from '../../utils/fs.js'
import { log } from '../../logging/index.js'
import type { Task } from '../types.js'
import type { TaskReplicaRegistry } from '../task-manager.js'

export const TASK_REPLICA_SOURCE = 'task-replica'
const STATE_FILE = () => path.join(WALNUT_HOME, 'cache', 'task-replica.json')
/** A write made here holds its row this long: its relay to the primary takes ~100ms and gives up at 20s
 *  (task-queue.ts), after which a queued op holds it instead. */
const LOCAL_WRITE_HOLD_MS = 30_000
/** While the primary sent a manifest this recently, its projection is not imported into the store. */
const FRESH_MS = 15 * 60_000
/** From this many rows on, a manifest that would remove more than half of them is refused. */
const MASS_REMOVE_FLOOR = 50

export function sha12(body: string): string {
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 12)
}

interface State {
  v: 1
  /** The primary's clock when it built the last manifest. */
  asOf: number
  /** This box's clock when that manifest arrived. */
  at: number
  order: string[]
  hashes: Record<string, string>
  registry: string | null
}

let state: State | null = null
let loading: Promise<State> | null = null
const localWrites = new Map<string, number>()

function load(): Promise<State> {
  if (state) return Promise.resolve(state)
  loading ??= (async () => {
    let s: State = { v: 1, asOf: 0, at: 0, order: [], hashes: {}, registry: null }
    try {
      const raw = JSON.parse(await fsp.readFile(STATE_FILE(), 'utf8')) as Partial<State>
      if (raw && raw.v === 1 && raw.hashes && typeof raw.hashes === 'object') {
        s = { v: 1, asOf: Number(raw.asOf) || 0, at: Number(raw.at) || 0, order: Array.isArray(raw.order) ? raw.order.map(String) : [], hashes: raw.hashes, registry: typeof raw.registry === 'string' ? raw.registry : null }
      }
    } catch { /* none yet, or unreadable: start empty and ask for every row */ }
    state = s
    loading = null
    return s
  })()
  return loading
}

async function save(): Promise<void> {
  if (state) await writeJsonFile(STATE_FILE(), state)
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
/** A burst of writes here persists once. */
function saveSoon(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => { saveTimer = null; void serial(save).catch(() => {}) }, 1_000)
  saveTimer.unref?.()
}

let chain: Promise<unknown> = Promise.resolve()
/** One replica step at a time: a put must never interleave with the sync it answers. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.catch(() => {})
  return run
}

/** Rows this box wrote itself and the primary may not have yet. */
async function heldIds(): Promise<{ has: (id: string) => boolean }> {
  const tq = await import('../task-queue.js')
  const queued = new Set<string>()
  for (const op of await tq.listQueuedOps()) {
    if (op.type === 'delete') queued.add(op.id)
    else if (op.type === 'create' || op.type === 'update') queued.add(op.task.id)
  }
  const now = Date.now()
  return {
    has: (id) => queued.has(id) || tq.hasDeleteTombstone(id) || now - (localWrites.get(id) ?? 0) < LOCAL_WRITE_HOLD_MS,
  }
}

/** A task write on this box that did not come from the primary's copy. */
export function noteLocalTaskWrite(id: string): void {
  localWrites.set(id, Date.now())
  // The row no longer is the primary's: the next manifest asks for it again,
  // also after a restart before the primary's next round.
  void load().then((s) => {
    if (!(id in s.hashes)) return
    delete s.hashes[id]
    saveSoon()
  }).catch(() => {})
  if (localWrites.size > 2_000) {
    const cutoff = Date.now() - LOCAL_WRITE_HOLD_MS
    for (const [k, at] of localWrites) if (at < cutoff) localWrites.delete(k)
  }
}

export interface ManifestEntry { k: string; h: string }

function entriesOf(raw: unknown): ManifestEntry[] | null {
  if (!Array.isArray(raw)) return null
  const out: ManifestEntry[] = []
  for (const e of raw) {
    const k = (e as { k?: unknown })?.k
    const h = (e as { h?: unknown })?.h
    if (typeof k !== 'string' || !k || typeof h !== 'string' || !/^[0-9a-f]{12}$/.test(h)) return null
    out.push({ k, h })
  }
  return out
}

/** The rows both lists name are in the same order (rows only one names are not an order change). */
function sameOrder(local: readonly string[], manifest: readonly string[]): boolean {
  const have = new Set(local)
  const want = new Set(manifest)
  const a = local.filter((id) => want.has(id))
  const b = manifest.filter((id) => have.has(id))
  return a.length === b.length && a.every((id, i) => id === b[i])
}

function changed(): void {
  void import('../event-bus.js').then(({ bus, EventNames }) => {
    bus.emit(EventNames.TASK_UPDATED, { task: null }, ['web-ui'], { source: TASK_REPLICA_SOURCE })
  }).catch(() => {})
}

export type ReplicaStepResult = { ok: true; [k: string]: unknown } | { ok: false; status: 400; error: string }

/** The manifest step. */
export function replicaSync(body: { kind?: unknown; entries?: unknown; asOf?: unknown }): Promise<ReplicaStepResult> {
  return serial(async () => {
    if (!CLOUD_MODE) return { ok: false, status: 400, error: 'not_a_replica' }
    const entries = entriesOf(body.entries)
    if (!entries) return { ok: false, status: 400, error: 'bad_entries' }
    const s = await load()
    if (body.kind === 'registry') {
      const h = entries.find((e) => e.k === 'registry')?.h
      return { ok: true, need: h && h !== s.registry ? ['registry'] : [], held: 0 }
    }
    if (body.kind !== 'tasks') return { ok: false, status: 400, error: 'unknown_kind' }
    const tm = await import('../task-manager.js')
    const tq = await import('../task-queue.js')
    const held = await heldIds()
    const local = (await tm.taskStoreForReplica()).tasks.map((t) => t.id)
    const localSet = new Set(local)
    const wanted = new Set(entries.map((e) => e.k))
    const need: string[] = []
    let heldCount = 0
    for (const e of entries) {
      if (held.has(e.k)) { if (s.hashes[e.k] !== e.h || !localSet.has(e.k)) heldCount++; continue }
      if (!localSet.has(e.k) || s.hashes[e.k] !== e.h) need.push(e.k)
    }
    const removeIds: string[] = []
    for (const id of local) {
      if (wanted.has(id)) continue
      if (held.has(id)) { heldCount++; continue }
      removeIds.push(id)
    }
    // A primary that lost its store (an empty or damaged database at boot) must
    // not empty this one, which may then be the only copy left.
    if (local.length >= MASS_REMOVE_FLOOR && removeIds.length * 2 > local.length) {
      log.task.warn('task replica: refused a manifest that removes most rows', { entries: entries.length, local: local.length, removing: removeIds.length })
      return { ok: false, status: 400, error: 'manifest_removes_most_rows' }
    }
    const order = entries.map((e) => e.k)
    const reorder = !tq.hasRecentOrderOp() && !sameOrder(local, order)
    if (removeIds.length > 0 || reorder) {
      await tm.applyTaskReplica({ removeIds, ...(reorder ? { order } : {}) })
      changed()
    }
    for (const id of removeIds) delete s.hashes[id]
    s.order = order
    s.asOf = Number(body.asOf) || Date.now()
    s.at = Date.now()
    await save()
    if (removeIds.length > 0 || need.length > 0) {
      log.task.info('task replica: manifest', { entries: entries.length, need: need.length, held: heldCount, removed: removeIds.length, reordered: reorder })
    }
    return { ok: true, need, held: heldCount, removed: removeIds.length }
  })
}

function isRow(v: unknown): v is Task {
  const t = v as Partial<Task> | null
  return !!t && typeof t === 'object' && typeof t.id === 'string' && !!t.id && typeof t.title === 'string'
}

function isRegistry(v: unknown): v is TaskReplicaRegistry {
  const r = v as Partial<TaskReplicaRegistry> | null
  return !!r && typeof r === 'object' && !!r.projects && typeof r.projects === 'object'
    && !!r.task_groups && typeof r.task_groups === 'object' && Array.isArray(r.custom_tiers)
}

/**
 * The bodies step: rows the manifest step asked for, or the registry. New rows
 * go after the others until the round's `last` batch, which takes the
 * manifest's order: reordering on every batch would rewrite the whole store
 * per batch on a first copy.
 */
export function replicaPut(body: { kind?: unknown; rows?: unknown; registry?: unknown; last?: unknown }): Promise<ReplicaStepResult> {
  return serial(async () => {
    if (!CLOUD_MODE) return { ok: false, status: 400, error: 'not_a_replica' }
    const tm = await import('../task-manager.js')
    const s = await load()
    if (body.kind === 'registry') {
      if (!isRegistry(body.registry)) return { ok: false, status: 400, error: 'bad_registry' }
      await tm.applyTaskReplica({ registry: body.registry })
      s.registry = sha12(JSON.stringify(body.registry))
      await save()
      void import('../event-bus.js').then(({ bus, EventNames }) => {
        bus.emit(EventNames.TASK_GROUPS_CHANGED, {}, ['web-ui'], { source: TASK_REPLICA_SOURCE })
        bus.emit(EventNames.CONFIG_CHANGED, { key: 'focus_tiers' }, ['web-ui'], { source: TASK_REPLICA_SOURCE })
      }).catch(() => {})
      return { ok: true, stored: 1, held: 0 }
    }
    if (body.kind !== 'tasks') return { ok: false, status: 400, error: 'unknown_kind' }
    if (!Array.isArray(body.rows) || !body.rows.every(isRow)) return { ok: false, status: 400, error: 'bad_rows' }
    const held = await heldIds()
    const rows = (body.rows as Task[]).filter((r) => !held.has(r.id))
    const tq = await import('../task-queue.js')
    let order: string[] | undefined
    if (body.last === true && !tq.hasRecentOrderOp()) {
      // The order this batch would leave: rows already here keep their place, new ones go last.
      const ids = (await tm.taskStoreForReplica()).tasks.map((t) => t.id)
      const here = new Set(ids)
      if (!sameOrder([...ids, ...rows.map((r) => r.id).filter((id) => !here.has(id))], s.order)) order = s.order
    }
    let stored = 0
    if (rows.length > 0 || order) {
      const { skipped } = await tm.applyTaskReplica({ rows, ...(order ? { order } : {}) })
      const refused = new Set(skipped)
      for (const r of rows) {
        if (refused.has(r.id)) continue // not stored: asked for again next round
        s.hashes[r.id] = sha12(JSON.stringify(r))
        stored++
      }
      await save()
      changed()
    }
    // A refused row counts as held: the primary sends the manifest again.
    return { ok: true, stored, held: body.rows.length - stored }
  })
}

/**
 * Whether the primary's copy makes its projection redundant here: it sent a
 * manifest in the last 15 minutes, or this projection is no newer than the
 * last manifest (both clocks are the primary's). An older primary that sends
 * projections only is imported as before.
 */
export async function taskReplicaSupersedes(projectionExportedAt: string | undefined): Promise<boolean> {
  const s = await load()
  if (!s.asOf) return false
  if (Date.now() - s.at < FRESH_MS) return true
  const at = Date.parse(projectionExportedAt ?? '')
  return !Number.isFinite(at) || at <= s.asOf
}

/** Whether this row is the primary's own, as its last round sent it (no write here since). */
export async function taskReplicaHoldsRow(id: string): Promise<boolean> {
  if (!CLOUD_MODE) return false
  return typeof (await load()).hashes[id] === 'string'
}

/**
 * Companion only: every task write on this box that is not the primary's copy
 * holds its row (noteLocalTaskWrite). Returns the stop.
 */
export function startTaskReplicaLocalWrites(): { stop: () => void } {
  if (!CLOUD_MODE) return { stop: () => {} }
  const name = 'task-replica-local-writes'
  let stopped = false
  void import('../event-bus.js').then(({ bus }) => {
    if (stopped) return
    const interest = ['task:created', 'task:updated', 'task:completed', 'task:deleted']
    bus.subscribe(name, (event) => {
      if (event.source === TASK_REPLICA_SOURCE || event.source === 'cloud-outbox') return
      const data = event.data as { task?: { id?: unknown } | null; id?: unknown } | undefined
      const id = typeof data?.task?.id === 'string' ? data.task.id : typeof data?.id === 'string' ? data.id : null
      if (id) noteLocalTaskWrite(id)
    }, { global: true, interest })
  })
  return { stop: () => { stopped = true; void import('../event-bus.js').then(({ bus }) => bus.unsubscribe(name)).catch(() => {}) } }
}

/** Tests only. */
export function _resetTaskReplicaStoreForTesting(): void {
  state = null
  loading = null
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  localWrites.clear()
  chain = Promise.resolve()
}

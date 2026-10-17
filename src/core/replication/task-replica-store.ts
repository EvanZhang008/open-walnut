/**
 * A follower's side of its copy of the primary's task store: the `tasks` and
 * `registry` replication kinds (docs/plan/walnut-control-plane.md "The
 * companion's copy of the tasks"; docs/plan/walnut-replica-servers-impl.md,
 * section 4 and WP3). Every follower keeps it: the cloud companion, a host
 * replica, a host server. The primary's side is task-replica.ts, the route is
 * web/routes/bridge-replica.ts, the generic steps are kind-follower.ts.
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
 * the primary to send the manifest again next round. The companion's held
 * rows are its own writes; a host replica's come from its journal
 * (replica/journal-overlay.ts), and it writes the copy only through the
 * follower apply connection (task-db.ts withCopyApply).
 *
 * What this box holds is kept in cache/task-replica.json (the hash of each row
 * as the primary sent it, the manifest order, the primary's clock), so a
 * restart does not ask for every row again.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import { followerKind, isFollower } from '../server-role.js'
import type { Task } from '../types.js'
import type { TaskReplicaRegistry } from '../task-manager.js'
import { entriesOf, sha12, type ReplicaStepResult } from './kind.js'
import {
  createRowSetFollower, refusalAnswer, registerFollowerKind, serialChain, writeCopyFile,
  type FollowerKindHandler, type HeldSource, type Refusal, type RowSetFollower,
} from './kind-follower.js'

export { sha12 } from './kind.js'
export type { ManifestEntry, ReplicaStepResult } from './kind.js'

export const TASK_REPLICA_SOURCE = 'task-replica'
/** The task copy's state keeps its first path (an upgraded follower asks for nothing again). */
const STATE_FILE = () => path.join(WALNUT_HOME, 'cache', 'task-replica.json')
/** A write made here holds its row this long: its relay to the primary takes ~100ms and gives up at 20s
 *  (task-queue.ts), after which a queued op holds it instead. */
const LOCAL_WRITE_HOLD_MS = 30_000
/** While the primary sent a manifest this recently, its projection is not imported into the store. */
const FRESH_MS = 15 * 60_000
/** From this many rows on, a manifest that would remove more than half of them is refused. */
const MASS_REMOVE_FLOOR = 50
/** The wire shape of a task row and of the registry document (section 4: `schemaVersion`). */
export const TASKS_SCHEMA_VERSION = 1
export const REGISTRY_SCHEMA_VERSION = 1

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
  if (state) await writeCopyFile(STATE_FILE(), state)
}

let serial = serialChain()

let saveTimer: ReturnType<typeof setTimeout> | null = null
/** A burst of writes here persists once. */
function saveSoon(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => { saveTimer = null; void serial(save).catch(() => {}) }, 1_000)
  saveTimer.unref?.()
}

/**
 * Rows this box wrote itself and the primary may not have yet. The companion's
 * own writes: a queued op, a live op still on its way (task-queue.ts
 * taskOpInFlight), a delete tombstone, a write here in the last 30 s. A host
 * replica's: its journal (replica/journal-overlay.ts; none until WP10).
 */
async function heldIds(): Promise<HeldSource> {
  if (followerKind() !== 'companion') return (await import('../../replica/journal-overlay.js')).journalHeld('tasks')
  const tq = await import('../task-queue.js')
  const queued = new Set<string>()
  for (const op of await tq.listQueuedOps()) {
    if (op.type === 'delete') queued.add(op.id)
    else if (op.type === 'create' || op.type === 'update') queued.add(op.task.id)
  }
  const now = Date.now()
  return {
    has: (id) => queued.has(id) || tq.taskOpInFlight(id) || tq.hasDeleteTombstone(id) || now - (localWrites.get(id) ?? 0) < LOCAL_WRITE_HOLD_MS,
    orderWriteRecent: () => tq.hasRecentOrderOp(),
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

function changed(): void {
  void import('../event-bus.js').then(({ bus, EventNames }) => {
    bus.emit(EventNames.TASK_UPDATED, { task: null }, ['web-ui'], { source: TASK_REPLICA_SOURCE })
  }).catch(() => {})
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
 * Which Walnut a host's copy belongs to. The daemon runs one host server per
 * Walnut home and every one of them gets the same data dir, so the first to
 * copy stamps it (cache/task-replica-leader.json, created exclusively) and a
 * step from another Walnut is `409 other_leader` (its leader rests the kind).
 * A stamp from the SAME home with another id is that home set up again (the
 * daemon replaced its host server): this one takes the copy over and asks for
 * every row again; the half rule still guards what the new manifest removes.
 */
const LEADER_FILE = () => path.join(WALNUT_HOME, 'cache', 'task-replica-leader.json')
interface LeaderStamp { walnutId: string; home: string }
let ownStamp: LeaderStamp | null = null

async function readStamp(): Promise<LeaderStamp | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(LEADER_FILE(), 'utf8')) as Partial<LeaderStamp> | null
    return raw && typeof raw.walnutId === 'string' ? { walnutId: raw.walnutId, home: typeof raw.home === 'string' ? raw.home : '' } : null
  } catch { return null }
}

async function claimStamp(me: LeaderStamp): Promise<LeaderStamp | null> {
  await fsp.mkdir(path.dirname(LEADER_FILE()), { recursive: true, mode: 0o700 })
  try {
    await fsp.writeFile(LEADER_FILE(), JSON.stringify(me), { flag: 'wx', mode: 0o600 })
    return me
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    return readStamp() // another host server stamped it first
  }
}

export async function leaderRefusal(): Promise<Refusal> {
  if (followerKind() !== 'host') return null
  const me: LeaderStamp = { walnutId: (process.env.WALNUT_WALNUT_ID ?? '').trim(), home: (process.env.WALNUT_LEADER_HOME ?? '').trim() }
  if (!me.walnutId) return null // names no leader: nothing to tell apart
  if (ownStamp?.walnutId === me.walnutId) return null
  const found = (await readStamp()) ?? (await claimStamp(me))
  if (found?.walnutId === me.walnutId) { ownStamp = found; return null }
  if (found && found.home !== me.home) {
    log.task.warn('task replica: this host\'s copy belongs to another Walnut, refusing the step', { owner: found.walnutId, ownerHome: found.home, file: LEADER_FILE() })
    return { status: 409, error: 'other_leader' }
  }
  // The same home under another id, or a stamp nobody can read.
  log.task.warn('task replica: the Walnut at this home was set up again, taking the copy over', { was: found?.walnutId ?? null, now: me.walnutId })
  await writeCopyFile(LEADER_FILE(), me)
  state = { v: 1, asOf: 0, at: 0, order: [], hashes: {}, registry: null }
  await save()
  ownStamp = me
  return null
}

/** Every follower takes the copy (the companion, a host replica, a host server); the leader never. */
function refuse(): Refusal | Promise<Refusal> {
  return isFollower() ? leaderRefusal() : 'not_a_replica'
}

/** On a host replica the copy's one writer is the apply connection (task-db.ts withCopyApply). */
async function applyToStore(change: Parameters<typeof import('../task-manager.js')['applyTaskReplica']>[0]): Promise<{ skipped: readonly string[] }> {
  const [tm, db] = await Promise.all([import('../task-manager.js'), import('../task-db.js')])
  const r = await db.withCopyApply(() => tm.applyTaskReplica(change))
  // The companion's base of its next write to each row (task-queue.ts, WP13).
  if ((change.rows?.length || change.removeIds?.length) && followerKind() === 'companion') {
    const q = await import('../task-queue.js')
    if (change.rows?.length) q.noteKnownTaskRows(change.rows, r.skipped)
    if (change.removeIds?.length) q.forgetKnownTaskRows(change.removeIds.filter((id) => !r.skipped.includes(id)))
  }
  return r
}

function makeTasksFollower(): RowSetFollower {
  return createRowSetFollower<Task>({
    kind: 'tasks',
    schemaVersion: TASKS_SCHEMA_VERSION,
    label: 'task replica',
    log: log.task,
    removalFloor: MASS_REMOVE_FLOOR,
    ordered: true,
    serial: (fn) => serial(fn),
    refuse,
    load,
    save,
    isRow,
    key: (t) => t.id,
    localKeys: async () => (await (await import('../task-manager.js')).taskStoreForReplica()).tasks.map((t) => t.id),
    apply: applyToStore,
    held: heldIds,
    changed,
  })
}

/** The registry (projects, folders, custom tiers): one document, key 'registry'. */
function makeRegistryFollower(): FollowerKindHandler {
  const sync = (body: Record<string, unknown>): Promise<ReplicaStepResult> => serial(async () => {
    const refused = refusalAnswer(await refuse())
    if (refused) return refused
    const entries = entriesOf(body.entries)
    if (!entries) return { ok: false, status: 400, error: 'bad_entries' }
    const s = await load()
    const h = entries.find((e) => e.k === 'registry')?.h
    return { ok: true, need: h && h !== s.registry ? ['registry'] : [], held: 0 }
  })
  const put = (body: Record<string, unknown>): Promise<ReplicaStepResult> => serial(async () => {
    const refused = refusalAnswer(await refuse())
    if (refused) return refused
    const s = await load()
    if (!isRegistry(body.registry)) return { ok: false, status: 400, error: 'bad_registry' }
    await applyToStore({ registry: body.registry })
    s.registry = sha12(JSON.stringify(body.registry))
    await save()
    void import('../event-bus.js').then(({ bus, EventNames }) => {
      bus.emit(EventNames.TASK_GROUPS_CHANGED, {}, ['web-ui'], { source: TASK_REPLICA_SOURCE })
      bus.emit(EventNames.CONFIG_CHANGED, { key: 'focus_tiers' }, ['web-ui'], { source: TASK_REPLICA_SOURCE })
    }).catch(() => {})
    return { ok: true, stored: 1, held: 0 }
  })
  return {
    kind: 'registry',
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    step: (op, body) => (op === 'sync' ? sync(body) : op === 'put' ? put(body) : { ok: false, status: 400, error: 'unknown_op' }),
  }
}

let tasksFollower: RowSetFollower | null = null
let registryFollower: FollowerKindHandler | null = null

/** The task copy's two follower kinds, registered for POST /bridge/replica (kind-follower.ts). */
export function registerTaskFollowerKinds(): () => void {
  tasksFollower ??= makeTasksFollower()
  registryFollower ??= makeRegistryFollower()
  const a = registerFollowerKind(tasksFollower)
  const b = registerFollowerKind(registryFollower)
  return () => { a(); b() }
}

function stepOf(op: 'sync' | 'put', body: Record<string, unknown>): Promise<ReplicaStepResult> | ReplicaStepResult {
  tasksFollower ??= makeTasksFollower()
  registryFollower ??= makeRegistryFollower()
  if (body.kind === 'registry') return registryFollower.step(op, body)
  if (body.kind === 'tasks') return tasksFollower.step(op, body)
  // An unknown kind, after the same checks the old store made first.
  return serial(async () => {
    const refused = refusalAnswer(await refuse())
    if (refused) return refused
    if (op === 'sync' && !entriesOf(body.entries)) return { ok: false, status: 400, error: 'bad_entries' }
    return { ok: false, status: 400, error: 'unknown_kind' }
  })
}

/** The manifest step (tasks or registry). */
export async function replicaSync(body: { kind?: unknown; entries?: unknown; asOf?: unknown; confirm?: unknown }): Promise<ReplicaStepResult> {
  return stepOf('sync', body as Record<string, unknown>)
}

/**
 * The bodies step: rows the manifest step asked for, or the registry. New rows
 * go after the others until the round's `last` batch, which takes the
 * manifest's order: reordering on every batch would rewrite the whole store
 * per batch on a first copy.
 */
export async function replicaPut(body: { kind?: unknown; rows?: unknown; registry?: unknown; last?: unknown }): Promise<ReplicaStepResult> {
  return stepOf('put', body as Record<string, unknown>)
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
  if (!isFollower()) return false
  return typeof (await load()).hashes[id] === 'string'
}

/**
 * Companion only: every task write on this box that is not the primary's copy
 * holds its row (noteLocalTaskWrite). Returns the stop.
 */
export function startTaskReplicaLocalWrites(): { stop: () => void } {
  if (!isFollower()) return { stop: () => {} }
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
  serial = serialChain()
  ownStamp = null
}

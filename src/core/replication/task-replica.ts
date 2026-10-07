/**
 * The primary's side of the companion's copy of the task store
 * (docs/plan/walnut-control-plane.md "The companion's copy of the tasks"; the
 * companion's side is task-replica-store.ts).
 *
 * One round, two kinds:
 *   tasks     manifest of every row (`{k: id, h: sha256-12 of the row}`, in
 *             store order) → the ids the companion lacks → those rows, in
 *             batches of at most 512 KB;
 *   registry  projects, folders and custom tiers as one document.
 * An unchanged manifest is not sent again; the 5-minute sweep sends it anyway,
 * so a companion that lost its copy is found within one sweep. A row's hash is
 * kept against the row object itself: the store keeps an unchanged row's object
 * between writes, so a round hashes only what changed.
 *
 * Over POST /bridge/replica (cloud-ingest.ts postToCloudReplica). A companion
 * without the route gets nothing new and keeps importing the projection.
 */

import crypto from 'node:crypto'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import type { CloudReplicaReply } from '../cloud-ingest.js'
import type { Task } from '../types.js'
import type { TaskReplicaRegistry } from '../task-manager.js'

const PUT_BATCH_BYTES = 512 * 1024
const PUT_TIMEOUT_MS = 60_000
const DEBOUNCE_MS = 3_000
const SWEEP_MS = 5 * 60_000
const FIRST_ROUND_MS = 15_000
/** A round the companion answered with held rows runs again after their hold ends (30s there). */
const HELD_RETRY_MS = 35_000
/** Hash this many rows, then let the event loop run. */
const HASH_SLICE = 300

function sha12(body: string): string {
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 12)
}

const rowHashes = new WeakMap<object, string>()

function hashOf(row: Task): string {
  let h = rowHashes.get(row)
  if (h === undefined) {
    h = sha12(JSON.stringify(row))
    rowHashes.set(row, h)
  }
  return h
}

export interface TaskReplicaDeps {
  view: () => Promise<{ tasks: readonly Task[]; registry: TaskReplicaRegistry }>
  post: (payload: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<CloudReplicaReply>
  /** No companion, or its lane resting: the round builds no manifest at all. */
  available?: () => Promise<boolean>
}

async function defaultDeps(): Promise<TaskReplicaDeps> {
  const [tm, ingest] = await Promise.all([import('../task-manager.js'), import('../cloud-ingest.js')])
  return { view: tm.taskStoreForReplica, post: ingest.postToCloudReplica, available: ingest.cloudReplicaAvailable }
}

export interface TaskReplicaRoundResult {
  kind: 'tasks' | 'registry'
  action: 'synced' | 'unchanged' | 'unsupported' | 'failed'
  entries?: number
  sent?: number
  held?: number
  removed?: number
  error?: string
}

/** The manifest last taken by the companion, per kind. */
const lastManifest = new Map<string, string>()

/** Send every manifest again on the next round (the sweep, a companion that may have lost its copy). */
export function forgetTaskReplica(): void {
  lastManifest.clear()
}

class StepFailed extends Error {
  constructor(readonly outcome: 'failed' | 'unsupported', message: string) { super(message) }
}

async function step(deps: TaskReplicaDeps, payload: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
  const r = await deps.post(payload, timeoutMs ? { timeoutMs } : undefined)
  if (r.ok) {
    if (r.reply.ok !== true) throw new StepFailed('failed', typeof r.reply.error === 'string' ? r.reply.error : 'refused')
    return r.reply
  }
  throw new StepFailed(r.outcome, r.error ?? (r.status ? `HTTP ${r.status}` : r.outcome))
}

async function syncTasks(deps: TaskReplicaDeps, tasks: readonly Task[]): Promise<TaskReplicaRoundResult> {
  const entries: Array<{ k: string; h: string }> = []
  for (let i = 0; i < tasks.length; i++) {
    entries.push({ k: tasks[i].id, h: hashOf(tasks[i]) })
    if (i % HASH_SLICE === HASH_SLICE - 1) await new Promise((r) => setImmediate(r))
  }
  const manifestHash = sha12(entries.map((e) => `${e.k}:${e.h}`).join('\n'))
  if (lastManifest.get('tasks') === manifestHash) return { kind: 'tasks', action: 'unchanged', entries: entries.length }
  const reply = await step(deps, { op: 'sync', kind: 'tasks', entries, asOf: Date.now() })
  const need = Array.isArray(reply.need) ? (reply.need as unknown[]).filter((k): k is string => typeof k === 'string') : []
  const byId = new Map(tasks.map((t) => [t.id, t]))
  let held = Number(reply.held) || 0
  let sent = 0
  let batch: Task[] = []
  let bytes = 0
  const flush = async (last = false): Promise<void> => {
    if (batch.length === 0) return
    const r = await step(deps, { op: 'put', kind: 'tasks', rows: batch, ...(last ? { last: true } : {}) }, PUT_TIMEOUT_MS)
    sent += Number(r.stored) || 0
    held += Number(r.held) || 0
    batch = []
    bytes = 0
  }
  for (const id of need) {
    const row = byId.get(id)
    if (!row) continue
    const size = Buffer.byteLength(JSON.stringify(row))
    if (batch.length > 0 && bytes + size > PUT_BATCH_BYTES) await flush()
    batch.push(row)
    bytes += size
  }
  await flush(true)
  // A held row comes back once the companion's own write reaches this store.
  if (held === 0) lastManifest.set('tasks', manifestHash)
  else lastManifest.delete('tasks')
  return { kind: 'tasks', action: 'synced', entries: entries.length, sent, held, removed: Number(reply.removed) || 0 }
}

async function syncRegistry(deps: TaskReplicaDeps, registry: TaskReplicaRegistry): Promise<TaskReplicaRoundResult> {
  const h = sha12(JSON.stringify(registry))
  if (lastManifest.get('registry') === h) return { kind: 'registry', action: 'unchanged' }
  const reply = await step(deps, { op: 'sync', kind: 'registry', entries: [{ k: 'registry', h }], asOf: Date.now() })
  let sent = 0
  if (Array.isArray(reply.need) && reply.need.includes('registry')) {
    await step(deps, { op: 'put', kind: 'registry', registry })
    sent = 1
  }
  lastManifest.set('registry', h)
  return { kind: 'registry', action: 'synced', sent }
}

let running: { rerun: boolean } | null = null

/**
 * Bring the companion's copy up to date. One round at a time; a request
 * during a round runs one more after it. Never throws.
 */
export async function syncTaskReplica(deps?: TaskReplicaDeps): Promise<TaskReplicaRoundResult[]> {
  if (running) { running.rerun = true; return [] }
  const me = { rerun: false }
  running = me
  const results: TaskReplicaRoundResult[] = []
  try {
    const d = deps ?? await defaultDeps()
    if (d.available && !(await d.available())) return [{ kind: 'tasks', action: 'unsupported' }]
    do {
      me.rerun = false
      const view = await d.view()
      // The store's row list is patched in place; the round works on its own copy of it.
      const tasks = [...view.tasks]
      for (const kind of ['tasks', 'registry'] as const) {
        const startedAt = Date.now()
        try {
          const r = kind === 'tasks' ? await syncTasks(d, tasks) : await syncRegistry(d, view.registry)
          results.push(r)
          if (r.action === 'synced') log.task.info('task replica: round', { ...r, ms: Date.now() - startedAt })
        } catch (err) {
          const outcome = err instanceof StepFailed ? err.outcome : 'failed'
          const error = err instanceof Error ? err.message : String(err)
          results.push({ kind, action: outcome, error })
          if (outcome === 'failed') log.task.warn('task replica: round failed', { kind, error })
          break // the other kind waits for the next round
        }
      }
    } while (me.rerun)
  } finally {
    running = null
  }
  return results
}

/**
 * Primary only: a round a few seconds after a task or registry change, a
 * first one shortly after boot, one more after rows the companion held, and
 * the sweep every 5 minutes.
 */
export function startTaskReplicaSync(deps?: TaskReplicaDeps): { stop: () => void } {
  if (CLOUD_MODE) return { stop: () => {} }
  const name = 'task-replica-sync'
  let timer: ReturnType<typeof setTimeout> | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const round = (): void => {
    if (stopped) return
    void syncTaskReplica(deps).then((results) => {
      if (stopped || retry || !results.some((r) => (r.held ?? 0) > 0)) return
      retry = setTimeout(() => { retry = null; round() }, HELD_RETRY_MS)
      retry.unref?.()
    })
  }
  const soon = (): void => {
    if (timer || stopped) return
    timer = setTimeout(() => { timer = null; round() }, DEBOUNCE_MS)
    timer.unref?.()
  }
  const interest = ['task:', 'project:', 'config:changed']
  void import('../event-bus.js').then(({ bus }) => {
    if (stopped) return
    bus.subscribe(name, (event) => {
      if (event.name.startsWith('task:') || event.name.startsWith('project:')) soon()
      else if ((event.data as { key?: unknown } | undefined)?.key === 'focus_tiers') soon()
    }, { global: true, interest })
  })
  const first = setTimeout(round, FIRST_ROUND_MS)
  first.unref?.()
  const sweep = setInterval(() => { forgetTaskReplica(); round() }, SWEEP_MS)
  sweep.unref?.()
  return {
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
      if (retry) clearTimeout(retry)
      clearTimeout(first)
      clearInterval(sweep)
      void import('../event-bus.js').then(({ bus }) => bus.unsubscribe(name)).catch(() => {})
    },
  }
}

/** Tests only. */
export function _resetTaskReplicaForTesting(): void {
  lastManifest.clear()
  running = null
}

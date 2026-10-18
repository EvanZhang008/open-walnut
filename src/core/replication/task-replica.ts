/**
 * The primary's side of every follower's copy of the task store: the
 * `tasks` and `registry` replication kinds (docs/plan/walnut-control-plane.md
 * "The companion's copy of the tasks"; docs/plan/walnut-replica-servers-impl.md
 * section 4 and WP3). A follower's side is task-replica-store.ts; the generic
 * round for one kind on one target is kind-leader.ts, whose state is kept per
 * target (replica-status.ts), so the companion and each host never share a memo.
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
 * Over POST /bridge/replica on every target of replica-targets.ts (the
 * companion through cloud-ingest.ts postToCloudReplica, a host over its
 * daemon's stream), one target after another. A companion without the route
 * gets nothing new and keeps importing the projection.
 */

import { log } from '../../logging/index.js'
import type { CloudReplicaReply } from '../cloud-ingest.js'
import { isFollower } from '../server-role.js'
import type { Task } from '../types.js'
import type { TaskReplicaRegistry } from '../task-manager.js'
import { HELD_RETRY_MS, confirmRetryMs, sha12 } from './kind.js'
// One build sends the schema its own follower side stores.
import { REGISTRY_SCHEMA_VERSION, TASKS_SCHEMA_VERSION } from './task-replica-store.js'
import { buildKindManifest, confirmKindRemoval, runKindRound, StepFailed, type KindManifest, type LeaderKind } from './kind-leader.js'
import { _resetReplicaStatusForTesting, confirmWaiting, dropTargetsNotIn, forgetKindManifests, peekKindState } from './replica-status.js'
import type { ReplicaTarget } from './replica-targets.js'

const DEBOUNCE_MS = 3_000
const SWEEP_MS = 5 * 60_000
const FIRST_ROUND_MS = 15_000
const KINDS = ['tasks', 'registry'] as const

const rowHashes = new WeakMap<object, string>()

function hashOf(row: Task): string {
  let h = rowHashes.get(row)
  if (h === undefined) {
    h = sha12(JSON.stringify(row))
    rowHashes.set(row, h)
  }
  return h
}

/** The `tasks` kind: every row as it is (no projection), in store order. */
export const TASKS_KIND: LeaderKind<Task> = {
  kind: 'tasks',
  schemaVersion: TASKS_SCHEMA_VERSION,
  key: (t) => t.id,
  hash: hashOf,
}

/** The `registry` kind: projects, folders and custom tiers as one document. */
export const REGISTRY_KIND: LeaderKind<TaskReplicaRegistry> = {
  kind: 'registry',
  schemaVersion: REGISTRY_SCHEMA_VERSION,
  key: () => 'registry',
  hash: (r) => sha12(JSON.stringify(r)),
  encodePut: (rows) => ({ registry: rows[0] }),
  single: true,
}

export interface TaskReplicaDeps {
  view: () => Promise<{ tasks: readonly Task[]; registry: TaskReplicaRegistry }>
  /** One follower (the companion), posted to directly; results then name no target. */
  post?: (payload: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<CloudReplicaReply>
  /** No companion, or its lane resting: the round builds no manifest at all (with `post`). */
  available?: () => Promise<boolean>
  /** Every follower (replica-targets.ts): the companion and each host server or host replica. */
  targets?: () => ReplicaTarget[]
}

async function defaultDeps(): Promise<TaskReplicaDeps> {
  const [tm, targets] = await Promise.all([import('../task-manager.js'), import('./replica-targets.js')])
  return { view: tm.taskStoreForReplica, targets: targets.replicaTargets }
}

export interface TaskReplicaRoundResult {
  kind: 'tasks' | 'registry'
  action: 'synced' | 'unchanged' | 'unsupported' | 'failed'
  /** The follower, when the round served the targets list (not a single `post`). */
  target?: string
  entries?: number
  sent?: number
  held?: number
  removed?: number
  error?: string
}

/** Send every manifest again on the next round (the sweep, a follower that may have lost its copy). */
export function forgetTaskReplica(): void {
  forgetKindManifests(KINDS)
}

type Served = { target: Pick<ReplicaTarget, 'id' | 'kind' | 'label' | 'post' | 'available'>; named: boolean }

function servedTargets(d: TaskReplicaDeps): Served[] {
  if (d.targets) return d.targets().map((target) => ({ target, named: true }))
  if (!d.post) return []
  const post = d.post
  return [{ target: { id: 'companion', kind: 'companion', label: 'Cloud companion', post, available: d.available ?? (async () => true) }, named: false }]
}

function named(s: Served, r: Omit<TaskReplicaRoundResult, 'target'>): TaskReplicaRoundResult {
  return s.named ? { target: s.target.id, ...r } : r
}

let running: { rerun: boolean } | null = null

/**
 * Bring every follower's copy up to date, one target after another, each with
 * its own state (replica-status.ts). One round at a time; a request during a
 * round runs one more after it. Never throws.
 */
export async function syncTaskReplica(deps?: TaskReplicaDeps): Promise<TaskReplicaRoundResult[]> {
  if (running) { running.rerun = true; return [] }
  const me = { rerun: false }
  running = me
  const results: TaskReplicaRoundResult[] = []
  try {
    const d = deps ?? await defaultDeps()
    do {
      me.rerun = false
      const all = servedTargets(d)
      if (d.targets) dropTargetsNotIn(all.map((s) => s.target.id))
      const ready: Served[] = []
      for (const s of all) {
        if (await s.target.available()) ready.push(s)
        else results.push(named(s, { kind: 'tasks', action: 'unsupported' }))
      }
      if (ready.length === 0) break
      const view = await d.view()
      const asOf = Date.now()
      // The store's row list is patched in place; the round works on its own copy of it.
      const manifests = {
        tasks: await buildKindManifest(TASKS_KIND, [...view.tasks]),
        registry: await buildKindManifest(REGISTRY_KIND, [view.registry]),
      }
      for (const s of ready) await serveTarget(s, manifests, asOf, results)
    } while (me.rerun)
  } finally {
    running = null
  }
  return results
}

async function serveTarget(
  s: Served, manifests: { tasks: KindManifest<Task>; registry: KindManifest<TaskReplicaRegistry> }, asOf: number, results: TaskReplicaRoundResult[],
): Promise<void> {
  for (const kind of KINDS) {
    const startedAt = Date.now()
    try {
      const r = kind === 'tasks'
        ? await runKindRound(TASKS_KIND, manifests.tasks, s.target, { asOf, log: log.task })
        : await runKindRound(REGISTRY_KIND, manifests.registry, s.target, { asOf, log: log.task })
      results.push(named(s, r as Omit<TaskReplicaRoundResult, 'target'>))
      if (r.action === 'synced') log.task.info('task replica: round', { target: s.target.id, ...r, ms: Date.now() - startedAt })
    } catch (err) {
      const outcome = err instanceof StepFailed ? err.outcome : 'failed'
      const error = err instanceof Error ? err.message : String(err)
      results.push(named(s, { kind, action: outcome, error }))
      if (outcome === 'failed') log.task.warn('task replica: round failed', { target: s.target.id, kind, error })
      break // the other kind waits for the next round
    }
  }
}

/** Every running scheduler's "round soon" and "round now": a scheduler that stops takes only its own. */
const soonHooks = new Set<() => void>()
const nowHooks = new Set<() => void>()
const soonAll = (): void => { for (const soon of soonHooks) soon() }

/**
 * A follower's forwarded task write ran here (v1-forward policy.ts
 * noteForwardedTaskWrite): a round now, not after the debounce, so the
 * companion's copy, which answers the phone's task reads, shows it at once.
 */
export function taskReplicaRoundNow(): void {
  for (const now of nowHooks) now()
}
let schedulers = 0

/**
 * A drain of a host's journal took away writes (offline-handover.ts): every manifest
 * goes again within the debounce, so a host replica's "awaiting copy" marks resolve in
 * seconds. A create the ledger took as a duplicate of its op id, or a write refused
 * into the letter, changes no row, so no store event would bring a round before the
 * sweep (WP10, docs/plan/walnut-replica-servers-impl.md section 4 "Hold after ack").
 */
export function resendTaskReplicaSoon(): void {
  forgetTaskReplica()
  soonAll()
}

/**
 * The user confirmed a removal the half rule refused three rounds in a row
 * (the Settings row): the next round on that target sends `confirm:true`,
 * only while the leader still has the refused count and keys (kind-leader.ts).
 * `entries`, `keys`: the count and key set the user saw (a confirm for another
 * manifest is refused).
 */
export async function confirmTaskReplicaRemoval(targetId: string, kind: 'tasks' | 'registry' = 'tasks', opts: { entries?: number; keys?: string } = {}): Promise<boolean> {
  const { replicaTargets } = await import('./replica-targets.js')
  const target = replicaTargets().find((t) => t.id === targetId)
  if (!target || !peekKindState(targetId, kind)) return false
  if (!confirmKindRemoval(target, kind, opts)) return false
  log.task.warn('task replica: the user confirmed a removal of most rows', { target: targetId, kind, entries: peekKindState(targetId, kind)?.confirmFor?.entries })
  soonAll()
  return true
}

/**
 * Primary only: a round a few seconds after a task or registry change or a
 * follower joining, a first one shortly after boot, one more after rows a
 * follower held, one soon after a round that lost the step of a confirm the
 * user gave (backing off, while the confirm holds), and the sweep every 5 minutes.
 */
export function startTaskReplicaSync(deps?: TaskReplicaDeps): { stop: () => void } {
  if (isFollower()) return { stop: () => {} }
  // Its own bus name: stopping an older scheduler never unsubscribes a newer one.
  const name = `task-replica-sync-${++schedulers}`
  let timer: ReturnType<typeof setTimeout> | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  /** Rounds in a row that lost a confirm's step (stream reset, host not connected, timeout). */
  let confirmTries = 0
  const round = (): void => {
    if (stopped) return
    void syncTaskReplica(deps).then((results) => {
      // No results: no follower, or the round already running took this request (its caller reads them).
      if (stopped || results.length === 0) return
      // A lost step keeps the confirm (kind-leader.ts), but no store event may come to send it.
      const lost = results.some((r) => r.action === 'failed' && KINDS.some((k) => confirmWaiting(r.target ?? 'companion', k)))
      confirmTries = lost ? confirmTries + 1 : 0
      if (retry || (!lost && !results.some((r) => (r.held ?? 0) > 0))) return
      retry = setTimeout(() => { retry = null; round() }, lost ? confirmRetryMs(confirmTries) : HELD_RETRY_MS)
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
  // A follower that joins (a host server came up) gets its first round within seconds.
  let unlistenTargets: (() => void) | null = null
  void import('./replica-targets.js').then(({ onReplicaTargetsChanged }) => {
    if (!stopped) unlistenTargets = onReplicaTargetsChanged(soon)
  })
  soonHooks.add(soon)
  const now = (): void => {
    if (stopped) return
    if (timer) { clearTimeout(timer); timer = null }
    round()
  }
  nowHooks.add(now)
  const first = setTimeout(round, FIRST_ROUND_MS)
  first.unref?.()
  const sweep = setInterval(() => { forgetTaskReplica(); round() }, SWEEP_MS)
  sweep.unref?.()
  return {
    stop: () => {
      stopped = true
      soonHooks.delete(soon)
      nowHooks.delete(now)
      unlistenTargets?.()
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
  _resetReplicaStatusForTesting()
  running = null
}

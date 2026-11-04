/**
 * The pull request watcher: keeps each open task's linked pull requests' status on the task
 * (Task.pr_status), wakes its session on news, and completes it when its pull request merges.
 *
 *   read    every 2 minutes, one provider call for every open pull request on every open task
 *           (a closed one every 30 minutes, since it can be reopened; a merged one never again).
 *           A link tag added to a task is read within seconds (the tag watch below), and the card's
 *           Refresh reads one task's now.
 *   store   a compact snapshot per pull request, written only when something in it changed, so a
 *           quiet pull request costs no task write and no event. The time of the last read is kept
 *           in memory and answered by GET /api/tasks/:id/pull-requests.
 *   wake    news (watch-eval.ts) on an open pull request the signed-in account opened goes to the
 *           task's session the way a trigger's fire does: the live session, else the stopped one (a
 *           cold resume). A task with no session is not given one. Another person's pull request (a
 *           link to a colleague's work, say) is shown and never wakes anyone. Off for a task with
 *           `pr_wake: false`, or everywhere with `pull_requests.wake_agent: false`.
 *   settle  when its pull requests are all merged or closed, and one of the user's own was seen
 *           merging, the task completes (`pr_auto_complete: false` on the task, or
 *           `pull_requests.auto_complete_on_merge: false`, turns it off). Never in a read that woke
 *           the session, never while its session is in a turn (both wait for a later read), never
 *           Main or a lead, never a task with open subtasks or with something still owed to the user
 *           (owed-to-user.ts): those stay open, the card says why, and every read asks again, so the
 *           task completes once the reason is gone.
 *
 * Runs on the leader only (boot-policy 'pr-watch'): GitHub's answers are the same from anywhere,
 * and the leader holds the tasks and the user's gh sign-in. A test or ephemeral server reads only
 * through a stand-in gh (WALNUT_GH_BIN), never the real GitHub.
 */

import { createHash } from 'node:crypto'
import { log } from '../../logging/index.js'
import type { Task } from '../types.js'
import { linkUrlOfTag } from '../link-tags.js'
import type { PrSnapshot, PrWatchState } from './model.js'
import { prRefOf, type PrProvider, type PrReadResult, type PrRef } from './providers.js'
import { evaluatePrWatch, prWakeBody, prWakeSummary, type PrWatchReport } from './watch-eval.js'

export const PR_WATCH_SOURCE = 'pr-watch'
export const PR_WATCH_EVERY_MS = 2 * 60_000
const CLOSED_EVERY_MS = 30 * 60_000
/** How often the watcher looks at what is due. Each pull request is read every PR_WATCH_EVERY_MS
 *  (a little sooner: DUE_SHARE), so news waits at most about that plus one look. */
export const PR_WATCH_TICK_MS = 30_000
const DUE_SHARE = 0.95
/** When one is due, every other at least this far into its interval is read in the same call. */
const RIDE_SHARE = 0.5
const MAX_OPEN_TASKS = 5000

export interface PrWatchDeps {
  /** Open tasks, read-only views. */
  openTasks(): Promise<ReadonlyArray<Readonly<Task>>>
  getTask(id: string): Promise<Task | null>
  /** Read-modify-write of one task's PR fields; null from the function writes nothing. */
  writeTask(id: string, patch: (current: Readonly<Task>) => Partial<Task> | null): Promise<void>
  /** The session that should hear about news, or null. `running` is a turn in progress. */
  deliveryTarget(taskId: string): Promise<{ sessionId: string; running: boolean } | null>
  /** `messageId` is stable for the same news, so a retold wake still queued is not queued twice. */
  send(sessionId: string, text: string, taskId: string, messageId: string): Promise<void>
  /** `why` goes on the task's note, the record of why it closed. */
  complete(taskId: string, why: string): Promise<void>
  /** Why a merged task must stay open (owed to the user, open subtasks), or null. */
  holdReason(task: Readonly<Task>): Promise<string | null>
  config(): Promise<{ watch?: boolean; auto_complete_on_merge?: boolean; wake_agent?: boolean } | undefined>
  now(): number
}

/** When each pull request was last read (url to ms), and the last answer for each task's read. */
const lastRead = new Map<string, number>()
/** When each pull request was last read without an error: what a failed read's card shows is that old. */
const lastGood = new Map<string, number>()

/** The URLs of the pull requests a task links that a provider can read, in tag order. */
export function linkedPrRefs(task: Pick<Task, 'tags'>): Array<{ provider: PrProvider; ref: PrRef }> {
  const out: Array<{ provider: PrProvider; ref: PrRef }> = []
  const seen = new Set<string>()
  for (const tag of task.tags ?? []) {
    const url = linkUrlOfTag(tag)
    if (!url) continue
    const hit = prRefOf(url)
    if (!hit || seen.has(hit.ref.url)) continue
    seen.add(hit.ref.url)
    out.push(hit)
  }
  return out
}

function due(snapshot: PrSnapshot | undefined, url: string, now: number, force: boolean, share = DUE_SHARE): boolean {
  if (force || !snapshot) return true
  const at = lastRead.get(url)
  if (at === undefined) return snapshot.state !== 'merged'
  if (snapshot.state === 'merged') return false
  const every = snapshot.state === 'closed' ? CLOSED_EVERY_MS : PR_WATCH_EVERY_MS
  return now - at >= every * share
}

/** The snapshot without its read time: two reads that found the same thing compare equal. */
function sameSnapshot(a: PrSnapshot | undefined, b: PrSnapshot | undefined): boolean {
  if (!a || !b) return a === b
  const { checkedAt: _a, ...ra } = a
  const { checkedAt: _b, ...rb } = b
  return JSON.stringify(ra) === JSON.stringify(rb)
}

function emptySnapshot(ref: PrRef, provider: string): PrSnapshot {
  return {
    provider, url: ref.url, repo: `${ref.owner}/${ref.name}`, number: ref.number, state: 'open',
    checks: { total: 0, passed: 0, failed: 0, pending: 0, skipped: 0, items: [] }, checkedAt: '',
  }
}

interface Planned {
  url: string
  next: PrSnapshot
  report?: PrWatchReport
  /** Seen going from open to merged in this read. */
  merged?: boolean
}

function plan(prev: PrSnapshot | undefined, ref: PrRef, provider: string, result: PrReadResult | undefined, viewer: string | undefined, nowIso: string): Planned {
  if (!result) return { url: ref.url, next: prev ?? emptySnapshot(ref, provider) }
  if (!result.ok) {
    const base = prev ?? emptySnapshot(ref, provider)
    return { url: ref.url, next: { ...base, error: { code: result.code, message: result.message } } }
  }
  const { read } = result
  const report = evaluatePrWatch(prev?.watch, { ...read.snapshot, failed: read.failed }, read.remarks, { viewer })
  const merged = !!prev && prev.state !== 'merged' && read.snapshot.state === 'merged' && !!prev.checkedAt
  const watch: PrWatchState = { ...report.next, ...(merged ? { mergeSeen: true } : {}) }
  const mine = !!viewer && !!read.snapshot.author && viewer.toLowerCase() === read.snapshot.author.toLowerCase()
  return {
    url: ref.url,
    next: { ...read.snapshot, ...(mine ? { mine } : {}), checkedAt: nowIso, watch },
    ...(prev ? { report } : {}),
    ...(merged ? { merged } : {}),
  }
}

export interface PrTickReport {
  tasks: number
  read: number
  written: number
  woken: number
  completed: number
}

export interface PrTickOptions {
  /** Only these tasks (a Refresh, a new link tag). */
  taskIds?: readonly string[]
  /** Read even what is not due, merged ones included. */
  force?: boolean
}

let chain: Promise<unknown> = Promise.resolve()

/** One pass. Passes never overlap (a Refresh during a tick waits for it). */
export function prWatchTick(deps: PrWatchDeps, opts: PrTickOptions = {}): Promise<PrTickReport> {
  const run = chain.then(() => tickOnce(deps, opts))
  chain = run.catch(() => undefined)
  return run
}

async function tickOnce(deps: PrWatchDeps, opts: PrTickOptions): Promise<PrTickReport> {
  const report: PrTickReport = { tasks: 0, read: 0, written: 0, woken: 0, completed: 0 }
  const config = (await deps.config().catch(() => undefined)) ?? {}
  if (config.watch === false) return report
  const now = deps.now()
  const nowIso = new Date(now).toISOString()
  const wanted = opts.taskIds ? new Set(opts.taskIds) : null
  const tasks = (await deps.openTasks()).filter((t) => (!wanted || wanted.has(t.id)) && t.phase !== 'COMPLETE')

  // Which pull requests to read, once each however many tasks link them.
  const byProvider = new Map<PrProvider, Map<string, PrRef>>()
  const riders = new Map<PrProvider, Map<string, PrRef>>()
  const perTask: Array<{ task: Readonly<Task>; refs: Array<{ provider: PrProvider; ref: PrRef }> }> = []
  const add = (into: Map<PrProvider, Map<string, PrRef>>, provider: PrProvider, ref: PrRef) => {
    let set = into.get(provider)
    if (!set) { set = new Map(); into.set(provider, set) }
    set.set(ref.url, ref)
  }
  for (const task of tasks) {
    const refs = linkedPrRefs(task)
    const stale = Object.keys(task.pr_status ?? {}).some((url) => !refs.some((r) => r.ref.url === url))
    if (refs.length === 0 && !stale) continue
    perTask.push({ task, refs })
    for (const { provider, ref } of refs) {
      const snap = task.pr_status?.[ref.url]
      if (due(snap, ref.url, now, opts.force === true)) add(byProvider, provider, ref)
      else if (!opts.taskIds && due(snap, ref.url, now, false, RIDE_SHARE)) add(riders, provider, ref)
    }
  }
  // One call per provider: what is half-way due rides along with what is due.
  for (const [provider, set] of byProvider) for (const [url, ref] of riders.get(provider) ?? []) set.set(url, ref)

  const results = new Map<string, PrReadResult>()
  let viewer: string | undefined
  for (const [provider, refs] of byProvider) {
    try {
      const answer = await provider.read([...refs.values()])
      viewer = answer.viewer ?? viewer
      for (const [url, r] of answer.results) results.set(url, r)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.task.warn('pr-watch: provider read failed', { provider: provider.id, error: message })
      // The card says the read failed rather than showing an unread pull request as plain "Open".
      for (const url of refs.keys()) results.set(url, { ok: false, code: 'failed', message })
    }
  }
  for (const [url, r] of results) {
    lastRead.set(url, now)
    if (r.ok) lastGood.set(url, now)
  }
  report.read = results.size

  for (const { task, refs } of perTask) {
    report.tasks++
    try {
      await settleTask(deps, task, refs, results, viewer, nowIso, config, report)
    } catch (err) {
      log.task.warn('pr-watch: task pass failed', { taskId: task.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  if (report.read || report.written || report.woken || report.completed) log.task.info('pr-watch tick', { ...report })
  return report
}

async function settleTask(
  deps: PrWatchDeps,
  task: Readonly<Task>,
  refs: Array<{ provider: PrProvider; ref: PrRef }>,
  results: Map<string, PrReadResult>,
  viewer: string | undefined,
  nowIso: string,
  config: { auto_complete_on_merge?: boolean; wake_agent?: boolean },
  report: PrTickReport,
): Promise<void> {
  const planned = refs.map(({ provider, ref }) => plan(task.pr_status?.[ref.url], ref, provider.id, results.get(ref.url), viewer, nowIso))

  // Wake first, so news a failed send never delivered is told again on the next read. Only the
  // user's own open pull requests: a merged or closed one asks nothing more of the agent.
  const news = planned.filter((p) => p.report && p.report.changes.length > 0 && p.next.mine && p.next.state === 'open')
  const wakeOn = task.pr_wake !== false && config.wake_agent !== false && task.org_role !== 'main' && task.org_role !== 'lead'
  let woke = false
  if (news.length && wakeOn) {
    const target = await deps.deliveryTarget(task.id).catch(() => null)
    if (target) {
      const { buildWalnutMessage } = await import('../peers/walnut-message-tag.js')
      const body = news.map((p) => prWakeBody(p.next, p.report!)).join('\n\n')
      const text = buildWalnutMessage({
        kind: 'trigger',
        attrs: {
          from: 'Walnut: pull request watch',
          about: news.map((p) => `#${p.next.number}`).join(', '),
          note: 'a change on a pull request linked to this task',
        },
        body,
      })
      const messageId = `pr-watch-${createHash('sha1').update(`${task.id}\n${body}`).digest('hex').slice(0, 16)}`
      try {
        await deps.send(target.sessionId, text, task.id, messageId)
        report.woken++
        woke = true
        for (const p of news) {
          p.next = { ...p.next, watch: { ...p.next.watch!, lastWakeAt: nowIso, lastWake: prWakeSummary(p.report!.changes) } }
        }
        log.task.info('pr-watch: session woken', { taskId: task.id, sessionId: target.sessionId, prs: news.map((p) => p.url), why: news.map((p) => prWakeSummary(p.report!.changes)) })
      } catch (err) {
        log.task.warn('pr-watch: wake failed, told again next read', { taskId: task.id, error: err instanceof Error ? err.message : String(err) })
        for (const p of news) {
          const prev = task.pr_status?.[p.url]
          if (prev?.watch) p.next = { ...p.next, watch: { ...prev.watch, ...(p.next.watch?.mergeSeen ? { mergeSeen: true } : {}) } }
        }
      }
    }
  }

  // Complete when every linked pull request is finished and one of the user's own was seen merging.
  // A merge kept open is asked about again on every read (no provider call: a merged one is not
  // read again), so the task completes once its reason is gone.
  const settles = (s: PrSnapshot) => s.state === 'merged' && s.mine === true && s.watch?.mergeSeen === true && !s.watch.completedAt
  const all = planned.map((p) => p.next)
  const finished = all.length > 0 && all.every((s) => s.state === 'merged' || s.state === 'closed')
  let complete = false
  if (all.some(settles) && finished) {
    const off = task.pr_auto_complete === false || (task.pr_auto_complete === undefined && config.auto_complete_on_merge === false)
    const hold = task.org_role === 'main' || task.org_role === 'lead' ? 'Main and the leads are never completed by a merge.'
      : off ? 'Completing on merge is off for this task.'
        : await deps.holdReason(task).catch(() => null)
    const target = hold || woke ? null : await deps.deliveryTarget(task.id).catch(() => null)
    if (!hold && (woke || target?.running)) {
      // A turn may be the one that merged it, or this read just woke one: completing would stop
      // it mid-work, or reopen the task when the wake is read. A later read.
      log.task.info('pr-watch: merged, waiting for the turn to end before completing', { taskId: task.id })
    } else {
      for (const p of planned) {
        if (!settles(p.next)) continue
        const { heldOpen: _was, ...watch } = p.next.watch!
        p.next = { ...p.next, watch: hold ? { ...watch, heldOpen: hold } : { ...watch, completedAt: nowIso } }
      }
      complete = !hold
      if (hold && !planned.some((p) => task.pr_status?.[p.url]?.watch?.heldOpen === hold)) {
        log.task.info('pr-watch: merged, task kept open', { taskId: task.id, why: hold })
      }
    }
  }

  const nextStatus: Record<string, PrSnapshot> = {}
  for (const p of planned) nextStatus[p.url] = p.next
  const prevStatus = task.pr_status ?? {}
  const changed = Object.keys(prevStatus).length !== planned.length
    || planned.some((p) => !sameSnapshot(prevStatus[p.url], p.next))
  if (changed) {
    const urls = new Set(planned.map((p) => p.url))
    await deps.writeTask(task.id, (current) => {
      // A tag removed while this read ran is not written back.
      const keep: Record<string, PrSnapshot> = {}
      const tagged = new Set(linkedPrRefs(current).map((r) => r.ref.url))
      for (const [url, snap] of Object.entries(nextStatus)) if (tagged.has(url) && urls.has(url)) keep[url] = snap
      return Object.keys(keep).length ? { pr_status: keep } : { pr_status: undefined }
    })
    report.written++
  }

  if (complete) {
    const fresh = await deps.getTask(task.id)
    if (fresh && fresh.phase !== 'COMPLETE') {
      const merged = planned.filter((p) => p.next.state === 'merged' && p.next.mine).map((p) => `${p.next.repo}#${p.next.number}`)
      await deps.complete(task.id, `Completed by Walnut: ${merged.join(', ')} merged.`)
      report.completed++
      log.task.info('pr-watch: pull request merged, task completed', { taskId: task.id, prs: planned.filter((p) => p.next.state === 'merged').map((p) => p.url) })
    }
  }
}

/** The time of the last read of each of a task's pull requests (ms), for the card. */
export function lastReadAt(url: string): number | undefined {
  return lastRead.get(url)
}

/** For tests. */
export function _resetPrWatchForTesting(): void {
  lastRead.clear()
  lastGood.clear()
  chain = Promise.resolve()
}

// ── Real wiring ──

export function defaultPrWatchDeps(): PrWatchDeps {
  return {
    async openTasks() {
      const { listOpenTaskViews } = await import('../task-manager.js')
      return listOpenTaskViews(MAX_OPEN_TASKS)
    },
    async getTask(id) {
      const { getTask } = await import('../task-manager.js')
      return getTask(id).catch(() => null)
    },
    async writeTask(id, patch) {
      const { updateTaskRaw } = await import('../task-manager.js')
      await updateTaskRaw(id, patch, { emitEvent: true, source: PR_WATCH_SOURCE })
    },
    async deliveryTarget(taskId) {
      const { getSessionsForTask } = await import('../session-tracker.js')
      const { pickDeliverySession } = await import('../routines/session-target.js')
      const target = pickDeliverySession(await getSessionsForTask(taskId).catch(() => []))
      return target ? { sessionId: target.claudeSessionId, running: target.process_status === 'running' } : null
    },
    async send(sessionId, text, taskId, messageId) {
      const { sendMessageToSession } = await import('../session-message-queue.js')
      // endsWait: a task parked on its pull request waited for exactly this.
      await sendMessageToSession(sessionId, text, { source: PR_WATCH_SOURCE, taskId, endsWait: true, messageId })
    },
    async complete(taskId, why) {
      const { completeTask, addNote } = await import('../task-manager.js')
      const { bus, EventNames } = await import('../event-bus.js')
      const { task } = await completeTask(taskId, { source: PR_WATCH_SOURCE })
      // The record on the task, for whoever looks for why it closed (the session never hears it).
      await addNote(taskId, why).catch((err) => log.task.warn('pr-watch: completion note failed', { taskId, error: String(err) }))
      bus.emit(EventNames.TASK_COMPLETED, { task }, ['web-ui'], { source: PR_WATCH_SOURCE })
    },
    async holdReason(task) {
      const { listOpenTaskViews } = await import('../task-manager.js')
      const openSubtasks = (await listOpenTaskViews(MAX_OPEN_TASKS)).filter((t) => t.parent_task_id === task.id)
      if (openSubtasks.length) {
        return `It still has ${openSubtasks.length === 1 ? 'an open subtask' : `${openSubtasks.length} open subtasks`}.`
      }
      const { owedToUser } = await import('../sessions/owed-to-user.js')
      const owed = await owedToUser(task as Task)
      if (owed.length) return `It still holds something for you: ${owed[0]!.text}${owed.length > 1 ? ` (and ${owed.length - 1} more)` : ''}.`
      return null
    },
    async config() {
      const { getConfig } = await import('../config-manager.js')
      return (await getConfig()).pull_requests
    },
    now: () => Date.now(),
  }
}

let started: { stop(): void; kick(taskIds?: readonly string[], force?: boolean): Promise<PrTickReport> } | null = null

/** Start the watcher (idempotent): the periodic read, and a read of a task soon after it gains a link. */
export async function startPrWatch(deps: PrWatchDeps = defaultPrWatchDeps()): Promise<typeof started> {
  if (started) return started
  const { runPeriodic } = await import('../periodic-task.js')
  const { bus, EventNames } = await import('../event-bus.js')
  const handle = runPeriodic('pr-watch', PR_WATCH_TICK_MS, 90_000, async () => {
    await prWatchTick(deps).catch((err) => log.task.warn('pr-watch tick failed', { error: err instanceof Error ? err.message : String(err) }))
  })
  const pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    timer = null
    const ids = [...pending]
    pending.clear()
    void prWatchTick(deps, { taskIds: ids }).catch(() => undefined)
  }
  bus.subscribe('pr-watch', (event) => {
    if (event.source === PR_WATCH_SOURCE) return
    const task = (event.data as { task?: Task } | undefined)?.task
    if (!task || task.phase === 'COMPLETE') return
    const refs = linkedPrRefs(task)
    const known = task.pr_status ?? {}
    // A newly linked pull request, or an unlinked one whose snapshot should go.
    const fresh = refs.some((r) => !known[r.ref.url]) || Object.keys(known).some((url) => !refs.some((r) => r.ref.url === url))
    if (!fresh) return
    pending.add(task.id)
    if (!timer) { timer = setTimeout(flush, 3_000); timer.unref?.() }
  }, { global: true, interest: [EventNames.TASK_UPDATED, EventNames.TASK_CREATED] })
  started = {
    stop() { handle.stop(); bus.unsubscribe('pr-watch'); if (timer) clearTimeout(timer); started = null },
    kick: (taskIds, force) => prWatchTick(deps, { ...(taskIds ? { taskIds } : {}), ...(force ? { force } : {}) }),
  }
  return started
}

/** Whether this server watches pull requests (the leader, a real install or a stand-in gh). */
export function prWatchRunning(): boolean {
  return started !== null
}

/** Read one task's pull requests now (the card's Refresh). Only where the watcher runs: a server
 *  that does not watch (a replica, a test server with no stand-in gh) never reads GitHub. */
export async function refreshTaskPrs(taskId: string): Promise<PrTickReport | null> {
  return started ? started.kick([taskId], true) : null
}

/** What the card shows for a task: its snapshots with their last read, and the switches in force. */
export async function taskPrView(task: Pick<Task, 'id' | 'tags' | 'pr_status' | 'pr_auto_complete' | 'pr_wake'>): Promise<{
  watching: boolean
  autoComplete: boolean
  wake: boolean
  prs: Array<PrSnapshot & { lastReadAt?: string; lastGoodAt?: string }>
}> {
  const { getConfig } = await import('../config-manager.js')
  const cfg = (await getConfig().catch(() => null))?.pull_requests ?? {}
  const prs = linkedPrRefs(task).map(({ provider, ref }) => {
    const snap = task.pr_status?.[ref.url] ?? emptySnapshot(ref, provider.id)
    const at = lastRead.get(ref.url)
    const good = lastGood.get(ref.url)
    return {
      ...snap,
      ...(at ? { lastReadAt: new Date(at).toISOString() } : snap.checkedAt ? { lastReadAt: snap.checkedAt } : {}),
      // A snapshot is written only when it changes: its checkedAt is when it last changed.
      ...(good ? { lastGoodAt: new Date(good).toISOString() } : snap.checkedAt ? { lastGoodAt: snap.checkedAt } : {}),
    }
  })
  return {
    watching: started !== null && cfg.watch !== false,
    autoComplete: task.pr_auto_complete ?? cfg.auto_complete_on_merge ?? true,
    wake: task.pr_wake ?? cfg.wake_agent ?? true,
    prs,
  }
}

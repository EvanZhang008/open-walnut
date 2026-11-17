/**
 * The change watcher: keeps the status of each open task's change links (model.ts) on the task
 * (Task.change_status) and wakes its session on news. Off unless the experiment `change_status` is on.
 *
 *   read    a look every 30 seconds reads what is due (cadence.ts: from what each change waits on),
 *           once per URL however many tasks link it, one link per provider call, at most 3 calls in
 *           flight per provider, each under its own deadline. A link a task has no snapshot of is due
 *           at once; one a provider left out of its answer comes back with the failed reads. After a
 *           restart the first reads are spread over two minutes. A change link added to a task is read
 *           within seconds (task-news.ts); the card's Refresh reads one task's now.
 *   store   written only when the snapshot changed (its read time and next read aside), so a quiet
 *           change costs no task write and no event; the last answer and next read are kept in memory
 *           and answered by GET /api/tasks/:id/changes. A link the task no longer holds loses its snapshot.
 *   wake    news (cadence.ts) goes to the task's session (task-news.ts). Never Main or a lead, never
 *           with `pr_wake: false` on the task or `pull_requests.wake_agent: false`; a pull request the
 *           pull request watch already follows leaves its review news to that watch.
 *
 * Runs on the leader only (boot-policy 'change-watch'). Stage details: stage-detail.ts.
 */

import { createHash } from 'node:crypto'
import { log } from '../../logging/index.js'
import type { Task } from '../types.js'
import { linkLabel } from '../link-tags.js'
import { followTaskLinks, sendTaskNews, taskNewsTarget } from '../task-news.js'
import { changeSettled, taskChangeLinks, type ChangeLink, type ChangeSnapshot } from './model.js'
import { changeProviderFor, type ChangeReadResult, type RegisteredChangeProvider } from './registry.js'
import { CHANGE_ERROR_EVERY_MS, changeNews, changeWakeLines, nextReadAt, type ChangeNews } from './cadence.js'
import { ensureCoreChangeProviders } from './github.js'
import { abortableDeadline, DEADLINE_MESSAGE } from './deadline.js'

export const CHANGE_WATCH_SOURCE = 'change-watch'
export const CHANGE_WATCH_TICK_MS = 30_000
const MAX_OPEN_TASKS = 5000
const READS_IN_FLIGHT = 3
/** A news send that failed is tried again this soon. */
const RETELL_MS = 2 * 60_000
/** After a restart, stored reads already due are spread over this long. */
const STAGGER_MS = 2 * 60_000
const deadlines = { readMs: 90_000 }

export interface ChangeWatchDeps {
  openTasks(): Promise<ReadonlyArray<Readonly<Task>>>
  /** Read-modify-write of one task's change_status; null from the function writes nothing. */
  writeTask(id: string, patch: (current: Readonly<Task>) => Partial<Task> | null): Promise<void>
  deliveryTarget(taskId: string): Promise<{ sessionId: string; running: boolean } | null>
  /** `messageId` is stable for the same news, so a retold wake still queued is not queued twice. */
  send(sessionId: string, text: string, taskId: string, messageId: string): Promise<void>
  /** The experiment `change_status`. */
  enabled(): Promise<boolean>
  /** The pull request settings: `wake_agent: false` silences this watcher's wakes too. */
  config(): Promise<{ wake_agent?: boolean } | undefined>
  now(): number
}

/** Per URL: the last good answer (ms) and the next read (ms, null = never). */
const lastGood = new Map<string, number>()
const nextDue = new Map<string, number | null>()
/** A URL its provider left out of an answer: not asked again before this (ms). */
const retryAt = new Map<string, number>()
/** When the watcher started: a stored read already due waits a share of STAGGER_MS after it. */
let startedAt: number | null = null

function placeholder(link: ChangeLink, provider: string): ChangeSnapshot {
  return { provider, url: link.url, label: linkLabel(link.url), checkedAt: '' }
}

function staggerOf(url: string): number {
  let h = 0
  for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) >>> 0
  return h % STAGGER_MS
}

/** When a task's link is due (ms), or null when it is read no more. A link this task has no
 *  snapshot of is due at once, whatever another task's read of the same URL said. */
function dueAt(snap: ChangeSnapshot | undefined, url: string, now: number): number | null {
  const retry = retryAt.get(url)
  if (retry !== undefined && retry > now) return retry
  if (!snap) return 0
  if (nextDue.has(url)) return nextDue.get(url)!
  if (!snap.nextAt) return snap.checkedAt ? null : 0
  const stored = Date.parse(snap.nextAt) || 0
  return startedAt === null ? stored : Math.max(stored, startedAt + staggerOf(url))
}

/** The snapshot as stored for comparison: its read time aside, and of its next read only whether there is one. */
function sameSnapshot(a: ChangeSnapshot | undefined, b: ChangeSnapshot | undefined): boolean {
  if (!a || !b) return a === b
  const strip = ({ checkedAt: _c, nextAt, ...rest }: ChangeSnapshot) => JSON.stringify({ ...rest, next: !!nextAt })
  return strip(a) === strip(b)
}

/** The next snapshot from a read's answer (or the previous one when the link was not read). */
function plan(prev: ChangeSnapshot | undefined, link: ChangeLink, providerId: string, result: ChangeReadResult | undefined, now: number): ChangeSnapshot {
  if (!result) return prev ?? placeholder(link, providerId)
  const nowIso = new Date(now).toISOString()
  const followedSince = prev?.followedSince ?? nowIso
  let next: ChangeSnapshot
  if (!result.ok) {
    const { nextAt: _n, ...base } = prev ?? placeholder(link, providerId)
    next = { ...base, provider: providerId, followedSince, error: { code: result.code, message: result.message } }
  } else {
    next = { provider: providerId, url: link.url, ...result.snapshot, checkedAt: nowIso, followedSince }
  }
  const at = nextReadAt(next, now, result.ok ? result.nextInMs : undefined)
  if (at !== undefined) next.nextAt = new Date(at).toISOString()
  return next
}

type ReadLink = ChangeLink & { prev?: ChangeSnapshot; pr?: unknown }

/** Read one provider's due links, one per call so a slow one costs only itself, READS_IN_FLIGHT at a
 *  time. A link it leaves out is not in the answer (the caller sets it back). */
async function readProvider(provider: RegisteredChangeProvider, links: ReadLink[]): Promise<Map<string, ChangeReadResult>> {
  const out = new Map<string, ChangeReadResult>()
  let at = 0
  const worker = async () => {
    for (let link = links[at++]; link; link = links[at++]) {
      try {
        const answer = await abortableDeadline(deadlines.readMs, (signal) => provider.read([link!], { signal }))
        const r = answer?.get(link.url)
        if (r) out.set(link.url, r)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.task.warn('change-watch: provider read failed', { provider: provider.id, url: link.url, error: message })
        out.set(link.url, message === DEADLINE_MESSAGE ? { ok: false, code: 'unreachable', message: 'The read timed out.' } : { ok: false, code: 'failed', message })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(READS_IN_FLIGHT, links.length) }, worker))
  return out
}

export interface ChangeTickReport { tasks: number; read: number; written: number; woken: number }

export interface ChangeTickOptions {
  taskIds?: readonly string[]
  /** Read every link of the chosen tasks, due or not, settled ones included. */
  force?: boolean
  /** Read these URLs now. */
  forceUrls?: ReadonlySet<string>
  /** Called when the pass starts (it may wait behind another). */
  onStart?: () => void
}

let chain: Promise<unknown> = Promise.resolve()

/** One pass. Passes never overlap (a Refresh during a tick waits for it). */
export function changeWatchTick(deps: ChangeWatchDeps, opts: ChangeTickOptions = {}): Promise<ChangeTickReport> {
  const run = chain.then(() => { opts.onStart?.(); return tickOnce(deps, opts) })
  chain = run.catch(() => undefined)
  return run
}

async function tickOnce(deps: ChangeWatchDeps, opts: ChangeTickOptions): Promise<ChangeTickReport> {
  const report: ChangeTickReport = { tasks: 0, read: 0, written: 0, woken: 0 }
  if (!(await deps.enabled().catch(() => false))) return report
  ensureCoreChangeProviders()
  const now = deps.now()
  const wanted = opts.taskIds ? new Set(opts.taskIds) : null
  const all = await deps.openTasks()
  const tasks = all.filter((t) => (!wanted || wanted.has(t.id)) && t.phase !== 'COMPLETE')

  const due = new Map<RegisteredChangeProvider, Map<string, ReadLink>>()
  const perTask: Array<{ task: Readonly<Task>; links: Array<{ link: ChangeLink; provider?: RegisteredChangeProvider }> }> = []
  for (const task of tasks) {
    const links = taskChangeLinks(task.tags).map((link) => ({ link, provider: changeProviderFor(link) }))
    const stale = Object.keys(task.change_status ?? {}).some((url) => !links.some((l) => l.link.url === url))
    if (!links.some((l) => l.provider) && !stale) continue
    perTask.push({ task, links })
    for (const { link, provider } of links) {
      if (!provider) continue
      const snap = task.change_status?.[link.url]
      const at = dueAt(snap, link.url, now)
      if (!(opts.force || opts.forceUrls?.has(link.url) || (at !== null && at <= now))) continue
      let set = due.get(provider)
      if (!set) { set = new Map(); due.set(provider, set) }
      if (!set.has(link.url)) set.set(link.url, { ...link, ...(snap ? { prev: snap } : {}), ...(task.pr_status?.[link.url] ? { pr: task.pr_status[link.url] } : {}) })
    }
  }

  const results = new Map<string, ChangeReadResult>()
  await Promise.all([...due].map(async ([provider, links]) => {
    const answers = await readProvider(provider, [...links.values()])
    for (const url of links.keys()) {
      const r = answers.get(url)
      if (r) { results.set(url, r); retryAt.delete(url) }
      // Left out of the answer: asked again with the failed reads, not on every look.
      else retryAt.set(url, now + CHANGE_ERROR_EVERY_MS)
    }
  }))
  report.read = results.size

  const config = (await deps.config().catch(() => undefined)) ?? {}
  for (const { task, links } of perTask) {
    report.tasks++
    try {
      await settleTask(deps, task, links, results, now, config.wake_agent !== false, report)
    } catch (err) {
      log.task.warn('change-watch: task pass failed', { taskId: task.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  if (!wanted) {
    // Forget what no open task links any more.
    const held = new Set(all.filter((t) => t.phase !== 'COMPLETE').flatMap((t) => taskChangeLinks(t.tags).map((l) => l.url)))
    for (const map of [lastGood, nextDue, retryAt]) for (const url of map.keys()) if (!held.has(url)) map.delete(url)
  }
  if (report.read || report.written || report.woken) log.task.info('change-watch tick', { ...report })
  return report
}

async function settleTask(
  deps: ChangeWatchDeps,
  task: Readonly<Task>,
  links: Array<{ link: ChangeLink; provider?: RegisteredChangeProvider }>,
  results: Map<string, ChangeReadResult>,
  now: number,
  wakeAgent: boolean,
  report: ChangeTickReport,
): Promise<void> {
  const prevStatus = task.change_status ?? {}
  const planned: Array<{ url: string; next: ChangeSnapshot; news: ChangeNews[]; settledNow: boolean }> = []
  for (const { link, provider } of links) {
    const prev = prevStatus[link.url]
    if (!provider) { if (prev) planned.push({ url: link.url, next: prev, news: [], settledNow: false }); continue }
    const result = results.get(link.url)
    // Not answered and never read: nothing to store yet.
    if (!result && !prev) continue
    const next = plan(prev, link, provider.id, result, now)
    if (result) {
      if (result.ok) lastGood.set(link.url, now)
      nextDue.set(link.url, next.nextAt ? Date.parse(next.nextAt) : null)
    }
    const news = result ? changeNews(prev, next, { skipReview: !!task.pr_status?.[link.url] }) : []
    planned.push({ url: link.url, next, news, settledNow: !!prev && !changeSettled(prev) && changeSettled(next) })
  }

  const told = planned.filter((p) => p.news.length > 0)
  const wakeOn = wakeAgent && task.pr_wake !== false && task.org_role !== 'main' && task.org_role !== 'lead'
  if (told.length && wakeOn) {
    const target = await deps.deliveryTarget(task.id).catch(() => null)
    if (target) {
      const { buildWalnutMessage } = await import('../peers/walnut-message-tag.js')
      const body = told.map((p) => changeWakeLines(p.next, p.news, p.settledNow)).join('\n')
      const text = buildWalnutMessage({
        kind: 'trigger',
        attrs: { from: 'Walnut: change watch', about: told.map((p) => p.next.label).join(', '), note: 'news on a change linked to this task' },
        body,
      })
      const messageId = `change-watch-${createHash('sha1').update(`${task.id}\n${body}`).digest('hex').slice(0, 16)}`
      try {
        await deps.send(target.sessionId, text, task.id, messageId)
        report.woken++
        log.task.info('change-watch: session woken', { taskId: task.id, sessionId: target.sessionId, changes: told.map((p) => p.url), why: told.flatMap((p) => p.news.map((n) => n.kind)) })
      } catch (err) {
        // Keep what the session last heard, so the next read finds the same news and tells it again.
        log.task.warn('change-watch: wake failed, told again soon', { taskId: task.id, error: err instanceof Error ? err.message : String(err) })
        for (const p of told) {
          const prev = prevStatus[p.url]
          if (prev) p.next = prev
          nextDue.set(p.url, now + RETELL_MS)
        }
      }
    }
  }

  const nextStatus: Record<string, ChangeSnapshot> = {}
  for (const p of planned) nextStatus[p.url] = p.next
  const changed = Object.keys(prevStatus).length !== planned.length || planned.some((p) => !sameSnapshot(prevStatus[p.url], p.next))
  if (!changed) return
  await deps.writeTask(task.id, (current) => {
    // A link removed while this read ran is not written back.
    const held = new Set(taskChangeLinks(current.tags).map((l) => l.url))
    const keep: Record<string, ChangeSnapshot> = {}
    for (const [url, snap] of Object.entries(nextStatus)) if (held.has(url)) keep[url] = snap
    return Object.keys(keep).length ? { change_status: keep } : { change_status: undefined }
  })
  report.written++
}

/** The task's change links a provider reads, in tag order, with their last answer and next read. */
export async function taskChangeView(task: Pick<Task, 'tags' | 'change_status'>, deps: Pick<ChangeWatchDeps, 'enabled'> = defaultChangeWatchDeps()): Promise<{ enabled: boolean; changes: ChangeSnapshot[] }> {
  ensureCoreChangeProviders()
  const enabled = await deps.enabled().catch(() => false)
  const changes: ChangeSnapshot[] = []
  for (const link of taskChangeLinks(task.tags)) {
    const provider = changeProviderFor(link)
    if (!provider) continue
    const snap = task.change_status?.[link.url] ?? placeholder(link, provider.id)
    const good = lastGood.get(link.url)
    const { nextAt: storedNext, ...rest } = snap
    const next = snap.checkedAt && nextDue.has(link.url) ? nextDue.get(link.url) : storedNext ? Date.parse(storedNext) : null
    changes.push({
      ...rest,
      ...(good && snap.checkedAt ? { checkedAt: new Date(good).toISOString() } : {}),
      ...(next ? { nextAt: new Date(next).toISOString() } : {}),
    })
  }
  return { enabled, changes }
}

/** For tests. */
export function _resetChangeWatchForTesting(): void {
  lastGood.clear()
  nextDue.clear()
  retryAt.clear()
  queuedRefresh.clear()
  startedAt = null
  chain = Promise.resolve()
  deadlines.readMs = 90_000
}

/** For tests: a shorter read deadline. */
export function _setChangeDeadlinesForTesting(next: Partial<typeof deadlines>): void {
  Object.assign(deadlines, next)
}

/** For tests: what the watcher holds in memory per URL. */
export function _changeWatchMemoryForTesting(): { lastGood: string[]; nextDue: string[]; retryAt: string[] } {
  return { lastGood: [...lastGood.keys()], nextDue: [...nextDue.keys()], retryAt: [...retryAt.keys()] }
}

// ── Real wiring ──

export async function changeStatusEnabled(): Promise<boolean> {
  const { getConfig } = await import('../config-manager.js')
  const { experimentalEnabled } = await import('../experimental.js')
  return experimentalEnabled((await getConfig().catch(() => undefined))?.experimental, 'change_status')
}

export function defaultChangeWatchDeps(): ChangeWatchDeps {
  return {
    async openTasks() {
      const { listOpenTaskViews } = await import('../task-manager.js')
      return listOpenTaskViews(MAX_OPEN_TASKS)
    },
    async writeTask(id, patch) {
      const { updateTaskRaw } = await import('../task-manager.js')
      await updateTaskRaw(id, patch, { emitEvent: true, source: CHANGE_WATCH_SOURCE })
    },
    deliveryTarget: taskNewsTarget,
    send: (sessionId, text, taskId, messageId) => sendTaskNews(CHANGE_WATCH_SOURCE, sessionId, text, taskId, messageId),
    enabled: changeStatusEnabled,
    async config() {
      const { getConfig } = await import('../config-manager.js')
      return (await getConfig()).pull_requests
    },
    now: () => Date.now(),
  }
}

let started: { stop(): void; kick(opts: ChangeTickOptions): Promise<ChangeTickReport> } | null = null
/** A Refresh's forced read per task, while it has not started: a second Refresh joins it. */
const queuedRefresh = new Map<string, Promise<ChangeTickReport>>()

/** Start the watcher (idempotent): the periodic look, and a read of a task soon after it gains a change link. */
export async function startChangeWatch(deps: ChangeWatchDeps = defaultChangeWatchDeps()): Promise<NonNullable<typeof started>> {
  if (started) return started
  ensureCoreChangeProviders()
  startedAt = deps.now()
  const { runPeriodic } = await import('../periodic-task.js')
  const { PR_WATCH_SOURCE } = await import('../pull-requests/pr-watch.js')
  const handle = runPeriodic('change-watch', CHANGE_WATCH_TICK_MS, 90_000, async () => {
    await changeWatchTick(deps).catch((err) => log.task.warn('change-watch tick failed', { error: err instanceof Error ? err.message : String(err) }))
  })
  const unfollow = await followTaskLinks(CHANGE_WATCH_SOURCE, (task, eventSource) => {
    const links = taskChangeLinks(task.tags).filter((l) => changeProviderFor(l))
    const known = task.change_status ?? {}
    // A new change link (read now, whatever another task's read of it said), a removed one whose
    // snapshot should go, or a pull request the pull request watch just read again (its review is
    // this card's review too).
    const fresh = links.filter((l) => !known[l.url]).map((l) => l.url)
    const removed = Object.keys(known).some((url) => !links.some((l) => l.url === url))
    const prMoved = eventSource === PR_WATCH_SOURCE ? links.filter((l) => task.pr_status?.[l.url]).map((l) => l.url) : []
    return fresh.length || removed || prMoved.length ? [...fresh, ...prMoved] : null
  }, (taskIds, forceUrls) => { void changeWatchTick(deps, { taskIds, forceUrls }).catch(() => undefined) })
  started = {
    stop() { handle.stop(); unfollow(); started = null; startedAt = null },
    kick: (opts) => changeWatchTick(deps, opts),
  }
  return started
}

export function changeWatchRunning(): boolean {
  return started !== null
}

/** Read one task's changes now (the card's Refresh), only where the watcher runs. A Refresh while
 *  another for the same task still waits its turn joins it. */
export function refreshTaskChanges(taskId: string): Promise<ChangeTickReport | null> {
  if (!started) return Promise.resolve(null)
  const queued = queuedRefresh.get(taskId)
  if (queued) return queued
  const run = started.kick({ taskIds: [taskId], force: true, onStart: () => { if (queuedRefresh.get(taskId) === run) queuedRefresh.delete(taskId) } })
  queuedRefresh.set(taskId, run)
  run.catch(() => undefined).finally(() => { if (queuedRefresh.get(taskId) === run) queuedRefresh.delete(taskId) })
  return run
}

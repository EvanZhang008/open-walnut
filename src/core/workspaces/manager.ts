/**
 * Task workspaces, the server half: request, create, launch-when-ready, probe
 * and remove. The cleanup after a task's completion or deletion is cleanup.ts.
 *
 * The server decides and records; the task's host does the work through its
 * daemon (workspace-core.ts). Creation and removal are daemon JOBS: the server
 * starts one, then polls it, so a slow provider (minutes for a monorepo tool)
 * never pins a request. Every state change lands on the task row
 * (`task.workspace`) and reaches the browser as an ordinary task:updated.
 *
 * Restart safety: the job id is on the task, so a restarted server picks up a
 * creating/removing workspace where it was (resumeWorkspaces). A job the daemon
 * no longer knows (its daemon restarted) fails with a Retry; a retried git
 * creation adopts a worktree that did get made.
 */

import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Task } from '../types.js'
import type { TaskWorkspace, WorkspacePendingStart, WorkspaceProbeSummary } from './types.js'
import { workspaceRpc, WorkspaceError, replyError, hostLabel } from './daemon-client.js'
import { findProvider, validateInputs, workspaceProviderCatalog, GIT_WORKTREE_ID } from './registry.js'
import { cleanupDecision, isLaunchReady, keptReason, workspaceName, isBusy, type CleanupTrigger } from './decisions.js'
import { log } from '../../logging/index.js'

const POLL_MS = 1_500
export const START_RPC_MS = 30_000
const JOB_RPC_MS = 10_000
const STATUS_RPC_MS = 90_000
/** The confirm dialog's probe: below the route's deadline, which is below the browser's patience. */
export const PREVIEW_RPC_MS = 20_000
export const LOST_SLACK_MS = 5 * 60_000

export interface WorkspaceManagerDeps {
  getTask(id: string): Promise<Task | null>
  /** Read-modify-write `task.workspace` under the task lock; returning null writes nothing. */
  write(taskId: string, fn: (cur: TaskWorkspace | undefined, task: Readonly<Task>) => TaskWorkspace | null): Promise<Task | null>
  rpc(host: string, cmd: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>>
  /** Start the session that waited for the workspace. Throws with the reason it could not. */
  launch(task: Task, ws: TaskWorkspace, pending: WorkspacePendingStart): Promise<void>
  /** A session of the task is mid-turn. */
  sessionBusy(taskId: string): Promise<boolean>
  /** A session of the task is alive (its start already happened). */
  hasLiveSession(taskId: string): Promise<boolean>
  notify(input: { title: string; body: string; dedupKey: string; taskId?: string; severity: 'info' | 'warning' }): Promise<void>
  listTasks(): Promise<Task[]>
  /** The realpath of this server's WALNUT_HOME (a workspace records the one that made it). */
  walnutHome(): Promise<string>
  cloudMode(): boolean
  now(): number
  sleep(ms: number): Promise<void>
  jobId(): string
}

const realDeps: WorkspaceManagerDeps = {
  async getTask(id) {
    const { getTask } = await import('../task-manager.js')
    try { return await getTask(id) } catch { return null }
  },
  async write(taskId, fn) {
    const { updateTaskRaw } = await import('../task-manager.js')
    // Silent write + our own TASK_UPDATED: emitEvent would announce a COMPLETE
    // task as task:completed again, which other subscribers read as a fresh completion.
    const res = await updateTaskRaw(taskId, (current) => {
      const next = fn(current.workspace, current)
      return next ? { workspace: next } : null
    }, { source: 'workspace' })
    if (!res.changed || !res.task) return null
    const { bus, EventNames } = await import('../event-bus.js')
    bus.emit(EventNames.TASK_UPDATED, { task: res.task }, ['web-ui'], { source: 'workspace' })
    return res.task
  },
  rpc: workspaceRpc,
  async launch(task, ws, pending) {
    if (pending.via === 'task-start') {
      const { startSessionForTask } = await import('../sessions/task-start.js')
      await startSessionForTask({
        taskIdPrefix: task.id, message: pending.message, model: pending.model, mode: pending.mode,
        engine: pending.engine as never, callerSid: pending.caller_sid, expectReply: pending.expect_reply,
        replyTimeoutSecs: pending.reply_timeout_secs, source: pending.source ?? 'workspace',
      })
      return
    }
    const { quickStartSession } = await import('../sessions/quick-start.js')
    await quickStartSession({
      message: pending.message, messagePrefix: pending.messagePrefix,
      cwd: ws.cwd!, host: ws.host === '__local__' ? undefined : ws.host,
      model: pending.model, mode: pending.mode, existingTaskId: task.id,
      source: pending.source ?? 'workspace', engine: pending.engine as never,
      ...(pending.session_id ? { preassignedSessionId: pending.session_id } : {}),
    })
  },
  async sessionBusy(taskId) {
    const { getSessionsForTask } = await import('../session-tracker.js')
    return (await getSessionsForTask(taskId)).some((s) => !s.archived && s.process_status === 'running')
  },
  async hasLiveSession(taskId) {
    const { getSessionsForTask } = await import('../session-tracker.js')
    return (await getSessionsForTask(taskId)).some((s) => !s.archived && (s.process_status === 'running' || s.process_status === 'idle'))
  },
  async notify(input) {
    const { addNotification } = await import('../notifications/store.js')
    await addNotification({ kind: 'cron', ...input })
  },
  async listTasks() {
    const { listTasks } = await import('../task-manager.js')
    return listTasks()
  },
  walnutHome: () => (ownHome ??= (async () => {
    const { WALNUT_HOME } = await import('../../constants.js')
    try { return await fs.promises.realpath(WALNUT_HOME) } catch { return path.resolve(WALNUT_HOME) }
  })()),
  cloudMode: () => process.env.WALNUT_CLOUD_MODE === '1',
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  jobId: () => `ws-${Date.now().toString(36)}-${randomBytes(5).toString('hex')}`,
}

let ownHome: Promise<string> | null = null
let deps: WorkspaceManagerDeps = realDeps

/** The live deps, for cleanup.ts and launch.ts. */
export function managerDeps(): WorkspaceManagerDeps {
  return deps
}

/** Test-only: swap the store, the daemon and the clock (null restores them). */
export function __setWorkspaceManagerDepsForTesting(next: Partial<WorkspaceManagerDeps> | null): void {
  deps = next ? { ...realDeps, ...next } : realDeps
  drivers.clear()
  kickedAgain.clear()
}

/**
 * One background driver per task: a second kick joins the first, and the driver
 * looks once more when it ends (a removal begun while a creation's driver was
 * finishing must not be lost).
 */
const drivers = new Map<string, Promise<void>>()
const kickedAgain = new Set<string>()

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function stamp(ws: TaskWorkspace, patch: Partial<TaskWorkspace>): TaskWorkspace {
  const next: TaskWorkspace = { ...ws, ...patch, updated_at: new Date(deps.now()).toISOString() }
  for (const k of Object.keys(next) as Array<keyof TaskWorkspace>) if (next[k] === undefined) delete next[k]
  return next
}

async function taskOrThrow(taskId: string): Promise<Task> {
  const task = await deps.getTask(taskId)
  if (!task) throw new WorkspaceError(`Task ${taskId} not found`, 404, 'not-found')
  return task
}

/**
 * Made by this Walnut? A test server over copied tasks keeps the real HOME, so a
 * copied row names the user's real folders: only the Walnut that made a workspace
 * resumes, launches, cleans up or removes it. A row without a home fails closed.
 */
export async function madeHere(ws: TaskWorkspace): Promise<boolean> {
  return !!ws.home && ws.home === await deps.walnutHome()
}

async function assertMadeHere(ws: TaskWorkspace): Promise<void> {
  if (await madeHere(ws)) return
  throw new WorkspaceError(`This workspace was made by another Walnut (${ws.home ?? 'unknown'}), so this one will not change it.`, 409, 'other-walnut')
}

function refuseInCloud(): void {
  if (deps.cloudMode()) throw new WorkspaceError('Isolated workspaces are made by the Walnut on your Mac.', 409, 'cloud')
}

export interface WorkspaceRequest {
  provider: string
  /** '__local__' or a config.hosts key. Default: the task's launch host. */
  host?: string
  /** The folder to make it from. Default: the task's cwd. */
  anchor?: string
  inputs?: unknown
  pending?: WorkspacePendingStart
}

/** Ask for a workspace and start making it. Answers at once with the task (state `creating`). */
export async function requestWorkspace(taskId: string, req: WorkspaceRequest): Promise<Task> {
  refuseInCloud()
  const task = await taskOrThrow(taskId)
  const provider = await findProvider(req.provider)
  if (!provider) throw new WorkspaceError(`Unknown workspace provider: ${req.provider}`, 400, 'unknown-provider')
  const inputs = validateInputs(provider.inputSchema, req.inputs)
  if (typeof inputs === 'string') throw new WorkspaceError(inputs, 400, 'bad-inputs')
  const anchor = (req.anchor ?? task.cwd ?? '').trim()
  if (!anchor || (!anchor.startsWith('/') && !anchor.startsWith('~/'))) {
    throw new WorkspaceError('An isolated workspace needs the task\'s folder (an absolute path).', 400, 'no-folder')
  }
  const host = req.host && req.host !== 'local' ? req.host : '__local__'
  const cur = task.workspace
  if (cur && isBusy(cur.state)) throw new WorkspaceError(`This task's workspace is ${cur.state === 'creating' ? 'being prepared' : 'being removed'}.`, 409, 'busy')
  if (cur && isLaunchReady(cur)) throw new WorkspaceError(`This task already has a workspace at ${cur.root}.`, 409, 'exists')
  const jobId = deps.jobId()
  const now = new Date(deps.now()).toISOString()
  const home = await deps.walnutHome()
  const written = await deps.write(task.id, (latest) => {
    if (latest && (isBusy(latest.state) || isLaunchReady(latest))) return null
    return {
      provider: provider.id, provider_name: provider.displayName, host, home, anchor,
      repos: [], ...(Object.keys(inputs).length ? { inputs } : {}),
      state: 'creating', job_id: jobId, progress: 'Starting',
      // The same request retried after a failure keeps its name, so it finds the same place.
      name: latest && latest.provider === provider.id && latest.anchor === anchor && latest.name
        ? latest.name : workspaceName(task, req.pending?.message),
      ...(req.pending ?? latest?.pending_start ? { pending_start: req.pending ?? latest!.pending_start } : {}),
      created_at: now, updated_at: now,
    }
  })
  if (!written) throw new WorkspaceError('This task\'s workspace changed meanwhile; reload and try again.', 409, 'conflict')
  log.web.info('workspace requested', { taskId: task.id, provider: provider.id, host, anchor, jobId })
  void drive(task.id)
  return written
}

/**
 * A launch's request was refused before any row was written (no folder, a refusal
 * the plan could not foresee): record it as a failed workspace holding the launch,
 * so the task shows the error with Retry, which replays the launch once it works.
 */
export async function recordRequestFailure(taskId: string, req: { provider: string; host?: string; anchor: string; inputs?: unknown },
  pending: WorkspacePendingStart, err: WorkspaceError): Promise<Task | null> {
  const provider = await findProvider(req.provider)
  const task = await deps.getTask(taskId)
  if (!task || !provider) return task
  const inputs = validateInputs(provider.inputSchema, req.inputs)
  const now = new Date(deps.now()).toISOString()
  const home = await deps.walnutHome()
  const written = await deps.write(taskId, (latest) => (latest && latest.state !== 'removed' ? null : {
    provider: provider.id, provider_name: provider.displayName, host: req.host && req.host !== 'local' ? req.host : '__local__', home,
    anchor: req.anchor, repos: [], ...(typeof inputs !== 'string' && Object.keys(inputs).length ? { inputs } : {}),
    state: 'failed', error: err.message, error_code: err.code, name: workspaceName(task, pending.message),
    pending_start: pending, created_at: now, updated_at: now,
  }))
  return written ?? task
}

/** Retry a failed creation, or a session that could not start in a ready workspace. */
export async function retryWorkspace(taskId: string): Promise<Task> {
  const task = await taskOrThrow(taskId)
  const ws = task.workspace
  if (!ws) throw new WorkspaceError('This task has no workspace.', 404, 'none')
  if (isLaunchReady(ws) && ws.pending_start) {
    await assertMadeHere(ws)
    void launchPending(task.id)
    return task
  }
  if (ws.state !== 'failed' && ws.state !== 'requested') throw new WorkspaceError(`Nothing to retry: the workspace is ${ws.state}.`, 409, 'not-failed')
  return requestWorkspace(taskId, { provider: ws.provider, host: ws.host, anchor: ws.anchor, inputs: ws.inputs })
}

/** Remember a start that waits for the workspace; kicks creation when nothing is making it yet. */
export async function deferStart(taskId: string, pending: WorkspacePendingStart): Promise<Task> {
  const task = await taskOrThrow(taskId)
  const ws = task.workspace
  if (!ws) throw new WorkspaceError('This task has no workspace.', 404, 'none')
  if (ws.state === 'removing') throw new WorkspaceError('This task\'s workspace is being removed; start the session after it is gone.', 409, 'busy')
  if (ws.state === 'creating') {
    // Another Walnut's creation is never driven here, so a start must not wait on it.
    await assertMadeHere(ws)
    const written = await deps.write(task.id, (latest) => (latest?.state === 'creating' ? stamp(latest, { pending_start: pending }) : null))
    return written ?? task
  }
  return requestWorkspace(taskId, { provider: ws.provider, host: ws.host, anchor: ws.anchor, inputs: ws.inputs, pending })
}

export function drive(taskId: string): Promise<void> {
  const running = drivers.get(taskId)
  if (running) {
    kickedAgain.add(taskId)
    return running
  }
  const p = (async () => {
    try {
      const task = await deps.getTask(taskId)
      const ws = task?.workspace
      if (!task || !ws) return
      if (!(await madeHere(ws))) {
        log.web.info('workspace job left alone: another Walnut made it', { taskId, home: ws.home, state: ws.state })
        return
      }
      if (ws.state === 'creating') await runCreate(task, ws)
      else if (ws.state === 'removing') await runRemove(task, ws)
    } catch (err) {
      log.web.warn('workspace driver failed', { taskId, error: errText(err) })
    } finally {
      drivers.delete(taskId)
      if (kickedAgain.delete(taskId)) void drive(taskId)
    }
  })()
  drivers.set(taskId, p)
  return p
}

type JobOutcome =
  | { state: 'done'; result: Record<string, unknown> }
  | { state: 'failed'; error: string; code?: string; result?: Record<string, unknown> }
  | { state: 'lost'; error: string }

export async function pollJob(host: string, jobId: string, lostAfterMs: number, onProgress: (p: string) => Promise<void>): Promise<JobOutcome> {
  let lastAnswer = deps.now()
  let lastProgress: string | undefined
  let lastError = ''
  for (;;) {
    await deps.sleep(POLL_MS)
    try {
      const res = await deps.rpc(host, 'workspace.job', { jobId }, JOB_RPC_MS)
      if (!res.ok) throw new Error(replyError(res, 'job poll refused'))
      lastAnswer = deps.now()
      const job = res.job as Record<string, unknown> | null
      if (!job) return { state: 'lost', error: `${hostLabel(host)} has no record of this job (its Walnut daemon may have restarted). Retry to start over.` }
      if (job.state === 'running') {
        const progress = typeof job.progress === 'string' ? job.progress : undefined
        if (progress && progress !== lastProgress) {
          lastProgress = progress
          await onProgress(progress).catch(() => {})
        }
        continue
      }
      if (job.state === 'done') return { state: 'done', result: (job.result as Record<string, unknown>) ?? {} }
      return {
        state: 'failed', error: typeof job.error === 'string' ? job.error : 'the host reported a failure',
        ...(typeof job.code === 'string' ? { code: job.code } : {}),
        ...(job.result && typeof job.result === 'object' ? { result: job.result as Record<string, unknown> } : {}),
      }
    } catch (err) {
      lastError = errText(err)
      if (deps.now() - lastAnswer > lostAfterMs) {
        return { state: 'lost', error: `Lost contact with ${hostLabel(host)} (${lastError}). Retry once it is back.` }
      }
    }
  }
}

async function createBudgetMs(provider: string): Promise<number> {
  if (provider === GIT_WORKTREE_ID) return 10 * 60_000 + LOST_SLACK_MS
  const spec = (await workspaceProviderCatalog()).config.providers.find((p) => p.id === provider)
  return ((spec?.timeouts?.createSec ?? 180) * 1000) + LOST_SLACK_MS
}

async function runCreate(task: Task, ws: TaskWorkspace): Promise<void> {
  const jobId = ws.job_id!
  const isGit = ws.provider === GIT_WORKTREE_ID
  const baseRef = isGit && typeof ws.inputs?.baseRef === 'string' ? ws.inputs.baseRef : undefined
  const params: Record<string, unknown> = {
    provider: ws.provider, jobId, anchor: ws.anchor, name: ws.name ?? task.id, taskId: task.id, title: task.title,
    ...(baseRef ? { baseRef } : {}),
    ...(!isGit ? { inputs: ws.inputs ?? {} } : {}),
  }
  const fail = async (error: string, code?: string) => {
    log.web.warn('workspace creation failed', { taskId: task.id, provider: ws.provider, host: ws.host, jobId, error, code })
    await deps.write(task.id, (cur) => (cur?.job_id === jobId && cur.state === 'creating'
      ? stamp(cur, { state: 'failed', error, error_code: code, progress: undefined })
      : null))
  }
  let startError: string | undefined
  try {
    const res = await deps.rpc(ws.host, 'workspace.create', params, START_RPC_MS)
    if (!res.ok) return fail(replyError(res, 'the host refused to start it'), typeof res.code === 'string' ? res.code : undefined)
  } catch (err) {
    // The job may have started anyway (a lost answer): ask for it before giving up.
    startError = errText(err)
    if (err instanceof WorkspaceError && (err.code === 'daemon-upgrade' || err.code === 'unknown-host')) return fail(err.message, err.code)
  }
  const outcome = await pollJob(ws.host, jobId, await createBudgetMs(ws.provider), async (progress) => {
    await deps.write(task.id, (cur) => (cur?.job_id === jobId && cur.state === 'creating' ? stamp(cur, { progress }) : null))
  })
  if (outcome.state !== 'done') return fail(outcome.state === 'lost' && startError ? `Could not reach ${hostLabel(ws.host)}: ${startError}` : outcome.error, outcome.state === 'failed' ? outcome.code : 'lost')
  const r = outcome.result
  const repos = Array.isArray(r.repos) ? (r.repos as TaskWorkspace['repos']) : []
  const ready = await deps.write(task.id, (cur) => (cur?.job_id === jobId && cur.state === 'creating'
    ? stamp(cur, {
      state: 'ready', root: String(r.root), cwd: String(r.cwd ?? r.root),
      branch: typeof r.branch === 'string' ? r.branch : undefined,
      base_ref: r.baseRef && typeof r.baseRef === 'object' ? r.baseRef as TaskWorkspace['base_ref'] : undefined,
      source_repo: typeof r.sourceRepo === 'string' ? r.sourceRepo : undefined,
      repos, progress: undefined, error: undefined, error_code: undefined, launch_error: undefined,
    })
    : null))
  if (!ready) {
    // The task was deleted (or its workspace replaced) while the host was making it.
    if (!(await deps.getTask(task.id))) {
      const { cleanupForDeletedTask } = await import('./cleanup.js')
      await cleanupForDeletedTask(task, { ...ws, state: 'ready', root: String(r.root), cwd: String(r.cwd ?? r.root), repos,
        branch: typeof r.branch === 'string' ? r.branch : undefined, source_repo: typeof r.sourceRepo === 'string' ? r.sourceRepo : undefined,
        base_ref: r.baseRef as TaskWorkspace['base_ref'] })
    }
    return
  }
  log.web.info('workspace ready', { taskId: task.id, provider: ws.provider, host: ws.host, root: r.root, cwd: r.cwd })
  if (ready.phase === 'COMPLETE') {
    // Completed while the host was making it: its start is moot, and the completion
    // cleanup (which skipped a workspace still being made) runs now.
    await deps.write(task.id, (cur) => (cur?.pending_start ? stamp(cur, { pending_start: undefined }) : null))
    const { onTaskCompleted } = await import('./cleanup.js')
    void onTaskCompleted(task.id)
    return
  }
  if (ready.workspace?.pending_start) await launchPending(task.id)
}

/** Start the session that waited for the workspace (once: a live session means it already started). */
const launching = new Set<string>()

export async function launchPending(taskId: string): Promise<void> {
  if (launching.has(taskId)) return
  launching.add(taskId)
  try {
    await launchPendingOnce(taskId)
  } finally {
    launching.delete(taskId)
  }
}

async function launchPendingOnce(taskId: string): Promise<void> {
  const task = await deps.getTask(taskId)
  const ws = task?.workspace
  const pending = ws?.pending_start
  if (!task || !ws || !pending || !isLaunchReady(ws)) return
  if (!(await madeHere(ws))) return
  if (task.phase === 'COMPLETE') {
    await deps.write(task.id, (cur) => (cur?.pending_start ? stamp(cur, { pending_start: undefined }) : null))
    return
  }
  if (await deps.hasLiveSession(task.id)) {
    await deps.write(task.id, (cur) => (cur?.pending_start ? stamp(cur, { pending_start: undefined, launch_error: undefined }) : null))
    return
  }
  try {
    await deps.launch(task, ws, pending)
    await deps.write(task.id, (cur) => (cur ? stamp(cur, { pending_start: undefined, launch_error: undefined }) : null))
    log.web.info('workspace session started', { taskId: task.id, cwd: ws.cwd, host: ws.host, via: pending.via })
  } catch (err) {
    const message = errText(err)
    log.web.warn('workspace session could not start', { taskId: task.id, cwd: ws.cwd, host: ws.host, error: message })
    await deps.write(task.id, (cur) => (cur ? stamp(cur, { launch_error: message }) : null))
  }
}

function summarize(raw: Record<string, unknown>): WorkspaceProbeSummary {
  const repos = Array.isArray(raw.repos) ? raw.repos as WorkspaceProbeSummary['repos'] : []
  return {
    rootExists: raw.rootExists === true,
    clean: raw.clean === true,
    merged: raw.merged === true,
    problems: Array.isArray(raw.problems) ? (raw.problems as unknown[]).map(String) : [],
    repos: repos.map((r) => ({
      path: r.path, ...(r.name ? { name: r.name } : {}), dirty: !!r.dirty, changes: Number(r.changes) || 0, unreadable: !!r.unreadable,
      merged: r.merged ?? null, exists: !!r.exists,
      ...(Array.isArray(r.ignored) ? { ignored: r.ignored.slice(0, 8).map(String), ignoredCount: Number(r.ignoredCount) || r.ignored.length } : {}),
    })),
    ...(typeof raw.branch === 'string' ? { branch: raw.branch } : {}),
    ...(raw.branchMerged !== undefined ? { branchMerged: raw.branchMerged as boolean | null } : {}),
  }
}

export function probeParams(ws: TaskWorkspace): Record<string, unknown> {
  return {
    provider: ws.provider, root: ws.root, repos: ws.repos, anchor: ws.anchor,
    ...(ws.branch ? { branch: ws.branch } : {}),
    ...(ws.source_repo ? { sourceRepo: ws.source_repo } : {}),
    ...(ws.base_ref ? { baseRef: ws.base_ref } : {}),
    ...(ws.inputs ? { inputs: ws.inputs } : {}),
  }
}

/** Check every repository of the workspace on its host. */
export async function probeWorkspace(ws: TaskWorkspace, timeoutMs = STATUS_RPC_MS): Promise<WorkspaceProbeSummary> {
  if (!ws.root) throw new WorkspaceError('This workspace has no folder yet.', 409, 'no-root')
  const res = await deps.rpc(ws.host, 'workspace.status', probeParams(ws), timeoutMs)
  if (!res.ok) throw new WorkspaceError(`Could not check the workspace: ${replyError(res, 'the host refused')}`, 502, 'probe-failed')
  return summarize(res.probe as Record<string, unknown>)
}

/** What removing this task's workspace would do, for the confirm dialog. */
export async function removalPreview(taskId: string): Promise<{ task: Task; probe: WorkspaceProbeSummary; decision: ReturnType<typeof cleanupDecision> }> {
  refuseInCloud()
  const task = await taskOrThrow(taskId)
  const ws = task.workspace
  if (!ws || !isLaunchReady(ws)) throw new WorkspaceError('This task has no workspace to remove.', 409, 'none')
  await assertMadeHere(ws)
  const probe = await probeWorkspace(ws, PREVIEW_RPC_MS)
  return { task, probe, decision: cleanupDecision(ws, probe, 'manual') }
}

/**
 * Mark it removing and start the driver. The daemon re-checks before it deletes.
 * `still` runs inside the same locked write (a completion passes "the task is
 * still COMPLETE", so a reopen in between wins).
 */
export async function beginRemoval(task: Task, ws: TaskWorkspace, trigger: 'manual' | 'complete',
  still?: (task: Readonly<Task>) => boolean): Promise<Task | null> {
  const jobId = deps.jobId()
  const from = ws.state === 'kept' ? 'kept' : 'ready'
  const written = await deps.write(task.id, (cur, row) => (cur && isLaunchReady(cur) && cur.root === ws.root && (!still || still(row))
    ? stamp(cur, { state: 'removing', job_id: jobId, removal: { trigger, from }, progress: 'Checking every repository', error: undefined })
    : null))
  if (written) void drive(task.id)
  return written
}

/**
 * The user's "Remove workspace…", after the confirm dialog showed the plan. It
 * answers at once: the host probes again and refuses when anything would be lost,
 * and the row (state, then the error) tells the UI how it went.
 */
export async function removeWorkspaceManually(taskId: string): Promise<Task> {
  refuseInCloud()
  const task = await taskOrThrow(taskId)
  const ws = task.workspace
  if (!ws || !isLaunchReady(ws)) throw new WorkspaceError('This task has no workspace to remove.', 409, 'none')
  await assertMadeHere(ws)
  if (await deps.sessionBusy(task.id)) throw new WorkspaceError('A session of this task is working in the workspace right now. Stop it first.', 409, 'session-busy')
  const written = await beginRemoval(task, ws, 'manual')
  if (!written) throw new WorkspaceError('This task\'s workspace changed meanwhile; reload and try again.', 409, 'conflict')
  log.web.info('workspace manual removal started', { taskId: task.id, root: ws.root, provider: ws.provider })
  return written
}

async function runRemove(task: Task, ws: TaskWorkspace): Promise<void> {
  const jobId = ws.job_id!
  const trigger = ws.removal?.trigger ?? 'manual'
  const from = ws.removal?.from ?? 'ready'
  const settle = (patch: Partial<TaskWorkspace>) => deps.write(task.id, (cur) => (cur?.job_id === jobId && cur.state === 'removing'
    ? stamp(cur, { removal: undefined, progress: undefined, ...patch })
    : null))
  const refuse = async (error: string, code?: string) => {
    log.web.info('workspace kept', { taskId: task.id, trigger, error, code })
    const kept = code === 'not_clean' || code === 'not_merged'
    if (kept && trigger === 'complete') await settle({ state: 'kept', kept_reason: keptReason(error) })
    else await settle({ state: from, error: kept ? `Not removed: ${keptReason(error)}` : `Could not remove it: ${error}` })
  }
  try {
    // A plugin workspace's unpushed work lives only in its folder: merged is required
    // for it even by hand. A git worktree removed by hand keeps its branch instead.
    const res = await deps.rpc(ws.host, 'workspace.remove', {
      ...probeParams(ws), jobId, deleteBranch: 'if-merged', requireMerged: trigger !== 'manual' || ws.provider !== GIT_WORKTREE_ID,
    }, START_RPC_MS)
    if (!res.ok) return void await refuse(replyError(res, 'the host refused'), typeof res.code === 'string' ? res.code : undefined)
  } catch (err) {
    if (err instanceof WorkspaceError && err.code !== 'host-timeout') return void await refuse(err.message, err.code)
  }
  const outcome = await pollJob(ws.host, jobId, 10 * 60_000 + LOST_SLACK_MS, async (progress) => {
    await deps.write(task.id, (cur) => (cur?.job_id === jobId && cur.state === 'removing' ? stamp(cur, { progress }) : null))
  })
  if (outcome.state === 'done') {
    const branchKept = outcome.result.branchKept === true
    log.web.info('workspace removed', { taskId: task.id, root: ws.root, trigger, branchKept })
    await settle({ state: 'removed', branch_kept: branchKept || undefined, error: undefined, kept_reason: undefined, launch_error: undefined, pending_start: undefined })
    return
  }
  await refuse(outcome.error, outcome.state === 'failed' ? outcome.code : 'lost')
}

/** Test seam: wait for a task's driver to finish. */
export async function __settleWorkspaceDriver(taskId: string): Promise<void> {
  await drivers.get(taskId)
}

export type { CleanupTrigger }

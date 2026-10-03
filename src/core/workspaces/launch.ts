/**
 * Task workspaces at the start paths. Each start path calls ONE function here:
 *
 *   quick-start route   workspaceLaunchPlan: a draft that asked for an isolated
 *                       workspace files its task now and starts the session once
 *                       the workspace is ready, in it; an existing task with a
 *                       ready workspace launches in it.
 *   task-start          deferTaskStart (a start of a task whose workspace is not
 *                       ready waits for it) and workspaceStartPlace (a ready one
 *                       is where it runs: cwd and host as one pair).
 *   mobile launch       mobileWorkspacePlace (same rule; a phone does not wait).
 *
 * A session never starts half-way: until the workspace is ready the task shows
 * "Preparing workspace…", and a failure shows the provider's error with Retry.
 */

import type { Task } from '../types.js'
import type { TaskWorkspace, WorkspacePendingStart } from './types.js'
import { QuickStartError } from '../sessions/quick-start.js'
import { WorkspaceError } from './daemon-client.js'
import { findProvider, validateInputs } from './registry.js'
import { belongsToWorkspace, isLaunchReady, needsCreation } from './decisions.js'
import { deferStart, managerDeps, recordRequestFailure, requestWorkspace } from './manager.js'

function normHost(host: string | undefined | null): string {
  return !host || host === 'local' ? '__local__' : host
}

function insideRoot(ws: TaskWorkspace, p: string | undefined): boolean {
  if (!p || !ws.root) return false
  const root = ws.root.replace(/\/+$/, '')
  const target = p.replace(/\/+$/, '')
  return target === root || target.startsWith(root + '/')
}

async function organizeUnfiled(taskId: string, cwd: string, message: string): Promise<void> {
  try {
    const { backgroundAiDisabled } = await import('../cheap-model.js')
    if (backgroundAiDisabled()) return
    const { organizeQuickStartTask } = await import('../session-organize.js')
    await organizeQuickStartTask(taskId, cwd, message)
  } catch { /* best effort, like the quick-start pass it stands in for */ }
}

function asQuickStartError(err: unknown): unknown {
  return err instanceof WorkspaceError ? new QuickStartError(err.message, err.status, { error: err.message, code: err.code, ...(err.data ?? {}) }) : err
}

/** A ready workspace's cwd, for a task in the parent chain (recordedCwd). */
export function workspaceCwdOf(task: Pick<Task, 'workspace'>): string | undefined {
  return isLaunchReady(task.workspace) ? task.workspace.cwd : undefined
}

/** Where a start of this task runs when its workspace is ready; null when it is not, or the start names another place. */
export function workspaceStartPlace(task: Pick<Task, 'workspace'>, params: { cwd?: string; host?: string }): { cwd: string; host: string } | null {
  const ws = task.workspace
  if (!isLaunchReady(ws)) return null
  if (params.cwd !== undefined && !belongsToWorkspace(ws, params.cwd)) return null
  if (params.host !== undefined && normHost(params.host) !== ws.host) return null
  return { cwd: insideRoot(ws, params.cwd) ? params.cwd! : ws.cwd, host: ws.host === '__local__' ? '' : ws.host }
}

export interface DeferredTaskStart { taskId: string; title: string; started: false; preparing: true }

/** task_start of a task whose workspace is not ready: remember the start, make the workspace, start then. */
export async function deferTaskStart(task: Task, params: {
  message?: string; model?: string; mode?: string; engine?: string; cwd?: string
  callerSid?: string; expectReply?: boolean; replyTimeoutSecs?: number; source: string
}): Promise<DeferredTaskStart | null> {
  const ws = task.workspace
  if (!ws || (params.cwd !== undefined && !belongsToWorkspace(ws, params.cwd))) return null
  if (ws.state === 'removing') throw new QuickStartError('This task\'s workspace is being removed; start the session after it is gone.', 409)
  if (ws.state !== 'creating' && !needsCreation(ws)) return null
  const pending: WorkspacePendingStart = {
    via: 'task-start',
    message: params.message?.trim() || task.description || `Working on task: ${task.title}`,
    ...(params.model ? { model: params.model } : {}),
    ...(params.mode ? { mode: params.mode } : {}),
    ...(params.engine ? { engine: params.engine } : {}),
    ...(params.callerSid ? { caller_sid: params.callerSid } : {}),
    ...(params.expectReply !== undefined ? { expect_reply: params.expectReply } : {}),
    ...(params.replyTimeoutSecs !== undefined ? { reply_timeout_secs: params.replyTimeoutSecs } : {}),
    source: params.source,
    at: new Date().toISOString(),
  }
  try {
    await deferStart(task.id, pending)
  } catch (err) {
    throw asQuickStartError(err)
  }
  return { taskId: task.id, title: task.title, started: false, preparing: true }
}

/** The phone's launch on an existing task: a ready workspace is where it runs; a phone does not wait for one. */
export async function mobileWorkspacePlace(taskId: string, cwd: string, host: string | undefined): Promise<{ cwd: string; host: string | undefined } | null> {
  const task = await managerDeps().getTask(taskId)
  const ws = task?.workspace
  if (!ws || !belongsToWorkspace(ws, cwd)) return null
  if (!isLaunchReady(ws)) {
    const what = ws.state === 'creating' ? 'is still being prepared; try again in a moment'
      : ws.state === 'removing' ? 'is being removed'
        : ws.state === 'removed' ? 'was removed (start the task on your Mac to make a new one)'
          : 'is not ready (open the task on your Mac to retry it)'
    throw new QuickStartError(`This task's isolated workspace ${what}.`, 409)
  }
  if (host !== undefined && normHost(host) !== ws.host) {
    throw new QuickStartError(`This task's workspace lives on ${ws.host === '__local__' ? 'this Mac' : ws.host}.`, 409)
  }
  return { cwd: insideRoot(ws, cwd) ? cwd : ws.cwd, host: ws.host === '__local__' ? undefined : ws.host }
}

export interface QuickStartWorkspacePlan {
  /** Answer this instead (a refusal). */
  refuse?: { status: number; body: Record<string, unknown> }
  /** Launch now, here (an existing task's ready workspace). */
  cwd?: string
  /** File the task without starting; `begin` makes the workspace and answers the route. */
  defer?: true
  begin?: (task: Task, pending: Omit<WorkspacePendingStart, 'via' | 'at'>) => Promise<Record<string, unknown>>
}

/** The quick-start route's workspace step (body field `workspace: { provider, inputs? }`). */
export async function workspaceLaunchPlan(body: Record<string, unknown>, ctx: {
  cwd: string; host?: string; existingTaskId?: string; isWalnutAgent: boolean
}): Promise<QuickStartWorkspacePlan | null> {
  const asked = body.workspace && typeof body.workspace === 'object' ? body.workspace as Record<string, unknown> : null
  const refuse = (status: number, error: string, code: string) => ({ refuse: { status, body: { error, code } } })
  let existing: Task | null = null
  // A bound draft's Start (▶ on an existing task): the task's own row decides.
  if (ctx.existingTaskId) existing = await managerDeps().getTask(ctx.existingTaskId)
  const ws = existing?.workspace
  const begin = (request: { provider: string; inputs?: unknown } | null): QuickStartWorkspacePlan => ({
    defer: true,
    begin: async (task, pending) => {
      const full: WorkspacePendingStart = { ...pending, via: 'quick-start', at: new Date().toISOString() }
      try {
        const cur = task.workspace
        const updated = cur && (cur.state === 'creating' || needsCreation(cur)) && (!request || request.provider === cur.provider)
          ? await deferStart(task.id, full)
          : await requestWorkspace(task.id, { provider: request!.provider, host: normHost(ctx.host), anchor: ctx.cwd, inputs: request?.inputs, pending: full })
        // quickStartSession returned before its auto-organize pass (the real start is a
        // retry on this task, which skips it), so an unfiled new task gets it here.
        if (!ctx.existingTaskId && !updated.project) void organizeUnfiled(updated.id, ctx.cwd, pending.message)
        return { taskId: updated.id, task: updated, preparing: true }
      } catch (err) {
        if (err instanceof WorkspaceError) {
          // The row records the refusal (with the launch) so the task shows it with Retry.
          const cur = task.workspace
          const req = request ?? (cur ? { provider: cur.provider, inputs: cur.inputs } : null)
          const latest = req
            ? await recordRequestFailure(task.id, { provider: req.provider, host: normHost(ctx.host), anchor: ctx.cwd, inputs: req.inputs }, full, err).catch(() => null)
            : null
          return { taskId: task.id, task: latest ?? task, preparing: false, workspaceError: err.message }
        }
        throw err
      }
    },
  })

  if (asked) {
    if (ctx.isWalnutAgent) return refuse(400, 'An Ask Walnut session has no isolated workspace.', 'bad-request')
    const providerId = typeof asked.provider === 'string' ? asked.provider : ''
    if (ws && isLaunchReady(ws)) {
      return normHost(ctx.host) === ws.host ? { cwd: ws.cwd } : refuse(409, `This task's workspace lives on ${ws.host === '__local__' ? 'this Mac' : ws.host}.`, 'host-mismatch')
    }
    if (ws?.state === 'removing') return refuse(409, 'This task\'s workspace is being removed.', 'busy')
    if (!ws || ws.state === 'removed' || !(ws.state === 'creating' || needsCreation(ws)) || ws.provider !== providerId) {
      const provider = await findProvider(providerId)
      if (!provider) return refuse(400, `Unknown workspace provider: ${providerId || '(none)'}`, 'unknown-provider')
      const inputs = validateInputs(provider.inputSchema, asked.inputs)
      if (typeof inputs === 'string') return refuse(400, inputs, 'bad-inputs')
      if (process.env.WALNUT_CLOUD_MODE === '1') return refuse(409, 'Isolated workspaces are made by the Walnut on your Mac.', 'cloud')
      return begin({ provider: providerId, inputs })
    }
    return begin(null)
  }
  // A removed workspace is made again (same provider and inputs): the task asked for isolation.
  if (!ws || !belongsToWorkspace(ws, ctx.cwd)) return null
  if (isLaunchReady(ws)) {
    if (normHost(ctx.host) !== ws.host) return refuse(409, `This task's workspace lives on ${ws.host === '__local__' ? 'this Mac' : ws.host}.`, 'host-mismatch')
    return { cwd: insideRoot(ws, ctx.cwd) ? ctx.cwd : ws.cwd }
  }
  if (ws.state === 'removing') return refuse(409, 'This task\'s workspace is being removed.', 'busy')
  return begin(null)
}

/**
 * Task workspaces: the cleanup that follows a task's completion or deletion, and
 * the boot pass that picks up what a restart interrupted.
 *
 * The rule (decisions.ts): remove only when nothing in it would be lost. Two more
 * guards live here:
 *  - a live session keeps its cwd in the folder, idle included, so a completed
 *    task's workspace waits until no session process of the task is alive. Nothing
 *    stops the CLI for it: completing a task already stops its sessions, and the
 *    session's stop (session:status-changed) runs the check again;
 *  - a reopen wins: "still COMPLETE" is checked inside the same locked write that
 *    moves the workspace to `removing`.
 * Only the Walnut that made a workspace cleans it up (madeHere).
 */

import type { Task } from '../types.js'
import type { TaskWorkspace, WorkspaceProbeSummary } from './types.js'
import { cleanupDecision, isLaunchReady, keptReason } from './decisions.js'
import { hostLabel, replyError } from './daemon-client.js'
import {
  beginRemoval, drive, errText, launchPending, madeHere, managerDeps, pollJob, probeParams, probeWorkspace, stamp,
  START_RPC_MS,
} from './manager.js'
import { log } from '../../logging/index.js'

/** Grace after a completion: the turn that completed the task is still ending, its sessions are stopping. */
const COMPLETE_GRACE_MS = 4_000

/** One check per task at a time; a request that arrives meanwhile runs once more after it. */
const checking = new Map<string, { again: boolean }>()

/** A task moved into COMPLETE: remove its workspace when nothing in it would be lost; otherwise keep it and say why. */
export async function onTaskCompleted(taskId: string, opts: { grace?: boolean } = {}): Promise<void> {
  const running = checking.get(taskId)
  if (running) {
    running.again = true
    return
  }
  const slot = { again: false }
  checking.set(taskId, slot)
  try {
    let grace = opts.grace !== false
    for (;;) {
      await completionCheck(taskId, grace)
      if (!slot.again) break
      slot.again = false
      grace = false
    }
  } finally {
    checking.delete(taskId)
  }
}

/** A session of a task stopped: a completed task's workspace that waited for it may go now. */
export async function onTaskSessionStopped(taskId: string): Promise<void> {
  const task = await managerDeps().getTask(taskId)
  if (task?.phase !== 'COMPLETE' || task.workspace?.state !== 'ready') return
  await onTaskCompleted(taskId, { grace: false })
}

async function completionCheck(taskId: string, grace: boolean): Promise<void> {
  const deps = managerDeps()
  const first = await deps.getTask(taskId)
  if (!first || first.phase !== 'COMPLETE' || !first.workspace || !isLaunchReady(first.workspace)) return
  if (!(await madeHere(first.workspace))) return
  if (grace) await deps.sleep(COMPLETE_GRACE_MS)
  if (await deps.hasLiveSession(taskId)) {
    log.web.info('workspace cleanup waits: a session of the task is still alive in it', { taskId, root: first.workspace.root })
    return
  }
  const task = await deps.getTask(taskId)
  const ws = task?.workspace
  if (!task || task.phase !== 'COMPLETE' || !ws || !isLaunchReady(ws) || ws.root !== first.workspace.root) return
  // A kept (or reopened) task is never flipped to kept by a check it outlived.
  const keep = (reason: string) => deps.write(task.id, (cur, row) => (cur && isLaunchReady(cur) && cur.root === ws.root && row.phase === 'COMPLETE'
    ? stamp(cur, { state: 'kept', kept_reason: reason })
    : null))
  let probe: WorkspaceProbeSummary
  try {
    probe = await probeWorkspace(ws)
  } catch (err) {
    return void await keep(`it could not be checked (${errText(err)})`)
  }
  const decision = cleanupDecision(ws, probe, 'complete')
  if (decision.action !== 'remove') return void await keep(decision.reason ?? 'it could not be checked')
  if (await deps.hasLiveSession(taskId)) return
  const started = await beginRemoval(task, ws, 'complete', (row) => row.phase === 'COMPLETE')
  if (!started) log.web.info('workspace cleanup skipped: the task changed meanwhile', { taskId, root: ws.root })
}

/** A task was deleted: the same rule; the task row is gone, so a kept workspace becomes a notification. */
export async function onTaskDeleted(task: Task): Promise<void> {
  const ws = task.workspace
  if (!ws) return
  // A creation in flight finishes in its driver, which cleans up when it finds the task gone.
  if (ws.state === 'creating') return
  if (!isLaunchReady(ws)) return
  await cleanupForDeletedTask(task, ws)
}

export async function cleanupForDeletedTask(task: Pick<Task, 'id' | 'title'>, ws: TaskWorkspace): Promise<void> {
  const deps = managerDeps()
  if (!(await madeHere(ws))) {
    log.web.info('workspace of a deleted task left alone: another Walnut made it', { taskId: task.id, root: ws.root, home: ws.home })
    return
  }
  const tell = (body: string) => deps.notify({
    severity: 'warning', title: `Workspace kept: ${task.title}`, body,
    dedupKey: `workspace-kept:${task.id}:${ws.root ?? ''}`,
  }).catch((err) => log.web.warn('workspace notification failed', { taskId: task.id, error: errText(err) }))
  let probe: WorkspaceProbeSummary
  try {
    probe = await probeWorkspace(ws)
  } catch (err) {
    return void await tell(`The task was deleted, but its workspace at ${ws.root} on ${hostLabel(ws.host)} could not be checked (${errText(err)}), so it is still there.`)
  }
  const decision = cleanupDecision(ws, probe, 'delete')
  if (decision.action !== 'remove') {
    return void await tell(`The task was deleted, but its workspace at ${ws.root} on ${hostLabel(ws.host)} still holds work: ${decision.reason}. Nothing was removed.`)
  }
  const jobId = deps.jobId()
  try {
    const res = await deps.rpc(ws.host, 'workspace.remove', { ...probeParams(ws), jobId, deleteBranch: 'if-merged', requireMerged: true }, START_RPC_MS)
    if (!res.ok) return void await tell(`The task was deleted; its workspace at ${ws.root} was kept: ${keptReason(replyError(res, 'the host refused'))}.`)
  } catch (err) {
    return void await tell(`The task was deleted; its workspace at ${ws.root} could not be removed (${errText(err)}).`)
  }
  const outcome = await pollJob(ws.host, jobId, 10 * 60_000, async () => {})
  if (outcome.state !== 'done') await tell(`The task was deleted; its workspace at ${ws.root} was kept: ${keptReason(outcome.error)}.`)
  else log.web.info('workspace of a deleted task removed', { taskId: task.id, root: ws.root })
}

/**
 * Server boot: pick up the jobs and launches a restart interrupted, and the
 * completion cleanup of a completed task whose workspace is still there (its check
 * was waiting for a session, or the server stopped mid-way). Another Walnut's
 * workspaces are left alone.
 */
export async function resumeWorkspaces(): Promise<void> {
  const deps = managerDeps()
  if (deps.cloudMode()) return
  const tasks = await deps.listTasks()
  for (const task of tasks) {
    const ws = task.workspace
    if (!ws || !(await madeHere(ws))) continue
    if (ws.state === 'creating' || ws.state === 'removing') void drive(task.id)
    else if (task.phase === 'COMPLETE' && ws.state === 'ready') void onTaskCompleted(task.id, { grace: false })
    else if (isLaunchReady(ws) && ws.pending_start && !ws.launch_error) void launchPending(task.id)
  }
}

/** Test seam: wait until no completion check runs for the task. */
export async function __settleCompletionCheck(taskId: string): Promise<void> {
  for (let i = 0; i < 1000 && checking.has(taskId); i++) await new Promise((r) => setImmediate(r))
}

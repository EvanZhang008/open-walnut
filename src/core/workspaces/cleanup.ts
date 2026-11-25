/**
 * Task workspaces: the cleanup that follows a task's completion or deletion, and
 * the boot pass that picks up what a restart interrupted.
 *
 * The rule (decisions.ts): remove only when nothing in it would be lost. Two more
 * guards live here:
 *  - the task's work must be over (still-working.ts): no session process of the
 *    task alive on the host, idle included and whatever its record says, and no
 *    request to it left unanswered. Asked before the teardown script and again
 *    before the removal, on every path here (completion, a session's stop, the boot
 *    pass, a script's end, a deletion). Nothing stops the CLI for it: completing a
 *    task already stops its sessions, and the session's stop
 *    (session:status-changed) runs the check again; a check that waits also looks
 *    again later (RECHECK_MS), for what announces nothing (a request answered, a
 *    host back, a stop the record missed);
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
import { resumeScriptRuns, scriptRunning, teardownBeforeCleanup } from './scripts.js'
import { keptOnlyUnmerged, keptPatch } from './merge-recheck.js'
import { log } from '../../logging/index.js'
import { clause } from '../../utils/format.js'

/** The longest a deleted task's cleanup waits for a script running in its workspace (the scripts' own cap). */
const SCRIPT_WAIT_MS = 61 * 60_000

/** Grace after a completion: the turn that completed the task is still ending, its sessions are stopping. */
const COMPLETE_GRACE_MS = 4_000

/** A deleted task's workspace waits this long for its sessions to end (the deletion stops them). */
const DELETE_SESSION_WAIT_MS = 60_000
const DELETE_SESSION_POLL_MS = 5_000

/** A check that found the work not over looks again after this long. */
export const RECHECK_MS = 10 * 60_000

/** ...and this soon when a session's stop is on its way (it ends within a second or two; nothing announces it). */
export const RECHECK_SOON_MS = 15_000

/** Still not over this long after the completion: the workspace is kept, with why, and nothing looks again. */
export const GIVE_UP_AFTER_MS = 24 * 60 * 60_000

/** One check per task at a time; a request that arrives meanwhile runs once more after it. */
const checking = new Map<string, { again: boolean }>()

function recheckLater(taskId: string, soon = false): void {
  const look = () => {
    void onTaskCompleted(taskId, { grace: false })
      .catch((err) => log.web.warn('workspace cleanup recheck failed', { taskId, error: errText(err) }))
  }
  if (soon) managerDeps().later(`workspace-recheck-soon:${taskId}`, look, RECHECK_SOON_MS)
  managerDeps().later(`workspace-recheck:${taskId}`, look, RECHECK_MS)
}

/**
 * The task's work is not over: say why, look again later, and stop this check. A
 * day after the completion (a host that never comes back, a session left idle) the
 * workspace is kept with the reason instead: kept is never removed by itself.
 */
async function workGoesOn(task: Task, ws: TaskWorkspace, before: 'teardown' | 'removal'): Promise<boolean> {
  const deps = managerDeps()
  const still = await deps.stillWorking(task, ws)
  if (!still) return false
  const { why } = still
  const since = Date.parse(task.completed_at ?? '')
  if (Number.isFinite(since) && deps.now() - since >= GIVE_UP_AFTER_MS) {
    const root = ws.root
    await deps.write(task.id, (cur, row) => (cur && isLaunchReady(cur) && cur.root === root && row.phase === 'COMPLETE'
      ? stamp(cur, keptPatch(cur, `its work did not look over a day after the task completed: ${why}`, false))
      : null))
    log.web.info(`workspace kept: ${why}, a day after completion`, { taskId: task.id, root })
    return true
  }
  log.web.info(`workspace cleanup waits: ${why}`, { taskId: task.id, root: ws.root, before })
  recheckLater(task.id, still.soon === true)
  return true
}

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
  // Made again for a session's waiting message: that session starts in it first (remake.ts).
  const { remakeHoldsCleanup } = await import('./remake.js')
  if (remakeHoldsCleanup(taskId, first.workspace)) return
  let task = await deps.getTask(taskId)
  let ws = task?.workspace
  if (!task || task.phase !== 'COMPLETE' || !ws || !isLaunchReady(ws) || ws.root !== first.workspace.root) return
  if (await workGoesOn(task, ws, 'teardown')) return
  // A setup still running finishes first (its end runs this check again); then the
  // task's teardown script, once per completion (scripts.ts).
  if (scriptRunning(ws) === 'setup') {
    log.web.info('workspace cleanup waits: its setup script is still running', { taskId, root: ws.root })
    return
  }
  if (!(await teardownBeforeCleanup(task, ws))) {
    recheckLater(taskId)
    return
  }
  task = await deps.getTask(taskId)
  ws = task?.workspace
  if (!task || task.phase !== 'COMPLETE' || !ws || !isLaunchReady(ws) || ws.root !== first.workspace.root) return
  // A kept (or reopened) task is never flipped to kept by a check it outlived.
  const root = ws.root
  // Kept only for commits not merged yet: checked again later (merge-recheck.ts).
  const keep = (reason: string, unmergedOnly = false) => deps.write(taskId, (cur, row) => (cur && isLaunchReady(cur) && cur.root === root && row.phase === 'COMPLETE'
    ? stamp(cur, keptPatch(cur, reason, unmergedOnly))
    : null))
  let probe: WorkspaceProbeSummary
  try {
    probe = await probeWorkspace(ws)
  } catch (err) {
    return void await keep(`it could not be checked (${errText(err)})`)
  }
  const decision = cleanupDecision(ws, probe, 'complete')
  if (decision.action !== 'remove') return void await keep(decision.reason ?? 'it could not be checked', keptOnlyUnmerged(probe) && await deps.mergeRecheckOn())
  if (await workGoesOn(task, ws, 'removal')) return
  const started = await beginRemoval(task, ws, 'complete', (row) => row.phase === 'COMPLETE')
  if (!started) log.web.info('workspace cleanup skipped: the task changed meanwhile', { taskId, root })
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
  // A setup or teardown still running in it ends first: its folder must not go from under it.
  const running = scriptRunning(ws)
  const runningJob = running ? ws[running]?.job_id : undefined
  if (runningJob) {
    log.web.info('workspace of a deleted task waits for its script to end', { taskId: task.id, root: ws.root, script: running })
    await pollJob(ws.host, runningJob, SCRIPT_WAIT_MS, async () => {})
  }
  // A session still in it (the deletion stops them; a stop can take a moment) keeps it.
  for (let waited = 0; ; waited += DELETE_SESSION_POLL_MS) {
    const still = await deps.stillWorking(task, ws, { requests: false })
    if (!still) break
    if (waited >= DELETE_SESSION_WAIT_MS) {
      return void await tell(`The task was deleted, but its workspace at ${ws.root} on ${hostLabel(ws.host)} was kept: ${clause(still.why)}. Nothing was removed.`)
    }
    await deps.sleep(DELETE_SESSION_POLL_MS)
  }
  let probe: WorkspaceProbeSummary
  try {
    probe = await probeWorkspace(ws)
  } catch (err) {
    return void await tell(`The task was deleted, but its workspace at ${ws.root} on ${hostLabel(ws.host)} could not be checked (${errText(err)}), so it is still there.`)
  }
  const decision = cleanupDecision(ws, probe, 'delete')
  if (decision.action !== 'remove') {
    return void await tell(`The task was deleted, but its workspace at ${ws.root} on ${hostLabel(ws.host)} still holds work: ${clause(decision.reason)}. Nothing was removed.`)
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
    // A setup or teardown the restart interrupted: its end launches or cleans up.
    else if (scriptRunning(ws)) void resumeScriptRuns(task)
    // Made again for sessions whose messages wait for it: they go first (remake.ts).
    else if (isLaunchReady(ws) && ws.remade?.resume) void launchPending(task.id)
    else if (task.phase === 'COMPLETE' && ws.state === 'ready') void onTaskCompleted(task.id, { grace: false })
    else if (isLaunchReady(ws) && ws.pending_start && !ws.launch_error) void launchPending(task.id)
  }
}

/** Test seam: wait until no completion check runs for the task. */
export async function __settleCompletionCheck(taskId: string): Promise<void> {
  for (let i = 0; i < 1000 && checking.has(taskId); i++) await new Promise((r) => setImmediate(r))
}
